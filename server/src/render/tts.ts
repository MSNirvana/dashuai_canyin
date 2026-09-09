// TTS 配音适配层（AI 合成用）
// 供应商配置走后台（TtsProvider 表，见 services/tts-provider.service.ts），支持腾讯云 / 火山引擎。
// 真实语音合成尚未实现（TODO）：synthesizeNarration 在拿到已配置的供应商时仍回退静音兜底，
// 待接入厂商 SDK/HTTP 后只需补齐 vendor 分支，其余链路无需改动。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
 * - provider 已配置：TODO(语音合成) —— 接腾讯云 / 火山 TTS，合成后 pad/trim 对齐到 targetMs。
 *   当前未实现，统一抛错，由调用方（synthesis.ts）捕获后回退静音并告警。
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

  if (provider && provider.apiKey) {
    // TODO(语音合成)：按 provider.code 分流 ——
    //   tencent：腾讯云 TTS（SecretId/SecretKey + AppId，签名鉴权）
    //   volcano：火山引擎 TTS（AppId + AccessToken）
    // 拿到音频后 pad/trim 对齐到 durMs，写入 outPath 并返回实际时长。
    throw new Error(`TTS provider "${provider.code}" synthesis not implemented yet; falling back to silent track`)
  }

  // 本地兜底：静音轨，时长对齐分镜实际时长
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
  return durMs
}
