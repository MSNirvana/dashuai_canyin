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
import { ENCODE_DELIVERY, audioEncodeArgs, audioEncodeArgsStereo, videoEncodeArgs } from './encode-quality.js'

const execFileP = promisify(execFile)

// Fixed against the actual 1080x1920 output canvas. ASS must declare the same
// PlayRes or libass interprets these values against its legacy 384x288 canvas.
/**
 * 字幕字号倍率 —— **只改这一个数**。
 *
 * ★ 基准 52px 是历史值；2026-09-25 用户要求「字幕大小放大两倍」⇒ 2。
 * ★★ 字号**不是孤立常量**。下面这些全部由它推导，改字号时不要各路径各改一处
 *   （本项目在「字幕底边距」上已经吃过一次「散成三处」的亏）：
 *   · `SUBTITLE_MAX_WIDTH` / `SUBTITLE_BLOCK_WIDTH_PX` / `SUBTITLE_SIDE_MARGIN`
 *     —— 每行字数 ↔ 像素宽 ↔ 左右边距三者连动，改一个必须一起看；
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
 * 字幕底边距（相对 PlayResY=1920 的像素）——「字幕落在画面哪个高度」的唯一旋钮。
 *
 * ★★ 2026-09-29（第三次）用户要求「**改成 400**」⇒ **480 → 400**。
 *   服务器实测（720×1280 成片、104px 字号、Noto Sans CJK SC、同一帧真烧真量）：
 *     480 ⇒ 墨迹带 y=906~949（**70.8%~74.1%**）；400 ⇒ y=959~1002（**74.9%~78.3%**）。
 *   ⚠⚠ **这一档是「极限档」**：墨迹底边 **78.3%**，距画面下方 20% 的平台按钮/文案常占区
 *     只剩 **1.7%** ⇒ 某些端 / 某些机型上字幕会**贴住甚至压到**平台控件。
 *     再往下（320 ⇒ 墨迹底边 ≈82%）就**进区**了。
 *   ★ 用户是**看过五档对照图之后**明确选的这一档 ⇒ 照做；但交付时要**主动把这个边界说出来**，
 *     别等用户发现被压住再来一轮。
 *   ★ 留档判据：`墨迹底边 ≈ (1911 − MarginV) / 1920`；平台区上沿 = 画面高 **80%**
 *     ⇒ 可用下界 ≈ `MarginV 400`。
 *
 * ★★ 2026-09-29（第二次）用户要求「**再往下降低一些位置**」⇒ **640 → 480**（`= PlayResY / 4`）。
 *   那次往下挪了 **8.3% 画面高**，且仍高于平台区（74.1% < 80%）；第三次又往下取到了 400（见上）。
 *
 * ★★ 2026-09-29（第一次）用户要求「字幕位置设置为**底部三分之一处**，现在位置低了点」⇒ **116 → 640**。
 *   `640 = PlayResY / 3 = 1920 / 3` —— 就是「画面自底往上三分之一」那条线本身，不是估算值。
 *   ⚠ **别再拿「平台底部叠加层」当理由把它改回去**：那是 09-24 的**推断**，
 *     用户看过成片后已明确指定位置，以用户指定为准（09-25 那次换回 116 是把它和
 *     「字号翻倍」捆在一起改的，并不是单独对位置重新做了判断）。
 *
 * 沿革（每一档用户都看过成片，别再重复走一遍）：
 *   · **116**（= 仅高出画面底边 6.0%）＋ 52px 字号 ⇒ 墨迹带 y≈1770~1835（**92~96%**），
 *     用户反馈「字幕位置特别低」；
 *   · **640** ＋ 52px 字号 ⇒ 墨迹带 y≈1246~1311（**65~68%**），用户从 116/460/640
 *     三档对照图里选的就是这一档；
 *   · 09-25 换回 116 时把字号一并翻倍到 104px ⇒ 墨迹带落到 **90.2%~95.6%**，
 *     用户这次说「低了点」指的就是它。
 *   · **480** ＋ 104px 字号 ⇒ 墨迹带 **70.8%~74.1%**（09-29 第二次调）。
 *   · **400** ＋ 104px 字号 ⇒ 墨迹带 **74.9%~78.3%**（09-29 第三次调，**即本次**；已贴平台区）。
 * ★ 该常量在每条烧字幕路径上生效（ASS 的 MarginV、drawtext 的 y=h-text_h-…、
 *   overlay 的 y=main_h-overlay_h-… 三处共用），所以只改这一行即可。
 * ⚠ `MarginV` 与字幕**墨迹底边并不重合**（libass 行盒含 descent）⇒ 上面那串「x%~y%」
 *   **不是用 MarginV 反推的**，而是在服务器上用**真 ASS 引擎 + 生产字体烧到真帧上、
 *   逐行数近白像素量出来的**。可直接复用的近似式：墨迹底边 ≈ `(1911 − MarginV) / 1920`
 *   （实测与它差不到 0.5%），但它只是**校核**用，别拿它替代实测。
 * ⚠ 它**只影响成片**：客户端硬发 `engine:'LOCAL'`，字幕是服务端本地引擎烧的
 *   ⇒ 改完 `tsc` + `pm2 restart` 即可，**不需要重出小程序包**。
 */
