/**
 * 「选了菜，就得讲这道菜」这条链路的契约测试。
 *
 * 为什么单独一个脚本：这条链路上有三个**互不报错**的静默失效点，各钉一遍才安全：
 *   ① 判据（`mentionsDish`）判错 —— 太严 ⇒ 正常的稿子被判不合格、白花一次调用；
 *      太松 ⇒ 跑偏的稿子被判合格、兜底形同虚设。
 *   ② 名单（`DISH_MENTION_SCENES`）与模板里那条硬约束**不同步** ——
 *      名单里多一个场景 ⇒ 代码在强制一件模板没要求的事，重试必然失败；
 *      名单里少一个场景 ⇒ 那个场景的兜底根本没接上（而且全绿通过）。
 *   ③ 空值注解（`{{dishEmptyNote}}`）又变回「无条件打印」—— 那正是 2026-09-29 的原始故障：
 *      菜品有值时提示词里出现「锅巴土豆（空 = 这次没选具体菜品…改讲门店本身）」，
 *      实测报出菜名率从 92% 掉到 75%。
 *
 * 用法：npm run dish-mention:verify
 * ★ 纯离线、不连库 —— 判据是纯函数，名单与模板都在代码里。
 */
import { renderTemplate } from '../src/ai/gateway.js'
import {
  COPY_PROMPT,
  COPY_TRAFFIC_PROMPT,
  COPY_PERSONA_PROMPT,
  COPY_KNOWLEDGE_PROMPT,
  COPY_PRODUCT_PROMPT,
  COPY_RECOMMEND_PROMPT,
  STORY_PROMPT,
} from '../prisma/prompts.js'
import {
  DISH_EMPTY_NOTE,
  DISH_GUARD_RETRY_BUDGET_MS,
  DISH_MENTION_SCENES,
  dishEmptyNoteFor,
  dishMentionGuard,
  mentionsDish,
} from '../src/lib/dish-mention.js'

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

/** 场景码 → 模板（与 verify-prompt-vars.ts 的 TEMPLATES 同源；这里只列这条链路用得到的） */
const TPLS: Array<{ code: string; label: string; tpl: string }> = [
  { code: 'copy_generate', label: '文案·通用', tpl: COPY_PROMPT },
  { code: 'copy_traffic', label: '文案·流量款（话题）', tpl: COPY_TRAFFIC_PROMPT },
  { code: 'copy_persona', label: '文案·人设型', tpl: COPY_PERSONA_PROMPT },
  { code: 'copy_knowledge', label: '文案·知识型', tpl: COPY_KNOWLEDGE_PROMPT },
  { code: 'copy_product', label: '文案·产品型', tpl: COPY_PRODUCT_PROMPT },
  { code: 'copy_recommend', label: '文案·种草型', tpl: COPY_RECOMMEND_PROMPT },
  { code: 'storyboard_generate', label: '分镜', tpl: STORY_PROMPT },
]

/** 模板里「必须报出菜名」那条硬约束的特征串（prisma/prompts.ts 里两处措辞共用这一句） */
const MUST_MENTION = '正文里就必须出现这个菜名'

/** 取出渲染结果里 `【菜品】` 那一行（断言要盯「用户/模型看到的那一行」，不是模板字符串） */
function dishLine(rendered: string): string {
  return rendered.split('\n').find((l) => l.startsWith('【菜品】')) ?? ''
}

// ──────────────────────── ① 判据本身 ────────────────────────
section('① mentionsDish：正文里到底有没有这道菜')

const DISH = '锅巴土豆'
check(mentionsDish('咱家这个锅巴土豆，孩子来了基本桌桌必点。', DISH), '原样出现 ⇒ 命中')
check(mentionsDish('咱家这个**锅巴土豆**，孩子来了必点。', DISH), '模型常写成的加粗形式 ⇒ 命中')
check(mentionsDish('咱家这道「锅巴 土豆」，外酥里嫩。', DISH), '名字中间夹空格/引号 ⇒ 命中', '太严会白花一次调用')
check(mentionsDish('孩子必点的锅巴土豆。', DISH), '句中出现（非开头）⇒ 命中')
// ★ 真实失败输出（生产 ai_call_log id=163）：整篇改写门店介绍，一个字都没提这道菜
check(
  !mentionsDish(
    '咱店里主打的是大虾火锅，虾都是开好背、去了虾线的，炸完再炒，壳酥肉嫩。一锅两吃，先吃虾，完了加骨汤涮菜涮肉，还送现抻的面条。口味有微辣、五香、番茄、麻辣，老人小孩都有得选。马上国庆了，一家子来或者朋友聚，人均五六十，吃得踏实。',
    DISH,
  ),
  '★ 复现：id=163 那份跑偏的稿子必须判「没报菜名」',
)
check(!mentionsDish('咱家主打大虾火锅，虾开背去线，一锅两吃。', DISH), '只提了别的菜 ⇒ 未命中')
check(!mentionsDish('孩子必点的土豆', DISH), '只写了半个菜名（土豆）⇒ 未命中', '不做模糊匹配，代价不对称')
check(mentionsDish('随便什么文案', ''), '没选菜（菜名空）⇒ 一律命中，即不适用')

