// FFmpeg 命令构建与执行：单镜头 trim+scale+调色 → 全片硬切 concat
// 分两步而非一次性 filter_complex：单镜头参数各自不同（trim 起止），
// 统一编码参数后再用 concat demuxer -c copy 拼接，最稳且最快
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rm, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ColorGrade } from '../services/render.service.js'

const execFileP = promisify(execFile)

/**
 * ffmpeg 可执行文件：可用 FFMPEG_PATH 覆盖（与 lib/thumbnail.ts 口径一致）。
 * 需要它的典型场景：Homebrew 把 ffmpeg 拆成精简版 `ffmpeg` 与完整版 `ffmpeg-full`，
 * 后者是 keg-only（不 symlink 进 /opt/homebrew/bin），只能靠绝对路径指过去。
 */
export function ffmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg'
}

/**
 * ffprobe 可执行文件：FFPROBE_PATH > FFMPEG_PATH 同目录 > PATH。
 * keg-only 安装通常只会配 FFMPEG_PATH，因此从它的同目录推导，避免 ffprobe 仍是旧版。
 */
export function ffprobeBin(): string {
  const explicit = process.env.FFPROBE_PATH?.trim()
  if (explicit) return explicit
  const ff = process.env.FFMPEG_PATH?.trim()
  if (ff) {
    const sibling = join(dirname(ff), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    if (existsSync(sibling)) return sibling
  }
  return 'ffprobe'
}

/** FFmpeg 滤镜能力探测结果缓存：进程内每种滤镜只探测一次 */
const filterSupport = new Map<string, boolean>()

export async function ffmpegSupportsFilter(name: string): Promise<boolean> {
  const cached = filterSupport.get(name)
  if (cached !== undefined) return cached
  let supported = false
  try {
    const { stdout } = await execFileP(ffmpegBin(), ['-hide_banner', '-filters'], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    supported = new RegExp(`\\b${name}\\b`).test(stdout)
  } catch {
    supported = false
  }
  filterSupport.set(name, supported)
  return supported
}

/**
 * 本机 ffmpeg 是否编译了 libass（即是否有 subtitles 滤镜）。
 * 注意：字幕烧录的前置条件是「有中文字体」**且**「ffmpeg 带 libass」，
 * 只查字体目录存在会误判（精简版 ffmpeg 没有 subtitles 滤镜，必烧必败）。
 */
export async function ffmpegSupportsSubtitles(): Promise<boolean> {
  return ffmpegSupportsFilter('subtitles')
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly killed = false,
  ) {
    super(message)
    this.name = 'FfmpegError'
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** 四参数调色 → ffmpeg 滤镜串（全 0 时返回 null，不挂滤镜省 CPU） */
export function buildColorFilter(c: ColorGrade): string | null {
  const eq: string[] = []
  if (c.brightness) eq.push(`brightness=${clamp(c.brightness / 100, -1, 1).toFixed(3)}`)
  if (c.contrast) eq.push(`contrast=${clamp(1 + c.contrast / 100, 0, 2).toFixed(3)}`)
  if (c.saturation) eq.push(`saturation=${clamp(1 + c.saturation / 100, 0, 3).toFixed(3)}`)
  const parts: string[] = []
  if (eq.length) parts.push(`eq=${eq.join(':')}`)
  // 只给 luma 三个参数：继续往下传会被解析为 chroma/alpha 尺寸，传 0 会报 "Result too large"
  if (c.sharpen) parts.push(`unsharp=5:5:${clamp(c.sharpen / 100, -2, 5).toFixed(3)}`)
  return parts.length ? parts.join(',') : null
}

export interface NormalizeOpts {
  width: number
  height: number
  startMs: number
  endMs: number
  /** 输出帧率。**必须传**（成片画布 fps）：见 ffmpegNormalize 里关于帧率不统一的注释 */
  fps?: number
  timeoutMs?: number
}

/**
 * 第一级：归一化（可缓存）
 * 按 trim 起止裁切 → 等比放大并居中裁切到 9:16 → **统一帧率/时间基** → 统一编码参数，**不含调色**
 * 音轨：**保留素材原声**，统一为 aac 44.1k 立体声 128k；素材本身没有音轨时才挂 anullsrc 静音轨。
 * 产物按 (assetId, trim, 尺寸) 缓存，重调色时直接复用，省掉源解码+缩放这个最贵的环节
 *
 * ★★ 为什么必须显式 `fps=`（2026-09-24 实测 task 32，用户反馈「中间卡顿」的真因）：
 *   原实现只统一了「编码参数」，**漏了帧率与时间基** —— 而下游拼接走的是
 *   `ffmpegConcat`（`-f concat -c copy`，流拷贝不重编码）。素材来自小程序自建相机的录制，
 *   帧率不保证是 30：实测 6 段里 5 段是 30/1 + timebase 1/15360，**第 4 段（asset 56）
 *   是 7500/253 ≈ 29.644fps + timebase 1/15000**。concat demuxer 用**第一段**的时间基做输出、
 *   再按各段自身 timebase 换算偏移，异质段就被错位挂上去，后果实测为：
 *     · 15.664s → 16.073s 丢约 12 帧（画面定住 0.4s，正是用户看到的卡顿）
 *     · 同时出现 `-0.066602s` 的**负间隔**和 `0.000196s` 的重复帧（接缝处的回跳/停顿）
 *   只加一条 `fps=30` 重编码**修不掉**（实测仍有 0.400000s×1 空洞），必须**逐段**统一帧率；
 *   而统一后同样的 `-c copy` 拼接实测 **0 异常**，所以既有速度也保住了。
 *   ⚠ 改了这条判据必须同时递增 `cache-keys.ts` 的 `INTERMEDIATE_CACHE_VERSION`，
 *     否则会继续命中按旧参数编出来的异质片段。
 */
export async function ffmpegNormalize(input: string, output: string, opts: NormalizeOpts): Promise<void> {
  const args: string[] = []
  const fps = Number.isFinite(opts.fps) && (opts.fps as number) > 0 ? (opts.fps as number) : 30
  if (opts.startMs > 0) args.push('-ss', (opts.startMs / 1000).toFixed(3))
  if (opts.endMs > opts.startMs) args.push('-to', (opts.endMs / 1000).toFixed(3))
  args.push('-i', input)
  // fps + settb 放在 format 之前：先落到统一网格，再定像素格式。
  // 顺序与 2026-09-24 的对照实验一致（fps=30,settb=AVTB,setsar=1 实测 -c copy 拼接 0 异常）
  const base =
    `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,` +
    `crop=${opts.width}:${opts.height},` +
    `fps=${fps},settb=AVTB,setsar=1,format=yuv420p`
  if (await hasAudioStream(input)) {
    // apad 把音轨补到不短于画面，再靠 -shortest 截到画面长度：画面时长不受音频长短影响
    args.push('-filter_complex', `[0:v]${base}[v];[0:a]apad[a]`)
    args.push('-map', '[v]', '-map', '[a]')
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100')
    args.push('-filter_complex', `[0:v]${base}[v]`)
    args.push('-map', '[v]', '-map', '1:a')
  }
  args.push('-shortest')
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-y', output,
  )
  await runFfmpeg(args, opts.timeoutMs ?? 120_000)
}

/**
 * 用最后一帧延长画面到目标时长。口播比原镜头长时使用，避免为了对齐音画而截断句子。
 * 输入已经是统一编码的中间片段，因此这里单独编码一个临时文件，不污染归一化缓存。
 */
export async function ffmpegExtendVideo(
  input: string,
  output: string,
  targetDurationMs: number,
  timeoutMs = 120_000,
): Promise<void> {
  const target = Math.max(1, Math.round(targetDurationMs))
  await runFfmpeg([
    '-i', input,
    '-vf', `tpad=stop_mode=clone:stop_duration=${(target / 1000).toFixed(3)}`,
    '-af', 'apad',
    '-t', (target / 1000).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart',
    '-y', output,
  ], timeoutMs)
}

/**
 * 生成一条极低存在感的无歌词背景音乐。
 *
 * 默认模式不能依赖外部音乐服务才能出片，因此这里使用确定性的和弦床作为兜底。
 * 运营可以通过 `DEFAULT_BGM_PATH` 替换成已获授权的音乐文件；调用方只在没有配置
 * 外部曲库时使用这个函数。音量会在混音阶段再次压低，避免盖住人声或原声。
 */
export async function ffmpegGenerateBackgroundMusic(
  output: string,
  durationMs: number,
  style: 'LIGHT' | 'UPBEAT' | 'PREMIUM' = 'LIGHT',
  timeoutMs = 120_000,
): Promise<void> {
  const duration = Math.max(1, Math.round(durationMs)) / 1000
  const presets = {
    LIGHT: [220, 277.18, 329.63],
    UPBEAT: [261.63, 329.63, 392],
    PREMIUM: [196, 246.94, 293.66],
  } as const
  const [a, b, c] = presets[style]
  const pulse = style === 'UPBEAT'
    ? '(0.72+0.28*sin(2*PI*2*t))'
    : style === 'PREMIUM'
      ? '(0.86+0.14*sin(2*PI*0.25*t))'
      : '(0.90+0.10*sin(2*PI*0.5*t))'
  const expr = `${pulse}*(0.30*sin(2*PI*${a}*t)+0.20*sin(2*PI*${b}*t)+0.14*sin(2*PI*${c}*t))`
  await runFfmpeg([
    '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=44100:d=${duration.toFixed(3)}`,
    '-af', `lowpass=f=1800,highpass=f=80,volume=0.22,afade=t=in:st=0:d=0.8,afade=t=out:st=${Math.max(0, duration - 1.5).toFixed(3)}:d=1.5`,
    '-ac', '2', '-ar', '44100', '-c:a', 'aac', '-b:a', '96k', '-t', duration.toFixed(3),
    '-y', output,
  ], timeoutMs)
}

export interface MeaningfulRange {
  durationMs: number
  startMs: number
  endMs: number
  blackRatio: number | null
  freezeRatio: number | null
  leadingSilenceMs: number
  trailingSilenceMs: number
}

export interface TimeRangeMs {
  startMs: number
  endMs: number
}

/**
 * 找出画面冻结与音频静音同时持续的区间。
 *
 * 单独的静音可能是正常 B-roll，单独的静止画面也可能是有意停留；两者重合且持续
 * 超过 0.8 秒时才视为高置信度无效停顿。首尾各保留 150ms，避免把呼吸和切点压得过硬。
 */
export async function probeRemovableFreezeSilenceRanges(
  input: string,
  timeoutMs = 45_000,
): Promise<TimeRangeMs[]> {
  const durationMs = await probeDurationMs(input)
  if (!durationMs || durationMs <= 0) return []
  const [videoResult, audioResult] = await Promise.all([
    execFileP(ffmpegBin(), [
      '-hide_banner', '-nostdin', '-i', input,
      '-vf', 'freezedetect=n=-60dB:d=0.45', '-an', '-f', 'null', '-',
    ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }).catch((e) => e as { stderr?: string }),
    execFileP(ffmpegBin(), [
      '-hide_banner', '-nostdin', '-i', input,
      '-af', 'silencedetect=noise=-42dB:d=0.45', '-vn', '-f', 'null', '-',
    ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }).catch((e) => e as { stderr?: string }),
  ])
  const durationSec = durationMs / 1000
  const freezes = detectedRanges(
    String((videoResult as { stderr?: string }).stderr ?? ''),
    /freeze_start:\s*(-?\d+(?:\.\d+)?)/g,
    /freeze_end:\s*(-?\d+(?:\.\d+)?)/g,
    durationSec,
  )
  const silences = detectedRanges(
    String((audioResult as { stderr?: string }).stderr ?? ''),
    /silence_start:\s*(-?\d+(?:\.\d+)?)/g,
    /silence_end:\s*(-?\d+(?:\.\d+)?)/g,
    durationSec,
  )
  const result: TimeRangeMs[] = []
  for (const freeze of freezes) {
    for (const silence of silences) {
      const start = Math.max(freeze.start, silence.start)
      const end = Math.min(freeze.end, silence.end)
      if (end - start < 0.8) continue
      const startMs = Math.round((start + 0.15) * 1000)
      const endMs = Math.round((end - 0.15) * 1000)
      if (endMs - startMs >= 300) result.push({ startMs, endMs })
    }
  }
  return mergeTimeRanges(result, durationMs)
}

function detectedRanges(
  log: string,
  startPattern: RegExp,
  endPattern: RegExp,
  durationSec: number,
): Array<{ start: number; end: number }> {
  const starts = [...log.matchAll(startPattern)].map((match) => Number(match[1])).filter(Number.isFinite)
  const ends = [...log.matchAll(endPattern)].map((match) => Number(match[1])).filter(Number.isFinite)
  let endIndex = 0
  return starts.flatMap((start) => {
    while (endIndex < ends.length && ends[endIndex]! <= start) endIndex += 1
    const end = endIndex < ends.length ? ends[endIndex++]! : durationSec
    return end > start ? [{ start: Math.max(0, start), end: Math.min(durationSec, end) }] : []
  })
}

function mergeTimeRanges(ranges: TimeRangeMs[], durationMs: number): TimeRangeMs[] {
  const sorted = ranges
    .map((range) => ({
      startMs: Math.max(0, Math.min(durationMs, range.startMs)),
      endMs: Math.max(0, Math.min(durationMs, range.endMs)),
    }))
    .filter((range) => range.endMs - range.startMs >= 100)
    .sort((a, b) => a.startMs - b.startMs)
  const merged: TimeRangeMs[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && range.startMs <= previous.endMs + 50) previous.endMs = Math.max(previous.endMs, range.endMs)
    else merged.push({ ...range })
  }
  return merged
}

/** 同步删除视频和音频中的高置信度无效区间，保持后续字幕时间轴一致。 */
export async function ffmpegRemoveTimeRanges(
  input: string,
  output: string,
  ranges: TimeRangeMs[],
  timeoutMs = 120_000,
): Promise<void> {
  const durationMs = await probeDurationMs(input)
  if (!durationMs || ranges.length === 0) throw new Error('没有可删除的音画区间')
  const removed = mergeTimeRanges(ranges, durationMs)
  const kept: TimeRangeMs[] = []
  let cursor = 0
  for (const range of removed) {
    if (range.startMs - cursor >= 100) kept.push({ startMs: cursor, endMs: range.startMs })
    cursor = Math.max(cursor, range.endMs)
  }
  if (durationMs - cursor >= 100) kept.push({ startMs: cursor, endMs: durationMs })
  if (!kept.length) throw new Error('无效区间覆盖了整段素材')
  const filters: string[] = []
  const concatInputs: string[] = []
  kept.forEach((range, index) => {
    const start = (range.startMs / 1000).toFixed(3)
    const end = (range.endMs / 1000).toFixed(3)
    filters.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`)
    filters.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`)
    concatInputs.push(`[v${index}][a${index}]`)
  })
  filters.push(`${concatInputs.join('')}concat=n=${kept.length}:v=1:a=1[v][a]`)
  await runFfmpeg([
    '-i', input,
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart',
    '-y', output,
  ], timeoutMs)
}

