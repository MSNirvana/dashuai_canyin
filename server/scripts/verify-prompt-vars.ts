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
 * ★ 2026-09-20：「你想拍什么风格？」模块（{{userIdea}}）已从整条链路删除 ⇒
 *   本脚本原本钉住它的正向断言，现改成**反向**断言（模板与白名单里都不许再出现）。
 *
 * ★ 2026-09-20：菜单资产新增**套餐**（`dish.kind='COMBO'`）⇒ 新增变量 {{comboInfo}}。
 *   它与上面的字段不同，是**正向**断言（6 个模板都必须引用、恰好一次），
 *   并且单菜那一侧要反向断言「comboInfo 必须是空串」—— 否则每道炒菜都会被写成套餐。
 *
 * ★ 2026-09-20 同日：流量款从「四款文案」拆成独立功能（`creation.mode='TOPIC'`）⇒
 *   `copy_traffic` 的模板与白名单**都不再包含门店/菜品**（改用 {{topicInfo}}）。
 *   所以本脚本里所有「6 个模板都引用 X」的断言都按「菜品稿 / 话题稿」两组拆开：
 *   菜品组正向、话题组**反向**（引用了就渲染成一排空标题，模型会自己编一个店名补上）。
 *   新增 ⑥ 段专测话题方向库（同一天稳定、隔天轮换、节点只抢 14 天内的头条）。
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
import { formatDateInfo, shanghaiYmd, upcomingNodes, LUNAR_FESTIVAL_MAX_YEAR } from '../src/lib/festival.js'
// 话题方向库（流量款独立功能的时间/话题来源）
import { formatTopicInfo, topicDirections } from '../src/lib/topic.js'
import {
  buildVariables,
  formatPersona,
  formatComboInfo,
  createCreation,
  CONTENT_MODES,
  TOPIC_TRACK,
} from '../src/services/creation.service.js'
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
 * ★ 话题驱动模板（流量款）。
 *
 * 流量款已拆成独立功能：输入里**没有门店、也没有菜品**，那几个变量在话题稿里全是空串。
 * 模板一旦引用它们，渲染出来就是一排空标题（「【门店】｜品类：｜城市：」），
 * 模型会以为信息漏了并**自己编一个店名补上** —— 而且不报错。
 * 所以下面凡「6 个模板都要引用 X」的断言都按这两组分开，话题组另补**反向**断言。
 */
const TOPIC_CODES = new Set(['copy_traffic'])
const dishTemplates = TEMPLATES.filter((t) => !TOPIC_CODES.has(t.code))
const topicTemplates = TEMPLATES.filter((t) => TOPIC_CODES.has(t.code))

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
for (const t of dishTemplates) {
  check(t.tpl.includes('{{storeIntro}}'), `${t.label} 引用了门店介绍 {{storeIntro}}`)
  check(t.tpl.includes('{{persona}}'), `${t.label} 引用了门店人设 {{persona}}`)
}
// 反向：话题模板**不许**引用它们 —— 渲染成空串会让模型以为门店信息漏了，于是自己编一个
for (const t of topicTemplates) {
  check(
    !t.tpl.includes('{{storeIntro}}') && !t.tpl.includes('{{persona}}'),
    `${t.label}（话题）不引用门店介绍/人设`,
  )
}

// ★ 套餐信息（{{comboInfo}}）与上面两个字段不同，它**必须**在 6 个模板里都被引用：
//   套餐与单菜在库里是同一张表，「菜名/简介/卖点」表达不出「含哪些菜、多少钱」，
//   而这两件事正是套餐推广的全部卖点 —— 模板少引用一个场景，那个场景的套餐文案就退回编造。
//   所以这里逐个钉「引用」而不是「可以引用」。
for (const t of dishTemplates) {
  check(t.tpl.includes('{{comboInfo}}'), `${t.label} 引用了套餐信息 {{comboInfo}}`)
}
// 且必须**只出现一次**：同一份套餐信息出现两遍，模型会当成两份不同的套餐去写（同 userIdea 的教训）
for (const t of dishTemplates) {
  const n = (t.tpl.match(/\{\{comboInfo\}\}/g) ?? []).length
  check(n === 1, `${t.label} 恰好引用一次 {{comboInfo}}`, `实际 ${n} 次`)
}
// 反向：话题稿没有门店、没有菜品，更没有套餐 —— 引用它只会渲染成空串
for (const t of topicTemplates) {
  check(!t.tpl.includes('{{comboInfo}}'), `${t.label}（话题）不引用套餐信息 {{comboInfo}}`)
}
// 兜底模板不加：兜底文案本来就短，塞套餐明细只会更容易超出口播长度（同 storeIntro 的取舍）
check(
  TEMPLATES.every((t) => !t.fallback.includes('{{comboInfo}}')),
  '兜底模板不引用 {{comboInfo}}（避免超出口播长度）',
)
// 文案与分镜都要认这个变量：一个场景漏登记白名单，后台一保存就报「未支持的变量」
check(
  findUnknownPlaceholders('copy_intro', '{{comboInfo}}').length === 0 &&
    findUnknownPlaceholders('storyboard_generate', '{{comboInfo}}').length === 0,
  'comboInfo 已在文案与分镜两个场景的白名单里',
)
// 反向：话题场景的白名单里**没有** comboInfo —— 后台若给流量款手填这段会被当场拒绝
check(
  findUnknownPlaceholders('copy_traffic', '{{comboInfo}}').length === 1,
  'comboInfo 不在流量款（话题）白名单里',
)

