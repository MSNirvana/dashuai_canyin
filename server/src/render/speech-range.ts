/**
 * 「哪一段有人在说话」→「哪些区间该保留」—— **纯函数**：零 I/O、零环境依赖、零 import。
 *
 * ⚠ 为什么要有这个模块（2026-09-29）：
 *
 *   用户原话：「AI 剪辑视频有一个问题，就是没有删除无用片段，比如视频的卡顿、人物没有说话的时候」。
 *   实测那条素材（19.48s）里 **11.06s 是空白** —— 头 1.55s、尾 0.76s，中间还有 4 处
 *   1.65~2.95s 的大停顿。这些全部被原样保留进了成片。
 *
 * ★★ 为什么不能用音量阈值（这是本模块存在的**唯一**理由）：
 *   最常规的做法是 `ffmpeg silencedetect`。实测这条手机直录素材：
 *     · 整体均量 `-16.0 dB`、峰值 `0.0 dB`（已削顶）⇒ 动态范围被压扁
 *     · 「说话」与「没说话」的电平差只有 **约 10 dB**
 *     · `-40dB / -30dB / -28dB / -25dB`、加 `highpass=f=150|200|250`、加 lowpass
 *       —— **几十种参数组合全部零命中**
 *   阈值法成立的前提是「静音区 ≪ 说话区」，这里不成立；而且换人换环境换手机都得重调阈值。
 *   ⇒ 判据换成**词级时间戳**（腾讯云 ASR `WordInfo: 1`）：它是「谁在什么时候说了哪个字」，
 *     语义级、与底噪无关、不需要调参。第一个词开口之前全是废片，最后一个字之后也是。
 *
 * ★★ 这个模块的**保守边界**（比裁剪本身更重要，别为了「剪得更狠」把它拆了）：
 *   1) **没有词就一律不剪** —— 餐饮 B-roll / 空镜 / 环境音素材本来就没有人声，
 *      「没人说话」恰恰是它的正常状态。原 `ffmpeg.ts::probeMeaningfulRange` 的注释
 *      写得很准：「安静不等于无意义……静音不能单独驱动画面裁切」。
 *      本模块沿用这条：只在**确实检出过词**、且人声覆盖率够高时才给结果，否则返回 null。
 *   2) **收益太小就不动** —— 为几百毫秒去重构整条时间轴（拆段、重排、重算转场余量）
 *      不划算，风险还全落在出片上。低于 `minGainMs` 直接返回 null。
 *   3) **自然呼吸必须留** —— 词间空白 < `pauseMs`（默认 500ms）的不算废片。
 *      把 200~300ms 的换气也剪掉，话会说得像机器人。
 *   4) **切口两侧留余量** —— 默认 200ms。卡在字头/字尾上会听出「秃」的一声。
 *
 * ★★ 为什么必须是纯函数（和 `edl.ts` / `chatcut-timing.ts` 同一个口径）：
 *   要被 `scripts/verify-speech-range.ts` 零依赖直接调用，把「给一堆离谱词表会算出什么」
 *   变成每次提交都能验的闸门。⚠ 别往这里 import 任何东西 —— 一旦引入连接，
 *   守护脚本就得连库/连网才能跑，这条闸门会很快被跳过。
 */

/** 一个词的时间跨度（ms）。`word` 只用于日志，不参与计算。 */
export interface SpeechWordSpan {
  startMs: number
  endMs: number
  word?: string
}

/** 素材时间轴上的一个区间（绝对坐标，相对素材起点）。 */
export interface KeepRange {
  startMs: number
  endMs: number
}

export interface SpeechKeepOptions {
  /** 词间空白 ≥ 此值（ms）才当废片。默认 `SPEECH_PAUSE_MS`。 */
  pauseMs?: number
  /** 每个切口两侧保留的余量（ms）。默认 `SPEECH_PAD_MS`。 */
  padMs?: number
  /** 整体收益小于此值（ms）就不动。默认 `SPEECH_MIN_GAIN_MS`。 */
  minGainMs?: number
  /** 人声覆盖率低于此值 ⇒ 判定为「没有口播」，一律不剪。默认 `SPEECH_MIN_RATIO`。 */
  minSpeechRatio?: number
}

export interface SpeechKeepPlan {
  /** 应保留的区间（升序、互不重叠、落在 [0, durationMs] 内） */
  ranges: KeepRange[]
  /** 保留总时长（ms） */
  keptMs: number
  /** 剪掉总时长（ms） */
  cutMs: number
  /** 第一个词的开口位置（ms）—— 它之前都是首部废片 */
  speechStartMs: number
  /** 最后一个词的收口位置（ms）—— 它之后都是尾部废片 */
  speechEndMs: number
  /** 被判定为「长停顿」的**内部**区间（已扣掉两侧 pad，仅用于日志/用户提示） */
  pauses: KeepRange[]
}

