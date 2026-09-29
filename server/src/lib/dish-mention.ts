/**
 * 「选了菜，就得讲这道菜」—— 菜品在正文里的**出现判据**，以及相关的三样东西。
 *
 * 为什么单独成模块：这件事有三处要用同一个口径（提示词变量的值、生成后的兜底判据、
 * 契约测试），散在三个文件里迟早不一致 —— 而这类不一致**不报错**，只会让文案悄悄跑偏。
 *
 * ★ 背景（2026-09-29 用户报「AI 文案还是跟选择的产品联系不上」）：
 *   生产 `ai_call_log id=163`（创作 #57，选的是锅巴土豆）里，模型看到的提示词是
 *
 *       【菜品】锅巴土豆（空 = 这次没选具体菜品…改讲门店本身；…）
 *
 *   菜名后面**紧挨着**一段「没选菜 ⇒ 改讲门店本身」的空值说明，而它是**无条件**打印的。
 *   模型把两句话一起读了进去，最后逐句改写了【门店介绍】。
 *
 * ★ 实测（同一条真实创作 #57，真门店 216 字介绍 + 锅巴土豆，deepseek-v4-flash、
 *   temp 0.8、每臂 12 次，脚本 scripts/ab-copy-dish-note.ts）：
 *     · 现状（注解无条件打印）            报出菜名 9/12 = **75%**
 *     · 注解改成「有值时不出现」           报出菜名 11/12 = **92%**  ← 已采用
 *     · 连硬约束段里「菜品为空 ⇒ 改讲门店本身」那条也一起删 → 10/12 = 83%（**更差**，故保留）
 *   也就是说：**只把这句自相矛盾的文本从「有值」的路径上拿掉**，
 *   空值那条约束一个字都不能动。
 *
 * ★★ 92% 仍然不是 100%。剩下的 8% 是采样本身的抖动，靠改措辞压不下去 ——
 *   所以另有 `mentionsDish` 这一层**确定性兜底**：生成后查不到菜名就再要一次
 *   （见 creation.service.ts 的 generateCopy，重试那一次**不再扣用户积分**）。
 */

import { SCENE } from '../ai/scene-codes.js'

/**
 * `{{dishEmptyNote}}` 的值 —— 只在**没选菜**时才有内容。
 *
 * ★ 这段文字就是从模板里搬过来的那 73 个字，**一个字都没改**：
 *   「没选菜」这条路径的提示词与改动前逐字一致，改的只是「有菜名时不再打印它」。
 * ★ 它由 `dishEmptyNoteFor` 按菜名有无来取值，模板只写 `{{dishEmptyNote}}`
 *   （模板见 prisma/prompts.ts 的 CONTEXT_BLOCK；那边也有注释指向本文件）。
 */
export const DISH_EMPTY_NOTE = `（空 = 这次没选具体菜品，下面两行也一起为空：不要编造菜名、价格或做法，
改讲门店本身；门店资料也一起空着就写短一点，别拿别家店的常见做法补上）`

/** 有菜名 ⇒ 空串（那段说明一个字都不出现）；没菜名 ⇒ 原样的空值说明 */
export function dishEmptyNoteFor(dishName: string): string {
  return dishName ? '' : DISH_EMPTY_NOTE
}

/**
 * 正文里**必须**出现菜名的场景。
 *
 * ★ 这份名单必须与 prisma/prompts.ts 里那条硬约束一一对应：
 *   `copy_product`（产品型）与 `copy_recommend`（种草型）的硬约束段里都有
 *   「只要【菜品】一节有内容，正文里就必须出现这个菜名 —— 没出现就是不合格稿」。
 * ★ 故意**不含**这两个：
 *   · `copy_persona`（人设型）、`copy_knowledge`（干货型）—— 这两型的定义就是不荐菜不报货，
 *     要求它们报菜名等于让它们违反自己的边界；
 *   · `copy_generate`（通用兜底）—— 它的模板里没有这条约束，代码却去强制它，
 *     会变成「反复重试必然失败」的白花钱。
 * ★ 名单与模板的一致性由 `scripts/verify-dish-mention.ts` 钉死（正反两个方向都断言），
 *   以后加场景/加约束忘了同步会当场变红。
 */