// ★ 反向断言：{{userIdea}} 已随「你想拍什么风格？」模块一起删除，**不许再出现**。
//   为什么会有人加回来：模板里那一行看着「挺合理」，顺手补回去就成了一段
//   永远渲染成兜底文案的假内容 —— 模型看得见、用户却填不了，而且不改代码查不出来。
for (const t of TEMPLATES) {
  check(!t.tpl.includes('{{userIdea}}'), `${t.label} 模板已不含 {{userIdea}}`)
  check(!t.fallback.includes('{{userIdea}}'), `${t.label} 兜底模板已不含 {{userIdea}}`)
}
// 反向的一半：白名单里也必须没有 —— 这样后台有人手填会当场被拒，而不是静默渲染成兜底文案
check(
  findUnknownPlaceholders('copy_traffic', '{{userIdea}}').length === 1 &&
    findUnknownPlaceholders('storyboard_generate', '{{userIdea}}').length === 1,
  'userIdea 已不在文案与分镜的白名单里（后台若手填会被拒）',
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
// ★ 用菜品场景（copy_intro）验：话题场景现在连 storeName 都不在白名单里，
//   拿它测「只多出一个 dishname」会变成多出两个，断言本身失去意义。
check(
  findUnknownPlaceholders('copy_intro', lowerCase).join(',') === 'dishname',
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
    findUnknownPlaceholders('copy_intro', '{{ dishName }}').length === 0,
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

// ── 套餐信息（纯函数，可离线验：不连库就能把每个分支走一遍）──
const comboDish = {
  kind: 'COMBO',
  priceFen: 8800,
  originalPriceFen: 12000,
  comboItems: [
    { quantity: 1, dish: { name: '宫保鸡丁', deletedAt: null } },
    { quantity: 2, dish: { name: '米饭', deletedAt: null } },
    // 故意混一条指向已软删菜的明细：读取侧必须把它滤掉
    { quantity: 1, dish: { name: '例汤', deletedAt: new Date() } },
  ],
}
const comboInfo = formatComboInfo(comboDish)
check(
  comboInfo.includes('¥88') && comboInfo.includes('¥120') && comboInfo.includes('省 ¥32'),
  'comboInfo 带出套餐价 / 原价 / 省多少',
  comboInfo,
)
check(
  comboInfo.includes('宫保鸡丁') && comboInfo.includes('米饭×2'),
  'comboInfo 带出套餐内容与份数（份数 >1 才标 ×N）',
)
check(!comboInfo.includes('例汤'), 'comboInfo 不含已软删的菜（读取侧过滤）')
check(
  formatComboInfo({ ...comboDish, kind: 'SINGLE' }) === '',
  '★ 单菜 → comboInfo 是**空串**（不是「本菜品不是套餐」这类占位文字，否则模型会在一道炒菜上讨论套餐）',
)
check(formatComboInfo(null) === '', '没有关联菜品 → comboInfo 是空串')
check(formatComboInfo(undefined) === '', 'undefined 也不会抛（落库路径可能给空）')
// 原价不高于套餐价（假划线价）：宁可完全不提「省」，也不要在文案里写「省 ¥-8」
check(
  !formatComboInfo({ kind: 'COMBO', priceFen: 8800, originalPriceFen: 8800, comboItems: [] }).includes('省'),
  '原价 == 套餐价 → 不说「省」（假划线价比不划线更伤信任）',
)
// 套餐没有内容是**异常**状态：整段消失会让模型自己编「包含什么」
check(
  formatComboInfo({ kind: 'COMBO', priceFen: 8800, originalPriceFen: null, comboItems: [] }).includes('还没有填'),
  '明细为空 → 明确说「还没有填」，而不是让这一段消失（否则模型会编出不存在的菜）',
)
check(
  formatComboInfo({
    kind: 'COMBO',
    priceFen: 8800,
    originalPriceFen: null,
    comboItems: [{ quantity: 1, dish: { name: '已删菜', deletedAt: new Date() } }],
  }).includes('还没有填'),
  '明细全指向已删菜 → 同样按「还没有填」处理',
)
// 没有价格时不要凭空造一个「套餐价 ¥0」
check(
  !formatComboInfo({ kind: 'COMBO', priceFen: null, originalPriceFen: null, comboItems: [{ quantity: 1, dish: { name: '米饭', deletedAt: null } }] }).includes('¥'),
  '套餐价为空 → 整段不提价格（而不是写出「套餐价 ¥0」）',
)

// ──────────────────────── ④ 真实数据链路（需要数据库） ────────────────────────
section('④ 真实数据链路：临时门店 → buildVariables → 渲染')

/** 造一家临时门店：intro / persona 由参数决定，返回所需 id */
async function makeStore(
  merchantId: bigint,
  tag: string,
  intro: string | null,
  persona: { bossTags: string | null; activity: string | null } | null,
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
    // 菜品稿三款之一：流量款已拆成话题稿（mode='TOPIC'），不再是菜品稿的款式
    track: 'INTRO',
    complexity: 'COMPLEX',
  })
  await prisma.creation.update({ where: { id: creation.id }, data: { copyText: '测试用口播文案正文' } })
  return { storeId: store.id, dishId: dish.id, creationId: creation.id }
}

