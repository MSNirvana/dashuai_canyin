// FFmpeg 命令构建与执行：单镜头 trim+scale+调色 → 全片硬切 concat
// 分两步而非一次性 filter_complex：单镜头参数各自不同（trim 起止），
// 统一编码参数后再用 concat demuxer -c copy 拼接，最稳且最快
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rm } from 'node:fs/promises'
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

/** subtitles 滤镜（libass）能力探测结果缓存：进程内只探测一次 */
let subtitlesSupport: boolean | null = null

/**
 * 本机 ffmpeg 是否编译了 libass（即是否有 subtitles 滤镜）。
 * 注意：字幕烧录的前置条件是「有中文字体」**且**「ffmpeg 带 libass」，
 * 只查字体目录存在会误判（精简版 ffmpeg 没有 subtitles 滤镜，必烧必败）。
 */
export async function ffmpegSupportsSubtitles(): Promise<boolean> {
  if (subtitlesSupport !== null) return subtitlesSupport
  try {
    const { stdout } = await execFileP(ffmpegBin(), ['-hide_banner', '-filters'], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    subtitlesSupport = /\bsubtitles\b/.test(stdout)
  } catch {
    subtitlesSupport = false
  }
  return subtitlesSupport
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
  timeoutMs?: number
}

/**
 * 第一级：归一化（可缓存）
 * 按 trim 起止裁切 → 等比放大并居中裁切到 9:16 → 统一编码参数，**不含调色**
 * 音轨：**保留素材原声**，统一为 aac 44.1k 立体声 128k；素材本身没有音轨时才挂 anullsrc 静音轨。
 *       两条分支产出参数一致，所以 concat demuxer -c copy 仍然成立。
 *       （早期版本一律丢弃原声挂静音轨，导致成片完全无声，已修正。）
 * 产物按 (assetId, trim, 尺寸) 缓存，重调色时直接复用，省掉源解码+缩放这个最贵的环节
 */
export async function ffmpegNormalize(input: string, output: string, opts: NormalizeOpts): Promise<void> {
  const args: string[] = []
  if (opts.startMs > 0) args.push('-ss', (opts.startMs / 1000).toFixed(3))
  if (opts.endMs > opts.startMs) args.push('-to', (opts.endMs / 1000).toFixed(3))
  args.push('-i', input)
  const base =
    `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,` +
    `crop=${opts.width}:${opts.height},format=yuv420p`
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
 * 第二级：调色（不可缓存，随参数变化）
 * 只重编码视频、音频直接 copy —— 一级产物已统一参数，这里开销远小于从源解码
 */
export async function ffmpegApplyColor(
  input: string,
  output: string,
  color: ColorGrade,
  timeoutMs = 120_000,
): Promise<void> {
  const cf = buildColorFilter(color)
  if (!cf) throw new Error('调色参数全为 0，无需重编码（调用方应先判断）')
  const args = [
    '-i', input,
    '-vf', cf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'copy',
    '-y', output,
  ]
  await runFfmpeg(args, timeoutMs)
}

/** 硬切拼接（无转场）。所有片段编码参数一致，直接 copy 不重编码 */
export async function ffmpegConcat(inputs: string[], output: string, timeoutMs = 120_000): Promise<void> {
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
