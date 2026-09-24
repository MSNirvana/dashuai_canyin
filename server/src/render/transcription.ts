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
    const gapMs = text ? Math.max(0, wordStart - end) : 0
    if (!text) start = wordStart
    text += value
    end = wordEnd
    // 只在明确句末标点、明显停顿或达到较宽的保护上限时结束；18 字会把正常口语
    // 强行切成半句话，后续字幕层会再按屏幕宽度做安全拆分。
    if (/[。！？!?；;]$/.test(value) || (gapMs >= 700 && text.length >= 10) || text.length >= 32) {
      segments.push({ startMs: start, endMs: Math.min(durationMs || end, end), text })
      text = ''
    }
  }
  if (text) segments.push({ startMs: start, endMs: Math.min(durationMs || end, end), text })
  return segments.filter((item) => item.text && item.endMs > item.startMs)
}

/** 子句断点：句末标点 + 逗号类停顿，字幕层据此切分 */
const ASR_CLAUSE_BREAK = /[。！？!?；;，、,:：]/
/** `Result` 里可能有、但 `WordList` 里一定没有的字符（标点/空白）——对齐时跳过，不消耗词 */
const ASR_PUNCT_ONLY = /[。！？!?；;，、,:：.」』】》…—\s]/

interface TimedChar {
  char: string
  startMs: number
  endMs: number
}

/** 把词级时间轴摊成**逐字**时间轴：词内按字数均分，供标点对齐时逐字消费。 */
function expandWordsToChars(words: Array<{ Word?: string; StartTime?: number; EndTime?: number }>): TimedChar[] {
  const chars: TimedChar[] = []
  let cursor = 0
  for (const word of words) {
    const value = word.Word ?? ''
    if (!value) continue
    const list = [...value]
    const start = Math.max(cursor, Math.round(word.StartTime ?? cursor))
    const end = Math.max(start + 80, Math.round(word.EndTime ?? start + 80))
    const per = (end - start) / Math.max(1, list.length)
    list.forEach((char, index) => {
      chars.push({
        char,
        startMs: Math.round(start + per * index),
        endMs: Math.round(start + per * (index + 1)),
      })
    })
    cursor = end
  }
  return chars
}

/**
 * 把「带标点的整句」与「无标点的词级时间轴」对齐，产出**按标点切分、且带真实起止时间**的
 * 子句片段。对齐失败（音频念的字与 `Result` 对不上）返回 null，调用方回退旧逻辑。
 *
 * ★★ 为什么必须做这一步（2026-09-24 实测 task 32）：
 *   腾讯一句话识别一次返回两样东西，而它们的**标点是错位的**：
 *     · `Result`   —— 带标点的整句：『明天就是中秋了。我一直想问一句，这顿饭你们打算去哪儿吃？…』
 *     · `WordList` —— 逐词 + 真实起止时间，但**词里一个标点都没有**（63 词 / 96 字 / 0 标点）
 *   早期只吃 `WordList`，于是下游依赖标点的两条规则**同时变成死代码**：
 *     · `tencentSegmentsFromWords` 的 `/[。！？!?；;]$/` 永不命中 ⇒ 只剩「按 32 字上限」硬断
 *     · `mergeSubtitleSegments` 的 `previousHasSentenceEnd` 恒为 false ⇒ 无条件连续合并
 *   两条一起失效后，字幕只剩「按屏宽盲切」一条路，切点落在词中间 ——
 *   实测成片字幕是『饭你们打算去哪儿吃是打算吃爸妈做』这种 17 字跑句。
 *
 *   标点位置与真实停顿高度吻合（实测停顿 1.14s / 0.90s / 2.02s 正好都落在标点上），
 *   所以把标点插回词序列后按标点切子句，边界就是**语义边界**，
 *   而且每段的起止时间来自真实词时间，不再是按字数摊出来的。
 *
 * ⚠ 长音频路径（`CreateRecTask`）拿到的 `ResultDetail[].FinalSentence` **本身带标点**，
 *   下游同一套判据直接生效，因此这里不再重复对齐；只是它的时间粒度是「整句」，
 *   句内子句的时间仍由字幕层按宽度摊分。
 */
export function alignPunctuatedAsrText(
  result: string,
  words: Array<{ Word?: string; StartTime?: number; EndTime?: number }> | undefined,
  durationMs: number,
): TranscriptionSegment[] | null {
  const clean = (result ?? '').replace(/\s+/g, '')
  if (!clean || !words?.length) return null
  const chars = expandWordsToChars(words)
  if (!chars.length) return null

  const segments: TranscriptionSegment[] = []
  let index = 0
  let text = ''
  let start = 0
  let end = 0
  /** 最后一个「有字」字符的结束时间：标点自己没有时间轴，只能沿用它的 */
  let lastCharEnd = 0

  const close = () => {
    if (!text) return
    segments.push({ startMs: start, endMs: Math.min(durationMs || end, Math.max(start + 1, end)), text })
    text = ''
  }

  for (const char of clean) {
    if (ASR_PUNCT_ONLY.test(char)) {
      // 开头就是标点（前一句已收口）：挂到上一段尾巴上，绝不凭空起一个新 cue
      if (!text) {
        const previous = segments[segments.length - 1]
        if (previous) previous.text += char
        continue
      }
      text += char
      if (lastCharEnd) end = lastCharEnd
    } else {
      const timed = chars[index]
      // 对齐失败：音频念的字与 Result 对不上，交给调用方回退
      if (!timed || timed.char !== char) return null
      index += 1
      if (!text) start = timed.startMs
      text += char
      end = timed.endMs
      lastCharEnd = timed.endMs
    }
    if (ASR_CLAUSE_BREAK.test(char)) close()
  }
  close()

  const usable = segments.filter((item) => item.text && item.endMs > item.startMs)
  // 对齐到一半就断了（还有没消费的词）说明文本与词表不是同一份，别用残缺结果
  if (!usable.length || index < chars.length * 0.9) return null
  return usable
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
    // ★ 优先用「带标点整句 + 词级时间轴」对齐出的子句；对齐失败才回退到旧的无标点分段。
    //   旧路径丢标点 ⇒ 下游两条标点判据全失效 ⇒ 字幕只能按屏宽盲切（见 alignPunctuatedAsrText 注释）
    const aligned = alignPunctuatedAsrText(text, response.WordList, response.AudioDuration ?? durationMs)
    const segments = aligned ?? tencentSegmentsFromWords(response.WordList, response.AudioDuration ?? durationMs)
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
      // 放宽云端句长上限；字幕层会根据标点、停顿和屏幕宽度做最终切分。
      SentenceMaxLength: 30,
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