const INTRO = '开了十二年的老川菜馆，招牌是每天现炒的辣子鸡。'
const BOSS_TAGS = '90后老板 / 退伍军人'
const ACTIVITY = '开业酬宾 8 折'
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
    const full = await makeStore(merchantId, 'full', INTRO, { bossTags: BOSS_TAGS, activity: ACTIVITY })
    const v = await buildVariables(prisma, full.creationId, { track: 'INTRO' })
    check(v.storeIntro === INTRO, 'buildVariables 产出了门店介绍', `storeIntro=${JSON.stringify(v.storeIntro).slice(0, 40)}`)
    check(
      v.persona === `老板人设标签：${BOSS_TAGS}；最近想重点告诉顾客：${ACTIVITY}`,
      'buildVariables 产出的门店人设带标签',
      v.persona,
    )
    check(v.dishName === '契约测试菜品-full', '菜品名称仍在变量里')
    check(v.sellingPoints === '分量实在 / 价格透明', '菜品卖点仍在变量里')

    // 渲染一次真模板，确认值真的落到了提示词里（而不只是变量对象里有）
    const rendered = renderTemplate(COPY_INTRO_PROMPT, v as unknown as Record<string, string>)
    check(rendered.includes(INTRO), '渲染后提示词含门店介绍正文')
    check(rendered.includes(BOSS_TAGS) && rendered.includes(ACTIVITY), '渲染后提示词含门店人设两字段')
    check(!rendered.includes('{{'), '渲染后提示词已无残留占位符', rendered.match(/\{\{[^}]*\}\}/g)?.join('、') ?? '')
    check(rendered.includes('【门店介绍】'), '提示词保留了【门店介绍】段落标题')

    // ★ 4.1b 套餐链路：光测纯函数只能验格式，「include 有没有真把 comboItems 读出来」
    //   只有连库才测得到 —— 漏了 include 的话 comboInfo 会静默变成「（门店还没有填具体菜品）」，
    //   而那句提示看起来完全合理，没人会怀疑是代码没读。
    const comboStore = await prisma.store.create({
      data: { merchantId, name: '契约测试门店-combo', category: '川菜', city: '济南' },
    })
    const memberA = await prisma.dish.create({ data: { storeId: comboStore.id, name: '套餐里的辣子鸡' } })
    const memberB = await prisma.dish.create({ data: { storeId: comboStore.id, name: '套餐里的米饭' } })
    const combo = await prisma.dish.create({
      data: { storeId: comboStore.id, name: '契约测试套餐', kind: 'COMBO', priceFen: 8800, originalPriceFen: 12000 },
    })
    await prisma.dishComboItem.createMany({
      data: [
        { comboId: combo.id, dishId: memberA.id, quantity: 1, sort: 0 },
        { comboId: combo.id, dishId: memberB.id, quantity: 2, sort: 1 },
      ],
    })
    const comboCreation = await createCreation(prisma, merchantId, {
      storeId: comboStore.id,
      dishId: combo.id,
      track: 'INTRO',
      complexity: 'COMPLEX',
    })
    const vCombo = await buildVariables(prisma, comboCreation.id, { track: 'INTRO' })
    check(vCombo.dishName === '契约测试套餐', '选套餐时 dishName 就是套餐名（复用同一张表的直接收益）')
    check(
      vCombo.comboInfo.includes('套餐里的辣子鸡') && vCombo.comboInfo.includes('套餐里的米饭×2'),
      'buildVariables 真的读出了套餐明细（漏 include 会静默退化成「还没有填」）',
      vCombo.comboInfo,
    )
    check(vCombo.comboInfo.includes('¥88') && vCombo.comboInfo.includes('省 ¥32'), '套餐价与优惠额进了变量')
    const renderedComboCopy = renderTemplate(COPY_INTRO_PROMPT, vCombo as unknown as Record<string, string>)
    const renderedComboStory = renderTemplate(STORY_PROMPT, vCombo as unknown as Record<string, string>)
    check(
      renderedComboCopy.includes('套餐里的辣子鸡') && renderedComboCopy.includes('¥88'),
      '文案提示词里出现了套餐内容与价格',
    )
    // 分镜那一侧也要吃到：文案与分镜是两次独立调用，漏一个就等于「只有文案知道这是套餐」
    check(
      renderedComboStory.includes('套餐里的辣子鸡') && renderedComboStory.includes('¥88'),
      '分镜提示词里同样出现了套餐内容与价格',
    )
    check(!renderedComboCopy.includes('{{') && !renderedComboStory.includes('{{'), '套餐场景渲染后无残留占位符')
    // 反向：上面 4.1 那家门店关联的是**单菜**，它的 comboInfo 必须是空串，
    // 否则每道炒菜的提示词里都会挂一句「套餐价」，模型会把单菜写成套餐
    check(v.comboInfo === '', '★ 单菜门店的 comboInfo 是空串（反向：单菜不该带套餐信息）')

    // 4.2 什么都没有的门店：介绍为空串、人设为空串（模板会留下一行空标题，这是可接受的）
    const bare = await makeStore(merchantId, 'bare', null, null)
    const v2 = await buildVariables(prisma, bare.creationId, { track: 'INTRO' })
    check(v2.storeIntro === '', '未填门店介绍 → storeIntro 为空串（不会变成 undefined）')
    check(v2.persona === '', '未填人设 → persona 为空串（不留空标签）')
    const rendered2 = renderTemplate(COPY_INTRO_PROMPT, v2 as unknown as Record<string, string>)
    check(!rendered2.includes('老板人设标签：') && !rendered2.includes('最近想重点告诉顾客：'), '渲染后不出现空的人设标签')
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

    // 4.5 ★★ 话题稿（流量款独立功能）：`mode='TOPIC'` 的真实链路。
    //     这一段是本次拆分的核心验收 —— 它要同时证明四件事：
    //       ① 不传门店也能创建（宿主门店由服务端解析）
    //       ② 门店/菜品相关变量**全是空串**（话题稿不喂它们）
    //       ③ topicInfo 真的进了提示词，且城市只在用户填了的时候才出现
    //       ④ 传了门店/菜品会被拒（不是静默忽略）
    const topicCreation = await createCreation(prisma, merchantId, {
      mode: 'TOPIC',
      complexity: 'COMPLEX',
      topicCity: '廊坊',
    })
    check(
      topicCreation.mode === 'TOPIC' && topicCreation.track === TOPIC_TRACK,
      '话题稿创建成功：mode=TOPIC 且款式被强制成流量款',
      `mode=${topicCreation.mode} track=${topicCreation.track}`,
    )
    check(
      topicCreation.dishId === null && topicCreation.storeId !== null,
      '话题稿没有菜品，但挂了一家宿主门店（媒体归属要用）',
    )
    const vTopic = await buildVariables(prisma, topicCreation.id, {})
    check(
      vTopic.storeName === '' && vTopic.storeIntro === '' && vTopic.city === '' && vTopic.dishName === '',
      '★ 话题稿的门店/菜品变量全为空串（不喂进提示词）',
      `storeName=${JSON.stringify(vTopic.storeName)} city=${JSON.stringify(vTopic.city)} dishName=${JSON.stringify(vTopic.dishName)}`,
    )
    check(vTopic.comboInfo === '' && vTopic.persona === '', '话题稿的套餐信息与人设也是空串')
    check(vTopic.mode === 'TOPIC', 'buildVariables 带出了内容模式')
    check(vTopic.topicInfo.length > 0, '话题稿拿到了 topicInfo（今天 + 起头方向）')
    const renderedTopic = renderTemplate(COPY_TRAFFIC_PROMPT, vTopic as unknown as Record<string, string>)
    check(renderedTopic.includes('廊坊'), '填了同城落点 → 提示词里带出城市')
    check(!renderedTopic.includes('{{'), '话题稿渲染后无残留占位符')
    check(
      !renderedTopic.includes('契约测试门店') && !renderedTopic.includes('契约测试菜品'),
      '★ 话题稿的提示词里**不出现**任何门店名与菜名',
    )

    // 没填城市时不该硬塞一个
    const noCity = await createCreation(prisma, merchantId, { mode: 'TOPIC', complexity: 'SIMPLE' })
    // 城市读**创建行**上的快照（buildVariables 不返回它 —— 它只喂进 topicInfo）
    check(noCity.topicCity === null, '未填同城落点 → 落库为 null（不是空串）')
    check(
      !(await buildVariables(prisma, noCity.id, {})).topicInfo.includes('城市：'),
      '未填同城落点 → topicInfo 里不出现「城市：」行',
    )

    // 调用方给话题稿传门店/菜品必须被拒（静默忽略会让「以为按门店生成了」长期藏着）
    let forbidden: unknown = null
    try {
      await createCreation(prisma, merchantId, { mode: 'TOPIC', storeId: full.storeId })
    } catch (e) {
      forbidden = e
    }
    check(
      forbidden !== null && (forbidden as Error).name === 'TopicCreationStoreForbiddenError',
      '话题稿传 storeId 被拒（不是静默忽略）',
      (forbidden as Error)?.name ?? '没有抛错',
    )

    // ★ 反向：菜品稿**不许**走流量款。存量数据里有 25 条 track='TRAFFIC' 的菜品稿，
    //   而流量款模板已经不喂门店/菜品 —— 不兜底就会生成一条只字不提门店的稿子且不报错。
    const legacyish = await createCreation(prisma, merchantId, {
      storeId: full.storeId,
      dishId: full.dishId,
      mode: 'DISH',
    })
    await prisma.creation.update({ where: { id: legacyish.id }, data: { track: 'TRAFFIC' } })
    const vLegacy = await buildVariables(prisma, legacyish.id, { track: 'TRAFFIC' as never })
    check(
      vLegacy.storeName !== '' && vLegacy.dishName !== '',
      '★ 菜品稿即便 track=TRAFFIC，变量里仍有门店与菜品（生成时会走菜品款模板）',
    )

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
      // 套餐明细先删（虽然外键 CASCADE 也会兜住，但显式删让清理顺序一眼可读）
      await prisma.dishComboItem.deleteMany({ where: { combo: { storeId: { in: storeIds } } } })
      await prisma.dish.deleteMany({ where: { storeId: { in: storeIds } } })
      await prisma.persona.deleteMany({ where: { storeId: { in: storeIds } } })
      await prisma.store.deleteMany({ where: { merchantId } })
      await prisma.merchant.delete({ where: { id: merchantId } })
      const left = await prisma.merchant.count({ where: { phone: PHONE } })
      check(left === 0, '临时商户已清理干净', `残留 ${left}`)
    }
  }
}

