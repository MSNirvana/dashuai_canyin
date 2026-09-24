import '../src/env.js'
import { access } from 'node:fs/promises'
import { transcribeAudio } from '../src/render/transcription.js'

const input = process.argv[2]
if (!input) {
  console.error('用法：npm run asr:probe -- /绝对路径/测试音频.wav')
  process.exit(2)
}

await access(input)
const startedAt = Date.now()
const result = await transcribeAudio(input, 180_000)
if (!result?.text.trim()) throw new Error('ASR 请求成功，但没有识别出文字')

console.log(JSON.stringify({
  ok: true,
  provider: result.provider,
  elapsedMs: Date.now() - startedAt,
  segmentCount: result.segments.length,
  text: result.text,
  firstSegment: result.segments[0] ?? null,
}, null, 2))
