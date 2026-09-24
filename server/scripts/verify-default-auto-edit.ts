import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ffmpegBin,
  ffmpegConcatWithTransitions,
  ffmpegGenerateBackgroundMusic,
  ffmpegRemoveTimeRanges,
  probeClipMeta,
  probeDurationMs,
  probeMeaningfulRange,
  probeRemovableFreezeSilenceRanges,
} from '../src/render/ffmpeg.js'
import { applyAiSynthesis, fitShotDurationsToTimeline } from '../src/render/synthesis.js'

const execFileP = promisify(execFile)

async function generateColorClip(path: string, color: string, tone: number, durationSec: number): Promise<void> {
  await execFileP(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=1080x1920:r=30:d=${durationSec}`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=44100:duration=${durationSec}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-y', path,
  ], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
}

async function generateBlackHeadClip(path: string): Promise<void> {
  await execFileP(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=360x640:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=c=red:s=360x640:r=30:d=2',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-t', '3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', path,
  ], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
}

async function generateFrozenSilenceClip(path: string): Promise<void> {
  await execFileP(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=1.2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=1.2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1.2',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100:d=1.2',
    '-filter_complex', '[0:v][1:v][0:v]concat=n=3:v=1:a=0[v];[2:a][3:a][2:a]concat=n=3:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]', '-t', '3.6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', path,
  ], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
}

async function main(): Promise<void> {
  // 避免开发机上的真实 ASR 配置让验证产生网络依赖；字幕应走文案兜底。
  for (const key of [
    'ASR_PROVIDER', 'ASR_API_URL', 'ASR_API_KEY', 'TENCENT_ASR_ENABLED',
    'TENCENT_ASR_SECRET_ID', 'TENCENT_ASR_SECRET_KEY', 'TENCENT_SMS_SECRET_ID', 'TENCENT_SMS_SECRET_KEY',
  ]) delete process.env[key]

  const dir = await mkdtemp(join(tmpdir(), 'dashuai-default-edit-'))
  try {
    const blackHead = join(dir, 'black-head.mp4')
    await generateBlackHeadClip(blackHead)
    const range = await probeMeaningfulRange(blackHead)
    assert.ok(range)
    assert.ok(range.startMs >= 900 && range.startMs <= 1_100, `unexpected black trim: ${range.startMs}`)

    const frozenSilence = join(dir, 'frozen-silence.mp4')
    await generateFrozenSilenceClip(frozenSilence)
    const removable = await probeRemovableFreezeSilenceRanges(frozenSilence)
    assert.equal(removable.length, 1, `unexpected removable ranges: ${JSON.stringify(removable)}`)
    const cleaned = join(dir, 'frozen-silence-cleaned.mp4')
    await ffmpegRemoveTimeRanges(frozenSilence, cleaned, removable)
    const cleanedMs = await probeDurationMs(cleaned)
    assert.ok(cleanedMs && cleanedMs < 3_250 && cleanedMs > 2_400, `unexpected cleaned duration: ${cleanedMs}`)

    const first = join(dir, 'first.mp4')
    const second = join(dir, 'second.mp4')
    await generateColorClip(first, 'red', 440, 2)
    await generateColorClip(second, 'blue', 660, 2)

    const transitioned = join(dir, 'transitioned.mp4')
    await ffmpegConcatWithTransitions([first, second], transitioned, 'CLEAN', 120_000)
    const transitionedMs = await probeDurationMs(transitioned)
    assert.ok(transitionedMs && transitionedMs >= 3_950 && transitionedMs <= 4_100, `unexpected direct-cut duration: ${transitionedMs}`)

    // Advanced transitions must still have a continuous, slightly shorter
    // timeline after timestamp normalization; a stalled/repeated seam is much
    // easier to catch here than in a rendered mobile preview.
    const smooth = join(dir, 'smooth.mp4')
    await ffmpegConcatWithTransitions([first, second], smooth, 'SMOOTH', 120_000)
    const smoothMs = await probeDurationMs(smooth)
    assert.ok(smoothMs && smoothMs >= 3_500 && smoothMs <= 3_850, `unexpected smooth duration: ${smoothMs}`)

    const shots = fitShotDurationsToTimeline([
      { line: '第一段素材按上传顺序展示。下一句话需要单独替换显示。', durationMs: 2_000 },
      { line: '第二段素材直接切换，不再吞掉句尾。', durationMs: 2_000 },
    ], transitionedMs!)
    assert.ok(Math.abs(shots.reduce((sum, shot) => sum + shot.durationMs, 0) - transitionedMs!) <= 30)

    const bgm = join(dir, 'bgm.m4a')
    await ffmpegGenerateBackgroundMusic(bgm, transitionedMs!, 'LIGHT', 120_000)
    const output = join(dir, 'output.mp4')
    const synthesis = await applyAiSynthesis(transitioned, shots, output, 120_000, null, {
      voiceEnabled: false,
      subtitles: true,
      subtitleMode: 'SOURCE_AUDIO',
      sourceAudioPath: transitioned,
      normalizeAudio: true,
      removeSilence: false,
      backgroundMusicPath: bgm,
      backgroundMusicGain: 0.1,
    })
    assert.equal(synthesis.subtitled, true)
    const meta = await probeClipMeta(output)
    assert.equal(meta.ok, true)
    assert.equal(meta.width, 1080)
    assert.equal(meta.height, 1920)
    assert.equal(meta.hasAudioTrack, true)
    assert.ok(meta.durationMs && Math.abs(meta.durationMs - transitionedMs!) <= 80)

    console.log('default auto-edit smoke verification passed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await main()