// ──────────────────────── ⑤ 日期 / 节气 / 节日（纯函数，不连库） ────────────────────────
section('⑤ 日期与节点变量：模型唯一的时间来源')

const at = (s: string) => new Date(s)
const info = (s: string) => formatDateInfo(at(s))

// 5.1 形态：恰好两行、第一行是「今天是 …」、没有残留占位符。
//     ★「永远非空」是这个变量的硬约束：模板里那一行渲染成空串，模型就退回瞎编状态。
for (const s of ['2026-09-20T09:00:00+08:00', '2026-12-31T23:30:00+08:00', '2027-02-05T09:00:00+08:00']) {
  const t = info(s)
  check(t.split('\n').length === 2, `${s.slice(0, 10)} 输出恰好两行`, JSON.stringify(t))
  check(t.startsWith('今天是 '), `${s.slice(0, 10)} 第一行以「今天是」开头`)
  check(!t.includes('{{'), `${s.slice(0, 10)} 输出里没有残留占位符`)
}

// 5.2 已知日期必须看到已知节点（下面这些值是实跑核对过的，改公式会当场红）
const todayInfo = info('2026-09-20T09:00:00+08:00')
check(todayInfo.includes('2026-09-20（星期日）'), '2026-09-20 认得出是星期日', todayInfo)
check(todayInfo.includes('9月23日 秋分'), '看得到 3 天后的秋分（寿星公式）')
check(todayInfo.includes('9月25日 中秋节'), '看得到 5 天后的中秋节（农历表）')
check(todayInfo.includes('10月1日 国庆节'), '看得到国庆节（公历表）')