export const SUBTITLE_BOTTOM_MARGIN = 400
/**
 * 每行最多几个 CJK 字（ASCII 按 0.55 个算，见 `subtitleDisplayWidth`）。
 *
 * ★ 17 → 14 是 2026-09-24 对齐自家断言的结果；09-25 字号翻倍后按像素预算曾推得 8，
 *   用户看过成片后要求**放宽到 10**（8 个字会把「欢迎」这类词劈开）。
 * ★★ 这里**直接写字数**、由它推像素宽，而不是反过来：用户是按「几个字」提要求的，
 *   而字数↔字号是同一件事的两面，分开写就会在改字号时悄悄失效。
 * ⚠⚠ 10 × 104px = **1040px**，已经吃掉 1080 画布宽的 96%，两侧只剩 20px。
 *   这是「字大 + 每行 10 字」两条要求叠加后的必然结果，**不要再往上加**：
 *   守护脚本守着「字数 × 字号 ＋ 描边 ≤ 1080」这条线，超了就会被裁边
 *   （`WrapStyle: 2` 不自动折行，所以不会有第二行来救，只会切掉两头的字）。
 *
 * ★★ 2026-09-29 用户提「超过 12 个字才分两行」，**这个数没被采纳**，仍是 10：
 *   `10 × 104px ＋ 描边 12 = 1052 ≤ 1080` 是硬上限，12 字要 1248px ⇒ 超出画布 168px。
 *   只有两条路：① 保住 104px 大字、按 10 字折行（**已选**）；② 降字号到 ~86px 才放得下 12 字。
 *   用户看过这组数据后选了 ①。
 * ★ 去标点之后（2026-09-29 起字幕不含任何标点，见 `SUBTITLE_STRIP_PUNCT`），
 *   这 10 个字**全是正文字**，不再被逗号占掉一格 ⇒ 同样一行的信息量比上一版多。
 */
export const SUBTITLE_MAX_WIDTH = 10
/** 字幕块像素宽 —— 由字数与字号推出（10 × 104 = 1040）。 */
export const SUBTITLE_BLOCK_WIDTH_PX = SUBTITLE_MAX_WIDTH * SUBTITLE_FONT_SIZE
/**
 * ASS 的 `MarginL` / `MarginR`：画布宽减去字幕块宽再对半分（1040 时是 20）。
 * ★ 与 `SUBTITLE_BLOCK_WIDTH_PX` 连动，别写死 —— 用 `Alignment=2` 居中时左右对称，
 *   居中点恒在画布中线，所以它只影响「换行判定」，不影响字幕实际落点。
 */
export const SUBTITLE_SIDE_MARGIN = Math.round((1080 - SUBTITLE_BLOCK_WIDTH_PX) / 2)

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
  /**
   * 可选：把**已合并的待分行文本**交给外部（大模型）分行，返回 `原文 → 行数组`。
   * 由 `worker.ts` 注入 `breakSubtitleLines`（见 `subtitle-split.service.ts`）。
   *
   * ★★ 为什么用**注入**而不是在这里直接 import 那个服务：本模块要保持
   *   「只有 ffmpeg 与纯函数」—— 于是守护脚本可以直接 import 它做断言，
   *   **不需要数据库、不需要 AI 通道**。一旦在这里 import prisma，所有字幕断言都会变成集成测试。
   * ★ 返回空 Map / 抛异常都算「不可用」⇒ 退回内建 `splitSubtitleText`（绝不拦住出片）。
   */
  breakSubtitleLines?: (texts: readonly string[]) => Promise<Map<string, string[]>>
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

/**
 * 字幕的**显示宽度**（CJK 记 1、ASCII 记 0.55）。
 *
 * ★★ 换行符 `\n` 记 **0** —— 它是「一句两行」的分隔符，不是可见字符。
 *   算进宽度会让两行的屏被误判成超宽，「同屏两行」直接失效（2026-09-29）。
 */
export function subtitleDisplayWidth(text: string): number {
  return [...text].reduce(
    (sum, char) => sum + (char === '\n' ? 0 : /^[\x00-\xff]$/.test(char) ? 0.55 : 1),
    0,
  )
}

