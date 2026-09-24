import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { safeFetch } from '../lib/outbound-url.js'
import { probeDurationMs } from './ffmpeg.js'
import { deleteObject, signedObjectUrl, uploadFile } from '../lib/cos.js'
import { isLocalStorage } from '../lib/local-storage.js'
import tencentcloud from 'tencentcloud-sdk-nodejs-asr'

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

function envBool(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

function tencentConfigured(): boolean {
  const provider = (process.env.ASR_PROVIDER ?? '').trim().toLowerCase()
  const enabled = envBool(process.env.TENCENT_ASR_ENABLED)
  const secretId = process.env.TENCENT_ASR_SECRET_ID?.trim() || process.env.TENCENT_SMS_SECRET_ID?.trim()
  const secretKey = process.env.TENCENT_ASR_SECRET_KEY?.trim() || process.env.TENCENT_SMS_SECRET_KEY?.trim()
  return (provider === 'tencent' || enabled) && Boolean(secretId && secretKey)
}

function tencentCredentials(): { secretId: string; secretKey: string; region: string } {
  const secretId = process.env.TENCENT_ASR_SECRET_ID?.trim() || process.env.TENCENT_SMS_SECRET_ID?.trim()
  const secretKey = process.env.TENCENT_ASR_SECRET_KEY?.trim() || process.env.TENCENT_SMS_SECRET_KEY?.trim()
  if (!secretId || !secretKey) throw new Error('腾讯云 ASR 未配置 SecretId/SecretKey')
  return {
    secretId,
    secretKey,
    region: process.env.TENCENT_ASR_REGION?.trim() || 'ap-guangzhou',
  }
}

function tencentClient() {
  const cfg = tencentCredentials()
  return new tencentcloud.asr.v20190614.Client({
    credential: { secretId: cfg.secretId, secretKey: cfg.secretKey },
    region: cfg.region,
    profile: { httpProfile: { endpoint: 'asr.tencentcloudapi.com', reqTimeout: 30 } },
  })
}

function tencentEngine(): string {
  return process.env.TENCENT_ASR_ENGINE_MODEL?.trim() || '16k_zh_en_2.0'
}

function tencentSegmentsFromWords(words: Array<{ Word?: string; StartTime?: number; EndTime?: number }> | undefined, durationMs: number): TranscriptionSegment[] {
  if (!words?.length) return []
  const segments: TranscriptionSegment[] = []
  let text = ''
  let start = 0
  let end = 0
  for (const word of words) {
    const value = word.Word?.trim() ?? ''
    if (!value) continue
    const wordStart = Math.max(0, Math.round(word.StartTime ?? end))
    const wordEnd = Math.max(wordStart + 80, Math.round(word.EndTime ?? wordStart + 80))
    if (!text) start = wordStart
    text += value
    end = wordEnd
    if (/[。！？!?；;]$/.test(value) || text.length >= 18) {
      segments.push({ startMs: start, endMs: Math.min(durationMs || end, end), text })
      text = ''
    }
  }
  if (text) segments.push({ startMs: start, endMs: Math.min(durationMs || end, end), text })
  return segments.filter((item) => item.text && item.endMs > item.startMs)
}

async function transcribeTencent(input: string, durationMs: number, timeoutMs: number): Promise<TranscriptionResult | null> {
  const client = tencentClient()
  const shortLimitMs = 60_000
  const bytes = durationMs > 0 && durationMs <= shortLimitMs ? await readFile(input) : null
  if (bytes && bytes.length <= 3 * 1024 * 1024) {
    const response = await client.SentenceRecognition({
      EngSerViceType: process.env.TENCENT_ASR_SHORT_ENGINE?.trim() || '16k_zh',
      SourceType: 1,
      VoiceFormat: 'wav',
      Data: bytes.toString('base64'),
      DataLen: bytes.length,
      WordInfo: 1,
      FilterPunc: 0,
      FilterModal: 0,
    })
    const text = response.Result?.trim() ?? ''
    const segments = tencentSegmentsFromWords(response.WordList, response.AudioDuration ?? durationMs)
    if (!text && !segments.length) return null
    return { segments: segments.length ? segments : [{ startMs: 0, endMs: durationMs || 60_000, text }], text, provider: 'tencent-asr' }
  }

  if (isLocalStorage()) throw new Error('腾讯云长音频 ASR 需要 COS 模式提供公网临时音频地址')
  const key = `asr-temp/${Date.now()}-${randomUUID()}.wav`
  await uploadFile(input, key, 'audio/wav')
  try {
    const url = await signedObjectUrl(key, Math.max(900, Math.ceil(timeoutMs / 1000) + 300))
    const created = await client.CreateRecTask({
      EngineModelType: tencentEngine(),
      ChannelNum: 1,
      ResTextFormat: 3,
      SourceType: 0,
      Url: url,
      FilterPunc: 0,
      FilterModal: 0,
      SentenceMaxLength: 18,
    })
    const taskId = created.Data?.TaskId
    if (!taskId) throw new Error('腾讯云 ASR 未返回 TaskId')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const status = await client.DescribeTaskStatus({ TaskId: taskId })
      const data = status.Data
      if (data?.Status === 2 || data?.StatusStr === 'success') {
        const details = (data.ResultDetail ?? [])
          .map((item) => ({ startMs: Math.max(0, Math.round(item.StartMs ?? 0)), endMs: Math.round(item.EndMs ?? 0), text: (item.FinalSentence ?? '').trim() }))
          .filter((item) => item.text && item.endMs > item.startMs)
        const text = (data.Result ?? details.map((item) => item.text).join('')).trim()
        if (!text && !details.length) return null
        return { segments: details.length ? details : [{ startMs: 0, endMs: durationMs, text }], text, provider: 'tencent-asr' }
      }
      if (data?.Status === 3 || data?.StatusStr === 'failed') throw new Error(data.ErrorMsg || '腾讯云 ASR 任务失败')
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error('腾讯云 ASR 任务超时')
  } finally {
    await deleteObject(key).catch((error) => console.warn('[transcription] 清理腾讯云 ASR 临时对象失败：', (error as Error).message))
  }
}

/**
 * 调用 OpenAI-compatible /audio/transcriptions。没有配置时返回 null，调用方可以安全降级。
 * ASR_API_URL 必须是完整 endpoint，例如 https://api.openai.com/v1/audio/transcriptions。
 */
export async function transcribeAudio(input: string, timeoutMs = 120_000): Promise<TranscriptionResult | null> {
  const durationMs = (await probeDurationMs(input)) ?? 0
  if (tencentConfigured()) return transcribeTencent(input, durationMs, timeoutMs)
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
  const segments = normalizeSegments(body.segments, durationMs)
  const text = typeof body.text === 'string' ? body.text.trim() : segments.map((s) => s.text).join('')
  if (!text && segments.length === 0) return null
  return { segments: segments.length ? segments : [{ startMs: 0, endMs: durationMs || 60_000, text }], text, provider: new URL(url).hostname }
}