/**
 * 找出一段素材里可以安全去掉的首尾无效区间。
 * 只处理首尾，绝不因为中间短暂安静就切断画面；这条保守策略能避免把一句话从中间
 * 剁掉。内部长停顿交给音频混音阶段处理，画面时间轴保持稳定。
 */
export async function probeMeaningfulRange(input: string, timeoutMs = 45_000): Promise<MeaningfulRange | null> {
  const durationMs = await probeDurationMs(input)
  if (!durationMs || durationMs <= 0) return null
  const videoArgs = [
    '-hide_banner', '-nostdin', '-i', input,
    '-vf', 'blackdetect=d=0.20:pix_th=0.10,freezedetect=n=-60dB:d=0.50',
    '-an', '-f', 'null', '-',
  ]
  const audioArgs = [
    '-hide_banner', '-nostdin', '-i', input,
    '-af', 'silencedetect=noise=-45dB:d=0.35',
    '-vn', '-f', 'null', '-',
  ]
  const [videoResult, audioResult] = await Promise.all([
    execFileP(ffmpegBin(), videoArgs, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }).catch((e) => e as { stderr?: string }),
    execFileP(ffmpegBin(), audioArgs, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }).catch((e) => e as { stderr?: string }),
  ])
  const videoLog = String((videoResult as { stderr?: string }).stderr ?? '')
  const audioLog = String((audioResult as { stderr?: string }).stderr ?? '')
  const blackMs = [...videoLog.matchAll(/black_duration:\s*(\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]) * 1000).filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0)
  const freezeMs = [...videoLog.matchAll(/freeze_duration:\s*(\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]) * 1000).filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0)
  const silenceStarts = [...audioLog.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]) * 1000).filter((v) => Number.isFinite(v) && v >= 0)
  const silenceEnds = [...audioLog.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]) * 1000).filter((v) => Number.isFinite(v) && v >= 0)
  const leadingSilenceMs = silenceStarts[0] === 0 && silenceEnds[0] !== undefined
    ? Math.min(durationMs, silenceEnds[0]!)
    : 0
  const lastStart = silenceStarts[silenceStarts.length - 1]
  const lastEnd = silenceEnds[silenceEnds.length - 1]
  const trailingSilenceMs = lastStart !== undefined && (lastEnd === undefined || lastEnd >= durationMs - 120)
    ? Math.max(0, durationMs - lastStart)
    : 0
  const blackRatio = Number.isFinite(blackMs) ? Math.min(1, blackMs / durationMs) : null
  const freezeRatio = Number.isFinite(freezeMs) ? Math.min(1, freezeMs / durationMs) : null
  const leadingVisualMs = parseLeadingVisualMs(videoLog)
  const trailingVisualMs = parseTrailingVisualMs(videoLog, durationMs)
  // 安静不等于无意义：餐饮 B-roll 常常没有人声。静音只作为诊断信号返回，
  // 不能单独驱动画面裁切；实际裁切只采用黑屏/长冻结这类确定性坏画面信号。
  const startMs = Math.min(durationMs, Math.max(0, leadingVisualMs))
  const endTrimMs = Math.max(0, trailingVisualMs)
  const endMs = Math.max(startMs + 300, durationMs - endTrimMs)
  return { durationMs, startMs, endMs, blackRatio, freezeRatio, leadingSilenceMs, trailingSilenceMs }
}

