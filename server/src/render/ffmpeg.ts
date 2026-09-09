// FFmpeg 命令构建与执行：单镜头 trim+scale+调色 → 全片硬切 concat
// 分两步而非一次性 filter_complex：单镜头参数各自不同（trim 起止），
// 统一编码参数后再用 concat demuxer -c copy 拼接，最稳且最快
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rm } from 'node:fs/promises'
import type { ColorGrade } from '../services/render.service.js'

const execFileP = promisify(execFile)

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
 * 原音轨丢弃，改挂 anullsrc 静音轨（各片段音视频参数一致，concat -c copy 才不会失败）
 * 产物按 (assetId, trim) 缓存，重调色时直接复用，省掉源解码+缩放这个最贵的环节
 */
export async function ffmpegNormalize(input: string, output: string, opts: NormalizeOpts): Promise<void> {
  const args: string[] = []
  if (opts.startMs > 0) args.push('-ss', (opts.startMs / 1000).toFixed(3))
  if (opts.endMs > opts.startMs) args.push('-to', (opts.endMs / 1000).toFixed(3))
  args.push('-i', input)
  args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100')
  const base =
    `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,` +
    `crop=${opts.width}:${opts.height},format=yuv420p`
  args.push('-filter_complex', `[0:v]${base}[v]`)
  args.push('-map', '[v]', '-map', '1:a', '-shortest')
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '128k',
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
    await execFileP('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
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
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 })
    const sec = Number(String(stdout).trim())
    return Number.isFinite(sec) ? Math.round(sec * 1000) : null
  } catch {
    return null
  }
}