/**
 * 词间空白 ≥ 此值就算废片。
 * ★ 500ms 的依据：正常口语的句内换气在 150~350ms，跨句停顿普遍 > 600ms。
 *   取 500 正好落在两者之间 —— 再低会把正常断句节奏也剪掉。
 */
export const SPEECH_PAUSE_MS = 500

/**
 * 切口两侧保留的余量。
 * ★ 200ms 的依据：ASR 的词级边界本身有 ±50~100ms 抖动，卡着边界切会切到字头/字尾；
 *   留 200ms 实测听感上「只是稍微利落了一点」，不会听出断层。
 */
export const SPEECH_PAD_MS = 200

/**
 * 收益下限：剪不到这么多就别动。
 * ★ 400ms 的依据：每次裁剪都要把这段素材拆成多区间，进而重算转场余量与整条时间轴
 *   （见 `chatcut-timing.ts` 与 driver 的 adds 展开）。为一两百毫秒付这个代价不值得。
 */
export const SPEECH_MIN_GAIN_MS = 400

/**
 * 人声覆盖率下限。
 * ★ 0.12 的依据：本项目的镜头上限是 15s，一句最短的台词（约 1.5s）落在一个 12s 的镜头上
 *   覆盖率才 0.125。取 0.12 意味着「一整段里至少要说够一句话」才认它是口播素材；
 *   纯环境音（覆盖率 ≈ 0）会被干净地挡在外面。
 */
export const SPEECH_MIN_RATIO = 0.12

/** 区间长度（ms），非法值按 0。 */
function spanMs(range: KeepRange): number {
  return Math.max(0, range.endMs - range.startMs)
}

/** 把任意值夹成「0 ≤ v ≤ upper」的有限整数；非法值给 fallback。 */
function clampMs(value: unknown, upper: number, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(upper, Math.round(n)))
}

/** 把词表整理成「升序、合法、落在 [0, durationMs] 内」的区间；非法项直接丢掉。 */
function normalizeWords(words: readonly SpeechWordSpan[], durationMs: number): SpeechWordSpan[] {
  const list: SpeechWordSpan[] = []
  for (const raw of words ?? []) {
    const startMs = clampMs(raw?.startMs, durationMs, -1)
    if (startMs < 0) continue
    const endMs = clampMs(raw?.endMs, durationMs, -1)
    // ⚠ `endMs <= startMs` 的词是脏数据（ASR 偶尔给零长度词），不能当成「一个瞬间」留下 ——
    //   它会让聚合阶段误判出一个 0 长度的锚点，把 pad 拉出一个多余的段。
    if (endMs <= startMs) continue
    list.push({ startMs, endMs, word: raw?.word })
  }
  list.sort((a, b) => a.startMs - b.startMs)
  return list
}

/**
 * 主函数：词级时间戳 → 保留区间。
 *
 * 返回 `null` = **不剪**（调用方必须原样保留素材）。返回 null 的每一种情形都对应一条上面的保守边界：
 *   · 素材时长非法 / 词表为空 ⇒ 没法判、或本来就没口播
 *   · 人声覆盖率过低 ⇒ 判定为纯环境音素材（B-roll / 空镜）
 *   · 算出来的保留区间已覆盖整段 ⇒ 本来就没废片
 *   · 可剪收益 < `minGainMs` ⇒ 不值得动
 */
