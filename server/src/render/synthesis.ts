// AI 合成（aiMode=true）：给拼接后的成片叠加「AI 配音(TTS) + 字幕 + 智能节奏」
// 处理顺序（在 concat 之后）：
//   1) 逐分镜用其口播文案 line 做 TTS（未配真实服务时为等长静音轨，见 tts.ts）
//   2) 按分镜在成片中的时间轴生成 SRT 字幕并烧录进画面（依赖 libass + CJK 字体，缺失时降级仅配音）
//   3) 配音音频替换原静音轨，与画面时间轴严格对齐
// 智能剪辑节奏：口播时长驱动每镜字幕停留（已按分镜时长布时）；更细的节拍检测留作后续能力。
import { join } from 'node:path'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { synthesizeNarration } from './tts.js'
import { ffmpegConcat } from './ffmpeg.js'
import type { TtsProviderConfig } from '../services/tts-provider.service.js'

const execFileP = promisify(execFile)

export interface SynthesisShot {
  /** 口播文案（Shot.line） */
  line?: string | null
  /** 该分镜在成片中的时长（毫秒） */
  durationMs: number
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
): Promise<{ subtitled: boolean }> {
  const workDir = await mkdtemp(join(tmpdir(), 'dashuai-ai-'))
  try {
    // 1) 逐分镜配音：每个分镜产出一段时长 = 分镜时长的音频（静音/语音），保证时间轴对齐
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
        // 配音失败：用等长静音轨兜底，保证音频轨道与画面时长一致
        console.warn(`[synthesis] 分镜 ${i} 配音失败，用静音兜底：`, (e as Error).message)
        await synthSilence(durMs, npath, timeoutMs)
        narrationFiles.push(npath)
      }
    }

    // 2) 拼接配音轨（各分镜编码参数一致，可直接 copy 拼接）
    const narrationPath = join(workDir, 'narration.m4a')
    await ffmpegConcat(narrationFiles, narrationPath, timeoutMs)

    // 3) 生成字幕并烧录（尽力而为）
    const srt = buildSrt(shots)
    const font = detectCjkFont()
    let subtitled = false
    if (srt.trim() && font) {
      const srtPath = join(workDir, 'subs.srt')
      await writeFile(srtPath, srt, 'utf8')
      subtitled = await muxWithSubtitles(videoPath, narrationPath, srtPath, font, outPath, timeoutMs)
    }

    // 4) 未烧字幕或烧录失败：仅替换配音轨（视频 copy，不重编码）
    if (!subtitled) {
      await muxAudioOnly(videoPath, narrationPath, outPath, timeoutMs)
    }
    return { subtitled }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/** 生成指定时长的静音轨 */
async function synthSilence(durMs: number, outPath: string, timeoutMs: number): Promise<void> {
  await execFileP(
    'ffmpeg',
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
  audioPath: string,
  srtPath: string,
  font: CjkFont,
  outPath: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const vf = `subtitles=${escapeFilterPath(srtPath)}:fontsdir=${escapeFilterPath(font.dir)}:force_style='FontName=${font.family}'`
    await execFileP(
      'ffmpeg',
      [
        '-i', videoPath, '-i', audioPath,
        '-filter_complex', `[0:v]${vf}[v]`,
        '-map', '[v]', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-y', outPath,
      ],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    )
    return true
  } catch (e) {
    console.warn('[synthesis] 字幕烧录失败，降级为仅配音：', (e as Error).message)
    return false
  }
}

async function muxAudioOnly(
  videoPath: string,
  audioPath: string,
  outPath: string,
  timeoutMs: number,
): Promise<void> {
  await execFileP(
    'ffmpeg',
    [
      '-i', videoPath, '-i', audioPath,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-y', outPath,
    ],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  )
}
