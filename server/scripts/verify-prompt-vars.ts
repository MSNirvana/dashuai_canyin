/**
 * 变量契约验证：提示词的「模板 ↔ 变量 ↔ 场景白名单」三者必须严丝合缝。
 *
 * 背景：`ai_scene.prompt_template` 存在数据库里，`{{变量}}` 由网关做**纯字符串替换** ——
 * 取不到的键替换成空串：不报错、提示词那一段渲染成空白、这次调用照常扣积分。
 * 也就是说这类缺陷**没有任何错误日志**，只能靠契约测试钉死。本脚本覆盖四类：
 *   ① 模板层：所有创建场景模板 / 兜底模板的占位符都在白名单内，且改动后确实引用了
 *      门店介绍与老板人设（这两个字段此前根本没进提示词）
 *   ② 判据一致性：白名单提取正则必须与网关替换正则等价 —— 否则会出现
 *      「网关照替换、契约查不到」的漏网（`{{store.intro}}` 就是这种：不替换、原样留在提示词里）
 *   ③ 拼装格式：门店介绍必须带值；人设两个字段必须带标签，全空时必须整段消失而不是留空标签
 *   ④ 真实数据链路：临时门店（分别填/不填介绍与人设）→ buildVariables → 渲染，逐项对值
 *
 * 用法：npm run ai-prompts:verify
 * 用一个一次性手机号造临时商户/门店/菜品/创作，跑完硬删；不动任何真实商户数据。
 * 未配置数据库时只跑 ①②③（纯离线），仍然有意义。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import {
  COPY_PROMPT,
  COPY_TRAFFIC_PROMPT,
  COPY_INTRO_PROMPT,
  COPY_QUALITY_PROMPT,
  COPY_RECOMMEND_PROMPT,
  STORY_PROMPT,
  COPY_FALLBACK,
  COPY_TRAFFIC_FALLBACK,
  COPY_INTRO_FALLBACK,
  COPY_QUALITY_FALLBACK,
  COPY_RECOMMEND_FALLBACK,
  STORY_FALLBACK,
  CREATION_SCENE_PROMPTS,
  STORYBOARD_SCENE,
} from '../prisma/prompts.js'
import {
  extractPlaceholders,
  findUnknownPlaceholders,
  findMalformedPlaceholders,
  validateTemplate,
  SCENE_VARIABLES,
} from '../src/ai/prompt-vars.js'
import { renderTemplate } from '../src/ai/gateway.js'
import { buildVariables, formatPersona, createCreation } from '../src/services/creation.service.js'
import { upsertAiScene, AdminAiInvalidTemplateError } from '../src/services/admin-ai.service.js'

const prisma = new PrismaClient()
/** 一次性测试账号：本脚本专用，跑完硬删。与其他 verify 脚本的号段刻意错开 */
const PHONE = '13900008811'

