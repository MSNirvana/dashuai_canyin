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
import { synthesizeNarration } from './tts.js'
import { ffmpegBin, ffmpegConcat, ffmpegExtractAudio, ffmpegSupportsSubtitles, hasAudioStream, probeDurationMs } from './ffmpeg.js'
import { transcribeAudio, type TranscriptionSegment } from './transcription.js'
import type { TtsProviderConfig } from '../services/tts-provider.service.js'

const execFileP = promisify(execFile)

export interface SynthesisShot {
  /** 口播文案（Shot.line） */
  line?: string | null
  /** 该分镜在成片中的时长（毫秒） */
  durationMs: number
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

function segmentsToSrt(segments: TranscriptionSegment[]): string {
  return segments.map((segment, index) => (
    `${index + 1}\n${toSrtTime(segment.startMs)} --> ${toSrtTime(segment.endMs)}\n${segment.text}\n`
  )).join('\n')
}

function audioFilter(options: SynthesisOptions): string {
  const filters: string[] = []
  if (options.removeSilence) {
    filters.push('silenceremove=start_periods=1:start_duration=0.15:start_threshold=-45dB:stop_periods=-1:stop_duration=0.35:stop_threshold=-45dB')
  }
  if (options.normalizeAudio) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
  return filters.join(',')
}

async function processVoiceTrack(input: string, output: string, targetDurationMs: number, options: SynthesisOptions, timeoutMs: number): Promise<void> {
  const filters = [audioFilter(options), 'apad'].filter(Boolean).join(',')
  await execFileP(ffmpegBin(), [
    '-i', input, '-vn', '-af', filters,
    '-t', (Math.max(1, targetDurationMs) / 1000).toFixed(3),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-y', output,
  ], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
}

interface CjkFont {
  family: string
  dir: string
}

/** 探测可用的 CJK 字体（libass 烧字幕用）。找不到返回 null，调用方降级为仅配音。 */
function detectCjkFont(): CjkFont | null {
  const candidates: CjkFont[] = [
    { family: 'PingFang SC', dir: '/System/Library/Fonts' },
    { family: 'STHeiti', dir: '/System/Library/Fonts' },
    { family: 'Arial Unicode MS', dir: '/Library/Fonts' },
    { family: 'Noto Sans CJK SC', dir: '/usr/share/fonts/opentype/noto' },
    { family: 'WenQuanYi Zen Hei', dir: '/usr/share/fonts/truetype/wqy' },
    { family: 'Droid Sans Fallback', dir: '/usr/share/fonts/truetype/droid' },
  ]
  for (const c of candidates) {
    if (existsSync(c.dir)) return c
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
      const targetDurationMs = (await probeDurationMs(videoPath)) ?? Math.max(1, shots.reduce((sum, shot) => sum + shot.durationMs, 0))
      const processedVoicePath = join(workDir, 'voice-processed.m4a')
      await processVoiceTrack(voicePath, processedVoicePath, targetDurationMs, options, timeoutMs)
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
    const srt = subtitleMode === 'OFF' ? '' : segmentsToSrt(subtitleSegments)
    const font = detectCjkFont()
    let subtitled = false
    if (srt.trim() && font) {
      if (await ffmpegSupportsSubtitles()) {
        const srtPath = join(workDir, 'subs.srt')
        await writeFile(srtPath, srt, 'utf8')
        subtitled = await muxWithSubtitles(videoPath, voicePath, srtPath, font, outPath, timeoutMs, options)
      } else {
        console.warn(
          '[synthesis] 跳过字幕烧录：当前 ffmpeg 未编译 libass（缺少 subtitles 滤镜）。' +
            'macOS：brew install ffmpeg-full，再设 FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg；' +
            'Linux：安装带 libass 的 ffmpeg 与 fonts-noto-cjk 字体。',
        )
      }
    }

    // 3) 未烧字幕或烧录失败：替换自定义/TTS音轨；没有旁白时保留原视频声音。
    if (!subtitled) {
      if (voicePath) await muxAudioOnly(videoPath, voicePath, outPath, timeoutMs)
      else if (options.normalizeAudio || options.removeSilence) await processVideoAudio(videoPath, outPath, options, timeoutMs)
      else await copyFile(videoPath, outPath)
    }
    return { subtitled }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
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
  srtPath: string,
  font: CjkFont,
  outPath: string,
  timeoutMs: number,
  options: SynthesisOptions,
): Promise<boolean> {
  try {
    const vf = `subtitles=${escapeFilterPath(srtPath)}:fontsdir=${escapeFilterPath(font.dir)}:force_style='FontName=${font.family}'`
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
    console.warn('[synthesis] 字幕烧录失败，降级为仅配音：', (e as Error).message)
    return false
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
