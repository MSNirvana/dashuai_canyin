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
  width: number | null
  height: number | null
  durationMs: number | null
  hasAudioTrack: boolean
  reason?: string
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
      '-show_entries', 'stream=codec_type,width,height:format=duration',
      '-of', 'json',
      input,
    ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })

    const parsed = JSON.parse(String(stdout)) as {
      format?: { duration?: string }
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>
    }
    const streams = parsed.streams ?? []
    const video = streams.find((s) => s.codec_type === 'video')
    if (!video?.width || !video?.height) {
      return {
        ok: false,
        width: null,
        height: null,
        durationMs: null,
        hasAudioTrack: false,
        reason: '未能从素材中解析出视频宽高（可能不是视频文件）',
      }
    }
    const sec = Number(parsed.format?.duration)
    return {
      ok: true,
      width: video.width,
      height: video.height,
      durationMs: Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null,
      hasAudioTrack: streams.some((s) => s.codec_type === 'audio'),
    }
  } catch (e) {
    return {
      ok: false,
      width: null,
      height: null,
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