export function speechKeepRanges(input: {
  durationMs: number
  words: readonly SpeechWordSpan[]
  options?: SpeechKeepOptions
}): SpeechKeepPlan | null {
  const durationMs = Number(input?.durationMs)
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null

  const pauseMs = Math.max(0, input.options?.pauseMs ?? SPEECH_PAUSE_MS)
  const padMs = Math.max(0, input.options?.padMs ?? SPEECH_PAD_MS)
  const minGainMs = Math.max(0, input.options?.minGainMs ?? SPEECH_MIN_GAIN_MS)
  const minRatio = Math.max(0, Math.min(1, input.options?.minSpeechRatio ?? SPEECH_MIN_RATIO))

  const words = normalizeWords(input.words, durationMs)
  if (!words.length) return null

  // ── 人声覆盖率闸门：整段能说上话才认它是口播素材，否则一律不剪
  const voicedMs = words.reduce((sum, word) => sum + spanMs(word), 0)
  if (voicedMs / durationMs < minRatio) return null

  const speechStartMs = words[0]!.startMs
  const speechEndMs = words[words.length - 1]!.endMs

  // ── 聚合：相邻词的间隔（前一个词的 end → 后一个词的 start）≥ pauseMs 就断开成新的一段
  const pauses: KeepRange[] = []
  const groups: Array<{ startMs: number; endMs: number }> = []
  for (const word of words) {
    const current = groups[groups.length - 1]
    if (current && word.startMs - current.endMs < pauseMs) {
      current.endMs = Math.max(current.endMs, word.endMs)
      continue
    }
    if (current) pauses.push({ startMs: current.endMs, endMs: word.startMs })
    groups.push({ startMs: word.startMs, endMs: word.endMs })
  }

  // ── 每段向外扩 pad，再夹回 [0, durationMs]；扩出来后相邻两段若贴合/重叠就并回一段
  //    （pad 很大而停顿很小时会出现，并回去才不会造出 5ms 的无意义碎片段）
  const ranges: KeepRange[] = []
  for (const group of groups) {
    const startMs = clampMs(group.startMs - padMs, durationMs)
    const endMs = clampMs(group.endMs + padMs, durationMs)
    const previous = ranges[ranges.length - 1]
    if (previous && startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, endMs)
      continue
    }
    ranges.push({ startMs, endMs })
  }

  const keptMs = ranges.reduce((sum, range) => sum + spanMs(range), 0)
  const cutMs = Math.max(0, Math.round(durationMs) - keptMs)

  // 没有可剪的（保留区间已经铺满整段）⇒ 不剪
  if (cutMs <= 0) return null
  // 收益太小 ⇒ 不剪（见 SPEECH_MIN_GAIN_MS 的依据）
  if (cutMs < minGainMs) return null

  return { ranges, keptMs, cutMs, speechStartMs, speechEndMs, pauses }
}

/**
 * 把保留区间夹进一个时间窗（`[windowStartMs, windowEndMs]`），返回**素材绝对坐标**的区间。
 *
 * ★ 用途：用户/上游可能已经选过窗口（`Shot.trimStartMs` / `trimEndMs`），
 *   语音探针算出的区间不能越过它 —— 否则等于把用户明确表示「不要」的部分又剪了进来。
 *   ⚠ 夹完可能为空（窗口整段落在废片里），调用方必须处理这种情况。
 */
export function sliceKeepRanges(
  ranges: readonly KeepRange[],
  windowStartMs: number,
  windowEndMs: number,
): KeepRange[] {
  const start = Math.max(0, Math.round(windowStartMs))
  const end = Math.max(start, Math.round(windowEndMs))
  const sliced: KeepRange[] = []
  for (const range of ranges ?? []) {
    const from = Math.max(start, Math.round(range.startMs))
    const to = Math.min(end, Math.round(range.endMs))
    if (to - from < 100) continue // 碎片段没意义，且会让下游帧数算出 0
    const previous = sliced[sliced.length - 1]
    if (previous && from <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, to)
      continue
    }
    sliced.push({ startMs: from, endMs: to })
  }
  return sliced
}

/**
 * 求「窗口内的保留区间」的补集 —— 也就是**要删掉的区间**，坐标已转成**相对窗口起点**。
 *
 * ★ 为什么坐标要转：本地 ffmpeg 路径先按窗口裁出 `norm_x.mp4`（PTS 已归零），
 *   再在那个产物上挖洞（`ffmpegRemoveTimeRanges`）⇒ 挖洞用的区间必须是**相对窗口**的。
 *   这一步算错就会挖错位置，而且症状是「画面被切花了」而不是报错，很难回查。
 *
 * ⚠ 传进来的 `keptRanges` 必须是**已经夹过窗口**的（用 `sliceKeepRanges`），否则会算出反的补集。
 */
export function cutRangesInWindow(
  keptRanges: readonly KeepRange[],
  windowStartMs: number,
  windowEndMs: number,
  minGapMs = 100,
): KeepRange[] {
  const start = Math.max(0, Math.round(windowStartMs))
  const end = Math.max(start, Math.round(windowEndMs))
  const cuts: KeepRange[] = []
  let cursor = start
  for (const range of keptRanges ?? []) {
    const from = Math.max(start, Math.round(range.startMs))
    if (from - cursor >= minGapMs) cuts.push({ startMs: cursor - start, endMs: from - start })
    cursor = Math.max(cursor, Math.round(range.endMs))
  }
  if (end - cursor >= minGapMs) cuts.push({ startMs: cursor - start, endMs: end - start })
  return cuts
}

