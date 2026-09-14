// AI 合成链路自检（AI 档出片前先跑这个）
// 用途：确认「配音轨拼接 + 字幕烧录」在本机 ffmpeg 上到底能不能做。
// 关键点：synthesis.ts 的 detectCjkFont() 只检查字体目录是否存在，
//        并不能证明 ffmpeg 带 libass（subtitles 滤镜）。本脚本把两者都验一遍。
//
// 用法：npx tsx scripts/ai-synthesis-check.mts [输入视频路径]
// 注意：必须显式加载 .env，否则 FFMPEG_PATH 不生效（服务端由 src/env.ts 负责加载）
import 'dotenv/config'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { probeDurationMs, ffmpegBin, ffprobeBin } from '../src/render/ffmpeg.js'
import { applyAiSynthesis, type SynthesisShot } from '../src/render/synthesis.js'
import { prisma } from '../src/db.js'
import { activeTtsProvider } from '../src/services/tts-provider.service.js'

const execFileP = promisify(execFile)

/** synthesis.ts 里 detectCjkFont 的候选列表，保持同步 */
const FONT_CANDIDATES = [
  { family: 'PingFang SC', dir: '/System/Library/Fonts' },
  { family: 'STHeiti', dir: '/System/Library/Fonts' },
  { family: 'Arial Unicode MS', dir: '/Library/Fonts' },
  { family: 'Noto Sans CJK SC', dir: '/usr/share/fonts/opentype/noto' },
  { family: 'WenQuanYi Zen Hei', dir: '/usr/share/fonts/truetype/wqy' },
  { family: 'Droid Sans Fallback', dir: '/usr/share/fonts/truetype/droid' },
]

async function ffmpegFilterList(): Promise<string> {
  const { stdout } = await execFileP(ffmpegBin(), ['-hide_banner', '-filters'], { maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

/** 用 volumedetect 判断音轨是否真的有声音（-91 dB 即数字静音） */
async function volumeOf(path: string): Promise<string> {
  let stderr = ''
  try {
    const r = await execFileP(ffmpegBin(), [
      '-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-',
    ], { maxBuffer: 16 * 1024 * 1024 })
    stderr = r.stderr
  } catch (e) {
    stderr = (e as { stderr?: string }).stderr ?? ''
  }
  const mean = /mean_volume:\s*([-\d.]+ dB)/.exec(stderr)?.[1]
  const max = /max_volume:\s*([-\d.]+ dB)/.exec(stderr)?.[1]
  return `mean=${mean ?? '?'} max=${max ?? '?'}`
}

async function probeStreams(path: string): Promise<string> {
  const { stdout } = await execFileP(ffprobeBin(), [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'csv=p=0', path,
  ])
  return stdout.trim().split('\n').filter(Boolean).join(' | ')
}

async function main(): Promise<void> {
  // 位置参数才是输入路径，--xxx 一律视为开关
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const input = resolve(positional[0] ?? 'storage/renders/1/21.mp4')
  if (!existsSync(input)) {
    console.error(`输入视频不存在：${input}`)
    process.exit(1)
  }

  console.log('── 1. ffmpeg 能力探测 ──')
  console.log(`  二进制         : ${ffmpegBin()}`)
  const filters = await ffmpegFilterList()
  const hasSubtitles = /\bsubtitles\b/.test(filters)
  const hasDrawtext = /\bdrawtext\b/.test(filters)
  console.log(`  subtitles 滤镜 : ${hasSubtitles ? '可用' : '缺失'}`)
  console.log(`  drawtext 滤镜  : ${hasDrawtext ? '可用' : '缺失'}`)

  console.log('── 2. 中文字体探测（synthesis.ts 的口径）──')
  const font = FONT_CANDIDATES.find((c) => existsSync(c.dir)) ?? null
  console.log(`  命中           : ${font ? `${font.family} @ ${font.dir}` : '无'}`)
  if (font && !hasSubtitles) {
    console.log('  ⚠ 字体目录存在但 ffmpeg 无 subtitles 滤镜 —— 字体探测是「必要非充分」条件')
  }

  console.log('── 3. 输入 ──')
  const totalMs = await probeDurationMs(input)
  console.log(`  ${input}`)
  console.log(`  时长 ${totalMs ?? '?'} ms；流：${await probeStreams(input)}`)
  if (!totalMs) { console.error('无法读取时长，终止'); process.exit(1) }

  // --tts：带真实配音供应商跑；不加则 provider=null（静音兜底）
  const useTts = process.argv.includes('--tts')
  const provider = useTts ? await activeTtsProvider(prisma) : null
  console.log(`── 4. 跑 applyAiSynthesis（provider = ${provider ? `${provider.code}/${provider.voiceId}` : 'null（静音兜底）'}）──`)
  const lines = ['大帅火锅，廊坊广阳区', '招牌毛肚，现切现涮', '关注我，带你吃遍廊坊']
  const per = Math.floor(totalMs / lines.length)
  const shots: SynthesisShot[] = lines.map((line, i) => ({
    line,
    durationMs: i === lines.length - 1 ? totalMs - per * (lines.length - 1) : per,
  }))
  const dir = await mkdtemp(join(tmpdir(), 'ai-check-'))
  const out = join(dir, 'out.mp4')
  try {
    const { subtitled } = await applyAiSynthesis(input, shots, out, 180_000, provider)
    console.log(`  subtitled = ${subtitled}`)
    console.log(`  产物流：${await probeStreams(out)}`)
    console.log(`  成品音量：${await volumeOf(out)}  (-91 dB = 静音；明显高于则说明配音已写入)`)
    if (subtitled) {
      const frame = join(tmpdir(), 'dashuai-subtitle-probe.png')
      await execFileP(ffmpegBin(), [
        '-hide_banner', '-ss', '5', '-i', out, '-frames:v', '1', '-y', frame,
      ], { maxBuffer: 8 * 1024 * 1024 })
      console.log(`  带字幕样帧已导出：${frame}`)
    }

    console.log('── 5. 直接调用 subtitles 滤镜，抓原始报错 ──')
    const srt = join(dir, 'probe.srt')
    await writeFile(srt, '1\n00:00:00,000 --> 00:00:02,000\n字幕测试\n', 'utf8')
    try {
      await execFileP(ffmpegBin(), [
        '-hide_banner', '-i', input,
        '-filter_complex', `[0:v]subtitles=${srt}[v]`,
        '-map', '[v]', '-frames:v', '1', '-y', join(dir, 'probe.png'),
      ], { maxBuffer: 8 * 1024 * 1024 })
      console.log('  烧录成功（说明 subtitles 滤镜可用）')
    } catch (e) {
      const msg = ((e as { stderr?: string }).stderr ?? (e as Error).message).trim()
      console.log(`  烧录失败，原始报错：${msg.split('\n').slice(-1)[0]}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

try {
  await main()
} finally {
  await prisma.$disconnect()
}
