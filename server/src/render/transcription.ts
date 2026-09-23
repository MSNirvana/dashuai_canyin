import { readFile } from 'node:fs/promises'
import { safeFetch } from '../lib/outbound-url.js'
import { probeDurationMs } from './ffmpeg.js'

export interface TranscriptionSegment {
  startMs: number
  endMs: number
  text: string
}

export interface TranscriptionResult {
  segments: TranscriptionSegment[]
  text: string
  provider: string
}

function numberMs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.round(n * (n < 1000 ? 1000 : 1))) : null
}

function normalizeSegments(raw: unknown, durationMs: number): TranscriptionSegment[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const row = item as { start?: unknown; end?: unknown; text?: unknown }
    const start = numberMs(row.start) ?? 0
    const end = Math.max(start + 200, numberMs(row.end) ?? durationMs)
    const text = typeof row.text === 'string' ? row.text.trim() : ''
    return { startMs: start, endMs: Math.min(durationMs || end, end), text }
  }).filter((item) => item.text && item.endMs > item.startMs)
}

/**
 * 调用 OpenAI-compatible /audio/transcriptions。没有配置时返回 null，调用方可以安全降级。
 * ASR_API_URL 必须是完整 endpoint，例如 https://api.openai.com/v1/audio/transcriptions。
 */
export async function transcribeAudio(input: string, timeoutMs = 120_000): Promise<TranscriptionResult | null> {
  const url = process.env.ASR_API_URL?.trim()
  const apiKey = process.env.ASR_API_KEY?.trim()
  if (!url || !apiKey) return null
  const bytes = await readFile(input)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', process.env.ASR_MODEL?.trim() || 'whisper-1')
  form.append('language', process.env.ASR_LANGUAGE?.trim() || 'zh')
  form.append('response_format', 'verbose_json')
  const response = await safeFetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  }, { timeoutMs })
  if (!response.ok) throw new Error(`ASR HTTP ${response.status}`)
  const body = await response.json() as { text?: unknown; segments?: unknown }
  const durationMs = (await probeDurationMs(input)) ?? 0
  const segments = normalizeSegments(body.segments, durationMs)
  const text = typeof body.text === 'string' ? body.text.trim() : segments.map((s) => s.text).join('')
  if (!text && segments.length === 0) return null
  return { segments: segments.length ? segments : [{ startMs: 0, endMs: durationMs || 60_000, text }], text, provider: new URL(url).hostname }
}