export const DISH_MENTION_SCENES: ReadonlySet<string> = new Set<string>([
  SCENE.copy_product,
  SCENE.copy_recommend,
])

/**
 * 正文里报出这道菜了吗？
 *
 * ★ 归一化必须**宽松**：模型常写成 `**锅巴土豆**`、或在名字中间夹个空格。
 *   判太严的代价是「正常的稿子被判不合格 ⇒ 白花一次调用」。
 * ★ 但**不做同义词/模糊匹配**：代价不对称 ——
 *   多花一次调用约 ¥0.03，而漏报一次就是用户这次的投诉。
 */
export function mentionsDish(text: string, dishName: string): boolean {
  const want = normalize(dishName)
  if (!want) return true
  return normalize(text).includes(want)
}

/** 去掉空白与各类包裹/装饰字符（加粗、引号、括号、书名号…），只留字面内容 */
function normalize(s: string): string {
  return s.replace(/[\s*_`~#「」『』《》【】""''“”‘’（）()\[\]]/g, '')
}

/**
 * 兜底重试的**时间闸门**：已经跑了多久就不再重试。
 *
 * ★ 为什么需要闸门：前端 `COPY_TIMEOUT_MS = 120s`（apps/mini/src/services/creation.ts），
 *   它是按「候选 2 × 单候选 45s × (maxRetries 0 + 1) = 90s」的最坏值加的余量。
 *   本重试会**再叠一次**同样的最坏耗时，不设闸门就可能顶穿前端 ——
 *   而那时的现象是「前端超时、服务端其实成功」，比文案跑偏更难查。
 *   20s 闸门 ⇒ 服务端最坏 20 + 90 = **110s < 120s**，still 留 10s 余量。
 * ★ 正常出稿实测 3~17s（见上面 A/B 的逐次耗时），所以闸门几乎不会拦到正常路径；
 *   它拦的是「第一个候选先挂了 45s」那种慢路径 —— 那种情况下宁可放弃重试。
 * ★ 改这里的数 / `ai_scene.timeout_ms` / 候选数组 / 前端 `COPY_TIMEOUT_MS`，
 *   四处必须一起重算（creation.ts 的注释里写着同一个算式）。
 */
export const DISH_GUARD_RETRY_BUDGET_MS = 20_000

/**
 * 这次生成该不该为了「没报出菜名」再要一次 —— **判据抽成纯函数**，理由有两个：
 *   · 它决定「要不要多花一次上游调用」，写死在业务代码里就只能靠真跑碰运气去验；
 *   · 它有四个「不适用」的分支（没选菜 / 不在这条链路的场景 / 兜底模板 / 超时闸门），
 *     任何一个写反了都**不会报错**，只会让兜底静默失效。
 * 断言在 scripts/verify-dish-mention.ts。
 */
export type DishGuardDecision = 'RETRY' | 'OK' | 'OVER_BUDGET' | 'NOT_APPLICABLE'

export function dishMentionGuard(o: {
  sceneCode: string
  dishName: string
  text: string
  elapsedMs: number
  /** 走的是兜底模板（AI 根本没成功）⇒ 不该再花一次调用去救 */
  isFallbackTemplate: boolean
}): DishGuardDecision {
  if (o.isFallbackTemplate) return 'NOT_APPLICABLE'
  if (!o.dishName) return 'NOT_APPLICABLE'
  if (!DISH_MENTION_SCENES.has(o.sceneCode)) return 'NOT_APPLICABLE'
  if (!o.text) return 'NOT_APPLICABLE'
  if (mentionsDish(o.text, o.dishName)) return 'OK'
  // ★ 超时闸门与「该不该重试」分开返回：调用方要能为两种情形打不同的日志
  //   （跳过重试 ≈ 这次兜底没启动，是运维要知道的事，不能和「重试了但没救回来」混为一谈）
  return o.elapsedMs > DISH_GUARD_RETRY_BUDGET_MS ? 'OVER_BUDGET' : 'RETRY'
}
