import dayjs, { type Dayjs } from 'dayjs'

/**
 * 后台时间显示的唯一口径：`2026-09-18 10:59`
 *   · 精确到分钟（不显示秒）
 *   · 日期与时间之间**一个空格**（`YYYY-MM-DD HH:mm`），不出现 `T` / `Z`
 *   · 一律按**浏览器本地时区**渲染
 *
 * ★ 为什么非要有这个文件：
 *   接口回的时间是 UTC 的 ISO 串（`2026-09-18T02:59:39.391Z`）。之前后台各页各写
 *   `dayjs(x).format(...)`，格式串漂移成四种口径（带秒 / 不带秒 / `MM-DD` 连年份都没有 /
 *   `toLocaleString()`），运营对时间就得做心算。这里收敛成一处。
 *   ⚠ 千万不要为了"省事"改成对 ISO 串做 `slice` / `replace('T',' ')`：那是 UTC，
 *   会比北京时间早 8 小时（服务器与容器时区都是 UTC）。
 *
 * 小程序端口径与此完全一致，见 `apps/mini/src/utils/time.ts`
 * （那边没引 dayjs，是为了主包体积，实现是手写的）。
 */

/** 收 ISO 串 / 时间戳 / Date，也收 dayjs 对象（`dayjs(d)` 是克隆，安全） */
type Input = string | number | Date | Dayjs | null | undefined

/** `2026-09-18 10:59`；空值 / 非法值回 `—`（后台表格里比空白更易读） */
export function fmtMinute(v?: Input): string {
  if (!v) return '—'
  const d = dayjs(v)
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : '—'
}

/** `2026-09-18` —— 只给「到日为止」的语义用（如顺延天数的说明文案） */
export function fmtDay(v?: Input): string {
  if (!v) return '—'
  const d = dayjs(v)
  return d.isValid() ? d.format('YYYY-MM-DD') : '—'
}

/** `10:59` —— 当天之内的时钟读数（如「已保存 10:59」），不带日期 */
export function fmtClock(v?: Input): string {
  if (!v) return '—'
  const d = dayjs(v)
  return d.isValid() ? d.format('HH:mm') : '—'
}