/**
 * 单个**词**本身就超过一行时的兜底：纯按宽度硬切。
 *
 * ★ 正常情况下轮不到它 —— 分词后每个原子都是「一个词 + 它后面的标点」，
 *   只有长串数字/字母/整段无标点的口语才会触发。
 * ★ 这里保留「先算块数 `n = ceil(总宽 / 上限)` 再按 `总宽 / n` 均分」的写法：
 *   对一个**不可再分**的长串来说，均分是唯一能避免「最后一块只剩一两个字」的办法
 *   （贪心会把余数全甩到最后一块；实测生产成片 task 32 尾部出现过 **2 个字、停留 0.37s**
 *   的孤儿 cue「吃呢」）。
 */
function hardSplitByWidth(text: string, maxWidth: number): string[] {
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
 * 中文分词器：Node 内置 ICU 词典（**无需新依赖**）。
 *
 * ★ 只用来**决定在哪里断行**，绝不改动文本本身 —— 切完拼回去必须逐字相等
 *   （**唯一例外是空白**：它由 `toSubtitleAtoms` 主动丢弃，见下）。
 * ★★ 为什么必须有它（2026-09-25 拿用户成片实测）：
 *   按「第 N 个字」硬切时，切点完全不认识词，实测把
 *   `千万` 劈成 `千 | 万`、`香油` 劈成 `香 | 油`、`七上八下` 劈成 `七上 | 八下`，
 *   用户的评价是「**一句话的最后一个字跑到下一行字幕的第一个字了**，这种情况肯定不行」。
 * ★ 类型用局部 interface 而不是 `lib.dom` 的 `Intl.Segmenter`：
 *   tsconfig 只开 `lib: ["ES2022"]`，直接引用会编译不过。
 */
interface SubtitleWordSegmenter {
  segment(input: string): Iterable<{ segment: string }>
}

const SUBTITLE_WORD_SEGMENTER: SubtitleWordSegmenter | null =
  typeof (Intl as unknown as { Segmenter?: unknown }).Segmenter === 'function'
    ? new (
        Intl as unknown as {
          Segmenter: new (locale: string, options: { granularity: string }) => SubtitleWordSegmenter
        }
      ).Segmenter('zh', { granularity: 'word' })
    : null

/**
 * 纯标点（自成一词的标点）—— 见到就粘到前一个词的尾巴上。
 *
 * ★★ 这里**故意不含 `\s`**（2026-09-29 修）：空白不是标点，它是**词间的分隔**。
 *   旧版把 `\s` 列进来 ⇒ ASR/文案里那个空格会被**粘进前一个词**变成 `别 `，
 *   于是 ① 空格**显形在字幕上**（成片实测 `廊坊想吃火锅的千万\N别 划走这盘牛肚`），
 *   且 ② 这个原子的宽度成了 `1 + 0.55 = 1.55`，把「千万别」从行尾挤掉 ⇒
 *   第一行只剩 9 个字（本该 10 个）。空白改由 `push` 按「两侧是否都是 ASCII」定夺，见下。
 */
const SUBTITLE_PUNCT_ONLY =
  /^[。．，、；：！？…⋯·,;:!?.～~“”‘’"'（）()「」『』【】《》〈〉—\-]+$/

/**
 * 把整句切成「**词 + 紧随其后的标点**」原子。
 *
 * ★★ 标点一律挂到**前一个词**的尾巴上 ⇒ 它永远不会成为某一行的第一个字符。
 *    这是「行首冒出逗号」（实测成片出现过 `，我敢说不是动货`）的**根治**做法 ——
 *    在切点处就杜绝，而不是事后把行首标点再挪回去。
 * ★★ 空白（空格/制表/全角空格）的处理是**有判据的丢弃**，不是无脑丢：
 *    ① 两侧只要有一侧是 CJK ⇒ **丢掉**。源文本要么是 ASR 转写（转写引擎会在数字/字母
 *       两侧塞空格），要么是口播文案 —— 这类空格是**噪声**，留着会**显形在成片上**
 *       （实测 `廊坊想吃火锅的千万\N别 划走这盘牛肚`），还会按 0.55 字占掉行宽、
 *       把本该在行尾的「千万别」挤到下一行（第一行只剩 9 个字）。
 *    ② 两侧都是 ASCII ⇒ **保留一个空格**。这是有意义的文本（`iPhone 15`、`128 GB`），
 *       丢了会粘成 `iPhone15`。
 * ★ 分词器不可用时退化成逐字，行为等价于「只按宽度切」，不会比旧实现更差。
 */
export function toSubtitleAtoms(text: string): string[] {
  const atoms: string[] = []
  /** 上一个被丢掉的空白 —— 它要等**下一个原子**来了才知道该不该保留（判据见上）。 */
  let pendingSpace = false
  const push = (value: string): void => {
    if (!value) return
    if (!value.trim()) {
      pendingSpace = true
      return
    }
    const word = value.trim()
    if (SUBTITLE_PUNCT_ONLY.test(word) && atoms.length) {
      atoms[atoms.length - 1] += word
      pendingSpace = false
      return
    }
    const previous = atoms[atoms.length - 1]
    if (pendingSpace && previous !== undefined && /[\x20-\x7e]$/.test(previous) && /^[\x20-\x7e]/.test(word)) {
      atoms[atoms.length - 1] = `${previous} `
    }
    pendingSpace = false
    atoms.push(word)
  }
  if (!SUBTITLE_WORD_SEGMENTER) {
    for (const char of text) push(char)
    return atoms
  }
  for (const part of SUBTITLE_WORD_SEGMENTER.segment(text)) push(part.segment)
  return atoms
}

/** 子句被拆成多条时，**末行**短于这个宽度就认为「尾重」⇒ 把整个子句重新均分。 */
export const SUBTITLE_MIN_TAIL_WIDTH = 4

/**
 * 末尾残行收口：**把整个子句按词边界重新均分**，而不是从上一行搬词。
 *
 * ★★ 为什么不是「从上一行搬词补短」（2026-09-29 真机实测，先后走了两条弯路）：
 *   ① 初版「搬词补短」搬的单位是**分词原子**，而 ICU 的原子 **≠ 词** ——
 *      它会把 `秘制` 切成 `秘` | `制`，于是搬走 1 个字的碎片，成片出过
 *      `蘸上老板这个秘` / `制香油啊`（**把词劈在接缝上**）。
 *   ② 加闸门「1 个字的原子一律不许搬」：`秘制` 是修好了，却**踩坏另一类** ——
 *      贪心填满 10 字后末行只剩 `一口`（2 字宽），本该把 `第` 搬下去拼回 `第一口`，
 *      闸门一挡就成 `来大帅火锅旗舰店试第` / `一口` ⇒ **劈词 ＋ 2 字残句，两个问题一起来**。
 *   ⇒ 根本矛盾：**「这个 1 字碎片该不该搬」在宽度和原子粒度上完全无法区分**（两种场景同形）。
 *      所以别再一个一个搬了 —— 直接把**整个子句**按 `总量 / 行数` 在**词边界**上重排：
 *      · `沾上老板这个秘制香油啊`(11) ⇒ `沾上老板这个`(6) / `秘制香油啊`(5)
 *      · `来大帅火锅旗舰店试第一口`(12) ⇒ `来大帅火锅旗舰店`(8) / `试第一口`(4)
 *      两条都既没劈词、也没留下残句。
 * ★ 只在**末行过短**时触发 ⇒ 正常情况仍是「每行尽量填满 `maxWidth`」：
 *   24 字那种 `10+10+4`（末行 4 ≥ `SUBTITLE_MIN_TAIL_WIDTH`）**完全不受影响**。
 * ★ 切点仍只取**词边界**（原子边界）⇒ 不会退回「按字数均分把 `千万` 劈开」的老毛病。
 */
function rebalanceLines(lines: string[][], maxWidth: number): string[][] {
  const tokens = lines.flat()
  const target = subtitleDisplayWidth(tokens.join('')) / lines.length
  const result: string[][] = []
  let current: string[] = []
  let width = 0
  for (const token of tokens) {
    const tokenWidth = subtitleDisplayWidth(token)
    // 前 n-1 行凑够「均分目标」就收口；再加一个会超上限也必须收口（最后一行全收）
    const enough = result.length < lines.length - 1 && width >= target
    if (current.length && (enough || width + tokenWidth > maxWidth)) {
      result.push(current)
      current = []
      width = 0
    }
    current.push(token)
    width += tokenWidth
  }
  if (current.length) result.push(current)
  return result
}

/**
 * 把整句**装箱**成行：贪心填满到 `maxWidth`，且**只在词边界换行**。
 *
 * ★★ 这里替代了旧的「先算块数 `n = ceil(总宽 / 上限)`、再按 `总宽 / n` 均分」：
 *    那套是按**算术**把整段平均分，于是 24 字必然切成 `8+8+8`、22 字切成 `8+8+7`、
 *    19 字切成 `10+9`……用户看到的就是「**还是 8 个字不是 10 个字**」。
 *    而它的切点也不认识词和标点，所以 `千万` 被劈开、逗号被甩到行首。
 * ★ 现在的边界：① 行宽 ≤ `maxWidth`；② 只在词边界断；③ 标点永远不在行首；
 *    ④ 标点在上游 `splitSubtitleText` 就被整个去掉了，这里**不**再处理标点；
 *    ⑤ 末行不留残句（见 `rebalanceLines`）。
 * ★★ 出口逐行 `trim()`：ASCII 词之间的空格是**粘在前一个词尾巴上**的
 *    （见 `toSubtitleAtoms` ②），若断行正好落在那个空格之后就成 `iPhone 15 `——
 *    行末空格既渲染成「字幕块莫名偏左」，又会多算 0.55 行宽。行内空格保留、行首尾一律去掉。
 */
function packSubtitleLines(text: string, maxWidth: number): string[] {
  const atoms = toSubtitleAtoms(text)
  const lines: string[][] = []
  let current: string[] = []
  let width = 0
  for (const atom of atoms) {
    const atomWidth = subtitleDisplayWidth(atom)
    if (current.length && width + atomWidth > maxWidth) {
      lines.push(current)
      current = []
      width = 0
    }
    if (!current.length && atomWidth > maxWidth) {
      // 单个「词」就超一行（长串数字/字母/无标点长句）：按宽度硬切，
      // 末块留给后面继续拼，避免它自己又变成一个残行。
      const pieces = hardSplitByWidth(atom, maxWidth)
      for (let index = 0; index < pieces.length - 1; index += 1) lines.push([pieces[index] ?? ''])
      const tail = pieces[pieces.length - 1] ?? ''
      current = tail ? [tail] : []
      width = subtitleDisplayWidth(tail)
      continue
    }
    current.push(atom)
    width += atomWidth
  }
  if (current.length) lines.push(current)
  // ★ 末行过短 ⇒ **整个子句**按词边界重新均分（为什么不是搬词，见 `rebalanceLines` 的注释）
  const lastLine = lines[lines.length - 1]
  const balanced = lines.length >= 2 && lastLine !== undefined
    && subtitleDisplayWidth(lastLine.join('')) < SUBTITLE_MIN_TAIL_WIDTH
    ? rebalanceLines(lines, maxWidth)
    : lines
  return balanced.map((line) => line.join('').trim()).filter(Boolean)
}

/**
 * 字幕的**句子边界** —— 见到就断成两条独立字幕。
 *
 * ★★ 2026-09-29 用户拍板：**逗号 / 顿号 / 冒号也算句界**（原话「禁止两句话同时出现」）。
 *   ⚠ 这与 `speech-range.ts::SPEECH_SENTENCE_END_PUNCT`（只认句末标点）**故意不同**：
 *     那个是「剪废片 + ASR cue 收口」共用的判据，管的是**声音在哪里剪**；
 *     这个是**字幕怎么分屏**。用途不同 ⇒ 两套粒度不同是对的，不是「不一致」。
 * ★ `stripTrailingPunctuation`（只吃行末标点那版）已随之**删除**：
 *   口径从「行末去标点」换成「整条不含标点」之后它一个调用点都没有了，
 *   留着只会让下一个人以为「出口还在吃行末标点」。
 */
const SUBTITLE_CLAUSE_BREAK = /[。．，、；：！？…⋯·!?～~]+/u

/**
 * 字幕里要**全部去掉**的标点（用户 2026-09-29：「去除标点符号」）。
 * ★ 句读标点 + 成对引号/括号一律去掉；**保留** `-` 与 `°`（可能是「100-200」「0°锁鲜」的一部分）。
 * ★ 这是**唯一**一份标点清洗 —— 旧的「只吃行末标点」那份（`TRAILING_PUNCTUATION`）已删除，
 *   别再加回来：两套粒度并存时，行内标点会从没被清掉的那个口子漏到成片上。
 */
const SUBTITLE_STRIP_PUNCT = /[。．，、；：！？…⋯·!?～~“”‘’"'「」『』【】《》〈〉（）()\[\]{}—–,;:.]/gu

/**
 * 把一段文本切成**逐条字幕**：每条**只占一行**，一句话放不下就拆成**先后连续的多条**。
 *
 * ★★ 2026-09-29 用户原话（分两次，第二次是对第一次的更正，**以第二次为准**）：
 *   ① 「要像自然语言表达那样，一句一行，如果超过12个字，则一句两行，
 *       禁止两句话同时出现，然后去除标点符号。」
 *   ② 看过成片后：「我说的一句话是逗号就算分割了，直接就跳下一个字幕了，**而不是分成两行**。」
 *   ⇒ 我第一版把①理解成「同屏上下两行」，② 是明确的更正：**长句要连播，不要同屏两行**。
 *     于是这里不再产出 `\n`（`\n` 那套能力仍在，但现在是**兜底/可回退**，见 `escapeAssText`）。
 *
 * 三条硬规则，缺一条都会被一眼看出来：
 *
 *   ① **标点即句界** —— 按**标点**断句（含逗号/顿号/冒号），每句独立成条。
 *      ✗ 旧实现按「10 字宽」装箱，切点不认识标点后的语义停顿，成片里产出过
 *        「土豆是切块炸的，火候」＝「一个完整子句 ＋ 下一个子句的头两个字」，
 *        用户看到的就是「两句话同时出现」。
 *   ② **一句超一行 ⇒ 连播多条** —— 子句超过 `maxWidth` 时按**词边界**装箱，每行各成一条，
 *      时间由 `normalizeSubtitleSegments` 按显示宽度摊分（前后紧接、不重叠）。
 *      ★ `maxWidth` 仍是 **10**、不是用户口头说的 12 —— 这是**画布的物理约束**：
 *        `10 × 104px ＋ 描边 12 = 1052 ≤ 1080`，而 12 字要 1248px、超出画布 168px，
 *        `WrapStyle: 2` 下不会折行、只会把两头静默裁掉。用户已拍板「保字号、按 10 字」。
 *   ③ **去掉所有标点** —— 句读标点 + 引号括号一并去掉。
 *      ✗ 旧实现只吃**行末**标点，行内逗号原样留着 —— 那正是用户截图里的「香料，香脆脆的」。
 *
 * ⚠ **返回值是「字幕条」不是「屏」**（2026-09-29 起）。仍按 `split('\n')` 去拆的调用方要改，
 *   否则会把一条正常字幕当成两行；断言也要改成「每条只有一行」而不是「一屏最多两行」。
 */
export function splitSubtitleText(text: string, maxWidth = SUBTITLE_MAX_WIDTH): string[] {
  const clean = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  // ① 按标点拆子句（分隔符本身丢弃），再清掉残留的引号/括号 —— 一步满足「去除标点」
  const clauses = clean
    .split(SUBTITLE_CLAUSE_BREAK)
    .map((clause) => clause.replace(SUBTITLE_STRIP_PUNCT, '').trim())
    .filter(Boolean)
  const subtitles: string[] = []
  for (const clause of clauses) {
    // ② 词边界装箱 ⇒ 每行 ≤ maxWidth（不劈词、行首不出标点）；③ **每行各成一条**（连播）
    for (const line of packSubtitleLines(clause, maxWidth)) subtitles.push(line)
  }
  return subtitles
}

/** 把「一条文本」换成「行数组」的外部分行器；返回 null = 这一条没有可用结果 */
export type SubtitleLineSplitter = (text: string) => string[] | null

/**
 * 将字幕归一为单行、非重叠、连续替换的 cue，避免 libass 自动换成多行。
 *
 * ★ `splitter`（2026-09-29 加）＝ 由 `worker.ts` 注入的 **AI 分行**结果
 *   （见 `subtitle-split.service.ts`）；返回 `null` 表示这一条不可用 ⇒ 退回内建算法。
 * ★★ 由 `splitter` 产出的行必须打上 `locked: true`：否则 `segmentsToAss` 内部的
 *   **二次归一化**会把它们合回一大段、再按屏宽重切 —— AI 的分行会在最后一刻被抹掉
 *   （完整机理见 `TranscriptionSegment.locked`）。
 * ★ 内建算法产出的行**不打标记** ⇒ 老路径（ASR 原始段 / 分镜文案）行为完全不变。
 */
export function normalizeSubtitleSegments(
  segments: TranscriptionSegment[],
  splitter?: SubtitleLineSplitter,
): TranscriptionSegment[] {
  const expanded: TranscriptionSegment[] = []
  for (const segment of mergeSubtitleSegments(segments)) {
    const text = String(segment.text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const aiLines = splitter ? splitter(text) : null
    const chunks = aiLines ?? splitSubtitleText(text)
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
      expanded.push({
        startMs: chunkStart,
        endMs: Math.max(chunkStart + 250, chunkEnd),
        text: chunk,
        // ★ 只有 AI 分的行才带标记（理由见上面的函数注释与 TranscriptionSegment.locked）
        ...(aiLines ? { locked: true } : {}),
      })
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
      // ★ 必须显式带过来：这里是一次「重建对象」的 map，不写就会把标记丢掉，
      //   而下游正是靠它区分「AI 分好的行」与「ASR 原始段」（见 TranscriptionSegment.locked）。
      locked: segment.locked === true,
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
    /**
     * ★★ `locked` 两侧都要查，缺一不可：
     *   · `previous.locked` —— 上一行是 AI 排好的最终行，再拼就把它的断行毁了；
     *   · `segment.locked` —— 当前行是 AI 排好的最终行（上一行可能是 ASR 原始段）。
     *   实测漏掉任何一侧，AI 的两行都会被拼回去、再按宽度重切 ⇒ 前功尽弃，且**不报错**。
     */
    const shouldMerge =
      !previous.locked && !segment.locked && !previousHasSentenceEnd && gapMs <= 900 && currentSpanMs <= 8_000
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

/**
 * ASS 事件文本转义。
 *
 * ★★ `\n` 必须转成 ASS 的换行符 `\N`，**不能**压成空格 —— 压成空格就是「两行静默变一行」，
 *   而且**不报错**（2026-09-29 实测过这个坑）。
 * ★★ 2026-09-29 用户改成「长句连播、不要同屏两行」之后，**管线已不再产出 `\n`**
 *   （见 `splitSubtitleText`）⇒ 这段映射现在是**兜底**，不是主路径。
 *   为什么还留着：原始 `\n` 直接进 ASS 的 `Dialogue` 行会把**文件格式本身**弄坏
 *   （换行就是事件分隔符），那比「多一行字」严重得多；留着它成本为 0。
 *   ★ 守护脚本另有一条「产出的每条字幕都不许含 `\N`」的断言盯着主路径。
 * ⚠ 顺序：先转义反斜杠、再处理换行 —— 反了会把刚生成的 `\N` 里的反斜杠再转义一次。
 */
function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\r?\n/g, '\\N')
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
Style: Default,${fontFamily},${SUBTITLE_FONT_SIZE},&H00FFFFFF,&H000000FF,&H00101010,&H00000000,-1,0,0,0,100,100,0,0,1,${SUBTITLE_OUTLINE},0,2,${SUBTITLE_SIDE_MARGIN},${SUBTITLE_SIDE_MARGIN},${SUBTITLE_BOTTOM_MARGIN},1

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
    ...audioEncodeArgsStereo(), '-y', output,
  ], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
}

/**
 * 把「已合并的待分行文本」交给外部（大模型）分行，拿回 `原文 → 行数组`。
 *
 * ★ 分组必须与 `normalizeSubtitleSegments` 内部**完全一致**（同样先 `mergeSubtitleSegments`）——
 *   否则这里问到的文本、和那边拿去查映射的文本对不上，映射永远查不到，AI 分行将**静默无效**。
 *   所以这里不自己实现合并，直接复用同一个函数。
 * ★ 只保留**真正被切成多行**的条目：单行结果与内建算法等价，留在映射里只会让
 *   「AI 到底改了什么」更难对照。
 * ★ 任何异常都吞掉并返回 null —— 分行是增强步骤，绝不能拦住出片。
 */
async function collectAiSubtitleLines(
  segments: TranscriptionSegment[],
  breaker: (texts: readonly string[]) => Promise<Map<string, string[]>>,
): Promise<Map<string, string[]> | null> {
  try {
    const texts: string[] = []
    for (const segment of mergeSubtitleSegments(segments)) {
      const text = String(segment.text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
      if (text) texts.push(text)
    }
    if (!texts.length) return null
    const raw = await breaker(texts)
    const multi = new Map<string, string[]>()
    for (const [text, lines] of raw) if (lines.length > 1) multi.set(text, lines)
    return multi.size ? multi : null
  } catch (e) {
    console.warn('[synthesis] AI 分行失败，改用内建分条算法：', (e as Error).message)
    return null
  }
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
    const aiLines = subtitleMode === 'OFF' || !options.breakSubtitleLines
      ? null
      : await collectAiSubtitleLines(subtitleSegments, options.breakSubtitleLines)
    if (aiLines) console.log(`[synthesis] ${aiLines.size} 条文本使用了 AI 分行（其余走内建算法）`)
    const normalizedSubtitleSegments = subtitleMode === 'OFF'
      ? []
      : normalizeSubtitleSegments(subtitleSegments, aiLines ? (text) => aiLines.get(text) ?? null : undefined)
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

/** drawtext 回退链的构造结果：滤镜串数组 ＋ 末端节点名（还要接 `null[v]`）。 */
export interface DrawtextFilterChain {
  filters: string[]
  lastNode: string
}

/**
 * libass 不可用时的字幕回退滤镜链（**纯函数**，抽出来是为了让守护脚本能断言）。
 *
 * ★★ 「一句两行」在这里靠**两个 drawtext 串联**实现，不依赖 `\n` 在 filtergraph 里的转义
 *   （那要过 shell + filtergraph 两层，写错了**不会报错**、只会把两行粘成一行）。
 *   第 0 行落在与单行时**完全相同**的位置，第 n 行再往上挪 n 个行高。
 * ★ 抽成纯函数之前这段逻辑埋在 `muxWithDrawtext` 里 ⇒ 只有真跑 ffmpeg 才走得到，
 *   而它偏偏是「libass 挂了」才启用的兜底路径 —— 等于**永远没被验证过**。
 */
export function buildDrawtextFilterChain(
  segments: TranscriptionSegment[],
  fontFile: string,
  startNode = '0:v',
): DrawtextFilterChain {
  let current = startNode
  const filters: string[] = []
  const lineHeight = Math.round(SUBTITLE_FONT_SIZE * 1.25)
  segments.forEach((segment, index) => {
    const enable = `between(t\\,${(segment.startMs / 1000).toFixed(3)}\\,${(segment.endMs / 1000).toFixed(3)})`
    segment.text.split('\n').filter(Boolean).forEach((line, lineIndex) => {
      const next = `dt${index}_${lineIndex}`
      filters.push(
        `[${current}]drawtext=fontfile='${escapeDrawtextPath(fontFile)}':text='${escapeDrawtextText(line)}':` +
        `fontcolor=white:fontsize=${SUBTITLE_FONT_SIZE}:borderw=${SUBTITLE_BORDER_WIDTH}:bordercolor=black:` +
        `x=(w-text_w)/2:y=h-text_h-${SUBTITLE_BOTTOM_MARGIN + lineIndex * lineHeight}:enable='${enable}'[${next}]`,
      )
      current = next
    })
  })
  return { filters, lastNode: current }
}

/** libass 不可用时的字幕回退：每个 cue 画一到两行（见 `buildDrawtextFilterChain`）。 */
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
  const { filters, lastNode: current } = buildDrawtextFilterChain(normalized, font.file)
  const args = ['-i', videoPath]
  if (audioPath) args.push('-i', audioPath)
  args.push('-filter_complex', `${filters.join(';')};[${current}]null[v]`, '-map', '[v]')
  if (audioPath) args.push('-map', '1:a')
  else args.push('-map', '0:a?')
  args.push(
    ...videoEncodeArgs(ENCODE_DELIVERY), '-movflags', '+faststart',
    ...audioEncodeArgs(), '-shortest', '-y', outPath,
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
 * Sharp 回退路径用的字幕 SVG（**支持同屏两行**）。
 *
 * ★ 抽成导出函数只为一个理由：它的**画布尺寸必须跟着字号走**，而那是「放大字号」时最容易
 *   漏掉、且**不会报错**的一处（字形被 sharp 裁掉，成片里只是字少了半个）。
 *   抽出来之后 `verify-auto-edit.ts` 才能断言「画布装得下字号」。
 * ★★ 2026-09-29：`text` 里可以含 `\n`（一句两行）—— 画布高度按**行数**翻倍，
 *   每行一个 `<text>`。只改 width/height 不拆行，会让第二行被画布裁掉（同样不报错）。
 */
export function buildCaptionSvg(text: string, fontFamily: string, width = 1080): string {
  const rows = String(text).split('\n').filter((line) => line.length > 0)
  const lines = rows.length ? rows : ['']
  const height = SUBTITLE_CAPTION_SVG_HEIGHT * lines.length
  const texts = lines
    .map((line, index) => {
      const y = SUBTITLE_CAPTION_SVG_BASELINE + index * SUBTITLE_CAPTION_SVG_HEIGHT
      return `
        <text x="${Math.round(width / 2)}" y="${y}" text-anchor="middle"
          font-family="${escapeXml(fontFamily)}" font-size="${SUBTITLE_FONT_SIZE}" font-weight="600"
          fill="white" stroke="black" stroke-width="${SUBTITLE_OUTLINE}" paint-order="stroke fill"
          letter-spacing="0">${escapeXml(line)}</text>`
    })
    .join('')
  return `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${texts}
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
    ...videoEncodeArgs(ENCODE_DELIVERY), '-movflags', '+faststart',
    ...audioEncodeArgs(), '-shortest', '-y', outPath,
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
    '-map', '[aout]', ...audioEncodeArgsStereo(),
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
      ...audioEncodeArgs(),
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
      ...videoEncodeArgs(ENCODE_DELIVERY), '-movflags', '+faststart',
      ...audioEncodeArgs(),
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
      '-c:v', 'copy', '-af', audioFilter(options), ...audioEncodeArgs(),
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
      '-c:v', 'copy', ...audioEncodeArgs(),
      '-shortest', '-y', outPath,
    ],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  )
}
