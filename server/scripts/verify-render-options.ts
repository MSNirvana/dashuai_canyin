import assert from 'node:assert/strict'
import { ChatCutOptionsSchema, DEFAULT_CHATCUT_OPTIONS } from '../src/render/chatcut.js'
import { providerForVoice, type TtsProviderConfig } from '../src/services/tts-provider.service.js'
import { transcribeAudio } from '../src/render/transcription.js'

const source = { ...DEFAULT_CHATCUT_OPTIONS, voiceId: 'none', subtitleMode: 'SOURCE_AUDIO' as const, subtitles: true }
const parsed = ChatCutOptionsSchema.parse(source)
assert.equal(parsed.voiceId, 'none')
assert.equal(parsed.subtitleMode, 'SOURCE_AUDIO')
assert.equal(DEFAULT_CHATCUT_OPTIONS.subtitleMode, 'VOICE')

const provider: TtsProviderConfig = {
  code: 'test', name: 'test', appId: null, secretId: null, apiKey: null, voiceId: 'default', extra: {},
}
process.env.CHATCUT_TTS_VOICE_BRIGHT_FEMALE = 'speaker-bright'
assert.equal(providerForVoice(provider, 'bright-female')?.voiceId, 'speaker-bright')
assert.equal(providerForVoice(provider, 'custom'), provider)
delete process.env.CHATCUT_TTS_VOICE_BRIGHT_FEMALE

delete process.env.ASR_API_URL
delete process.env.ASR_API_KEY
assert.equal(await transcribeAudio('/tmp/does-not-exist.wav'), null)

console.log('render-options verification passed')
