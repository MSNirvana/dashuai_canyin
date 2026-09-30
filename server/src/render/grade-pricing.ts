// 合成档位的**固定价**（2026-09-30 起）。
//
// 口径变更：旧版是「时长(秒) × render.point_per_sec × 档位系数」—— 成片越长扣得越多。
//   现按用户要求改为**按次固定价**：只与档位有关，**与成片时长无关**。
//
// ★ 为什么单独一个小模块，而不是塞进 `services/render.service.ts`：
//   同一份口径有**三处**要读 —— 计费（render.service）、小程序报价（routes/render-capabilities）、
//   守护脚本（scripts/verify-pricing）。
//   · 放 render.service.ts：守护脚本为了测一个乘法，得把 prisma / bean / chatcut 整条依赖链拖进来；
//   · 各自复制一份：这正是历史教训里点过名的反模式（同一个判据两处实现 ⇒ 改一处、另一处静默漂移，
//     `GRADE_RATIO_DEFAULT` 与小程序里的 `GRADE_RATIO` 就是这么坏掉的）。
//   本模块只依赖 `lib/decimal`（纯计算）与 `lib/settings`（读配置），无副作用部分可直接被守护断言。
import type { Prisma } from '@prisma/client'
import { decMulCeil, type Dec } from '../lib/decimal.js'
import { getDecimal } from '../lib/settings.js'

/**
 * 合成档位。
 * BASIC=纯粗剪拼接（**2026-09-28 已从前端下线**，类型保留：老成片记录里还有这一档，
 *   而且老客户端 `aiMode:false` 仍会解析成它）/ AI=本地自动剪辑 / PREMIUM=剪辑师人工精剪。
 */
export type RenderGrade = 'BASIC' | 'AI' | 'PREMIUM'

/**
 * 档位固定价的**兜底默认值**（实际以后台「系统设置 → render」组的 `grade_beans_*` 为准）。
 *
 * ★ 500 / 5000 是用户 2026-09-30 明确指定的两个数。
 * ★ BASIC 用户**没有**指定：它已下线、正常路径提交不到，这里暂与 AI 同价（500）。
 *   真要恢复这一档，请先在后台把 `grade_beans_basic` 调成想要的值 —— 不要改这里的默认值，
 *   否则「线上是后台值、开发机是默认值」，两边又开始漂移。
 */
export const GRADE_BEANS_DEFAULT: Record<RenderGrade, number> = {
  BASIC: 500,
  AI: 500,
  PREMIUM: 5000,
}

/** 后台配置键：`render.grade_beans_basic` / `_ai` / `_premium` */
export function gradeBeansKey(grade: RenderGrade): string {
  return `grade_beans_${grade.toLowerCase()}`
}

/**
 * 一次合成的扣费额 —— **纯函数**，只吃「档位固定价」与「模式折扣」。
 *
 * ★ 与时长无关：入参里刻意不出现任何时长字段，让「又不小心按时长算」在类型层面就写不出来。
 * ★ `recolorRatio` **不传 = 不打折**（FULL 模式走这条路）。传了才乘它是为了让调用点
 *   一眼看出「这个折扣只在 RECOLOR 下发生」，而不是在别处默认塞一个 1。
 * ★ RECOLOR 仍打折（默认 5 折）：它复用归一化缓存、成本确实更低。
 *   那是**模式**折扣，不是时长折扣，所以不随本次口径变更一起取消。
 * ★ 最低收 1 积分：后台若把价格配成 0 或小数，不能出现「免费出片」或「0 积分流水」。
 */
export function renderAmountBeans(gradeBeans: Dec, recolorRatio?: Dec): bigint {
  const raw = decMulCeil(recolorRatio ? [gradeBeans, recolorRatio] : [gradeBeans], 1n)
  return raw < 1n ? 1n : raw
}

/** 读某个档位的固定价（库里没有该行时回落到 `GRADE_BEANS_DEFAULT`） */
export function readGradeBeans(prisma: Prisma.TransactionClient, grade: RenderGrade): Promise<Dec> {
  return getDecimal(prisma, 'render', gradeBeansKey(grade), GRADE_BEANS_DEFAULT[grade])
}

/** 读 RECOLOR 折扣系数（仅 `mode='RECOLOR'` 用） */
export function readRecolorRatio(prisma: Prisma.TransactionClient): Promise<Dec> {
  return getDecimal(prisma, 'render', 'recolor_ratio', 0.5)
}