let pass = 0
let fail = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? `  ${extra}` : ''}`)
  }
}
function section(t: string) {
  console.log(`\n── ${t} ──`)
}

/** 6 个创作场景的「模板 + 兜底」清单 */
const TEMPLATES: Array<{ code: string; label: string; tpl: string; fallback: string }> = [
  { code: 'copy_generate', label: '文案·通用（兼容旧客户端）', tpl: COPY_PROMPT, fallback: COPY_FALLBACK },
  { code: 'copy_traffic', label: '文案·流量款', tpl: COPY_TRAFFIC_PROMPT, fallback: COPY_TRAFFIC_FALLBACK },
  { code: 'copy_intro', label: '文案·介绍款', tpl: COPY_INTRO_PROMPT, fallback: COPY_INTRO_FALLBACK },
  { code: 'copy_quality', label: '文案·质量款', tpl: COPY_QUALITY_PROMPT, fallback: COPY_QUALITY_FALLBACK },
  { code: 'copy_recommend', label: '文案·种草型', tpl: COPY_RECOMMEND_PROMPT, fallback: COPY_RECOMMEND_FALLBACK },
  { code: 'storyboard_generate', label: '分镜', tpl: STORY_PROMPT, fallback: STORY_FALLBACK },
]

/**
 * 用「记录所有被读取的键」的代理渲染一次，得到网关**真正会替换掉**的占位符集合。
 * 这是验证「提取正则 == 替换正则」的关键手段：不能靠肉眼看两条正则长得像。
 */
function placeholdersGatewayReplaces(tpl: string): string[] {
  const seen = new Set<string>()
  const spy = new Proxy({} as Record<string, string>, {
    get: (_t, k) => {
      if (typeof k !== 'string') return undefined
      seen.add(k)
      return `⟨${k}⟩`
    },
  })
  renderTemplate(tpl, spy)
  return [...seen].sort()
}

// ──────────────────────── ① 模板层（离线） ────────────────────────
section('① 模板层：占位符都在白名单内 / 关键字段确实被引用')

for (const t of TEMPLATES) {
  const problems = validateTemplate(t.code, t.tpl)
  check(problems.length === 0, `${t.label} 模板校验通过`, problems.join('；'))
  const fbProblems = validateTemplate(t.code, t.fallback)
  check(fbProblems.length === 0, `${t.label} 兜底模板校验通过`, fbProblems.join('；'))
}

// 门店介绍 / 老板人设此前从未进过提示词，这里钉住「以后不许再掉」
for (const t of TEMPLATES) {
  check(t.tpl.includes('{{storeIntro}}'), `${t.label} 引用了门店介绍 {{storeIntro}}`)
  check(t.tpl.includes('{{persona}}'), `${t.label} 引用了门店人设 {{persona}}`)
}

// 「你想怎么拍？」({{userIdea}}) 是用户唯一的自由输入 —— 掉出提示词 = 这个功能**静默失效**
// （前端照常填、照常扣积分、生成结果就是没理他）。所以 6 个模板逐个钉住。
// 同时必须**只出现一次**：同一句话在上下文里出现两遍会被模型当成两条独立要求放大。
for (const t of TEMPLATES) {
  const n = (t.tpl.match(/\{\{userIdea\}\}/g) ?? []).length
  check(n === 1, `${t.label} 恰好引用一次 {{userIdea}}`, `实际 ${n} 次`)
}
// 文案与分镜都要认这个变量：一个场景漏登记白名单的话，后台一保存就报「未支持的变量」
check(
  findUnknownPlaceholders('copy_traffic', '{{userIdea}}').length === 0 &&
    findUnknownPlaceholders('storyboard_generate', '{{userIdea}}').length === 0,
  'userIdea 已在文案与分镜两个场景的白名单里',
)

// 兜底文案刻意保持短，不塞门店介绍（见 prisma/prompts.ts 注释）
check(
  TEMPLATES.filter((t) => t.code.startsWith('copy_')).every((t) => !t.fallback.includes('{{storeIntro}}')),
  '兜底文案不引用门店介绍（避免超出口播长度）',
)

// 4 款文案必须彼此不同 —— 款式是靠「选哪个模板」生效的，模板一旦撞车就等于款式失效
const copyTpls = TEMPLATES.filter((t) => t.code.startsWith('copy_') && t.code !== 'copy_generate').map((t) => t.tpl)
check(new Set(copyTpls).size === copyTpls.length, '4 款文案模板互不相同', `共 ${copyTpls.length} 份`)

// 款式不是变量：模板里若出现 {{track}}，说明有人把「选模板」误实现成了「填变量」
for (const t of TEMPLATES) {
  const hasTrack = extractPlaceholders(t.tpl).some((v) => v === 'track' || v === 'trackLabel')
  check(!hasTrack, `${t.label} 未把款式写成变量（款式靠选模板生效）`)
}

// 同步脚本与 seed 共用同一份清单，别出现「代码里 6 个、清单里 5 个」
check(
  CREATION_SCENE_PROMPTS.length === 5 && STORYBOARD_SCENE.code === 'storyboard_generate',
  '场景清单完整（文案 5 + 分镜 1）',
)

// ──────────────────────── ② 判据一致性（离线） ────────────────────────
section('② 判据一致性：白名单提取正则 == 网关替换正则')

for (const t of TEMPLATES) {
  const byExtract = extractPlaceholders(t.tpl).sort()
  const byGateway = placeholdersGatewayReplaces(t.tpl)
  check(
    JSON.stringify(byExtract) === JSON.stringify(byGateway),
    `${t.label} 两侧看到的占位符一致`,
    byExtract.length === byGateway.length ? `${byExtract.length} 个` : `提取 ${byExtract.length} / 替换 ${byGateway.length}`,
  )
}

// 复现缺陷本身：小写变量是「静默变空串」，点号变量是「原样留在提示词里」
const lowerCase = '门店：{{storeName}}｜菜品：{{dishname}}'
check(
  renderTemplate(lowerCase, { storeName: '大帅川菜' }) === '门店：大帅川菜｜菜品：',
  '复现：未支持的变量被静默替换成空串（不报错）',
)
check(
  findUnknownPlaceholders('copy_traffic', lowerCase).join(',') === 'dishname',
  '能拦住未支持的变量 {{dishname}}',
)
check(
  findMalformedPlaceholders(lowerCase).length === 0,
  '小写变量不会被误判成「写法不合法」',
)
check(
  findMalformedPlaceholders('门店介绍：{{store.intro}}').join(',') === '{{store.intro}}',
  '能拦住写法不合法、网关不会替换的 {{store.intro}}',
)
check(
  renderTemplate('{{store.intro}}', {}) === '{{store.intro}}',
  '复现：写法不合法的占位符会原样出现在提示词里',
)
check(
  findMalformedPlaceholders('{{ dishName }}').length === 0 &&
    findUnknownPlaceholders('copy_traffic', '{{ dishName }}').length === 0,
  '带空格的 {{ dishName }} 属于合法写法，两边都放行',
)
// 白名单里没有的场景宽松放行，避免新场景一上线就被拦
check(validateTemplate('brand_new_scene', '{{whatever}}').length === 0, '未登记的场景不校验（宽松放行）')

// ──────────────────────── ③ 拼装格式（离线） ────────────────────────
section('③ 拼装格式：门店介绍带值 / 人设两字段带标签')

check(
  formatPersona({ bossTags: '90后老板 / 退伍军人', activity: '开业酬宾 8 折' }) ===
    '老板人设标签：90后老板 / 退伍军人；最近想重点告诉顾客：开业酬宾 8 折',
  '人设两字段都有 → 两个标签都在，顺序为「标签 → 活动」',
)
check(
  formatPersona({ bossTags: '匠人型老板', activity: null }) === '老板人设标签：匠人型老板',
  '只有老板标签 → 不出现「最近想重点告诉顾客」空标签',
)
check(
  formatPersona({ bossTags: null, activity: '每周三会员日' }) === '最近想重点告诉顾客：每周三会员日',
  '只有门店活动 → 不出现「老板人设标签」空标签',
)
check(
  formatPersona({ bossTags: '   ', activity: '\n' }) === '',
  '两字段都是空白字符 → 整段消失（视同未填写）',
)
check(formatPersona(null) === '', '门店没有填写过任何东西 → 空串')

// ──────────────────────── ④ 真实数据链路（需要数据库） ────────────────────────
section('④ 真实数据链路：临时门店 → buildVariables → 渲染')

/** 造一家临时门店：intro / persona 由参数决定，返回所需 id */
async function makeStore(
  merchantId: bigint,
  tag: string,
  intro: string | null,
  persona: { bossTags: string | null; activity: string | null } | null,
  userIdea?: string | null,
) {
  const store = await prisma.store.create({
    data: { merchantId, name: `契约测试门店-${tag}`, category: '川菜', city: '济南', intro },
  })
  if (persona) {
    await prisma.persona.create({
      data: { merchantId, storeId: store.id, bossTags: persona.bossTags, activity: persona.activity },
    })
  }
  const dish = await prisma.dish.create({
    data: { storeId: store.id, name: `契约测试菜品-${tag}`, intro: '现做现卖，出锅即上桌', sellingPoints: '分量实在 / 价格透明' },
  })
  const creation = await createCreation(prisma, merchantId, {
    storeId: store.id,
    dishId: dish.id,
    track: 'TRAFFIC',
    complexity: 'COMPLEX',
    userIdea: userIdea ?? undefined,
  })
  await prisma.creation.update({ where: { id: creation.id }, data: { copyText: '测试用口播文案正文' } })
  return { storeId: store.id, dishId: dish.id, creationId: creation.id }
}

const INTRO = '开了十二年的老川菜馆，招牌是每天现炒的辣子鸡。'
const BOSS_TAGS = '90后老板 / 退伍军人'
const ACTIVITY = '开业酬宾 8 折'
/** 用户在「你想怎么拍？」里自己写的一句话：要验证它**原样**进提示词，不被截断/改写 */
const USER_IDEA = '想让老板出镜讲两句，重点拍锅里现炒的画面，结尾说「报我名字送例汤」'

let dbReady = true
try {
  await prisma.$queryRaw`SELECT 1`
} catch (e) {
  dbReady = false
  console.log(`  ⚠ 数据库不可用，跳过真实链路（离线部分仍已校验）：${(e as Error).message.slice(0, 120)}`)
}

if (dbReady) {
  let merchantId: bigint | null = null
  try {
    const merchant = await prisma.merchant.create({ data: { phone: PHONE, nickname: '契约测试账号' } })
    merchantId = merchant.id

    // 4.1 信息填全的门店
    const full = await makeStore(merchantId, 'full', INTRO, { bossTags: BOSS_TAGS, activity: ACTIVITY }, USER_IDEA)
    const v = await buildVariables(prisma, full.creationId, { track: 'TRAFFIC' })
    check(v.storeIntro === INTRO, 'buildVariables 产出了门店介绍', `storeIntro=${JSON.stringify(v.storeIntro).slice(0, 40)}`)
    check(
      v.persona === `老板人设标签：${BOSS_TAGS}；最近想重点告诉顾客：${ACTIVITY}`,
      'buildVariables 产出的门店人设带标签',
      v.persona,
    )
    check(v.dishName === '契约测试菜品-full', '菜品名称仍在变量里')
    check(v.sellingPoints === '分量实在 / 价格透明', '菜品卖点仍在变量里')
    check(v.userIdea === USER_IDEA, '「你想怎么拍？」原样带出来（没被删改）', v.userIdea)

    // 渲染一次真模板，确认值真的落到了提示词里（而不只是变量对象里有）
    const rendered = renderTemplate(COPY_TRAFFIC_PROMPT, v as unknown as Record<string, string>)
    check(rendered.includes(INTRO), '渲染后提示词含门店介绍正文')
    check(rendered.includes(BOSS_TAGS) && rendered.includes(ACTIVITY), '渲染后提示词含门店人设两字段')
    check(rendered.includes(USER_IDEA), '渲染后提示词含用户原话（「最高优先级」那一段）')
    check(
      rendered.includes('最高优先级'),
      '提示词里明确标了这句话的优先级（否则模型容易把它当成一条普通的补充信息）',
    )
    // 分镜那一侧也要吃到同一句话：两次调用是两个场景，漏一个就等于「只有文案听了」
    const renderedStory = renderTemplate(STORY_PROMPT, v as unknown as Record<string, string>)
    check(renderedStory.includes(USER_IDEA), '分镜提示词同样含用户原话')
    check(!rendered.includes('{{'), '渲染后提示词已无残留占位符', rendered.match(/\{\{[^}]*\}\}/g)?.join('、') ?? '')
    check(rendered.includes('【门店介绍】'), '提示词保留了【门店介绍】段落标题')

    // 4.2 什么都没有的门店：介绍为空串、人设为空串（模板会留下一行空标题，这是可接受的）
    const bare = await makeStore(merchantId, 'bare', null, null)
    const v2 = await buildVariables(prisma, bare.creationId, { track: 'TRAFFIC' })
    check(v2.storeIntro === '', '未填门店介绍 → storeIntro 为空串（不会变成 undefined）')
    check(v2.persona === '', '未填人设 → persona 为空串（不留空标签）')
    // ★ 与上面两条相反：userIdea **不允许**为空串。它的标题写着「最高优先级」，
    //   留下一个没有内容的空标题，模型很可能自己脑补出一条要求（"用户要求……"）。
    check(v2.userIdea.length > 0, '未填「你想怎么拍？」→ 变量仍非空（空标题会让模型自己编要求）', v2.userIdea)
    const rendered2 = renderTemplate(COPY_TRAFFIC_PROMPT, v2 as unknown as Record<string, string>)
    check(!rendered2.includes('老板人设标签：') && !rendered2.includes('最近想重点告诉顾客：'), '渲染后不出现空的人设标签')
    check(
      !/【用户对怎么拍的要求[^\n]*】\s*(\n|$)/.test(rendered2),
      '未填时「最高优先级」那一段也不是空标题（变量兜住了）',
    )
    check(!rendered2.includes('{{'), '未填内容的门店渲染后同样无残留占位符')

    // 4.3 后台保存场景的闸门：非法模板必须被拒，且库里内容不变
    const scene = await prisma.aiScene.findUnique({ where: { code: 'copy_traffic' } })
    if (!scene) {
      console.log('  ⚠ 库里没有 copy_traffic 场景，跳过保存闸门用例（先跑 npm run db:seed）')
    } else {
      const before = scene.promptTemplate
      const readBack = async () =>
        (await prisma.aiScene.findUniqueOrThrow({ where: { id: scene.id } })).promptTemplate
      const base = {
        code: scene.code,
        name: scene.name,
        fallbackTemplate: scene.fallbackTemplate,
        defaultModelId: scene.defaultModelId,
        fallbackModelIds: (scene.fallbackModelIds as unknown[]).map((x) => BigInt(x as string | number)),
        beanPrice: scene.beanPrice,
        timeoutMs: scene.timeoutMs,
        maxRetries: scene.maxRetries,
        temperature: scene.temperature === null ? null : Number(scene.temperature),
        maxOutputTokens: scene.maxOutputTokens,
        enabled: scene.enabled,
      }
      try {
        // 4.3.1 未支持的变量：copy_traffic 的白名单里没有 copyText（那是分镜场景才有的）
        let rejected: unknown = null
        try {
          await upsertAiScene(prisma, scene.id, { ...base, promptTemplate: `${before}\n口播文案：{{copyText}}` })
        } catch (e) {
          rejected = e
        }
        check(
          rejected instanceof AdminAiInvalidTemplateError,
          '保存含未支持变量 {{copyText}} 的模板被拒绝',
          (rejected as Error)?.message?.slice(0, 60) ?? '没有抛错',
        )
        check((await readBack()) === before, '被拒绝的模板没有写进库里')
        check(
          ((rejected as Error)?.message ?? '').includes('该场景可用变量'),
          '拒绝提示里直接给出了该场景的可用变量清单（后台不用翻文档）',
        )

        // 4.3.2 写法不合法（网关根本不会替换，会原样留在提示词里）
        let rejected2: unknown = null
        try {
          await upsertAiScene(prisma, scene.id, { ...base, promptTemplate: `${before}\n门店介绍：{{store.intro}}` })
        } catch (e) {
          rejected2 = e
        }
        check(rejected2 instanceof AdminAiInvalidTemplateError, '保存写法不正确的 {{store.intro}} 也被拒绝')
        check((await readBack()) === before, '写法不正确的模板同样没有写进库里')

        // 4.3.3 合法模板必须能存进去，否则这道闸门就是把后台锁死了
        let saved = false
        try {
          await upsertAiScene(prisma, scene.id, { ...base, promptTemplate: before })
          saved = true
        } catch {
          saved = false
        }
        check(saved, '原有的合法模板仍然可以正常保存（闸门没有误伤）')
      } finally {
        // 无论断言成败都还原：闸门用例绝不能把本地库的模板改坏
        await upsertAiScene(prisma, scene.id, { ...base, promptTemplate: before })
        check((await readBack()) === before, '用完例后 copy_traffic 模板已还原')
        if (before !== COPY_TRAFFIC_PROMPT) {
          console.log('  ℹ 库里的 copy_traffic 模板与 prisma/prompts.ts 不一致（后台改过？）→ 跑 npm run ai-prompts:sync 对齐')
        }
      }
    }

    // 4.4 ★ 白名单不能把后台锁死：库里**已存在**的合法模板必须都能过校验。
    //     这条跑红说明白名单与库里模板已经漂移（要么漏登记变量，要么模板真有错）。
    const allScenes = await prisma.aiScene.findMany({
      select: { code: true, promptTemplate: true, fallbackTemplate: true },
    })
    const registered = allScenes.filter((s) => SCENE_VARIABLES[s.code])
    check(
      registered.length > 0,
      '库里存在已登记白名单的场景',
      `${registered.length}/${allScenes.length} 个`,
    )
    for (const s of registered) {
      const p = validateTemplate(s.code, s.promptTemplate)
      check(p.length === 0, `库里 ${s.code} 的现有模板仍能通过校验（白名单没锁死后台）`, p.join('；'))
      if (s.fallbackTemplate) {
        const pf = validateTemplate(s.code, s.fallbackTemplate)
        check(pf.length === 0, `库里 ${s.code} 的兜底模板仍能通过校验`, pf.join('；'))
      }
    }
  } finally {
    if (merchantId !== null) {
      // 硬删：creation → dish → persona → store → merchant（顺序遵循外键）
      const stores = await prisma.store.findMany({ where: { merchantId }, select: { id: true } })
      const storeIds = stores.map((s) => s.id)
      await prisma.shot.deleteMany({ where: { creation: { merchantId } } })
      await prisma.creation.deleteMany({ where: { merchantId } })
      await prisma.dish.deleteMany({ where: { storeId: { in: storeIds } } })
      await prisma.persona.deleteMany({ where: { storeId: { in: storeIds } } })
      await prisma.store.deleteMany({ where: { merchantId } })
      await prisma.merchant.delete({ where: { id: merchantId } })
      const left = await prisma.merchant.count({ where: { phone: PHONE } })
      check(left === 0, '临时商户已清理干净', `残留 ${left}`)
    }
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exitCode = 1
await prisma.$disconnect()
