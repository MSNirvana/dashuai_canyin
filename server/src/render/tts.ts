// TTS 配音适配层（AI 合成用）
// 供应商配置走后台（TtsProvider 表，见 services/tts-provider.service.ts），支持腾讯云 / 火山引擎。
// - volcano：火山引擎「语音合成大模型」V3 HTTP Chunked 单向流式接口
//     POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
//     新版 API Key 鉴权（X-Api-Key），响应为 NDJSON 流（每行 {code, data=base64}，20000000=结束）
//     音色/语速等经 extra 配置：resourceId(seed-tts-1.0/2.0)/sampleRate/bitRate/speechRate
// - tencent：腾讯云 TTS 暂未实现（需要 TC3 签名，待接入）
// 合成结果统一 ffmpeg 转 aac（44.1kHz 立体声 128k，与静音兜底轨参数一致，保证拼接 copy），
// 并 apad+截断对齐 targetMs —— 音频轨与画面分镜时长严格一致。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { writeFile, rm } from 'node:fs/promises'
import type { TtsProviderConfig } from '../services/tts-provider.service.js'

const execFileP = promisify(execFile)

/** 估算中文口播时长（毫秒）：约 4 字/秒 + 句间停顿 */
export function estimateSpeechMs(text: string): number {
  const chars = [...text.trim()].filter((c) => c !== ' ' && c !== '\n').length
  if (chars === 0) return 0
  return Math.round((chars / 4) * 1000) + 300
}

/**
 * 合成一段口播音频（aac/m4a）到 outPath，目标时长 targetMs（保证与画面时间轴对齐）。
 * - provider 未配置 / 无 apiKey：生成与 targetMs 一致的静音轨（本地可跑通）
 * - provider 已配置：走对应厂商真实合成，pad/trim 对齐到 targetMs
 * 返回实际生成时长（毫秒）。
 */
export async function synthesizeNarration(
  text: string,
  targetMs: number,
  outPath: string,
  provider?: TtsProviderConfig | null,
  timeoutMs = 60_000,
): Promise<number> {
  const durMs = Math.max(1, Math.round(targetMs))
  const speak = (text ?? '').trim()

  if (provider && provider.apiKey && speak) {
    if (provider.code === 'volcano') {
      return synthesizeVolcano(speak, durMs, outPath, provider, timeoutMs)
    }
    throw new Error(`TTS provider "${provider.code}" synthesis not implemented yet; falling back to silent track`)
  }

  // 本地兜底：静音轨，时长对齐分镜实际时长
  await synthSilence(durMs, outPath, timeoutMs)
  return durMs
}

/** 生成指定时长的静音 aac 轨（44.1kHz 立体声，与真实配音输出参数一致） */
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

/** 火山 V3 单向流式（HTTP Chunked / NDJSON）语音合成大模型 */
const VOLCANO_TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const VOLCANO_END_CODE = 20000000

interface VolcanoExtra {
  /** 模型版本（决定可用音色与计费）：seed-tts-1.0 / seed-tts-2.0，默认 1.0（xxx_bigtts 系列音色） */
  resourceId?: string
  sampleRate?: number
  bitRate?: number
  /** 语速 [-50,100]，100=2 倍速；对应火山 audio_params.speech_rate */
  speechRate?: number
}

async function synthesizeVolcano(
  text: string,
  durMs: number,
  outPath: string,
  provider: TtsProviderConfig,
  timeoutMs: number,
): Promise<number> {
  const extra = (provider.extra ?? {}) as VolcanoExtra
  const resourceId = extra.resourceId ?? 'seed-tts-1.0'
  const speaker = provider.voiceId
  if (!speaker) throw new Error('volcano TTS 未配置音色（voiceId）')

  const res = await fetch(VOLCANO_TTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': provider.apiKey!,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: 'dashuai-render' },
      req_params: {
        text,
        speaker,
        audio_params: {
          format: 'mp3',
          sample_rate: extra.sampleRate ?? 24000,
          bit_rate: extra.bitRate ?? 128000,
          speech_rate: extra.speechRate ?? 0,
        },
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e: Error) => {
    throw new Error(`volcano TTS 请求失败: ${e.message}`)
  })

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '')
    throw new Error(`volcano TTS HTTP ${res.status}: ${errText.slice(0, 300)}`)
  }

  // NDJSON 流解析：每行一个 JSON（{code, data}），code=0 音频分片，20000000 结束，其余报错
  const chunks: Buffer[] = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finished = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let obj: { code?: number; data?: string | null; message?: string }
      try {
        obj = JSON.parse(line)
      } catch {
        continue // 容忍非 JSON 行（如空行/心跳）
      }
      if (obj.code === VOLCANO_END_CODE) {
        finished = true
      } else if (obj.code === 0 && typeof obj.data === 'string' && obj.data.length > 0) {
        chunks.push(Buffer.from(obj.data, 'base64'))
      } else if (obj.code !== 0) {
        throw new Error(`volcano TTS code=${obj.code}: ${obj.message ?? '未知错误'}`)
      }
    }
    if (finished) break
  }
  if (!chunks.length) throw new Error('volcano TTS 未返回音频数据（可能音色与 resourceId 不匹配，检查 TtsProvider.voiceId / extra.resourceId）')

  // mp3 → aac，apad 补静音 + -t 截断，严格对齐分镜时长
  const mp3Path = `${outPath}.src.mp3`
  await writeFile(mp3Path, Buffer.concat(chunks))
  try {
    await execFileP(
      'ffmpeg',
      [
        '-i', mp3Path,
        '-af', 'apad',
        '-t', (durMs / 1000).toFixed(3),
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        '-y', outPath,
      ],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    )
  } finally {
    await rm(mp3Path, { force: true }).catch(() => {})
  }
  return durMs
}
