/**
 * 时间显示的唯一入口（小程序端）。
 *
 * 统一口径：`2026-09-18 10:59`
 *   · 本地时区（用户在东八区就看北京时间）
 *   · 精确到分钟（不显示秒与毫秒）
 *   · 日期与时间之间**一个空格**，中间不出现 `T` / `Z`
 *
 * ★ 为什么必须「解析成 Date 再按本地时区重排」，而不是对 ISO 串做字符串处理：
 *   接口回的是 `JSON.stringify(new Date())` 的形态（`2026-09-18T02:59:39.391Z`）——
 *   1. 直接渲染 ⇒ 把 `T` / `Z` / 毫秒暴露给用户；
 *   2. `slice(0, 16)` 或 `replace('T', ' ')` ⇒ **拿到的是 UTC 时间**，比北京时间早 8 小时，
 *      会把刚发生的事显示成"8 小时前的未来时间"。**这是本项目最容易踩的坑：
 *      服务器与容器时区都是 UTC，只有用户的眼睛在东八区。**
 *   3. 各页面各写一份 `fmtDate` 必然漂移（有的到日、有的到秒、横杠与斜杠混用），
 *      所以全部收敛到这里。
 *
 * ★ 刻意不引 dayjs：小程序主包已占 2MB 上限的 65% 左右，这点格式化不值得再进一个依赖。
 *   （后台 `apps/admin` 本来就有 dayjs，见 `apps/admin/src/lib/datetime.ts`，两边口径保持一致。）
 */

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/**
 * 解析成 Date。空值 / 非法值回 null，由调用方决定占位符。
 *
 * ⚠ 只往这里传「接口给的 ISO 串 / 时间戳 / Date」，
 *   不要把自己格式化过的 `2026-09-18 10:59` 再喂回来 ——
 *   带空格的日期串在 iOS（WKWebView / 微信）里会解析失败（返回 Invalid Date）。
 *   （`2026-09-18T02:59:39.391Z` 这种标准 ISO 反而是各端都安全的。）
 */
function toDate(input?: string | number | Date | null): Date | null {
  if (input === null || input === undefined || input === '') return null
  const d = input instanceof Date ? input : new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}

/** `2026-09-18 10:59`；空值 / 非法值回 `''` */
export function formatMinute(input?: string | number | Date | null): string {
  const d = toDate(input)
  if (!d) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * `2026-09-18` —— 只给「到日为止」的语义用（会员 / 赠积分到期日）。
 * ★ 这种地方**故意不带时分**：到期日给运营和用户看的是「哪一天」，多出来的时分只会让人怀疑。
 */
export function formatDay(input?: string | number | Date | null): string {
  const d = toDate(input)
  if (!d) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** `10:59` —— 当天之内的时钟读数（如「已保存 10:59」），不带日期 */
export function formatClock(input?: string | number | Date | null): string {
  const d = toDate(input)
  if (!d) return ''
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