// ──────────────────────── ② 名单 ↔ 模板约束 ────────────────────────
section('② 名单与模板里那条硬约束必须一一对应（正反两向）')

const withConstraint = TPLS.filter((t) => t.tpl.includes(MUST_MENTION)).map((t) => t.code)
check(
  withConstraint.length > 0,
  `模板里确实存在这条硬约束（找到 ${withConstraint.length} 个场景）`,
  withConstraint.join('、'),
)
// 正向：名单里的场景，模板必须有这条约束 —— 否则代码在强制一件模板没要求的事，重试必然失败
for (const code of DISH_MENTION_SCENES) {
  const t = TPLS.find((x) => x.code === code)
  check(Boolean(t) && t!.tpl.includes(MUST_MENTION), `${code} 在名单里，其模板含「必须报出菜名」约束`)
}
// 反向：有约束的场景必须在名单里 —— 否则那个场景的兜底根本没接上（且测试会全绿）
for (const code of withConstraint) {
  check(DISH_MENTION_SCENES.has(code), `含该约束的 ${code} 已登记进名单（否则兜底漏接线）`)
}
// 反向：人设型/知识型的定义就是不荐菜，绝不能要求它们报菜名
for (const code of ['copy_persona', 'copy_knowledge', 'copy_traffic']) {
  check(!DISH_MENTION_SCENES.has(code), `${code} 不在名单里（这一型不荐菜/不报货）`)
}

// ──────────────────────── ③ 空值注解的契约 ────────────────────────
section('③ {{dishEmptyNote}}：只在没选菜时出现')

check(dishEmptyNoteFor('锅巴土豆') === '', '有菜名 ⇒ 注解为空串')
check(dishEmptyNoteFor('') === DISH_EMPTY_NOTE, '没选菜 ⇒ 注解就是那段说明')
check(DISH_EMPTY_NOTE.includes('改讲门店本身'), '注解文本仍含「改讲门店本身」（空值路径的措辞没变）')

const dishCopy = TPLS.filter((t) => !['copy_traffic', 'storyboard_generate'].includes(t.code))
for (const t of dishCopy) {
  const n = (t.tpl.match(/\{\{dishEmptyNote\}\}/g) ?? []).length
  check(n === 1, `${t.label} 恰好引用一次 {{dishEmptyNote}}`, `实际 ${n} 次`)
}
for (const code of ['copy_traffic', 'storyboard_generate']) {
  const t = TPLS.find((x) => x.code === code)!
  check(!t.tpl.includes('{{dishEmptyNote}}'), `${t.label} 不引用 {{dishEmptyNote}}`)
}
// ★ 反向：不许再回到「把空值注解无条件跟在菜名后面」的形态 —— 那正是这次故障的成因。
//   只查 `{{dishEmptyNote}}` 在不在是不够的（断言窄于标题）：有人可以直接把那段文字抄回模板。
for (const t of TPLS) {
  check(
    !/\{\{dishName\}\}（空 = /.test(t.tpl),
    `${t.label} 没有把空值注解写死在 {{dishName}} 后面（否则重新引入这次故障）`,
  )
}

// ★★ 真渲染一遍，断言「那一行长什么样」—— 这才是模型看到的东西。
//    只断言模板含某个占位符是查不出「值配错了」的。
const withDish = dishLine(
  renderTemplate(COPY_PRODUCT_PROMPT, { dishName: '锅巴土豆', dishEmptyNote: dishEmptyNoteFor('锅巴土豆') }),
)
check(withDish === '【菜品】锅巴土豆', '★ 有菜名时那一行就是「【菜品】锅巴土豆」（逐字，后面不许再跟任何说明）', withDish)
const noDish = dishLine(
  renderTemplate(COPY_PRODUCT_PROMPT, { dishName: '', dishEmptyNote: dishEmptyNoteFor('') }),
)
check(noDish.startsWith('【菜品】（空 = 这次没选具体菜品'), '★ 没选菜时那一行仍带着空值说明（空值路径不变）', noDish.slice(0, 40))
// 反向复现：按**旧**写法渲染出来的那一行必须被上面那条断言判为不合格
const legacyLine = dishLine(
  renderTemplate(COPY_PRODUCT_PROMPT.replace('{{dishName}}{{dishEmptyNote}}', '{{dishName}}（空 = 测试）'), {
    dishName: '锅巴土豆',
    dishEmptyNote: '',
  }),
)
check(legacyLine !== '【菜品】锅巴土豆', '★ 复现：旧写法（注解写死在菜名后）确实会被上一条断言拦下', legacyLine)

