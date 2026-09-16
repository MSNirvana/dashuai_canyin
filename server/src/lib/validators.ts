// 用户输入文本的校验片段（zod）—— 统一在这里定义，路由只引用不手抄。
//
// 为什么必须抽出来：`trim` 漏掉是**静默**失效，没有任何报错 ——
// `z.string().min(1)` 会让 `"   "`（三个空格）通过校验，因为 min 数的是**长度**，
// 而不是「有没有实际内容」。于是库里会存下纯空白的名称/简介/文案，表现为：
//   · 菜品/门店列表出现空白卡片（点得进去、但标题是空的）
//   · 喂给 AI 的变量变成空白 —— 名称类还看不出问题，简介类会让提示词里出现空段
//   · 成片字幕压的是空白
// 本项目里 `creations.ts` 的 `title` 写对了（`.trim().min(1)`），而 `stores.ts` / `dishes.ts`
// 的 `name` 漏了 —— 手抄同一个模式必然会漂移，所以收敛成下面三个工厂函数。
//
// ⚠ 顺序很重要：`.trim()` 与 `.min()` / `.max()` 都是「字符串 check」，按**书写顺序**执行，
// 所以 `z.string().trim().min(1).max(128)` 是「先 trim，再判空、再判长」：
//   "   "          → 拒绝（too_small）
//   " ab "         → 通过，且**落库的值已经是 trim 后的 "ab"**
//   "  " + 128 字 + "  " → 通过（max 也是在 trim 之后判的，比原来更宽容，这是期望行为）

import { z } from 'zod'

/** 必填文本：先 trim 再判空，落库存的是 trim 后的值 */
export const requiredText = (max: number) => z.string().trim().min(1).max(max)

/** 可选文本：允许缺失，落库存的是 trim 后的值 */
export const optionalText = (max: number) => z.string().trim().max(max).optional()

/** 可选且可显式置空：`null` 表示「清空该字段」，落库存的是 trim 后的值 */
export const nullableText = (max: number) => z.string().trim().max(max).nullable().optional()