function parseLeadingVisualMs(log: string): number {
  const ranges = visualRanges(log)
  const leading = ranges.filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.start <= 0.12).sort((a, b) => b.end - a.end)[0]
  return leading && leading.end - leading.start >= 0.5 ? Math.round(leading.end * 1000) : 0
}

function parseTrailingVisualMs(log: string, durationMs: number): number {
  const trailing = visualRanges(log)
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end * 1000 >= durationMs - 120)
    .sort((a, b) => a.start - b.start)[0]
  return trailing && trailing.end - trailing.start >= 0.5
    ? Math.max(0, Math.round(durationMs - trailing.start * 1000))
    : 0
}

function visualRanges(log: string): Array<{ start: number; end: number }> {
  const pair = (startPattern: RegExp, endPattern: RegExp) => {
    const starts = [...log.matchAll(startPattern)].map((m) => Number(m[1])).filter(Number.isFinite)
    const ends = [...log.matchAll(endPattern)].map((m) => Number(m[1])).filter(Number.isFinite)
    return starts.flatMap((start, index) => {
      const end = ends[index]
      return end !== undefined && end > start ? [{ start, end }] : []
    })
  }
  return [
    ...pair(/black_start:\s*(\d+(?:\.\d+)?)/g, /black_end:\s*(\d+(?:\.\d+)?)/g),
    ...pair(/freeze_start:\s*(\d+(?:\.\d+)?)/g, /freeze_end:\s*(\d+(?:\.\d+)?)/g),
  ]
}