// ──────────────────────── ④ 时间闸门 ────────────────────────
section('④ 重试闸门与前端超时的算式')

/**
 * ★ 这个算式是跨文件契约，别把它当成「写死的常数」：
 *   前端 apps/mini/src/services/creation.ts::COPY_TIMEOUT_MS = 120s，
 *   它是按「候选 2 个 × 单候选 45s × (maxRetries 0 + 1) = 90s」加余量得到的。
 *   本重试会在最坏路径上再叠一次同样的 90s ⇒ 闸门必须让两者之和留出余量。
 */
const CANDIDATES = 2
const SCENE_TIMEOUT_MS = 45_000
const FRONTEND_TIMEOUT_MS = 120_000
const worstPerCall = CANDIDATES * SCENE_TIMEOUT_MS
check(
  DISH_GUARD_RETRY_BUDGET_MS + worstPerCall < FRONTEND_TIMEOUT_MS,
  '闸门 + 重试最坏耗时 < 前端 120s（改任一项都要重算）',
  `${DISH_GUARD_RETRY_BUDGET_MS} + ${worstPerCall} < ${FRONTEND_TIMEOUT_MS}`,
)

// ──────────────────────── ⑤ 兜底开关：这次该不该再要一次 ────────────────────────
section('⑤ dishMentionGuard：四个「不适用」分支一个都不能写反')

/** 默认是「该重试」的那组输入；每条断言只改一个字段 */
const base = {
  sceneCode: 'copy_product',
  dishName: '锅巴土豆',
  text: '咱店主打大虾火锅，虾开背去线，一锅两吃。',
  elapsedMs: 6000,
  isFallbackTemplate: false,
}
const guard = (o: Partial<typeof base>) => dishMentionGuard({ ...base, ...o })

check(guard({}) === 'RETRY', '选了菜、正文没报菜名、耗时正常 ⇒ RETRY')
check(guard({ text: '咱家这个锅巴土豆，孩子来了必点。' }) === 'OK', '正文报了菜名 ⇒ OK（不重试）')
check(
  guard({ sceneCode: 'copy_recommend' }) === 'RETRY',
  '种草型（copy_recommend）同样要兜底',
)
// ★ 反向：这三类场景**绝不能**触发重试 —— 前两型的定义就是不荐菜，话题稿手里没有菜品资料。
//   写反了的后果是「每次都判不合格 ⇒ 每次白花一次调用」，而且不报错。
for (const code of ['copy_persona', 'copy_knowledge', 'copy_generate', 'copy_traffic', 'storyboard_generate']) {
  check(guard({ sceneCode: code }) === 'NOT_APPLICABLE', `${code} 不触发重试（这一型不要求报菜名）`)
}
check(guard({ dishName: '' }) === 'NOT_APPLICABLE', '没选菜 ⇒ NOT_APPLICABLE（不适用，不是「没命中」）')
check(guard({ text: '' }) === 'NOT_APPLICABLE', '正文为空 ⇒ NOT_APPLICABLE（交给上面「有结构没正文」那条兜底）')
check(guard({ isFallbackTemplate: true }) === 'NOT_APPLICABLE', 'AI 整体失败走了兜底模板 ⇒ 不再多花一次调用')
// ★ 闸门边界：判据是「已耗时 **>** 闸门才放弃」，所以恰好等于闸门时仍应重试。
//   写成 `>=` 会让「卡在边界上的那一次」静默失去兜底 —— 这类差一错误不会报错。
check(
  guard({ elapsedMs: DISH_GUARD_RETRY_BUDGET_MS }) === 'RETRY',
  '★ 耗时恰好等于闸门 ⇒ 仍然重试（判据是「大于」才放弃）',
)
check(guard({ elapsedMs: DISH_GUARD_RETRY_BUDGET_MS + 1 }) === 'OVER_BUDGET', '超过闸门 ⇒ OVER_BUDGET（且不是 RETRY）')
// ★ OVER_BUDGET 必须与 RETRY 分开返回：调用方据此打**不同**的日志
//   （「兜底没启动」和「兜底启动但没救回来」是两件事，混一起就看不出兜底到底有没有在工作）
check(
  guard({ elapsedMs: 999_999 }) !== 'RETRY' && guard({ elapsedMs: 999_999 }) === 'OVER_BUDGET',
  '超闸门不会退化成 RETRY',
)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exitCode = 1