/**
 * 把保留区间转换成「每段在素材里的起点 + 时长」。
 *
 * ★ 只用于日志与诊断（打印「切了哪几刀」），**不参与排轨** ——
 *   落地方案是「先在本地把素材剪成一段连续文件，再交给下游」
 *   （见 `speech-cut.ts`），因为 ChatCut 的 clip 是单区间模型，
 *   与其在下游把一段素材拆成 N 条 clip，不如在上游就合成一段。
 */
export function toSourceSegments(
  keptRanges: readonly KeepRange[],
): Array<{ sourceStartMs: number; durationMs: number }> {
  return (keptRanges ?? [])
    .map((range) => ({
      sourceStartMs: Math.max(0, Math.round(range.startMs)),
      durationMs: Math.max(0, Math.round(range.endMs) - Math.round(range.startMs)),
    }))
    .filter((segment) => segment.durationMs >= 100)
}

/* ───────────────────────── 落库计划（Shot.keepRanges）───────────────────────── */

/**
 * 判定版本：**判据或聚合方式变化时必须递增**，否则线上会继续命中旧结论。
 *   v1（2026-09-29）：初版。词间空白 ≥ 500ms 判为废片、切口两侧各留 200ms。
 */
export const SHOT_SPEECH_VERSION = 1

/** 落库的计划结构（`Shot.keepRanges`）。存的是**素材绝对坐标**，与任何 trim 窗口无关。 */
export interface ShotSpeechPlan {
  v: number
  /** 要保留的区间；`[]` = 探测成功但无需裁剪（与「没探测过」不同，后者是字段为 NULL） */
  ranges: KeepRange[]
  /** 判定时使用的参数指纹：任一项不同则旧结论失效 */
  pauseMs: number
  padMs: number
  /** 素材时长（ms），用于 sanity check 结论是否还对得上这条素材 */
  durationMs: number
  /** 识别到的文本（截断，仅供排查） */
  text: string
}

/**
 * 生效的阈值参数。允许用环境变量微调，**无需重新出包**。
 * ★ 放在纯函数模块里（只读 `process.env`、零 I/O），这样阈值解析本身也能被守护脚本覆盖。
 */
export function shotSpeechOptions(): Required<SpeechKeepOptions> {
  const num = (raw: string | undefined, fallback: number): number => {
    const value = Number((raw ?? '').trim())
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }
  return {
    pauseMs: num(process.env.SHOT_SPEECH_PAUSE_MS, SPEECH_PAUSE_MS),
    padMs: num(process.env.SHOT_SPEECH_PAD_MS, SPEECH_PAD_MS),
    minGainMs: num(process.env.SHOT_SPEECH_MIN_GAIN_MS, SPEECH_MIN_GAIN_MS),
    minSpeechRatio: num(process.env.SHOT_SPEECH_MIN_RATIO, SPEECH_MIN_RATIO),
  }
}

/**
 * 把任意值解析成「落库计划」；**未命中一律返回 null ⇒ 必须重算**。
 *
 * ★★ 这里的三条判据少一条都会变成「改了没反应」：
 *   · 版本不符（`v !== SHOT_SPEECH_VERSION`）⇒ 判据换过了，旧结论不能再用
 *   · **参数指纹不符**（`pauseMs` / `padMs`）⇒ 用户把阈值调了，旧结论必须作废
 *   · 形状脏（不数组 / 区间非法 / end ≤ start）⇒ 宁可重算，也不能拿一份半坏的计划去剪
 *   ⚠ 别为了「省一次 ASR」把这几条放宽 —— 省下的是一次几厘钱的调用，
 *     换来的是「线上剪法改了但成片一模一样」这种要查半天的问题。
 */
export function parseShotSpeechPlan(
  raw: unknown,
  options: Required<SpeechKeepOptions>,
): ShotSpeechPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Partial<ShotSpeechPlan>
  if (row.v !== SHOT_SPEECH_VERSION) return null
  if (row.pauseMs !== options.pauseMs || row.padMs !== options.padMs) return null
  if (!Array.isArray(row.ranges)) return null
  const ranges: KeepRange[] = []
  for (const item of row.ranges) {
    const startMs = Math.round(Number((item as KeepRange)?.startMs))
    const endMs = Math.round(Number((item as KeepRange)?.endMs))
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null
    ranges.push({ startMs, endMs })
  }
  return {
    v: SHOT_SPEECH_VERSION,
    ranges,
    pauseMs: row.pauseMs,
    padMs: row.padMs,
    durationMs: Math.round(Number(row.durationMs)) || 0,
    text: typeof row.text === 'string' ? row.text : '',
  }
}