/**
 * 调色的编码档位。**只允许改编码参数，不允许改滤镜链** —— 这是「调色预览与最终成片
 * 看起来一致」的唯一保证：预览与成片都走同一个 `buildColorFilter(color)`，
 * 差别只在「压得糙不糙」。任何在预览侧额外挂 scale/crop/降帧的改动都会让
 * 锐化（unsharp 是**像素半径**卷积）的观感失真，从而让预览变成误导。
 */
export interface ColorEncodeOpts {
  preset?: string
  crf?: number
}

const COLOR_ENCODE_DEFAULT: Required<ColorEncodeOpts> = { preset: 'veryfast', crf: 23 }

/**
 * 构建「调色」这一步的 ffmpeg 参数。抽成纯函数是为了让它**可被测试断言**：
 * 预览与成片必须产出**完全相同的 `-vf`**（见 ColorEncodeOpts 的说明），
 * 而这件事只有在能把参数拿出来比对时才是可验证的，否则只能靠人盯代码。
 */
export function buildApplyColorArgs(
  input: string,
  output: string,
  color: ColorGrade,
  encode?: ColorEncodeOpts,
): string[] {
  const cf = buildColorFilter(color)
  if (!cf) throw new Error('调色参数全为 0，无需重编码（调用方应先判断）')
  const { preset, crf } = { ...COLOR_ENCODE_DEFAULT, ...encode }
  return [
    '-i', input,
    '-vf', cf,
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'copy',
    '-y', output,
  ]
}

/**
 * 第二级：调色（不可缓存，随参数变化）
 * 只重编码视频、音频直接 copy —— 一级产物已统一参数，这里开销远小于从源解码
 */
export async function ffmpegApplyColor(
  input: string,
  output: string,
  color: ColorGrade,
  timeoutMs = 120_000,
  encode?: ColorEncodeOpts,
): Promise<void> {
  await runFfmpeg(buildApplyColorArgs(input, output, color, encode), timeoutMs)
}

/**
 * 逐输入的「复位」滤镜：把每一路画面的时间基和 PTS 都归零、帧率统一，音轨同理。
 *
 * ★ 抽成一处出处，是因为它**必须**在多条拼接路径上保持一致：不一致就会重新长出
 *   「某条路径复位了、另一条没复位」这种接缝丢帧 bug（2026-09-24 就是这么炸的）。
 */
function perInputResetFilter(index: number, fps: number): string {
  return `[${index}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps},setsar=1,format=yuv420p[v${index}];` +
    `[${index}:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}];`
}

/**
 * 片段的「帧率|时间基」签名，用于判断能否安全地 `-c copy` 拼接。
 * 取不到返回 null，调用方按「不确定」处理（不敢 copy）。
 */
async function probeVideoSignature(file: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(ffprobeBin(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate,time_base',
      '-of', 'default=nw=1', file,
    ], { timeout: 30_000, maxBuffer: 1 * 1024 * 1024 })
    const text = String(stdout)
    const rate = /r_frame_rate=(\S+)/.exec(text)?.[1]
    const base = /time_base=(\S+)/.exec(text)?.[1]
    return rate && base ? `${rate}|${base}` : null
  } catch {
    return null
  }
}

/**
 * 逐输入复位 PTS + 统一帧率后再 concat 重编码 —— 接缝不安全时的兜底路径。
 *
 * ★ 实测（2026-09-24，任务 32 的 6 段缓存片段，第 4 段是 29.644fps/1-15000）：
 *     走 `-c copy`            → 15.664→16.073 丢约 12 帧（0.4s 定住）+ 一处 `-0.066602s` 负间隔 + 一处重复帧
 *     走这条逐输入复位后拼接   → 帧间隔 496×0.033333 + 248×0.033334，**零异常**
 *   ⚠ 只在外层加一条 `fps=30` 是修不掉的（实测仍有 0.400000s×1 空洞）—— 必须逐输入复位。
 * ⚠ 代价是整段重编码，比 `-c copy` 慢，所以只在判据命中时才走这里。
 */
