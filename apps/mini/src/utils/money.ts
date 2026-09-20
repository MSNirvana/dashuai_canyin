/**
 * 金额显示口径（唯一源）。
 *
 * 为什么单独成文件：全站的金额在**库里一律是「分」**（`price_fen` / `amount_fen`，
 * 与 member_package / order 同口径），只有在**渲染的最后一步**才变成「元」。
 * 这个转换原先只存在于充值页的一个局部函数里，套餐价一上来就会出现第二份实现 ——
 * 「¥88」和「¥88.00」并存、或者某个页面忘了 `toFixed` 露出「88.00000000000001」这类长尾。
 *
 * 小数位规则：整元不显示 `.00`（¥88 而不是 ¥88.00），有零头才补两位（¥88.5 → ¥88.50）。
 * 不做四舍五入到整元 —— 那会让 88.5 显示成 ¥89，用户按显示价付款就对不上账。
 */
export function fenToYuan(fen: number): string {
  if (!Number.isFinite(fen)) return '0'
  return (fen / 100).toFixed(fen % 100 === 0 ? 0 : 2)
}

/**
 * 用户输入的「元」（字符串）→ 库里的「分」。
 *
 * ★ 必须 `Math.round` 而不是直接 `* 100`：`88.7 * 100 = 8869.999999999998`，
 *   直接取整会变成 8869（少 1 分）。浮点数的锅不该让用户的钱包背。
 * 返回 null 表示「没填 / 填了不是数字 / 负数」—— 由调用方决定这是不是错误，
 * 因为「没填」在单菜下合法（清空划线价）、在套餐价下不合法。
 */
export function yuanToFen(input: string): number | null {
  const t = (input ?? '').trim()
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}
