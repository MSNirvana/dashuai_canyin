/**
 * 量一条真创作「报出菜名」率的探针 —— 改文案提示词之后用它拿数据说话。
 *
 * 背景（2026-09-29）：用户报「选了锅巴土豆，出来的文案一个字都没提它」。
 * 生产 `ai_call_log id=163` 的提示词里，模型看到的是：
 *
 *     【菜品】锅巴土豆（空 = 这次没选具体菜品，下面两行也一起为空：不要编造菜名、价格或做法，
 *     改讲门店本身；门店资料也一起空着就写短一点，别拿别家店的常见做法补上）
 *     【菜品简介】孩子必点
 *     【卖点】外酥里嫩 香香脆脆
 *
 * 菜名后面**紧挨着**一段「空 = 没选菜 ⇒ 改讲门店本身」的说明 —— 而它被无条件打印出来了。
 * 模型于是把「这道菜=锅巴土豆」和「改讲门店本身」同时读进了上下文，最终逐句改写了【门店介绍】。
 *
 * ★ 本脚本按**线上模板是哪一版**自动选跑法（判据就是模板里有没有 {{dishEmptyNote}}）：
 *   · 旧版 ⇒ 三臂对比，用来**定修法**：
 *       A 现状      —— 线上模板原样
 *       C 去矛盾    —— 行内注解换成 {{dishEmptyNote}}（有值时为空串）
 *       E 全条件化  —— C + 硬约束段里「菜品为空 ⇒ 改讲门店本身」那条、以及脚注里对它的引用
 *                      也一并由变量控制（有值时全部不出现）
 *     ★ C/E 在**菜品为空**时与 A 逐字一致 ⇒ 本改动不动空值那条路径的行为。
 *   · 新版 ⇒ 只跑现状臂，量的是**修复后线上的真实表现**。
 *
 * ★ 实测（creation #57，真门店 216 字介绍 + 锅巴土豆，deepseek-v4-flash、temp 0.8、每臂 12 次）：
 *     A 现状（注解无条件打印）  报出菜名 **9/12 = 75%**｜门店特征词均值 3.3
 *     C 去矛盾（已采用）        报出菜名 **11/12 = 92%**｜门店特征词均值 **1.6**
 *     E 全条件化（**被否掉**，比 C 更差）10/12 = 83% ⇒ 硬约束段里「菜品为空」那条**必须留着**
 *   ⇒ 结论：只把那句自相矛盾的文本从「有值」的路径上拿掉。
 *   上线后用本脚本复量同一创作：**12/12 = 100%**、门店特征词均值 **0.2**。
 *
 * 零计费：直调 `getAdapter`，不经过网关的计费/账本，也不写 `ai_call_log`
 * （只真花上游的 token 钱，一次约 ¥0.03）。
 *
 * 用法（在 server/ 下跑；要量线上就得在服务器上跑，本机打的是本地库）：
 *   npx tsx scripts/probe-copy-dish-mention.ts 57            # creation #57，每臂 10 次
 *   npx tsx scripts/probe-copy-dish-mention.ts 57 12
 * ⚠ creation 必须**选了菜**（脚本会断言 dishName 非空），否则量不出任何东西。
 * ⚠ 跑完务必 disconnect + exit。脚本**不改库**（只读 ai_scene）。
 */
import 'dotenv/config'
import { prisma } from '../src/db.js'
import { getAdapter } from '../src/ai/adapters.js'
import { decryptSecret } from '../src/lib/secret.js'
import { LOW_REASONING_SCENES } from '../src/ai/scene-codes.js'
import { buildVariables } from '../src/services/creation.service.js'

const creationId = BigInt(process.argv[2] ?? '57')
const N = Number(process.argv[3] ?? '10')
const SCENE = 'copy_product'

/** 门店特征词 —— 命中越多，说明这篇越是在讲门店而不是那道菜（用同一条门店介绍里的事实词） */
const STORE_WORDS = [
  '开好背', '虾线', '一锅两吃', '涮菜', '涮肉', '现抻', '面条', '微辣', '五香', '番茄',
  '麻辣', '大圆桌', '小桌', '护手霜', '创可贴', '服务承诺', '明明白白', '人均', '全国连锁', '宝德', '聚餐',
]

