// 「今天是什么日子」—— 供提示词用的日期 / 季节 / 临近节日与节气。
//
// 为什么需要它：模型**不知道今天是几号**。要它「跟上节假日、赶上当下热点」却没有日期，
// 它只会瞎编 —— 三月份给你写「中秋快乐」，或者把去年的热点当今年的。
// 这个字符串是模型**唯一的时间来源**，也是「流量款靠节日/时令起钩子」这条路的物理前提。
//
// 两条硬约束，都是踩过才知道的：
//
//   1. ★ **必须显式按 Asia/Shanghai 取日期**。本仓没有任何 TZ 处理（`grep Asia/Shanghai src/` 为空），
//      开发机是 CST+0800，而线上 Ubuntu 默认 UTC —— 直接用 `new Date().getMonth()`，
//      北京时间 00:00~08:00 这八小时会算出**前一天**：除夕当天的文案写成「明天除夕」，
//      而且**没有任何报错**（典型静默失效）。所以这里一律走 Intl + timeZone，不碰本地时区字段。
//
//   2. ★ **永远返回非空**。模板里那一行 `{{dateInfo}}` 若渲染成空串，模型就退回瞎编状态，
//      等于没有这个变量（对照 ai/prompt-vars.ts 里 userIdea 那个教训：取不到值只会静默变空串）。
//      所以任何一天都至少有「今天是 …」这一行；「临近节点」那行没有时也写「近三周内没有」。
//
// 精度口径：
//   · 公历固定节日 / 母亲节父亲节感恩节（第几个星期日）/ 农历大节 —— 表查，**准确**
//   · 24 节气 —— 通用「寿星公式」近似，**±1 天**。提示词只把它当「大概这几天」用，
//     且模板里明确禁止模型报具体日期，所以这点误差无害。已按 2026 年多个节气回验通过。

/** 一律按北京时间算「今天」，理由见文件头第 1 条 */
const CN_TZ = 'Asia/Shanghai'

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const

/** 往未来看多少天算「临近」。21 天 ≈ 三周，正好能覆盖「下一个节气 + 下一个节日」 */
const WINDOW_DAYS = 21

/** 最多报几个临近节点。多了模型会挑花眼，也会把文案写成节日播报 */
const MAX_ITEMS = 3

/** 公历固定日期的节日。只放餐饮真会做活动的，不把整本日历搬进来 */
const SOLAR_FESTIVALS: ReadonlyArray<readonly [number, number, string]> = [
  [1, 1, '元旦'],
  [2, 14, '情人节'],
  [3, 8, '妇女节'],
  [5, 1, '劳动节'],
  [6, 1, '儿童节'],
  [9, 10, '教师节'],
  [10, 1, '国庆节'],
  [11, 11, '双十一'],
  [12, 12, '双十二'],
  [12, 24, '平安夜'],
  [12, 25, '圣诞节'],
]

/**
 * 「某月第 n 个星期几」型节日：母亲节 / 父亲节 / 感恩节。
 * 单独算是因为它们不落在固定日期上 —— 写成固定日期表每年都会错一次。
 */
const NTH_WEEKDAY_FESTIVALS: ReadonlyArray<readonly [number, number, number, string]> = [
  // [月, 第几个, 星期几(0=周日), 名称]
  [5, 2, 0, '母亲节'],
  [6, 3, 0, '父亲节'],
  [11, 4, 4, '感恩节'],
]

/**
 * 农历大节 → 公历日期。**这个表会用完，用完必须补。**
 *
 * 口径：只放餐饮真会做活动的 5 个（除夕 / 春节 / 元宵 / 端午节 / 中秋节）。
 * 2026-09-20 逐条多来源核对过：2026 除夕 2/16、春节 2/17、元宵 3/3、端午 6/19、中秋 9/25；
 * 2027 除夕 2/5、春节 2/6、元宵 2/20、端午 6/9、中秋 9/15。
 *
 * ⚠ 农历节日的公历日期**每年都不一样，不许照抄往年**。补表时逐个查万年历，别凭印象。
 * ⚠ 表用完之后不会报错，只会静静地少掉「春节/中秋」这些最重要的节点
 *   —— 所以契约测试里钉了一条 `LUNAR_FESTIVAL_MAX_YEAR >= 今年`，到期会自己变红催补。
 */
const LUNAR_FESTIVALS: ReadonlyArray<readonly [number, number, number, string]> = [
  [2026, 2, 16, '除夕'],
  [2026, 2, 17, '春节'],
  [2026, 3, 3, '元宵节'],
  [2026, 6, 19, '端午节'],
  [2026, 9, 25, '中秋节'],
  [2027, 2, 5, '除夕'],
  [2027, 2, 6, '春节'],
  [2027, 2, 20, '元宵节'],
  [2027, 6, 9, '端午节'],
  [2027, 9, 15, '中秋节'],
]

/** 农历节日表覆盖到哪一年。契约测试用它做「该补表了」的告警 */
export const LUNAR_FESTIVAL_MAX_YEAR = 2027

