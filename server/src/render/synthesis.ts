// AI 合成（aiMode=true）：给拼接后的成片叠加「AI 配音(TTS) + 字幕 + 智能节奏」
// 处理顺序（在 concat 之后）：
//   1) 逐分镜用其口播文案 line 做 TTS（未配真实服务时为等长静音轨，见 tts.ts）
//   2) 按分镜在成片中的时间轴生成 SRT 字幕并烧录进画面（依赖 libass + CJK 字体，缺失时降级仅配音）
//   3) 配音音频替换原静音轨，与画面时间轴严格对齐
// 智能剪辑节奏：口播时长驱动每镜字幕停留（已按分镜时长布时）；更细的节拍检测留作后续能力。
import { join } from 'node:path'
import { writeFile, rm, mkdtemp, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import sharp from 'sharp'
import { synthesizeNarration } from './tts.js'
import {
  ffmpegBin,
  ffmpegConcat,
  ffmpegExtractAudio,
  ffmpegExtendVideo,
  ffmpegSupportsFilter,
  ffmpegSupportsSubtitles,
  hasAudioStream,
  probeDurationMs,
  probeSpeechEndMs,
  MAX_SPEECH_TEMPO,
} from './ffmpeg.js'
import { transcribeAudio, type TranscriptionSegment } from './transcription.js'
import type { TtsProviderConfig } from '../services/tts-provider.service.js'

const execFileP = promisify(execFile)

// Fixed against the actual 1080x1920 output canvas. ASS must declare the same
// PlayRes or libass interprets these values against its legacy 384x288 canvas.
/**
 * 字幕字号倍率 —— **只改这一个数**。
 *
 * ★ 基准 52px 是历史值；2026-09-25 用户要求「字幕大小放大两倍」⇒ 2。
 * ★★ 字号**不是孤立常量**。下面这些全部由它推导，改字号时不要各路径各改一处
 *   （本项目在「字幕底边距」上已经吃过一次「散成三处」的亏）：
 *   · `SUBTITLE_MAX_WIDTH`      —— 像素预算固定 ⇒ 字大了每行就只能少放几个字，否则冲出画布；
 *   · `SUBTITLE_OUTLINE` / `SUBTITLE_BORDER_WIDTH` —— 描边等比放大，否则字越大黑边越细，
 *     而描边存在的唯一理由就是可读性；
 *   · `SUBTITLE_CAPTION_SVG_*`  —— Sharp 回退路径的**画布尺寸**，不跟着走会把字形裁掉。
 */
const SUBTITLE_FONT_SCALE = 2
// ★ 下面带 `export` 的几个常量是**故意导出**的：守护脚本要断言「字号 ↔ 每行字数 ↔ SVG 画布」
//   这组耦合关系（见 scripts/verify-auto-edit.ts）。别把 export 去掉、改成在脚本里写死数字 ——
//   那正是这套耦合过去悄悄失效的原因。
export const SUBTITLE_FONT_SIZE = 52 * SUBTITLE_FONT_SCALE
/** ASS 的 `Outline` 与 Sharp SVG 的 `stroke-width`（52px 基准时是 3）。 */
export const SUBTITLE_OUTLINE = 3 * SUBTITLE_FONT_SCALE
/** drawtext 的 `borderw`（52px 基准时是 2，本来就比另外两条路径细一档，这里保持这个比例）。 */
const SUBTITLE_BORDER_WIDTH = 2 * SUBTITLE_FONT_SCALE
/**
 * Sharp 回退路径的 SVG 画布高度与文字基线（52px 基准时是 82 / 56）。
 *
 * ⚠ 这是**画布**不是样式：字号放大而画布不动 ⇒ 字形被 sharp 直接裁掉，而且**不报错**，
 *   成片里只是「字少了半个」。这是「放大字幕」最容易漏的一处，所以让它由字号推导，
 *   并由 `verify-auto-edit.ts` 断言「画布装得下字号」。
 */
export const SUBTITLE_CAPTION_SVG_HEIGHT = 82 * SUBTITLE_FONT_SCALE
const SUBTITLE_CAPTION_SVG_BASELINE = 56 * SUBTITLE_FONT_SCALE
/**
 * 字幕底边距（相对 PlayResY=1920 的像素）。
 *
 * ★★ 2026-09-24 实测修正 116 → **640**（用户看对照图后定的值）。
 *   旧值 116 = 仅高出画面底边 6.0%，实测成片字幕glyph带落在 **y≈1770~1835（画面高度的
 *   92~96%）**，正压在抖音/视频号底部的叠加层上（账号名、文案、音乐名、进度条大致占据
 *   下方约 1/5）—— 用户反馈「字幕位置特别低」就是这个。
 *   640 ⇒ 字幕带 y≈1246~1311（约 65~68%），离底边留足白，也被用户选中。
 *   ⚠ 这个 1/5 是**估算**，不同端/不同版本会变；真机上仍被平台控件压住就继续加大这个值，
 *     不要再各路径各改一处。
 * ★ 该常量在每条烧字幕路径上生效（ASS 的 MarginV、drawtext 的 y=h-text_h-…、
 *   overlay 的 y=main_h-overlay_h-… 三处共用），所以只改这一行即可。
 * ⚠ `MarginV` 与字幕**墨迹底边并不重合**（libass 行盒含 descent，实测差约 31px；字号翻倍后
 *   这个差值也会同步变大）⇒ 上面那串「y≈…」是**量出来的**，不要用旧值去反推像素位置。
 * ★★ 2026-09-25 用户要求**换回 116**（与上面 09-24 的判断相反，属按用户意愿覆盖）。
 *   ⚠ 同时字号已放大到 104px ⇒ 墨迹带落在画面高度的 87~92% 一带，比 09-24 用 116 时略高
 *     （字更高），但仍在平台底部叠加层可能够到的范围。真机若被压住，只改这一个值。
 */
export const SUBTITLE_BOTTOM_MARGIN = 116
/**
 * 字幕块的**像素宽上限**（相对 1080 的画布宽）。
 *
 * ★ 832px ≈ 画布宽的 77%，两侧各留 ~124px 白 —— 这个「呼吸感」是刻意保留的，不是随手取的数。
 * ★ 为什么不再写成「最多 14 个字」：字数与字号是同一件事的两种说法，**写死字数会在改字号时
 *   悄悄失效** —— 14 字 × 104px = 1456px，直接冲出 1080 画布（被裁掉、或被 libass 强制折成
 *   两行，而本模块专门在避免折行）。所以这里固定**像素**、由字号推字数。
 */
const SUBTITLE_BLOCK_WIDTH_PX = 832
/** 单条字幕的安全显示宽度（CJK 按 1、ASCII 按 0.55 计）；字号 104px 时推得 8。 */
export const SUBTITLE_MAX_WIDTH = Math.floor(SUBTITLE_BLOCK_WIDTH_PX / SUBTITLE_FONT_SIZE)

export interface SynthesisShot {
  /** 口播文案（Shot.line） */
  line?: string | null
  /** 该分镜在成片中的时长（毫秒） */
  durationMs: number
}

/**
 * 把镜头语义时间槽对齐到真实成片时长。转场会让相邻镜头重叠，不能只在片尾补时长，
 * 否则第二个镜头起字幕就开始延迟。这里把实际重叠量均匀扣在每个接缝之前。
 */
export function fitShotDurationsToTimeline(shots: SynthesisShot[], targetDurationMs: number): SynthesisShot[] {
  if (!shots.length || targetDurationMs <= 0) return shots
  const sourceTotal = shots.reduce((sum, shot) => sum + Math.max(0, shot.durationMs), 0)
  if (sourceTotal <= 0 || Math.abs(sourceTotal - targetDurationMs) <= 30) return shots
  if (shots.length === 1) return [{ ...shots[0]!, durationMs: targetDurationMs }]
  const overlapPerBoundary = Math.max(0, sourceTotal - targetDurationMs) / (shots.length - 1)
  const result = shots.map((shot, index) => ({
    ...shot,
    durationMs: index < shots.length - 1
      ? Math.max(300, Math.round(shot.durationMs - overlapPerBoundary))
      : Math.max(300, Math.round(shot.durationMs)),
  }))
  const beforeLast = result.slice(0, -1).reduce((sum, shot) => sum + shot.durationMs, 0)
  result[result.length - 1] = {
    ...result[result.length - 1]!,
    durationMs: Math.max(300, targetDurationMs - beforeLast),
  }
  return result
}

export interface SynthesisOptions {
  /** false 时由调用方保留素材原声，不生成旁白轨 */
  voiceEnabled?: boolean
  /** false 时仍可生成旁白，但不烧录字幕 */
  subtitles?: boolean
  /** 字幕来源；未传时兼容旧逻辑：有旁白就按文案生成字幕。 */
  subtitleMode?: 'OFF' | 'VOICE' | 'SOURCE_AUDIO' | 'VOICE_AND_SOURCE'
  /** 用户自定义配音文件，优先于逐镜头 TTS。 */
  customVoicePath?: string
  /** 原视频音频来源，用于无旁白时的语音识别。 */
  sourceAudioPath?: string
  /** 对最终音轨做响度均衡。 */
  normalizeAudio?: boolean
  /** 删除明显过长的静音段，并用静音补回视频总时长。 */
  removeSilence?: boolean
  /** 已生成或已授权的背景音乐文件；默认模式会与原声/旁白轻量混音。 */
  backgroundMusicPath?: string
  /** 背景音乐相对音量，默认 -22dB 左右的存在感。 */
  backgroundMusicGain?: number
}

function toSrtTime(msIn: number): string {
  const t = Math.max(0, Math.round(msIn))
  const h = Math.floor(t / 3_600_000)
  const m = Math.floor((t % 3_600_000) / 60_000)
  const s = Math.floor((t % 60_000) / 1000)
  const ms = t % 1000
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`
}

function toAssTime(msIn: number): string {
  const totalCentiseconds = Math.max(0, Math.round(msIn / 10))
  const h = Math.floor(totalCentiseconds / 360_000)
  const m = Math.floor((totalCentiseconds % 360_000) / 6_000)
  const s = Math.floor((totalCentiseconds % 6_000) / 100)
  const cs = totalCentiseconds % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** 生成 SRT：无口播的分镜不产生字幕块，但时间轴继续推进 */
function buildSrt(shots: SynthesisShot[]): string {
  let cursor = 0
  let idx = 0
  const blocks: string[] = []
  for (const shot of shots) {
    const text = (shot.line ?? '').trim()
    if (text) {
      idx++
      blocks.push(`${idx}\n${toSrtTime(cursor)} --> ${toSrtTime(cursor + shot.durationMs)}\n${text}\n`)
    }
    cursor += shot.durationMs
  }
  return blocks.join('\n')
}

function lineSegments(shots: SynthesisShot[]): TranscriptionSegment[] {
  let cursor = 0
  const segments: TranscriptionSegment[] = []
  for (const shot of shots) {
    const text = (shot.line ?? '').trim()
    if (text && shot.durationMs > 0) segments.push({ startMs: cursor, endMs: cursor + shot.durationMs, text })
    cursor += Math.max(0, shot.durationMs)
  }
  return segments
}

export function subtitleDisplayWidth(text: string): number {
  return [...text].reduce((sum, char) => sum + (/^[\x00-\xff]$/.test(char) ? 0.55 : 1), 0)
}

/**
 * 无标点长句的兜底切分（标点可用时轮不到它）。
 *
 * ★ 为什么改成「先算块数再均分」，而不是原来的「填满一行再换行」：
 *   贪心填满会把余数全甩到**最后一块**。实测生产成片（task 32）尾部因此出现
 *   只有 **2 个字、停留 0.37s** 的孤儿 cue「吃呢」—— 一闪而过，观感就是「分段不好」。
 *   现在先算需要几块 `n = ceil(总宽 / 单块上限)`，再按 `总宽 / n` 均匀切：
 *   构造上每块仍 ≤ maxWidth，但不会再留孤儿块。
 */
function hardSplitSubtitle(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return text.trim() ? [text.trim()] : []
  const chars = [...text]
  const widths = chars.map(subtitleDisplayWidth)
  const total = widths.reduce((sum, value) => sum + value, 0)
  if (total <= maxWidth) return text.trim() ? [text.trim()] : []
  const target = total / Math.ceil(total / maxWidth)
  const chunks: string[] = []
  let current = ''
  let width = 0
  for (let index = 0; index < chars.length; index += 1) {
    const charWidth = widths[index] ?? 0
    // 到均分目标就收口；再加一个字会超上限也必须收口
    if (current && (width >= target || width + charWidth > maxWidth)) {
      chunks.push(current.trim())
      current = ''
      width = 0
    }
    current += chars[index] ?? ''
    width += charWidth
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.filter(Boolean)
}

/**
 * 去掉字幕块**末尾**的标点。
 *
 * ★★ 2026-09-25 用户要求「每句字幕去除所有末尾的标点符号」。
 * ★ 放在 `splitSubtitleText` 的**出口**统一做，而不是在几个 push 点各做一次：句末切分
 *   （。！？；）与从句切分（，、：）都会把标点留在块尾，四个 push 点各写一遍迟早漏一个；
 *   出口做一次，之后新增任何切分分支都自动被覆盖。
 * ★★ 只吃「标点 + 紧随其后的收尾符号」，**不动单独出现的引号/括号** —— 这条边界是刻意的：
 *   · 「他说“没问题”。」→ 只掉「。」，保留成对的收尾引号（那是对的）；
 *   · 「今天真好（笑）」→ 末尾不是标点，整个「（笑）」保留；若只砍掉「）」会留下不成对的「（笑」。
 *   别为了「更彻底」把引号括号也一律砍掉。
 */
const TRAILING_PUNCTUATION = /[\s。．，、；：！？…⋯·,;:!?.～~]+[”’」』》】）)\]]*$/u

export function stripTrailingPunctuation(text: string): string {
  return text.replace(TRAILING_PUNCTUATION, '').trim()
}

/** 先按完整句拆，再按逗号等语义停顿拆；最后才按安全宽度硬切。每块末尾不留标点。 */
export function splitSubtitleText(text: string, maxWidth = SUBTITLE_MAX_WIDTH): string[] {
  const clean = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const sentences = clean.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [clean]
  const result: string[] = []
  for (const sentence of sentences) {
    // ★ 切分子句**必须带着标点**（标点就是边界依据），但切完立刻去掉块尾标点再量宽度：
    //   「第一句话完整显示。」去标点后是 8 个字、能整块显示；若带着「。」去量就会多出 1 个字
    //   而被硬切一刀，白白把一句完整的话劈成两半。
    const clauses = (sentence.trim().match(/[^，、,:：]+[，、,:：]?/g) ?? [sentence.trim()])
      .map(stripTrailingPunctuation)
      .filter(Boolean)
    let current = ''
    for (const clause of clauses) {
      if (current && subtitleDisplayWidth(`${current}${clause}`) > maxWidth) {
        result.push(...hardSplitSubtitle(current, maxWidth))
        current = clause
      } else {
        current += clause
      }
    }
    if (current) result.push(...hardSplitSubtitle(current, maxWidth))
  }
  // ★ 出口再兜一次：硬切是按字数切的，理论上不会重新引入标点，但兜底无害。
  return result.map(stripTrailingPunctuation).filter(Boolean)
}

/** 将字幕归一为单行、非重叠、连续替换的 cue，避免 libass 自动换成多行。 */
export function normalizeSubtitleSegments(segments: TranscriptionSegment[]): TranscriptionSegment[] {
  const expanded: TranscriptionSegment[] = []
  for (const segment of mergeSubtitleSegments(segments)) {
    const text = String(segment.text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const chunks = splitSubtitleText(text)
    const start = Math.max(0, Math.round(segment.startMs))
    const end = Math.max(start + 300, Math.round(segment.endMs))
    const span = Math.max(1, end - start)
    const weights = chunks.map((chunk) => Math.max(1, subtitleDisplayWidth(chunk)))
    const totalWeight = weights.reduce((sum, value) => sum + value, 0)
    let consumedWeight = 0
    chunks.forEach((chunk, index) => {
      const chunkStart = start + Math.round((span * consumedWeight) / totalWeight)
      consumedWeight += weights[index] ?? 1
      const chunkEnd = index === chunks.length - 1 ? end : start + Math.round((span * consumedWeight) / totalWeight)
      expanded.push({ startMs: chunkStart, endMs: Math.max(chunkStart + 250, chunkEnd), text: chunk })
    })
  }
  expanded.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const result: TranscriptionSegment[] = []
  let cursor = 0
  for (const segment of expanded) {
    const start = Math.max(cursor, segment.startMs)
    const end = Math.max(start + 250, segment.endMs)
    if (end <= start) continue
    result.push({ ...segment, startMs: start, endMs: end })
    cursor = end
  }
  return result
}

/**
 * ASR 服务可能因为内部长度上限把一句没有标点的口语拆成多个 segment。
 * 先按连续语流合并，再做字幕宽度切分，避免出现“说不是冻货 / 6小时到店 / 锁鲜只”这种
 * 半句话字幕。遇到明确句末标点、明显停顿或一段语音过长时才结束当前语义段。
 */
export function mergeSubtitleSegments(segments: TranscriptionSegment[]): TranscriptionSegment[] {
  const ordered = segments
    .map((segment) => ({
      startMs: Math.max(0, Math.round(segment.startMs)),
      endMs: Math.max(0, Math.round(segment.endMs)),
      text: String(segment.text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(),
    }))
    .filter((segment) => segment.text && segment.endMs > segment.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const result: TranscriptionSegment[] = []
  for (const segment of ordered) {
    const previous = result[result.length - 1]
    if (!previous) {
      result.push({ ...segment })
      continue
    }
    const gapMs = Math.max(0, segment.startMs - previous.endMs)
    const previousHasSentenceEnd = /[。！？!?；;.!?]$/.test(previous.text)
    const currentSpanMs = segment.endMs - previous.startMs
    const shouldMerge = !previousHasSentenceEnd && gapMs <= 900 && currentSpanMs <= 8_000
    if (shouldMerge) {
      previous.text += segment.text
      previous.endMs = Math.max(previous.endMs, segment.endMs)
    } else {
      result.push({ ...segment })
    }
  }
  return result
}

function segmentsToSrt(segments: TranscriptionSegment[]): string {
  return normalizeSubtitleSegments(segments).map((segment, index) => (
    `${index + 1}\n${toSrtTime(segment.startMs)} --> ${toSrtTime(segment.endMs)}\n${segment.text}\n`
  )).join('\n')
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/[\r\n]+/g, ' ')
}

/** Build a single-line ASS document with an explicit vertical-video canvas. */
export function segmentsToAss(segments: TranscriptionSegment[], fontFamily = 'Noto Sans CJK SC'): string {
  const cues = normalizeSubtitleSegments(segments)
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontFamily},${SUBTITLE_FONT_SIZE},&H00FFFFFF,&H000000FF,&H00101010,&H00000000,-1,0,0,0,100,100,0,0,1,${SUBTITLE_OUTLINE},0,2,72,72,${SUBTITLE_BOTTOM_MARGIN},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`
  const events = cues.map((segment) => (
    `Dialogue: 0,${toAssTime(segment.startMs)},${toAssTime(segment.endMs)},Default,,0,0,0,,${escapeAssText(segment.text)}`
  ))
  return `${header}\n${events.join('\n')}\n`
}

export function shouldExtendForNarration(
  voiceEnabled: boolean,
  line: string | null | undefined,
  visualMs: number | null,
  speechMs: number,
): boolean {
  return voiceEnabled && Boolean(line?.trim()) && Boolean(visualMs && speechMs > visualMs + 100)
}

function audioFilter(options: SynthesisOptions): string {
  const filters: string[] = []
  if (options.removeSilence) {
    filters.push('silenceremove=start_periods=1:start_duration=0.15:start_threshold=-45dB:stop_periods=-1:stop_duration=0.35:stop_threshold=-45dB')
  }
  if (options.normalizeAudio) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
  return filters.join(',')
}

async function processVoiceTrack(input: string, output: string, targetDurationMs: number, options: SynthesisOptions, timeoutMs: number, tempo = 1): Promise<void> {
  const filters = [tempo > 1.0001 ? `atempo=${Math.min(MAX_SPEECH_TEMPO, tempo).toFixed(4)}` : '', audioFilter(options), 'apad'].filter(Boolean).join(',')
  await execFileP(ffmpegBin(), [
    '-i', input, '-vn', '-af', filters,
    '-t', (Math.max(1, targetDurationMs) / 1000).toFixed(3),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-y', output,
  ], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
}

interface CjkFont {
  family: string
  dir: string
  file?: string
}

/** 探测可用的 CJK 字体（libass 烧字幕用）。 */
function detectCjkFont(): CjkFont | null {
  const candidates: CjkFont[] = [
    { family: 'PingFang SC', dir: '/System/Library/Fonts', file: '/System/Library/Fonts/PingFang.ttc' },
    { family: 'STHeiti', dir: '/System/Library/Fonts', file: '/System/Library/Fonts/STHeiti Medium.ttc' },
    { family: 'Arial Unicode MS', dir: '/Library/Fonts', file: '/Library/Fonts/Arial Unicode.ttf' },
    { family: 'Noto Sans CJK SC', dir: '/usr/share/fonts/opentype/noto', file: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc' },
    { family: 'WenQuanYi Zen Hei', dir: '/usr/share/fonts/truetype/wqy', file: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc' },
    { family: 'Droid Sans Fallback', dir: '/usr/share/fonts/truetype/droid', file: '/usr/share/fonts/truetype/droid/DroidSansFallback.ttf' },
  ]
  for (const c of candidates) {
    if (existsSync(c.dir) && (!c.file || existsSync(c.file))) return c
  }
  return null
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * 对成片应用 AI 合成。
 * 返回 { subtitled } 表示是否成功烧录字幕（配音始终尝试，配音失败则退化为原静音轨）。
 */
export async function applyAiSynthesis(
  videoPath: string,
  shots: SynthesisShot[],
  outPath: string,
  timeoutMs = 180_000,
  provider?: TtsProviderConfig | null,
  options: SynthesisOptions = {},
): Promise<{ subtitled: boolean }> {
  const workDir = await mkdtemp(join(tmpdir(), 'dashuai-ai-'))
  try {
    const voiceEnabled = options.voiceEnabled !== false
    const subtitleMode = options.subtitles === false ? 'OFF' : (options.subtitleMode ?? (voiceEnabled ? 'VOICE' : 'OFF'))
    let muxVideoPath = videoPath
    let voicePath: string | null = null
    const generatedVoice = voiceEnabled && !options.customVoicePath
    if (options.customVoicePath) {
      voicePath = options.customVoicePath
    } else if (generatedVoice && shots.length > 0) {
      // 1) 逐分镜 TTS：每个分镜产出与画面等长的音频，保证时间轴稳定。
      const narrationFiles: string[] = []
      for (let i = 0; i < shots.length; i++) {
        const shot = shots[i]
        if (!shot) continue
        const durMs = Math.max(1, Math.round(shot.durationMs))
        const text = (shot.line ?? '').trim()
        const npath = join(workDir, `narr_${i}.m4a`)
        try {
          await synthesizeNarration(text, durMs, npath, provider, timeoutMs)
          narrationFiles.push(npath)
        } catch (e) {
          console.warn(`[synthesis] 分镜 ${i} 配音失败，用静音兜底：`, (e as Error).message)
          await synthSilence(durMs, npath, timeoutMs)
          narrationFiles.push(npath)
        }
      }
      if (narrationFiles.length) {
        voicePath = join(workDir, 'narration.m4a')
        await ffmpegConcat(narrationFiles, voicePath, timeoutMs)
      }
    }
    if (voicePath) {
      let targetDurationMs = (await probeDurationMs(videoPath)) ?? Math.max(1, shots.reduce((sum, shot) => sum + shot.durationMs, 0))
      // 自定义配音或第三方 TTS 可能比镜头更长。最多提速 1.35 倍，超过这个阈值就延长最后画面，
      // 保证整句说完后才结束视频，而不是用 -t 从中间截断。
      const speechEndMs = await probeSpeechEndMs(voicePath, timeoutMs).catch(() => null)
      const requiredDurationMs = speechEndMs && speechEndMs > targetDurationMs
        ? Math.ceil(speechEndMs / MAX_SPEECH_TEMPO)
        : targetDurationMs
      if (requiredDurationMs > targetDurationMs + 100) {
        muxVideoPath = join(workDir, 'video-extended.mp4')
        await ffmpegExtendVideo(videoPath, muxVideoPath, requiredDurationMs, timeoutMs)
        targetDurationMs = requiredDurationMs
      }
      const tempo = speechEndMs && targetDurationMs > 0 ? Math.min(MAX_SPEECH_TEMPO, speechEndMs / targetDurationMs) : 1
      const processedVoicePath = join(workDir, 'voice-processed.m4a')
      // 旁白已经按镜头切成固定时间槽；再次做 silenceremove 会把槽间停顿挤掉，
      // 造成字幕和画面边界整体漂移。停顿清理只作用于保留原声的路径。
      await processVoiceTrack(voicePath, processedVoicePath, targetDurationMs, { ...options, removeSilence: false }, timeoutMs, tempo)
      voicePath = processedVoicePath
    }

    // 2) 组装字幕片段：旁白优先使用文案，原视频声音则调用 ASR。
    let subtitleSegments: TranscriptionSegment[] = []
    if (subtitleMode === 'VOICE' || subtitleMode === 'VOICE_AND_SOURCE') {
      if (options.customVoicePath) {
        const voiceWav = join(workDir, 'custom-voice.wav')
        await ffmpegExtractAudio(options.customVoicePath, voiceWav, timeoutMs)
        const asr = await transcribeAudio(voiceWav, timeoutMs).catch((e) => {
          console.warn('[synthesis] 自定义配音 ASR 失败：', (e as Error).message)
          return null
        })
        subtitleSegments = asr?.segments ?? []
      } else {
        subtitleSegments = lineSegments(shots)
      }
    }
    if (subtitleMode === 'SOURCE_AUDIO' || subtitleMode === 'VOICE_AND_SOURCE') {
      const source = options.sourceAudioPath ?? videoPath
      const sourceWav = join(workDir, 'source-audio.wav')
      const asr = await (async () => {
        try {
          await ffmpegExtractAudio(source, sourceWav, timeoutMs)
          return await transcribeAudio(sourceWav, timeoutMs)
        } catch (e) {
          console.warn('[synthesis] 原视频语音识别失败：', (e as Error).message)
          return null
        }
      })()
      if (asr?.segments?.length) subtitleSegments = [...subtitleSegments, ...asr.segments].sort((a, b) => a.startMs - b.startMs)
    }
    // 没有 ASR 配置时，SOURCE_AUDIO 仍尽量使用已有分镜文案，不让任务失败。
    if (!subtitleSegments.length && (subtitleMode === 'SOURCE_AUDIO' || subtitleMode === 'VOICE_AND_SOURCE')) {
      subtitleSegments = lineSegments(shots)
    }
    const normalizedSubtitleSegments = subtitleMode === 'OFF' ? [] : normalizeSubtitleSegments(subtitleSegments)
    let mixedAudioPath = voicePath
    if (options.backgroundMusicPath) {
      mixedAudioPath = join(workDir, 'mixed-audio.m4a')
      await mixAudioTracks(muxVideoPath, voicePath, options.backgroundMusicPath, mixedAudioPath, timeoutMs, options)
    }
    const font = detectCjkFont()
    let subtitled = false
    // ASR 暂不可用时不阻断出片：有文案就使用文案，没有文本则交付无字幕成片并留日志。
    if (subtitleMode !== 'OFF' && !normalizedSubtitleSegments.length) console.warn('[synthesis] 字幕开启但没有可用文本，跳过烧录')
    if (normalizedSubtitleSegments.length) {
      if (!font) throw new Error('字幕无法生成：服务器未安装可用的中文字体，请安装 fonts-noto-cjk')
      if (await ffmpegSupportsSubtitles()) {
        const assPath = join(workDir, 'subs.ass')
        await writeFile(assPath, segmentsToAss(normalizedSubtitleSegments, font.family), 'utf8')
        subtitled = await muxWithSubtitles(muxVideoPath, mixedAudioPath, assPath, font, outPath, timeoutMs, options)
      } else if (await ffmpegSupportsFilter('drawtext')) {
        console.warn('[synthesis] FFmpeg 缺少 libass，改用 drawtext 烧录字幕')
        subtitled = await muxWithDrawtext(muxVideoPath, mixedAudioPath, normalizedSubtitleSegments, font, outPath, timeoutMs)
      } else {
        console.warn('[synthesis] FFmpeg 缺少 libass/drawtext，改用图片叠加烧录字幕')
        subtitled = await muxWithCaptionOverlays(
          muxVideoPath,
          mixedAudioPath,
          normalizedSubtitleSegments,
          font,
          workDir,
          outPath,
          timeoutMs,
        )
      }
    }

    // 3) 字幕关闭时仅替换自定义/TTS音轨；没有旁白时保留原视频声音。
    if (!subtitled) {
      if (mixedAudioPath) await muxAudioOnly(muxVideoPath, mixedAudioPath, outPath, timeoutMs)
      else if (options.normalizeAudio || options.removeSilence) await processVideoAudio(muxVideoPath, outPath, options, timeoutMs)
      else await copyFile(muxVideoPath, outPath)
    }
    return { subtitled }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

function escapeDrawtextText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
}

function escapeDrawtextPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/** libass 不可用时的字幕回退：每个 cue 只画一行，后一个 cue 自动覆盖前一个。 */
async function muxWithDrawtext(
  videoPath: string,
  audioPath: string | null,
  segments: TranscriptionSegment[],
  font: CjkFont,
  outPath: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!font.file || !existsSync(font.file)) throw new Error('字幕无法生成：服务器未找到可用的中文字体文件')
  const normalized = normalizeSubtitleSegments(segments)
  if (!normalized.length) return false
  let current = '0:v'
  const filters: string[] = []
  normalized.forEach((segment, index) => {
    const next = `dt${index}`
    const enable = `between(t\\,${(segment.startMs / 1000).toFixed(3)}\\,${(segment.endMs / 1000).toFixed(3)})`
    filters.push(
      `[${current}]drawtext=fontfile='${escapeDrawtextPath(font.file!)}':text='${escapeDrawtextText(segment.text)}':` +
      `fontcolor=white:fontsize=${SUBTITLE_FONT_SIZE}:borderw=${SUBTITLE_BORDER_WIDTH}:bordercolor=black:x=(w-text_w)/2:y=h-text_h-${SUBTITLE_BOTTOM_MARGIN}:enable='${enable}'[${next}]`,
    )
    current = next
  })
  const args = ['-i', videoPath]
  if (audioPath) args.push('-i', audioPath)
  args.push('-filter_complex', `${filters.join(';')};[${current}]null[v]`, '-map', '[v]')
  if (audioPath) args.push('-map', '1:a')
  else args.push('-map', '0:a?')
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-y', outPath,
  )
  await execFileP(ffmpegBin(), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  return true
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Sharp 回退路径用的单行字幕 SVG。
 *
 * ★ 抽成导出函数只为一个理由：它的**画布尺寸必须跟着字号走**，而那是「放大字号」时最容易
 *   漏掉、且**不会报错**的一处（字形被 sharp 裁掉，成片里只是字少了半个）。
 *   抽出来之后 `verify-auto-edit.ts` 才能断言「画布装得下字号」。
 */
export function buildCaptionSvg(text: string, fontFamily: string, width = 1080): string {
  return `
      <svg width="${width}" height="${SUBTITLE_CAPTION_SVG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
        <text x="${Math.round(width / 2)}" y="${SUBTITLE_CAPTION_SVG_BASELINE}" text-anchor="middle"
          font-family="${escapeXml(fontFamily)}" font-size="${SUBTITLE_FONT_SIZE}" font-weight="600"
          fill="white" stroke="black" stroke-width="${SUBTITLE_OUTLINE}" paint-order="stroke fill"
          letter-spacing="0">${escapeXml(text)}</text>
      </svg>`
}

/**
 * 最终字幕回退：用 Sharp 将每个单行 cue 渲染成透明 PNG，再用 FFmpeg overlay。
 * 这条路径不需要 FFmpeg 编译 libass 或 freetype，适用于精简发行版。
 */
async function muxWithCaptionOverlays(
  videoPath: string,
  audioPath: string | null,
  segments: TranscriptionSegment[],
  font: CjkFont,
  workDir: string,
  outPath: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!(await ffmpegSupportsFilter('overlay'))) throw new Error('字幕无法生成：服务器 FFmpeg 缺少 overlay 滤镜')
  const normalized = normalizeSubtitleSegments(segments)
  if (!normalized.length) return false
  const captionPaths: string[] = []
  for (let index = 0; index < normalized.length; index += 1) {
    const segment = normalized[index]!
    const captionPath = join(workDir, `caption-${index}.png`)
    const svg = buildCaptionSvg(segment.text, font.family)
    await sharp(Buffer.from(svg)).png().toFile(captionPath)
    captionPaths.push(captionPath)
  }
  const args = ['-i', videoPath]
  if (audioPath) args.push('-i', audioPath)
  for (const captionPath of captionPaths) args.push('-loop', '1', '-i', captionPath)
  const imageStartIndex = audioPath ? 2 : 1
  let current = '0:v'
  const filters: string[] = []
  normalized.forEach((segment, index) => {
    const next = `ov${index}`
    const imageIndex = imageStartIndex + index
    const enable = `between(t\\,${(segment.startMs / 1000).toFixed(3)}\\,${(segment.endMs / 1000).toFixed(3)})`
    filters.push(
      `[${current}][${imageIndex}:v]overlay=x=(main_w-overlay_w)/2:y=main_h-overlay_h-${SUBTITLE_BOTTOM_MARGIN}:` +
      `eof_action=repeat:shortest=0:enable='${enable}'[${next}]`,
    )
    current = next
  })
  args.push('-filter_complex', `${filters.join(';')};[${current}]null[v]`, '-map', '[v]')
  if (audioPath) args.push('-map', '1:a')
  else args.push('-map', '0:a?')
  const durationMs = await probeDurationMs(videoPath)
  if (durationMs) args.push('-t', (durationMs / 1000).toFixed(3))
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-y', outPath,
  )
  await execFileP(ffmpegBin(), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  return true
}

/**
 * 混合原声/旁白与背景音乐。旁白存在时保留少量原声，便于真实环境声不被完全抹掉；
 * 没有旁白时原声保持主音量，BGM 固定压低并用 limiter 防止削波。
 */
async function mixAudioTracks(
  videoPath: string,
  voicePath: string | null,
  bgmPath: string,
  outPath: string,
  timeoutMs: number,
  options: SynthesisOptions,
): Promise<void> {
  const hasSource = await hasAudioStream(videoPath)
  const args = ['-i', videoPath]
  let nextInput = 1
  if (voicePath) {
    args.push('-i', voicePath)
    nextInput++
  }
  args.push('-i', bgmPath)
  const bgmIndex = nextInput
  const filters: string[] = []
  const inputs: string[] = []
  if (hasSource) {
    filters.push(`[0:a]volume=${voicePath ? '0.22' : '1.0'}[src]`)
    inputs.push('[src]')
  }
  if (voicePath) {
    filters.push(`[1:a]volume=1.0[voice]`)
    inputs.push('[voice]')
  }
  const requestedGain = options.backgroundMusicGain
  const gain = requestedGain !== undefined && Number.isFinite(requestedGain ?? NaN) ? requestedGain : 0.12
  filters.push(`[${bgmIndex}:a]volume=${Math.max(0.03, Math.min(0.35, gain))}[bgm]`)
  inputs.push('[bgm]')
  filters.push(`${inputs.join('')}amix=inputs=${inputs.length}:duration=longest:dropout_transition=2,loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.95[aout]`)
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[aout]', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-shortest', '-y', outPath,
  )
  await execFileP(ffmpegBin(), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
}

/** 生成指定时长的静音轨 */
async function synthSilence(durMs: number, outPath: string, timeoutMs: number): Promise<void> {
  await execFileP(
    ffmpegBin(),
    [
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t', (durMs / 1000).toFixed(3),
      '-c:a', 'aac', '-b:a', '128k',
      '-y', outPath,
    ],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  )
}

async function muxWithSubtitles(
  videoPath: string,
  audioPath: string | null,
  subtitlePath: string,
  font: CjkFont,
  outPath: string,
  timeoutMs: number,
  options: SynthesisOptions,
): Promise<boolean> {
  try {
    // 字号、画布、边距均写在 ASS 头里，避免 libass 使用 384x288 默认画布放大样式。
    const vf = `subtitles=${escapeFilterPath(subtitlePath)}:fontsdir=${escapeFilterPath(font.dir)}`
    const args = ['-i', videoPath]
    if (audioPath) args.push('-i', audioPath)
    args.push('-filter_complex', `[0:v]${vf}[v]`, '-map', '[v]')
    if (audioPath) args.push('-map', '1:a')
    else args.push('-map', '0:a?')
    const sourceAudioFilter = !audioPath ? audioFilter(options) : ''
    if (sourceAudioFilter) {
      args.push('-af', `${sourceAudioFilter},apad`)
      const durationMs = await probeDurationMs(videoPath)
      if (durationMs) args.push('-t', (durationMs / 1000).toFixed(3))
    }
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-y', outPath,
    )
    await execFileP(
      ffmpegBin(),
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    )
    return true
  } catch (e) {
    const failure = e as Error & { stderr?: string }
    const detail = [failure.message, failure.stderr?.trim()].filter(Boolean).join('\n')
    console.error('[synthesis] 字幕烧录失败：', detail)
    throw new Error(`字幕烧录失败：${detail}`)
  }
}

async function processVideoAudio(videoPath: string, outPath: string, options: SynthesisOptions, timeoutMs: number): Promise<void> {
  if (!(await hasAudioStream(videoPath))) {
    await copyFile(videoPath, outPath)
    return
  }
  await execFileP(
    ffmpegBin(),
    [
      '-i', videoPath,
      '-map', '0:v', '-map', '0:a',
      '-c:v', 'copy', '-af', audioFilter(options), '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-y', outPath,
    ],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  )
}

async function muxAudioOnly(
  videoPath: string,
  audioPath: string,
  outPath: string,
  timeoutMs: number,
): Promise<void> {
  await execFileP(
    ffmpegBin(),
    [
      '-i', videoPath, '-i', audioPath,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-y', outPath,
    ],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  )
}