// 5.3 节点就在当天时写「就是今天」，不能写成「0 天后」
check(
  info('2026-02-16T09:00:00+08:00').includes('除夕（就是今天）'),
  '节点就在当天时写「就是今天」',
  info('2026-02-16T09:00:00+08:00'),
)

// 5.4 ★★ 时区：同一时刻用 UTC 写法必须落到次日。
//     这条钉的是「显式按 Asia/Shanghai 取值」—— 线上 Ubuntu 默认 UTC，
//     若改用 new Date() 的本地字段，北京时间 00:00~08:00 会整体差一天（除夕当天写成「明天除夕」），
//     而且**没有任何报错**。这是本仓唯一一处对时区敏感的地方。
check(
  info('2026-06-19T23:30:00+08:00').includes('2026-06-19') && info('2026-06-19T16:30:00Z').includes('2026-06-20'),
  '按 Asia/Shanghai 取日期：同一时刻写成 UTC 会落到次日',
)

// 5.5 跨年：12 月下旬要能看到明年 1 月 1 日的元旦
//     （只扫当年会有半个月空窗期，而那正好是餐饮最忙的跨年档）
check(info('2026-12-28T09:00:00+08:00').includes('元旦'), '年末能看到跨年的元旦')

// 5.6 ★ 农历节日表的过期告警。表用完了**不会报错**，只会静静地少掉春节/中秋这些最重要的节点。
//     下面这条**会随时间自己变红** —— 红的那天就是「该补表了」，**不要把它注释掉**。
const thisYear = shanghaiYmd(new Date()).year
check(
  LUNAR_FESTIVAL_MAX_YEAR >= thisYear,
  `农历节日表覆盖到 ${LUNAR_FESTIVAL_MAX_YEAR} 年（今年 ${thisYear}）`,
  LUNAR_FESTIVAL_MAX_YEAR < thisYear
    ? '★ 表已过期：去 src/lib/festival.ts 补春节/中秋等日期（逐个查万年历，不许照抄往年）'
    : '',
)