const SOLAR_TERMS = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分',
  '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
  '小暑', '大暑', '立秋', '处暑', '白露', '秋分',
  '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
] as const

/** 各节气所在月份，与 SOLAR_TERMS 一一对应（小寒/大寒在 1 月、冬至在 12 月） */
const TERM_MONTHS = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12] as const

/** 通用「寿星公式」在 21 世纪的 24 个 C 值，与 SOLAR_TERMS 一一对应 */
const TERM_C = [
  5.4055, 20.12, 3.87, 18.73, 5.63, 20.646,
  4.81, 20.1, 5.52, 21.04, 5.678, 21.37,
  7.108, 22.83, 7.5, 23.13, 7.646, 23.042,
  8.318, 23.438, 7.438, 22.36, 7.18, 21.94,
] as const

/** 北京时间的年月日。不用 `new Date()` 的本地字段（见文件头第 1 条） */
export function shanghaiYmd(now: Date): { year: number; month: number; day: number } {
  // en-CA 的输出恰好是 YYYY-MM-DD，省得自己拼 Intl 的 parts
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: CN_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const [y, m, d] = s.split('-').map(Number)
  return { year: y!, month: m!, day: d! }
}

/** 把年月日压成一个「天序号」，跨年跨月的天数差直接相减即可 */
function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

/** 用 UTC 构造来求星期：入参已是「北京时间的年月日」，不能再让它受本地时区影响 */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** 某月第 n 个星期 w 是几号；找不到（第 5 个）返回 null */
function nthWeekdayOfMonth(year: number, month: number, nth: number, weekday: number): number | null {
  const first = weekdayOf(year, month, 1)
  const day = 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7
  return day <= daysInMonth(year, month) ? day : null
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 寿星公式。返回该年第 index 个节气落在几号（±1 天，见文件头「精度口径」） */
function solarTermDay(year: number, index: number): number {
  const y = year % 100
  return Math.floor(y * 0.2422 + TERM_C[index]!) - Math.floor(y / 4)
}

function seasonOf(month: number): string {
  if (month >= 3 && month <= 5) return '春季'
  if (month >= 6 && month <= 8) return '夏季'
  if (month >= 9 && month <= 11) return '秋季'
  return '冬季'
}

export type UpcomingNode = { month: number; day: number; name: string; ahead: number }

/**
 * 未来 WINDOW_DAYS 天内（含今天）的节点，按由近到远排。
 *
 * 同时扫**今年和明年**：12 月下旬要能看到 1 月 1 日的元旦与 2 月的春节，
 * 不扫明年就会有半个月的空窗期 —— 而那正好是餐饮最忙的跨年档。
 */
export function upcomingNodes(now: Date, windowDays = WINDOW_DAYS): UpcomingNode[] {
  const { year, month, day } = shanghaiYmd(now)
  const today = dayNumber(year, month, day)
  const out: UpcomingNode[] = []

  const push = (y: number, m: number, d: number, name: string) => {
    const ahead = dayNumber(y, m, d) - today
    if (ahead >= 0 && ahead <= windowDays) out.push({ month: m, day: d, name, ahead })
  }

  for (const y of [year, year + 1]) {
    for (const [m, d, name] of SOLAR_FESTIVALS) push(y, m, d, name)
    for (const [m, nth, w, name] of NTH_WEEKDAY_FESTIVALS) {
      const d = nthWeekdayOfMonth(y, m, nth, w)
      if (d !== null) push(y, m, d, name)
    }
    for (let i = 0; i < SOLAR_TERMS.length; i++) {
      push(y, TERM_MONTHS[i]!, solarTermDay(y, i), SOLAR_TERMS[i]!)
    }
  }
  for (const [y, m, d, name] of LUNAR_FESTIVALS) push(y, m, d, name)

  // 同一天可能既是节气又是节日（清明即节气、中秋可能撞国庆前后），按名字排一下保证稳定
  return out.sort((a, b) => a.ahead - b.ahead || a.name.localeCompare(b.name))
}

/**
 * 渲染成给提示词用的两行文本。**保证非空**（文件头第 2 条）。
 *
 * 样例（2026-09-20）：
 * ```
 * 今天是 2026-09-20（星期日），秋季
 * 临近节点：9月23日 秋分（3 天后）；9月25日 中秋节（5 天后）；10月1日 国庆节（11 天后）
 * ```
 */
export function formatDateInfo(now: Date = new Date()): string {
  const { year, month, day } = shanghaiYmd(now)
  const head = `今天是 ${year}-${pad(month)}-${pad(day)}（${WEEKDAYS[weekdayOf(year, month, day)]}），${seasonOf(month)}`

  const nodes = upcomingNodes(now).slice(0, MAX_ITEMS)
  if (nodes.length === 0) {
    return `${head}\n临近节点：近三周内没有节日或节气，按季节和生活场景找话头`
  }
  const body = nodes
    .map((n) => `${n.month}月${n.day}日 ${n.name}（${n.ahead === 0 ? '就是今天' : `${n.ahead} 天后`}）`)
    .join('；')
  return `${head}\n临近节点：${body}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
