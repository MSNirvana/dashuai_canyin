/**
 * AI 剪辑决策表（EDL）—— **纯函数**：零 I/O、零环境依赖、零 import。
 *
 * ⚠ 为什么要有这个模块：
 *   在此之前「怎么剪」完全由用户在面板上选的**固定档位**决定（转场 3 档 × 节奏 3 档 ×
 *   字幕 3 档 × 配乐 3 档），服务端只负责把档位映射成原语 ⇒ 出片永远是「模板套出来的」，
 *   用户的原话是「没有转场和剪辑」。本模块引入一层「让模型来出剪辑参数」：
 *     · 整片层面：节奏档 / 转场档 / 字幕样式 / 配乐
 *     · **逐镜头层面：每个镜头各自留多长** —— 这是「剪辑感」的主要来源
 *       （原先整片套同一个 `shotScale`，6 个镜头一起等比缩，看不出节奏）。
 *
 * ★★ 为什么必须是纯函数：要被 `scripts/verify-edl.ts` 零依赖直接调用，把
 *    「模型给出一堆离谱值时会被夹成什么样」变成每次提交都能验的闸门。
 *    ⚠ 别往这里 import `chatcut.ts`（它 import 了 redis）—— 一旦引入连接，
 *      守护脚本就必须连库才能跑，这条闸门会很快被跳过。
 *
 * ★★ 为什么夹取要**分两道**，别合并：
 *    ① 这里只做**粗夹**（`EDL_SHOT_MIN_MS ~ EDL_SHOT_MAX_MS`）—— 防模型给出
 *       50ms / 300000ms 这种明显不合理的值，以及 NaN / 字符串 / 负数。
 *    ② 「不超素材**真实**可用时长」的**严夹**在 `chatcut-timing.ts` 的 `planShotTiming`
 *       里做 —— 只有它知道每段素材探到的真实时长与转场余量。
 *    两处职责不同：这里防「离谱」，那里防「越界拒单」。合并会让任一方拿到它不该知道的信息。
 */

/** 整片层面的四个档位。取值集合与 `chatcut.ts` 的 ChatCutOptions **必须一致**（由 verify-edl 断言） */
export const EDL_PACINGS = ['NATURAL', 'FAST', 'STORY'] as const
export const EDL_TRANSITIONS = ['CLEAN', 'SMOOTH', 'DYNAMIC'] as const
export const EDL_SUBTITLE_STYLES = ['CLEAN', 'EMPHASIS', 'SOCIAL'] as const
export const EDL_BGMS = ['NONE', 'LIGHT', 'UPBEAT', 'PREMIUM'] as const

export type EdlPacing = (typeof EDL_PACINGS)[number]
export type EdlTransition = (typeof EDL_TRANSITIONS)[number]
export type EdlSubtitleStyle = (typeof EDL_SUBTITLE_STYLES)[number]
export type EdlBgm = (typeof EDL_BGMS)[number]

/**
 * 单镜头目标时长的**粗夹**边界（毫秒）。
 *
 * ★ 下限 800ms：低于它的镜头在 30fps 下不足 24 帧，观众来不及看清画面内容，
 *   而且转场余量（≤15%）会把可用时长再砍一刀 ⇒ 只剩「闪一下」。（配音下界还会再抬一次）
 * ★ 上限 15000ms：竖屏短视频里单个镜头超过 15 秒必然留不住人；
 *   模型偶尔会把「这段素材有 40 秒」直接抄成 targetMs，靠这条兜住。
 */
export const EDL_SHOT_MIN_MS = 800
export const EDL_SHOT_MAX_MS = 15_000

export interface EdlShotPlan {
  /** 镜头下标（对应客户端上传的分镜顺序，从 0 开始） */
  index: number
  /** 该镜头在时间线上应留的时长（ms，已粗夹） */
  targetMs: number
  /** 模型的取舍理由（可选，只用于日志，不参与计算） */
  reason?: string
}

/** 整片档位 + 逐镜头时长。`shots` 缺某些下标 = 那些镜头仍按用户选的档位走。 */
export interface Edl {
  pacing: EdlPacing
  transitions: EdlTransition
  subtitleStyle: EdlSubtitleStyle
  bgm: EdlBgm
  shots: EdlShotPlan[]
}

