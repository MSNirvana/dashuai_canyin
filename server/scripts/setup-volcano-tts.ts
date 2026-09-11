// 火山 TTS 接入：写入供应商配置（API Key 加密） + 直连合成测试
// 运行：npx tsx scripts/setup-volcano-tts.ts
import { PrismaClient } from '@prisma/client'
import { encryptSecret, maskSecret } from '../src/lib/secret.js'
import { activeTtsProvider } from '../src/services/tts-provider.service.js'
import { synthesizeNarration } from '../src/render/tts.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const execFileP = promisify(execFile)

// ───── 配置区（按需修改）─────
const API_KEY = 'b7f81d77-4ead-4b98-88e3-7c2ef2017a66'
const VOICE_ID = 'zh_female_qinqienv_uranus_bigtts' // 亲切女声 2.0（通用场景，豆包同款）
const RESOURCE_ID = 'seed-tts-2.0'                    // 2.0 音色配 2.0 模型
// ────────────────────────────

const TEST_TEXT = '家人们，今天给大家推荐我们店的招牌红烧肉，肥而不腻，入口即化，快来尝尝吧！'

async function main() {
  const prisma = new PrismaClient()

  // 1) 写入配置（幂等）；先临时启用以走 activeTtsProvider 与渲染链完全一致的取数路径，失败时回滚
  const data = {
    apiKeyEncrypted: encryptSecret(API_KEY),
    voiceId: VOICE_ID,
    extraJson: { resourceId: RESOURCE_ID, sampleRate: 24000, bitRate: 128000, speechRate: 0 },
    enabled: true,
  }
  const existing = await prisma.ttsProvider.findUnique({ where: { code: 'volcano' } })
  if (existing) {
    await prisma.ttsProvider.update({ where: { code: 'volcano' }, data })
    console.log('= volcano 配置已更新并临时启用（测试失败会自动回滚禁用）')
  } else {
    await prisma.ttsProvider.create({
      data: { code: 'volcano', name: '火山引擎语音合成', priority: 100, ...data },
    })
    console.log('+ volcano 供应商已创建并临时启用（测试失败会自动回滚禁用）')
  }

  // 2) 直连合成测试（走与渲染链完全相同的 synthesizeNarration）
  console.log(`\n[测试] 音色=${VOICE_ID} resourceId=${RESOURCE_ID}`)
  console.log(`[测试] 文本="${TEST_TEXT}"`)
  const provider = await activeTtsProvider(prisma)
  if (!provider || provider.code !== 'volcano') throw new Error('activeTtsProvider 未返回 volcano（检查配置）')
  console.log(`[测试] 解密 Key: ${maskSecret(provider.apiKey ?? '')}`)

  const outPath = join(tmpdir(), `volcano-tts-test-${Date.now()}.m4a`)
  const targetMs = 8000 // 8 秒分镜
  const t0 = Date.now()
  await synthesizeNarration(TEST_TEXT, targetMs, outPath, provider, 30_000)
  const cost = Date.now() - t0

  // 3) 校验输出
  const { probeDurationMs } = await import('../src/render/ffmpeg.js')
  const realMs = await probeDurationMs(outPath)
  console.log(`[测试] 合成耗时 ${cost}ms，输出=${outPath}`)
  console.log(`[测试] 实际时长 ${realMs}ms（目标 ${targetMs}ms，容差 ±200ms）`)
  const ok = realMs !== null && Math.abs(realMs - targetMs) <= 200
  if (!ok) throw new Error(`时长对齐失败: ${realMs}ms ≠ ${targetMs}ms`)

  console.log('\n✓ volcano TTS 测试通过，保持启用（enabled=true）')
  console.log('  下次 AI 合成（FFMPEG_WORKER=true）将输出真实配音 + 字幕')

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('\nFAIL:', e instanceof Error ? e.message : e)
  console.error('提示：若报「音色不存在/资源不匹配」，去火山控制台音色库核对 Speaker ID 所属模型版本（1.0/2.0），')
  console.error('     并对应修改 TtsProvider.voiceId 与 extraJson.resourceId（seed-tts-1.0 / seed-tts-2.0）。')
  // 回滚：禁用避免渲染链拿到坏配置（synthesis 有静音兜底，但明确禁用更干净）
  try {
    const { PrismaClient } = await import('@prisma/client')
    const p = new PrismaClient()
    await p.ttsProvider.update({ where: { code: 'volcano' }, data: { enabled: false } })
    console.error('（已自动回滚：volcano enabled=false，渲染链继续走静音兜底）')
    await p.$disconnect()
  } catch { /* 回滚失败不影响报错 */ }
  process.exit(1)
})