/** 三处「空值语义」锚点（都取自线上模板原文，必须逐字命中；命中不了就当场退出） */
const RE_ANNOT = /（空 = 这次没选具体菜品[\s\S]*?补上）/
const RE_BULLET = /- ★ \*\*菜品资料为空时[\s\S]*?（空值语义见上面的【菜品】）/
const RE_FOOTREF = /这时上面那句「改讲门店本身」\*\*不适用\*\*，/

function must(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`\n✗ 前置断言失败：${msg}`)
    console.error('   （锚点变过就把正则一起改，否则三臂会拿同一份模板跑，结论是空的）')
    process.exit(1)
  }
}

/** 抽出模板里含某段文字的那一行，用于打印「模型到底看到什么」 */
function lineOf(tpl: string, needle: string): string {
  const line = tpl.split('\n').find((l) => l.includes(needle))
  return line ?? '(模板里没有这一行)'
}

;(async () => {
  const scene = await prisma.aiScene.findUnique({ where: { code: SCENE } })
  must(scene && scene.enabled, `场景 ${SCENE} 不存在或已停用`)
  const A = scene.promptTemplate

  const vars0 = (await buildVariables(prisma, creationId)) as unknown as Record<string, string>
  const dishName = String(vars0.dishName ?? '')
  const storeName = String(vars0.storeName ?? '')
  console.log(`创作 #${creationId}｜门店：${storeName}｜菜品：${dishName || '(空)'}`)
  must(storeName, '这条创作的门店变量是空的 —— 拿它做 A/B 没有意义')
  must(dishName, '这条创作的菜品变量是空的 —— 本脚本验的就是「有菜名时」的情形')
  console.log(`门店介绍 ${String(vars0.storeIntro ?? '').length} 字｜菜品简介「${vars0.dishIntro}」｜卖点「${vars0.sellingPoints}」`)

  /**
   * ★ 两种跑法，按**线上模板是哪一版**自动选（判据就是模板里有没有那个变量，不靠人记得加参数）：
   *   · 旧版（空值注解还写死在 {{dishName}} 后面）⇒ 三臂对比，用来**定修法**；
   *   · 新版（已改成 {{dishEmptyNote}}）⇒ 只跑现状臂，量的是**修复后线上真实表现**。
   */
  const isFixed = A.includes('{{dishEmptyNote}}')

  const arms: { key: string; tpl: string; extra: Record<string, string>; note: string }[] = []

  if (isFixed) {
    console.log('\n★ 线上模板已是新版（含 {{dishEmptyNote}}）⇒ 只跑现状臂，量的是修复后的真实表现')
    arms.push({ key: 'A 现状', tpl: A, extra: {}, note: '线上原样（已修）' })
  } else {
    // ── 三处锚点必须逐字命中 ──────────────────────────────────────────────
    const mAnnot = A.match(RE_ANNOT)
    const mBullet = A.match(RE_BULLET)
    const mFootref = A.match(RE_FOOTREF)
    must(mAnnot, `模板里找不到行内空值注解 RE_ANNOT`)
    must(mBullet, `模板里找不到硬约束段的空值条 RE_BULLET`)
    must(mFootref, `模板里找不到脚注里对「改讲门店本身」的引用 RE_FOOTREF`)
    const annotText = mAnnot[0]
    const bulletText = mBullet[0]
    const footrefText = mFootref[0]
    console.log(`\n命中三处锚点：注解 ${annotText.length} 字｜硬约束条 ${bulletText.length} 字｜脚注引用 ${footrefText.length} 字`)

    // ── 造出 C / E 两臂的模板（只在锚点上做替换；其余逐字不动） ───────────
    const C = A.replace(RE_ANNOT, '{{dishEmptyNote}}')
    const E = C.replace(RE_BULLET, '{{dishEmptyRule}}').replace(RE_FOOTREF, '{{dishEmptyRef}}')
    must(C !== A, 'C 臂模板与 A 完全相同 —— 替换没生效')
    must(E !== C, 'E 臂模板与 C 完全相同 —— 替换没生效')
    // 反向：C 必须仍然包含【菜品简介】/【卖点】两行（别把别的行一起吃了）
    must(C.includes('【菜品简介】{{dishIntro}}') && C.includes('【卖点】{{sellingPoints}}'), 'C 臂误删了相邻两行')
    must(E.includes('★★★ **只要【菜品】一节有内容'), 'E 臂误删了「必须讲这道菜」那条约束')

    arms.push(
      { key: 'A 现状', tpl: A, extra: {}, note: '线上原样' },
      {
        key: 'C 去矛盾',
        tpl: C,
        extra: { dishEmptyNote: annotText },
        note: '有值时行内注解不出现',
      },
      {
        key: 'E 全条件化',
        tpl: E,
        extra: { dishEmptyNote: annotText, dishEmptyRule: bulletText, dishEmptyRef: footrefText },
        note: '有值时三处空值文本全不出现',
      },
    )
  }

  console.log('\n─── 各臂的【菜品】行（模型第一眼看到的东西） ───')
  for (const a of arms) console.log(`${a.key}｜${lineOf(a.tpl, '【菜品】')}`)
  console.log('─'.repeat(78) + '\n')

  // ── 生产调用参数（逐字对齐 gateway.runScene 的构造） ────────────────────
  const model = await prisma.aiModel.findUnique({ where: { id: scene.defaultModelId }, include: { provider: true } })
  must(model && model.enabled && model.provider, `默认候选模型 id=${scene.defaultModelId} 不可用`)
  must(model.capability !== 'IMAGE', '文案场景的候选不能是图像模型')
  const adapter = getAdapter(model.provider.protocol)
  const callOpts = {
    baseUrl: model.provider.baseUrl,
    apiKey: decryptSecret(model.provider.apiKeyEncrypted),
    model: model.modelCode,
    temperature: scene.temperature ? Number(scene.temperature) : undefined,
    maxOutputTokens: scene.maxOutputTokens ?? undefined,
    reasoningEffort: LOW_REASONING_SCENES.has(SCENE) ? ('low' as const) : undefined,
    timeoutMs: scene.timeoutMs,
    sceneCode: SCENE,
  }
  console.log(
    `通道 ${model.provider.code}/${model.modelCode}｜temp=${callOpts.temperature}｜maxTokens=${callOpts.maxOutputTokens}` +
      `｜reasoning=${callOpts.reasoningEffort}｜timeout=${callOpts.timeoutMs}ms｜每臂 ${N} 次\n`,
  )

  const render = (tpl: string, extra: Record<string, string>) =>
    tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => extra[k] ?? vars0[k] ?? '')

  const results: Record<string, { hit: number; n: number; words: number[]; texts: string[] }> = {}
  for (const a of arms) results[a.key] = { hit: 0, n: 0, words: [], texts: [] }

  // ★ 轮转跑（A→C→E→A→C→E…），而不是一臂跑完再跑下一臂：
  //   上游的时延/负载在几分钟里会漂，集中跑会让「后跑的那臂」系统性吃亏。
  for (let i = 0; i < N; i++) {
    for (const a of arms) {
      const prompt = render(a.tpl, a.extra)
      const t0 = Date.now()
      let text = ''
      try {
        const r = await adapter({ ...callOpts, user: prompt })
        text = r.text.trim()
      } catch (e) {
        console.log(`  ${a.key} 第${i + 1}次 ✗ ${(e as Error).message.slice(0, 120)}`)
        continue
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      const words = STORE_WORDS.filter((w) => text.includes(w)).length
      const hit = text.includes(dishName)
      const st = results[a.key]!
      st.n++
      if (hit) st.hit++
      st.words.push(words)
      st.texts.push(text)
      console.log(`  ${a.key} 第${i + 1}次 ${secs}s｜报菜名 ${hit ? '是' : '否'}｜门店词 ${words}｜${text.slice(0, 34)}…`)
    }
  }

  console.log('\n' + '='.repeat(78))
  console.log(`结论（创作 #${creationId}，菜品「${dishName}」，每臂 ${N} 次）`)
  console.log('='.repeat(78))
  for (const a of arms) {
    const st = results[a.key]!
    const rate = st.n ? Math.round((st.hit / st.n) * 100) : 0
    const avgW = st.words.length ? (st.words.reduce((x, y) => x + y, 0) / st.words.length).toFixed(1) : '-'
    console.log(`${a.key.padEnd(10)} 报出菜名 ${st.hit}/${st.n}（${rate}%）｜门店特征词均值 ${avgW}  ← ${a.note}`)
  }

  for (const a of arms) {
    console.log(`\n─── ${a.key} 的输出 ───`)
    results[a.key]!.texts.forEach((t, idx) => console.log(`${idx + 1}. ${t}\n`))
  }

  await prisma.$disconnect()
  process.exit(0)
})()