// 5.7 节气公式回验：钉住几个公认的 2026 年节气日期（公式是近似，±1 天可接受，所以这里用精确值兜底）
const termAt = (name: string) => upcomingNodes(at('2026-01-01T09:00:00+08:00'), 400).find((n) => n.name === name)
const TERM_CASES: Array<[string, number, number]> = [
  ['立春', 2, 4],
  ['春分', 3, 20],
  ['夏至', 6, 21],
  ['立秋', 8, 7],
  ['秋分', 9, 23],
  ['冬至', 12, 22],
]
for (const [name, m, d] of TERM_CASES) {
  const n = termAt(name)
  check(n?.month === m && n?.day === d, `2026 年${name}落在 ${m} 月 ${d} 日`, `实得 ${n?.month} 月 ${n?.day} 日`)
}

// 5.8 模板侧：菜品稿引用 {{dateInfo}}；话题稿引用 {{topicInfo}}（它的第一段就是 dateInfo 的内容）。
//     「跟上节假日」这条要求对每一款都必须成立，只是来源不同 —— 不存在某一款没有时间来源。
for (const t of dishTemplates) {
  check(t.tpl.includes('{{dateInfo}}'), `${t.label} 引用了日期与节点 {{dateInfo}}`)
}
for (const t of topicTemplates) {
  check(t.tpl.includes('{{topicInfo}}'), `${t.label} 引用了话题信息 {{topicInfo}}`)
  check(
    !t.tpl.includes('{{dateInfo}}'),
    `${t.label} 不重复引用 {{dateInfo}}（topicInfo 第一段就是它，两处都引用会让同一天出现两遍）`,
  )
}
// 兜底一律不引用日期 / 话题类变量：它是静态文案、拿不到真实日期，写了只会让模型编一个节日出来
for (const t of TEMPLATES) {
  check(
    !t.fallback.includes('{{dateInfo}}') && !t.fallback.includes('{{topicInfo}}'),
    `${t.label} 兜底不引用日期 / 话题变量（静态文案拿不到真实日期，只会编一个节日出来）`,
  )
}
check(
  findUnknownPlaceholders('copy_intro', '{{dateInfo}}').length === 0 &&
    findUnknownPlaceholders('storyboard_generate', '{{dateInfo}}').length === 0,
  'dateInfo 已在菜品文案与分镜两个场景的白名单里',
)
check(
  findUnknownPlaceholders('copy_traffic', '{{topicInfo}}').length === 0 &&
    findUnknownPlaceholders('copy_intro', '{{topicInfo}}').length === 1,
  'topicInfo 只在话题场景的白名单里（菜品稿引用不到它）',
)