export interface EdlDefaults {
  pacing: EdlPacing
  transitions: EdlTransition
  subtitleStyle: EdlSubtitleStyle
  bgm: EdlBgm
}

export interface EdlParseResult {
  /** 解析成功（至少拿到 `shots`）；完全不可用时为 null ⇒ 调用方应退回原有档位 */
  edl: Edl | null
  /** 逐条「模型给的哪里不合法」。**只记日志/notice，绝不阻塞出片** */
  problems: string[]
}

/** 枚举字段的容错读取：大小写与首尾空格不敏感，不认识就退回默认值并记一条 problem */
function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
  problems: string[],
): T {
  if (typeof value === 'string') {
    const up = value.trim().toUpperCase()
    if ((allowed as readonly string[]).includes(up)) return up as T
    problems.push(`${field}="${value}" 不在允许集合 [${allowed.join('/')}] 内`)
    return fallback
  }
  if (value !== undefined && value !== null) problems.push(`${field} 不是字符串`)
  return fallback
}

/**
 * 把模型给的时长夹进合理区间；不是有限正数就返回 null（= 该镜头退回档位）。
 *
 * ★ 接受**数字字符串**：模型经常把 `targetMs` 写成 `"3200"`（见 parseEdl 的容错清单）。
 *   只按 `typeof === 'number'` 判，会把这类**有真实决策价值**的输出整条丢掉，
 *   而丢掉是**静默**的 —— 那个镜头悄悄退回面板档位，日志里只留一行 problem。
 *   ⚠ 这条是 2026-09-22 复核时补的：原实现与上面的容错清单不符（注释说要转数字，代码在丢）。
 * ★ 但**带单位的字符串必须丢弃**：`"3.2s"` 里是秒，`Number()` 得 NaN ⇒ 自然被拒。
 *   不要为它做单位换算 —— 模型给错单位时，我们对「它想说 3.2 秒还是 3.2 毫秒」
 *   没有任何可靠依据，猜错会让那个镜头差 1000 倍。
 * ★ 类型守卫只放 string / number：`Number([3200])` 也等于 3200，光看 `Number()` 的结果不够。
 */
export function clampShotMs(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const n = typeof value === 'number' ? value : Number(value.trim())
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(EDL_SHOT_MAX_MS, Math.max(EDL_SHOT_MIN_MS, Math.round(n)))
}

/**
 * 从模型返回的文本里抠出 JSON 对象。
 *
 * ★ 为什么要这么「脏」地抠：调用方拿到的是一段**自由文本**，实测模型会
 *   · 用 ```json … ``` 围栏包起来（最常见）；
 *   · 前面写一句「好的，这是我的剪辑方案：」；
 *   · 结尾再补一段解释。
 *   ⇒ 先剥围栏，再取**第一个 `{` 到最后一个 `}`**。不要试图用正则严格匹配 JSON，
 *     嵌套结构会让正则回溯爆炸。
 */
export function extractJsonObject(text: string): string | null {
  if (typeof text !== 'string' || !text) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced?.[1] ?? text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return body.slice(start, end + 1)
}

/**
 * 解析模型输出。
 *
 * 容错清单（都实测遇到过）：
 *   · ```json 围栏 / 前后废话 —— 见 extractJsonObject；
 *   · **尾逗号**（`[{...},]` / `{"a":1,}`）—— JSON.parse 直接抛，先正则清掉；
 *   · `shots` 写成对象而不是数组（`{"0":3200}`）—— 归一成数组；
 *   · `targetMs` 给了字符串（`"3200"`）或带单位（`"3.2s"`）—— 前者转数字，后者丢弃；
 *   · 下标越界 / 重复 —— 越界丢弃，重复取**先出现的那个**（模型通常先给主要镜头）。
 *
 * ★ 返回 `edl: null` 的唯一情形是「连 shots 都没解析出来」—— 那时调用方应完全退回档位，
 *   而不是拿一个空 shots 的 EDL 去覆盖（空 shots 与「不覆盖」语义相同，没必要区分）。
 */