async function concatWithPtsReset(inputs: string[], output: string, timeoutMs: number, fps = 30): Promise<void> {
  const filters = inputs.map((_, index) => perInputResetFilter(index, fps)).join('')
  const labels = inputs.map((_, index) => `[v${index}][a${index}]`).join('')
  await runFfmpeg([
    ...inputs.flatMap((input) => ['-i', input]),
    '-filter_complex', `${filters}${labels}concat=n=${inputs.length}:v=1:a=1[v][a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart',
    '-y', output,
  ], timeoutMs)
}

/**
 * 硬切拼接（无转场）。默认 `-f concat -c copy`（流拷贝，不重编码，快）。
 *
 * ★★ 但 `-c copy` **有前提**：各片段的帧率与时间基必须一致。这个前提原来只写在注释里、
 *   没有任何检查，而生产上真的不成立 —— 小程序自建相机录出来的片段帧率可能是 29.644 这种
 *   非 30 值（见 ffmpegNormalize 的注释），concat demuxer 会按第一段的时间基错位挂上去，
 *   接缝处丢帧、画面定住，就是用户反馈的「中间卡顿」。
 *   所以这里补一条判据：签名不一致（或取不到）就不敢 copy，改走逐输入复位的重编码路径。
 *   代价只在真正异质时才付，同质的正常单还是会走 `-c copy`。
 */
export async function ffmpegConcat(inputs: string[], output: string, timeoutMs = 120_000): Promise<void> {
  const signatures = await Promise.all(inputs.map((input) => probeVideoSignature(input)))
  const first = signatures[0]
  const homogeneous = Boolean(first) && signatures.every((signature) => signature === first)
  if (!homogeneous) {
    console.warn(
      `[ffmpeg] 片段帧率/时间基不一致（${signatures.map((s) => s ?? '未知').join(', ')}），` +
      `改用逐输入复位的重编码拼接，避免接缝丢帧`,
    )
    await concatWithPtsReset(inputs, output, timeoutMs)
    return
  }
  const listPath = `${output}.list.txt`
  const listText = inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
  await writeFile(listPath, listText, 'utf8')
  const args = ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', '-y', output]
  try {
    await runFfmpeg(args, timeoutMs)
  } finally {
    await rm(listPath, { force: true })
  }
}

export type TransitionStyle = 'CLEAN' | 'SMOOTH' | 'DYNAMIC'

/**
 * 拼接并应用真实的镜头转场。CLEAN 保持无损硬切；其余两档用 xfade/acrossfade
 * 同步处理画面和声音。素材过短、缺少时长或当前 ffmpeg 不支持滤镜时回退硬切，
 * 保证选项不会把任务变成不可恢复的失败。
 */
export async function ffmpegConcatWithTransitions(
  inputs: string[],
  output: string,
  transition: TransitionStyle,
  timeoutMs = 120_000,
): Promise<void> {
  if (transition === 'CLEAN' || inputs.length < 2) {
    await ffmpegConcat(inputs, output, timeoutMs)
    return
  }
  const durations = await Promise.all(inputs.map((input) => probeDurationMs(input)))
  if (durations.some((duration) => !duration || duration <= 700)) {
    await ffmpegConcat(inputs, output, timeoutMs)
    return
  }
  const durationSec = transition === 'DYNAMIC' ? 0.28 : 0.35
  const transitionName = transition === 'DYNAMIC' ? 'wipeleft' : 'fade'
  if (durations.some((duration) => (duration as number) / 1000 <= durationSec + 0.1)) {
    await ffmpegConcat(inputs, output, timeoutMs)
    return
  }
  const args = inputs.flatMap((input) => ['-i', input])
  // xfade/acrossfade require every input to start at PTS=0. The normalized
  // files normally do, but concat/cache paths and container edit lists can
  // still carry a non-zero timestamp. Reset both streams explicitly so a
  // transition cannot repeat or stall a short section at a seam.
  // ★ 复位滤镜与 concatWithPtsReset 共用同一个出处（perInputResetFilter）：
  //   两处写法一旦漂移，就会重新长出「某条路径没复位 ⇒ 接缝丢帧」的 bug。
  let filter = inputs.map((_, index) => perInputResetFilter(index, 30)).join('')
  let videoLabel = 'v0'
  let audioLabel = 'a0'
  let timelineSec = (durations[0] as number) / 1000
  for (let index = 1; index < inputs.length; index += 1) {
    const nextVideo = `v${index}`
    const nextAudio = `a${index}`
    const nextVideoLabel = `v${index}`
    const nextAudioLabel = `a${index}`
    const offset = Math.max(0, timelineSec - durationSec)
    filter += `[${videoLabel}][${nextVideo}]xfade=transition=${transitionName}:duration=${durationSec}:offset=${offset.toFixed(3)}[${nextVideoLabel}];`
    filter += `[${audioLabel}][${nextAudio}]acrossfade=d=${durationSec}:c1=tri:c2=tri[${nextAudioLabel}];`
    videoLabel = nextVideoLabel
    audioLabel = nextAudioLabel
    timelineSec += (durations[index] as number) / 1000 - durationSec
  }
  args.push(
    '-filter_complex', filter,
    '-map', `[${videoLabel}]`, '-map', `[${audioLabel}]`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', '-y', output,
  )
  try {
    await runFfmpeg(args, timeoutMs)
  } catch (error) {
    console.warn(`[ffmpeg] ${transition} 转场不可用，回退硬切：`, (error as Error).message)
    await ffmpegConcat(inputs, output, timeoutMs)
  }
}

/** 从视频提取单声道 16k PCM WAV，供 Whisper-compatible ASR 使用。 */
export async function ffmpegExtractAudio(input: string, output: string, timeoutMs = 120_000): Promise<void> {
  await runFfmpeg([
    '-i', input,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-y', output,
  ], timeoutMs)
}

async function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  try {
    await execFileP(ffmpegBin(), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string; killed?: boolean }
    throw new FfmpegError(describeFfmpegError(err), err.killed)
  }
}

/** 抽取真实错误：ffmpeg 的 banner 占满前十几行，有效信息在 stderr 末尾或带 Error 的行 */
function describeFfmpegError(err: { stderr?: string; stdout?: string; message?: string }): string {
  const raw = err.stderr || err.stdout || err.message || 'ffmpeg failed'
  const lines = raw.split('\n').filter((l) => /error|invalid|failed|unable|not found|no such|refus/i.test(l))
  if (lines.length) return lines.slice(-5).join('\n').slice(0, 800)
  return raw.slice(-800)
}

/** 探测时长（毫秒），失败返回 null，不阻塞主流程 */
export async function probeDurationMs(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP(ffprobeBin(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 })
    const sec = Number(String(stdout).trim())
    return Number.isFinite(sec) ? Math.round(sec * 1000) : null
  } catch {
    return null
  }
}

/**
 * 素材是否含音轨。归一化据此决定「保留原声」还是「挂静音轨」。
 * 探测失败按 false 处理（走静音兜底），避免因探测异常导致整个合成失败。
 */
export async function hasAudioStream(file: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP(ffprobeBin(), [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file,
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 })
    return String(stdout).trim().length > 0
  } catch {
    return false
  }
}

export interface VideoProbe {
  /** 是否是一个可解码、有时长的视频 */
  ok: boolean
  /** 时长（毫秒），探测不到为 null */
  durationMs: number | null
  /** 视频编码名（h264 / hevc …） */
  videoCodec: string | null
  /** 不通过时的原因（可直接写进 errorMsg 给用户看） */
  reason?: string
}

/**
 * 成片可用性校验：确认输入确实是「能解码、有时长」的视频。
 *
 * 为什么必须有它：外部剪辑通道（ChatCut）只要返回 HTTP 200，我们就走 completeRender 扣全额积分。
 * 但 200 不等于内容正确 —— 上游返回一个 HTML 错误页、一段 JSON、或 0 字节文件时，
 * 旧代码会把坏文件当真成片入库并扣费。结果：用户付了钱拿到打不开的文件。
 *
 * input 可以是本地文件路径，也可以是 http(s) 签名 URL（ffprobe 原生支持网络输入，
 * 因此远端产物不必先整包下载到本地就能校验）。
 */
export async function probeVideo(input: string, timeoutMs = 60_000): Promise<VideoProbe> {
  try {
    const { stdout } = await execFileP(ffprobeBin(), [
      '-v', 'error',
      // 网络输入读取超时（微秒）：避免上游挂住导致 worker 卡死
      '-rw_timeout', '15000000',
      '-show_entries', 'format=duration:stream=codec_type,codec_name',
      '-of', 'json',
      input,
    ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })

    const parsed = JSON.parse(String(stdout)) as {
      format?: { duration?: string }
      streams?: Array<{ codec_type?: string; codec_name?: string }>
    }
    const streams = parsed.streams ?? []
    const video = streams.find((s) => s.codec_type === 'video')
    if (!video) {
      return { ok: false, durationMs: null, videoCodec: null, reason: '文件中没有视频流（可能不是视频）' }
    }
    const sec = Number(parsed.format?.duration)
    const durationMs = Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null
    if (!durationMs) {
      return { ok: false, durationMs: null, videoCodec: video.codec_name ?? null, reason: '视频时长为 0 或无法读取' }
    }
    return { ok: true, durationMs, videoCodec: video.codec_name ?? null }
  } catch (e) {
    return { ok: false, durationMs: null, videoCodec: null, reason: `无法解析为视频：${conciseProbeError(e)}` }
  }
}

/**
 * 找系统根证书包。**直读 https 时必须显式传给 ffprobe**：
 * keg-only / homebrew 装的 ffmpeg 链的是它自带的 openssl，不认系统钥匙串，
 * 于是 `[tls] Peer certificate failed verification: Input/output error`。
 * 实测同一个 COS 签名 URL：不加参数**必失败**，加 `-ca_file /etc/ssl/cert.pem` 正常（≈500ms）。
 * 一个候选都不存在就返回 null，交回 ffmpeg 默认行为 —— 不猜路径。
 */
function probeCaFile(): string | null {
  const candidates = [
    process.env.FFPROBE_CA_FILE?.trim(),
    '/etc/ssl/cert.pem', // macOS
    '/etc/ssl/certs/ca-certificates.crt', // Debian / Ubuntu
    '/etc/pki/tls/certs/ca-bundle.crt', // RHEL / CentOS
  ].filter((p): p is string => Boolean(p))
  return candidates.find((p) => existsSync(p)) ?? null
}

export interface ClipProbe {
  ok: boolean
  /** **显示**宽高（已按旋转角折算，见 rotateToDisplay）—— 不是容器宽高 */
  width: number | null
  height: number | null
  /** 原始旋转角（度），没有旋转信息时为 null。仅用于排查与日志。 */
  rotationDegrees: number | null
  durationMs: number | null
  hasAudioTrack: boolean
  reason?: string
}

/**
 * 把「容器宽高 + 旋转角」折算成**真实显示宽高**。
 *
 * ★★ 为什么必须折算（2026-09-22 线上事故，AI 档成片构图被毁）：
 *
 *   手机竖拍经部分 App / 微信导出后，落地像素是**躺着**的 —— 容器写 `960×540`，
 *   另配一个 `rotation=-90` 的 side data 告诉播放器「转 90° 再显示」。
 *   ⇒ **真实显示尺寸是 `540×960`**，`960×540` 只是它躺着的尺寸。
 *
 *   `ffprobe` 默认只报**容器宽高**，不看旋转 ⇒ 所有按宽高做算术的地方都会算错：
 *     · 素材表 `width/height` 存成 960×540（封面/预览跟着错）；
 *     · 上报给云端合成器的也是 960×540 ⇒ 云端据此算 `fit:"cover"` 的缩放系数
 *       `max(1080/960, 1920/540) = 3.556`，而按真实尺寸只要 `max(1080/540, 1920/960) = 2.0`
 *       ⇒ **多放大 1.78 倍**再居中裁切 ⇒ 成片只剩脸部特写。
 *
 *   ★ 本地 ffmpeg 管线没有这个缺陷，因为 `scale`/`crop` 滤镜**默认自动应用旋转**
 *     （autorotate 打开），它拿到的本来就是 540×960。**两边口径必须一致**，
 *     否则同一条素材「本地档正常、云端档被裁坏」——这正是当时最迷惑人的现象。
 *
 * 判据（两分钟验完）：
 *   ffprobe -v error -select_streams v:0 \
 *     -show_entries stream=width,height:stream_side_data=rotation -of csv=p=0 input.mp4
 *   ⇒ `960,540,-90` 表示显示尺寸是 `540×960`。
 *
 * @param sideDataList ffprobe JSON 里 `streams[i].side_data_list`
 */
export function rotateToDisplay(
  width: number,
  height: number,
  sideDataList?: ReadonlyArray<{ rotation?: number }> | null,
): { width: number; height: number; rotationDegrees: number | null } {
  const raw = sideDataList?.map((item) => Number(item?.rotation)).find((value) => Number.isFinite(value))
  if (raw === undefined) return { width, height, rotationDegrees: null }
  // 归一化到 [0,360)：-90、270、450 都是「竖过来」那一族；180 只上下颠倒，宽高不变
  const normalized = ((raw % 360) + 360) % 360
  const swapped = normalized === 90 || normalized === 270
  return swapped ? { width: height, height: width, rotationDegrees: raw } : { width, height, rotationDegrees: raw }
}

/**
 * 探测素材元数据（宽高 / 时长 / 有无音轨）。
 *
 * ★ input 可以是 **http(s) 签名 URL**：ffprobe 原生支持网络输入，不必先整包下载。
 *   这对云端剪辑通道是必需的 —— 它的 import registration 对视频**要求完整 metadata**
 *   （缺宽高直接回 400 `requires complete metadata`），而素材表的 width/height 经常为空
 *   （由客户端在上传确认时**选择性**上报，实测视频仅 25/56 有值）。
 *
 * ★ 拿不到视频流时 `ok=false`，调用方**不能**拿画布尺寸之类的假值去凑 ——
 *   声明错的尺寸比不声明更糟（云端会按错的比例处理）。
 */
export async function probeClipMeta(input: string, timeoutMs = 30_000): Promise<ClipProbe> {
  const caFile = probeCaFile()
  try {
    const { stdout } = await execFileP(ffprobeBin(), [
      '-v', 'error',
      // 网络输入读取超时（微秒）：上游挂住时不要陪着一起卡
      '-rw_timeout', '15000000',
      ...(caFile ? ['-ca_file', caFile] : []),
      // ★ `stream_side_data=rotation` 必须带上：不带就只能拿到容器宽高，见 rotateToDisplay
      '-show_entries', 'stream=codec_type,width,height:stream_side_data=rotation:format=duration',
      '-of', 'json',
      input,
    ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })

    const parsed = JSON.parse(String(stdout)) as {
      format?: { duration?: string }
      streams?: Array<{
        codec_type?: string
        width?: number
        height?: number
        side_data_list?: Array<{ rotation?: number }>
      }>
    }
    const streams = parsed.streams ?? []
    const video = streams.find((s) => s.codec_type === 'video')
    if (!video?.width || !video?.height) {
      return {
        ok: false,
        width: null,
        height: null,
        rotationDegrees: null,
        durationMs: null,
        hasAudioTrack: false,
        reason: '未能从素材中解析出视频宽高（可能不是视频文件）',
      }
    }
    const sec = Number(parsed.format?.duration)
    // ★★ 在这里就把旋转折算掉：返回的 width/height 一律是**显示尺寸**。
    //    调用方（素材表回填、云端 import 元数据）都不需要、也不应该自己再处理旋转。
    const display = rotateToDisplay(video.width, video.height, video.side_data_list)
    return {
      ok: true,
      width: display.width,
      height: display.height,
      rotationDegrees: display.rotationDegrees,
      durationMs: Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null,
      hasAudioTrack: streams.some((s) => s.codec_type === 'audio'),
    }
  } catch (e) {
    return {
      ok: false,
      width: null,
      height: null,
      rotationDegrees: null,
      durationMs: null,
      hasAudioTrack: false,
      reason: `元数据探测失败：${conciseProbeError(e)}`,
    }
  }
}

/** ffprobe 的报错是一整段带命令行的 stderr，取最后一行有效信息即可（要写进用户可见的 errorMsg） */
function conciseProbeError(e: unknown): string {
  const raw = String((e as { stderr?: string; message?: string }).stderr ?? (e as Error).message ?? e)
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Command failed:') && !l.startsWith('ffprobe '))
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, ''))
  const last = lines[lines.length - 1] ?? '探测失败'
  return last.slice(0, 200)
}

/**
 * 测一段素材（本地文件或 http(s) 签名 URL）的**整体响度**（EBU R128 integrated，单位 LUFS）。
 *
 * ★ 为什么需要它（2026-09-21）：AI 档的「统一音量」**不是 ChatCut 的能力** ——
 *   它的 59 个工具里没有任何响度归一项，`submit_export` 也没有音频归一选项；
 *   唯一能改音量的原语是 `edit_item` 的 `decibelAdjustment`。
 *   所以做法只能是「先把每段素材的真实响度在本地测出来，再据此算出每个 item 该加/减多少 dB」。
 *   这比拍一个固定增益值靠谱得多：用户的分镜来自不同手机/不同环境，电平差经常有 10dB 以上。
 *
 * ★ `-rw_timeout`：input 是签名 URL 时上游挂住不能陪着一起卡；外层 `timeoutMs` 再兜一层。
 * ★ 失败一律返回 null —— 调用方按「这一段不做调整」处理。**绝不能因为测不了响度就让出片失败**。
 */
export async function probeLoudnessLufs(input: string, timeoutMs = 45_000): Promise<number | null> {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-rw_timeout', '15000000',
    '-i', input,
    // 只取第一条音轨；素材没音轨时 ffmpeg 会报错 ⇒ 由 catch 归一成 null
    '-map', '0:a:0',
    '-af', 'ebur128=peak=none',
    '-f', 'null', '-',
  ]
  try {
    const { stderr } = await execFileP(ffmpegBin(), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
    return parseLufs(String(stderr))
  } catch (e) {
    // 有些 ffmpeg 会把 summary 写进 stderr 之后仍以非 0 退出 ⇒ 再从 stderr 里捞一次
    return parseLufs(String((e as { stderr?: string }).stderr ?? ''))
  }
}

/**
 * 从 ebur128 的 stderr 里取整体响度 `I: -23.4 LUFS`。
 * ★ 必须带 `LUFS` 单位一起匹配：filter 日志里同时有 `M:`（momentary）与 `S:`（short-term），
 *   只按 `I:` 抓容易误伤；取**最后一条**（summary 在最后）才是整段的结果。
 */
function parseLufs(stderr: string): number | null {
  const matches = [...stderr.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/gi)]
  if (matches.length === 0) return null
  const value = Number(matches[matches.length - 1]![1])
  return Number.isFinite(value) ? value : null
}

/**
 * 测「语音在哪里结束」（毫秒）—— 即去掉**尾部静音**之后的实际语音长度。
 *
 * ★★ 为什么需要它（2026-09-21）：AI 档的「剪辑节奏」档位想把镜头缩短，
 *   而配音是**按镜头时长合成**的 —— `synthesizeNarration` 对齐时长的做法是
 *   `apad` 尾部补静音 + `-t` 硬截断。于是：
 *     · 台词自然读出来比镜头短 ⇒ 结尾是一段**静音填充**，缩镜头没问题；
 *     · 台词自然读出来比镜头长 ⇒ 旧写法会把这句**从中间截断**，而且它是静默的
 *       （合成"成功"、时长也"对"，只有听才发现）。
 *   缩镜头必须知道「这句话至少要多久」，否则就会撞上第二种情况。
 *   判别尾部静音正好是免费的：`apad` 补出来的就是纯数字静音，必然是文件末尾那段静音。
 *
 * ★ 判据 = **最后一个 `silence_start`**。实测（ffmpeg 9）尾部静音在 EOF 处也会配一条
 *   `silence_end: <文件时长>`，所以「未闭合的 silence_start」这条规则反而永远不触发；
 *   而取最后一个 start 在「中间有停顿」的样本上也正确（尾部静音一定是最靠后的那段）。
 * ★ 一个静音都没检测到 ⇒ 返回 null（调用方按「整段都是语音」处理，即不缩镜头）。
 * ★ 失败一律 null：测得准不准只影响节奏档位的保守程度，绝不能让它把出片搞失败。
 */
export async function probeSpeechEndMs(input: string, timeoutMs = 45_000): Promise<number | null> {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-rw_timeout', '15000000',
    '-i', input,
    '-map', '0:a:0',
    '-af', 'silencedetect=noise=-40dB:d=0.25',
    '-f', 'null', '-',
  ]
  let stderr = ''
  try {
    stderr = String((await execFileP(ffmpegBin(), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })).stderr)
  } catch (e) {
    stderr = String((e as { stderr?: string }).stderr ?? '')
  }
  const starts = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 0)
  if (starts.length === 0) return null
  return Math.round(starts[starts.length - 1]! * 1000)
}

export interface VisualQualitySignals {
  blackRatio: number | null
  freezeRatio: number | null
}

/**
 * 轻量级画面健康检查。它不是内容理解模型，只负责淘汰明显不可用的黑帧/冻结片段；
 * 失败返回 null，由上层继续走保守规则，不把可选质量信号变成出片硬依赖。
 */
export async function probeVisualQuality(input: string, timeoutMs = 45_000): Promise<VisualQualitySignals | null> {
  const durationMs = await probeDurationMs(input)
  if (!durationMs || durationMs <= 0) return null
  const args = [
    '-hide_banner', '-nostdin', '-i', input,
    '-vf', 'blackdetect=d=0.20:pix_th=0.10,freezedetect=n=-60dB:d=0.50',
    '-an', '-f', 'null', '-',
  ]
  let stderr = ''
  try {
    stderr = String((await execFileP(ffmpegBin(), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })).stderr)
  } catch (e) {
    stderr = String((e as { stderr?: string }).stderr ?? '')
  }
  const blackMs = [...stderr.matchAll(/black_duration:\s*(\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]) * 1000)
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0)
  const freezeMs = [...stderr.matchAll(/freeze_duration:\s*(\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]) * 1000)
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0)
  return {
    blackRatio: Number.isFinite(blackMs) ? Math.min(1, blackMs / durationMs) : null,
    freezeRatio: Number.isFinite(freezeMs) ? Math.min(1, freezeMs / durationMs) : null,
  }
}

/**
 * 「剪辑节奏」提速配音时的语速上限。`atempo` 保音高，但 1.35 倍以上开始发飘、不像人话。
 */
export const MAX_SPEECH_TEMPO = 1.35

/**
 * 把一段音频**重新对齐**到目标时长：太长就整句提速（`atempo`，保音高），太短补静音。
 *
 * ★★ 为什么不用 `-t` 直接截断：那会把台词从中间切掉，而且完全是静默的
 *   （合成"成功"、时长也"对"，只有听才发现）—— 见 `probeSpeechEndMs` 的注释。
 *   这里把「多出来的时长」摊到整句上（1.1~1.35 倍速听起来仍然自然），
 *   而不是从尾巴上剁掉。
 * ★ 原文件与输出**不能同路径**：ffmpeg 边读边写会把输入读坏。所以先写 `.retimed.m4a`
 *   再原子替换；失败时保留原文件（宁可结尾多一截静音，也不要因为提速失败丢掉配音）。
 * ★ `atempo` 只接受 (0.5, 100)；本函数只会用 ≥1 的值，不会碰下限。
 */
export async function retimeAudioTo(
  filePath: string,
  targetMs: number,
  tempo = 1,
  timeoutMs = 60_000,
): Promise<boolean> {
  const target = Math.max(1, Math.round(targetMs))
  const rate = Number.isFinite(tempo) && tempo > 1.0001 ? tempo : 1
  const tmpPath = `${filePath}.retimed.m4a`
  const filters = [rate > 1 ? `atempo=${rate.toFixed(4)}` : null, 'apad'].filter(Boolean).join(',')
  try {
    await execFileP(
      ffmpegBin(),
      [
        '-hide_banner', '-nostdin',
        '-i', filePath,
        '-af', filters,
        '-t', (target / 1000).toFixed(3),
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        '-y', tmpPath,
      ],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    )
    await rename(tmpPath, filePath)
    return true
  } catch {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    return false
  }
}