// 5.9 口语化铁律：必须挂在 5 个文案模板上，且**不许**挂到分镜上。
//     分镜输出 JSON、line 要逐字照抄文案，而铁律第 1 条是「念着别扭就重写」——
//     挂上去反而会诱导它改写文案，与「逐字照抄」自相矛盾。
for (const t of TEMPLATES.filter((x) => x.code.startsWith('copy_'))) {
  check(t.tpl.includes('【口语化铁律'), `${t.label} 挂了口语文铁律`)
}
check(
  !TEMPLATES.find((t) => t.code === 'storyboard_generate')!.tpl.includes('【口语化铁律'),
  '分镜**不**挂口语化铁律（与「逐字照抄」冲突）',
)

// 5.10 流量款（话题稿）这一版的核心改动：靠 topicInfo 起头、不再提门店与菜品、不许编新闻
const traffic = TEMPLATES.find((t) => t.code === 'copy_traffic')!
const trafficTpl = traffic.tpl
check(trafficTpl.includes('{{topicInfo}}'), '流量款靠 {{topicInfo}} 拿「今天」与起头方向')
check(trafficTpl.includes('挑一条'), '流量款要求「只挑一条」起头方向（不许写成排比）')
check(trafficTpl.includes('不要几条都用上'), '流量款写明「不要几条都用上」')
check(
  trafficTpl.includes('不要报店名') && trafficTpl.includes('不要请人到店'),
  '流量款不收在到店邀请上（话题稿不涉及门店）',
)
check(
  trafficTpl.includes('不许') && trafficTpl.includes('热搜') && trafficTpl.includes('政策'),
  '流量款禁止编造新闻/热搜/明星/政策（没有新闻源，编了就是假热点）',
)
check(
  !trafficTpl.includes('{{storeName}}') && !trafficTpl.includes('{{dishName}}'),
  '★ 流量款不引用门店名与菜名（话题稿没有它们）',
)
check(!traffic.fallback.includes('{{'), '★ 流量款兜底是零占位符的静态句（变量全空时不会渲染出半句话）')
check(
  Object.keys(CONTENT_MODES).length === 2 && CONTENT_MODES.TOPIC.label.length > 0,
  '内容模式注册表含 DISH / TOPIC 两种',
)

// 5.11 分镜这一版的核心改动：台词逐字照抄 + 一个人能拍完 + 对空值稳健
const story = TEMPLATES.find((t) => t.code === 'storyboard_generate')!
const storyTpl = story.tpl
check(storyTpl.includes('逐字') && storyTpl.includes('一字不差'), '分镜要求 line 逐字照抄、拼回原文一字不差')
check(storyTpl.includes('一个人') && storyTpl.includes('航拍'), '分镜写明「一个人能拍完」并列出禁用设备')
// ★ 分镜在两个入口共用（菜品稿 / 话题稿），只有写清空值的含义才能一份模板两用而不漂移
check(
  storyTpl.includes('不要替它编造'),
  '★ 分镜写明「某项为空 = 这条视频不涉及它，不要替它编造」（话题稿的常态）',
)
check(
  storyTpl.includes('纯话题视频'),
  '★ 分镜区分了纯话题视频：门店/菜品全空时画面不该出现店名、招牌、菜品特写',
)
// ★ 旧版兜底引用了 {{dishName}}/{{city}}/{{storeName}}，那三个变量在话题稿里全是空串，
//   渲染出来就是「，现做现卖」「就在」这种半句话 —— 一条模板要同时服务两种稿子就不能依赖它们。
const storyFb = story.fallback
check(
  storyFb.includes('{{copyText}}') &&
    !storyFb.includes('{{dishName}}') &&
    !storyFb.includes('{{storeName}}') &&
    !storyFb.includes('{{city}}'),
  '★ 分镜兜底只引用 {{copyText}}（门店/菜品变量在话题稿里是空串，会渲染成半句话）',
)
check(
  (storyFb.match(/"line":/g) ?? []).length === 1,
  '★ 分镜兜底是单镜（line 只有一条 ⇒ 所有 line 拼起来必然等于原文）',
)