export function parseEdl(raw: string, defaults: EdlDefaults): EdlParseResult {
  const problems: string[] = []
  const json = extractJsonObject(raw)
  if (!json) {
    return { edl: null, problems: ['模型输出里找不到 JSON 对象'] }
  }

  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    // 尾逗号是最常见的一种；清掉再试一次（仍失败才放弃）
    try {
      data = JSON.parse(json.replace(/,\s*([}\]])/g, '$1'))
    } catch (e) {
      return { edl: null, problems: [`JSON 解析失败：${(e as Error).message.slice(0, 80)}`] }
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { edl: null, problems: ['JSON 顶层不是对象'] }
  }

  const obj = data as Record<string, unknown>
  const pacing = pickEnum(obj.pacing, EDL_PACINGS, defaults.pacing, 'pacing', problems)
  const transitions = pickEnum(obj.transitions, EDL_TRANSITIONS, defaults.transitions, 'transitions', problems)
  const subtitleStyle = pickEnum(obj.subtitleStyle, EDL_SUBTITLE_STYLES, defaults.subtitleStyle, 'subtitleStyle', problems)
  const bgm = pickEnum(obj.bgm, EDL_BGMS, defaults.bgm, 'bgm', problems)

  // shots：数组优先；对象形态 `{"0":3200}` 归一成数组
  const rawShots = obj.shots
  let list: unknown[] = []
  if (Array.isArray(rawShots)) {
    list = rawShots
  } else if (rawShots && typeof rawShots === 'object') {
    list = Object.entries(rawShots as Record<string, unknown>).map(([k, v]) => ({
      index: Number(k),
      targetMs: v,
    }))
    problems.push('shots 是对象而不是数组，已按 index→targetMs 归一')
  } else if (rawShots !== undefined) {
    problems.push('shots 缺失或类型不对')
  }

  const shots: EdlShotPlan[] = []
  const seen = new Set<number>()
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      problems.push('shots 里有非对象元素，已跳过')
      continue
    }
    const row = item as Record<string, unknown>
    const index = typeof row.index === 'number' ? Math.trunc(row.index) : Number(row.index)
    if (!Number.isFinite(index) || index < 0) {
      problems.push(`镜头下标非法：${String(row.index)}`)
      continue
    }
    if (seen.has(index)) {
      problems.push(`镜头下标 ${index} 重复出现，已取先出现的那个`)
      continue
    }
    const targetMs = clampShotMs(row.targetMs)
    if (targetMs === null) {
      problems.push(`镜头 ${index} 的 targetMs 不可用：${String(row.targetMs)}`)
      continue
    }
    seen.add(index)
    const reason = typeof row.reason === 'string' && row.reason.trim() ? row.reason.trim().slice(0, 60) : undefined
    shots.push(reason ? { index, targetMs, reason } : { index, targetMs })
  }

  if (shots.length === 0) {
    return { edl: null, problems: [...problems, '没有解析出任何可用的镜头时长'] }
  }

  shots.sort((a, b) => a.index - b.index)
  return { edl: { pacing, transitions, subtitleStyle, bgm, shots }, problems }
}

/**
 * 把 EDL 的逐镜头时长摊成与 `clips` 等长的数组，**没给的下标是 null**。
 *
 * ★ 为什么用 null 而不是「用档位缩放的近似值」：`planShotTiming` 里 null 的含义是
 *   「这个镜头没有 EDL 指令，按用户选的档位算」—— 这是精确的语义，而塞一个近似值
 *   会让「模型漏了第 3 个镜头」这件事**静默消失**。
 */
export function toEdlShotMs(edl: Edl | null, clipCount: number): Array<number | null> {
  /**
   * ★ `new Array(n)` 对负数 / 小数会抛 `RangeError: Invalid array length`。
   *   调用方传的是 `clips.length`（恒为非负整数）⇒ 生产上不可达；
   *   但本函数在驱动层是**在 `generateEditPlan` 那段「绝不抛错」之外**被调用的，
   *   真抛出来就是整单 FAILED。一行夹取换掉这个形状，值得。
   */
  const n = Math.max(0, Math.trunc(clipCount))
  const out: Array<number | null> = new Array<number | null>(n).fill(null)
  if (!edl) return out
  for (const shot of edl.shots) {
    if (shot.index >= 0 && shot.index < n) out[shot.index] = shot.targetMs
  }
  return out
}