// ──────────────────────── ⑥ 话题方向库（纯函数，不连库） ────────────────────────
section('⑥ 话题方向库：同一天稳定、隔天轮换、只让 14 天内的节点抢头条')

// 6.1 ★ 同一天两次调用必须**完全一致**：库里绝对不能引入随机数。
//     用户点「重新生成」时如果方向变了，他会以为「话题变了」，而实际上只是我们抖了一次骰子。
const day1 = topicDirections(at('2026-09-20T09:00:00+08:00'))
const day1b = topicDirections(at('2026-09-20T09:00:00+08:00'))
check(JSON.stringify(day1) === JSON.stringify(day1b), '同一天两次调用结果完全一致（无随机）')

// 6.2 数量：太少就永远同一句，太多模型会挑花眼
check(day1.length >= 2 && day1.length <= 4, `方向数落在 2~4 条之间（实得 ${day1.length}）`, day1.join(' ｜ '))

// 6.3 去重：节点方向与时令方向可能撞句，输出里不许有重复
check(new Set(day1).size === day1.length, '输出里没有重复方向')

// 6.4 节点驱动生效：2026-09-20 距中秋 5 天，必须给得出中秋那组里的方向。
//     ⚠ 断言用「中秋 | 月饼」而不是只认「中秋」二字：组内是按天轮转取一条的，
//       那天抽到的是「月饼现在还有人抢着买吗」。日期是钉死的，轮转结果因此是确定的，
//       所以这个并集写死不会 flaky；反过来只认「中秋」就会误判成没给。
check(day1.some((x) => x.includes('中秋') || x.includes('月饼')), '中秋前 5 天给出了中秋那组的方向', day1.join(' ｜ '))

// 6.5 ★ 窗口边界：只让 14 天内的节点抢头条。
//     2026-10-20 最近的节点是 3 天后的霜降（10/23），立冬在 11/7（18 天后）——
//     18 > 14 ⇒ 立冬那条方向**不许**出现。这条会随 WINDOW/窗口常量的改动而变红，是刻意的。
const oct = topicDirections(at('2026-10-20T09:00:00+08:00'))
check(oct.some((x) => x.includes('降温第一天')), '10-20 给出 3 天后霜降的方向', oct.join(' ｜ '))
check(!oct.includes('立冬这天该吃点扎实的'), '★ 18 天后的立冬没有抢头条（14 天窗口生效）')

// 6.6 隔天轮换：同一季节相邻两天的方向不应完全一样，否则一个月里天天同一句
const day2 = topicDirections(at('2026-09-21T09:00:00+08:00'))
check(JSON.stringify(day1) !== JSON.stringify(day2), '相邻两天的方向不同（按天轮换生效）')

// 6.7 渲染形态：首行是日期、带编号列表、无残留占位符、且**永远非空**
const ti = (s: string, city = '') => formatTopicInfo(at(s), city)
for (const when of ['2026-09-20T09:00:00+08:00', '2026-01-05T09:00:00+08:00', '2027-03-01T09:00:00+08:00']) {
  const t = ti(when)
  check(t.startsWith('今天是 '), `${when.slice(0, 10)} topicInfo 以「今天是」开头`)
  check(t.includes('1. '), `${when.slice(0, 10)} topicInfo 带编号的起头方向`)
  check(t.includes('不要编造新闻'), `${when.slice(0, 10)} topicInfo 带「不许编造新闻」的禁令`)
  check(!t.includes('{{'), `${when.slice(0, 10)} topicInfo 无残留占位符`)
  check(t.length > 30, `${when.slice(0, 10)} topicInfo 非空且有实质内容（${t.length} 字符）`)
}

// 6.8 城市：填了才出现；**空白字符视同没填**（与输入 trim 契约同一口径）
check(ti('2026-09-20T09:00:00+08:00', '廊坊').includes('城市：廊坊'), '填了城市 → 出现「城市：廊坊」')
check(!ti('2026-09-20T09:00:00+08:00').includes('城市：'), '没填城市 → 不出现「城市：」行')
check(!ti('2026-09-20T09:00:00+08:00', '   ').includes('城市：'), '★ 城市只填空白字符 → 视同没填（不许出现空的城市行）')
check(
  ti('2026-09-20T09:00:00+08:00', '廊坊').includes('不要编造具体街道'),
  '带城市时同时禁止编造具体街道/店名（有城市不等于可以编门店）',
)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exitCode = 1
await prisma.$disconnect()
