// AI 档「5 个音色档位」端到端可用性校验（2026-09-21）
//
// 为什么必须单独有这一步：配音链路里 `synthesizeNarration()` 失败会**直接抛错**
// （chatcut-driver 的配音循环只有 try/finally，没有 catch），也就是
// **一个坏 speaker id = 整单 AI 渲染失败 + 用户积分已被冻结**。
// 而档位 → 真实 speaker 的映射走环境变量（VOICE_ENV_KEYS），配错不会有任何编译或启动报错，
// 只会在用户点「生成」的那一刻炸。所以配完 TTS 必须逐个档位真合成一遍。
//
// 用法（在服务器上、cd 到 server 目录）：
//   npm run tts:verify-voices
// 需要：DATABASE_URL / APP_MASTER_KEY / CHATCUT_TTS_VOICE_* 都在环境里（生产由 dist/index.js
// 的同级 .env 提供；本脚本自己在入口 import env.js 加载，与线上同一条路径）。
//
// 判据：每个档位都必须「合成成功 ∧ 时长与目标对齐 ±200ms」；未映射的档位打印告警但不判失败
// （那是"回落到供应商默认音色"的有意行为，不是故障）。
import '../src/env.js'
import { PrismaClient } from '@prisma/client'
import { activeTtsProvider } from '../src/services/tts-provider.service.js'
import { synthesizeNarration } from '../src/render/tts.js'
import { probeDurationMs } from '../src/render/ffmpeg.js'
import { VOICE_ENV_KEYS } from '../src/render/chatcut-driver.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'

const TEXT = '招牌红烧肉，肥而不腻，入口即化。'
const TARGET_MS = 3000
const TOLERANCE_MS = 200

async function run(prisma: PrismaClient): Promise<number> {
  const provider = await activeTtsProvider(prisma)
  if (!provider) {
    console.error('✗ activeTtsProvider 返回 null：tts_provider 里没有「enabled ∧ 有 apiKey」的行')
    return 1
  }
  console.log(`供应商 = ${provider.code} / 默认音色 = ${provider.voiceId}`)
  console.log(`extra    = ${JSON.stringify(provider.extra)}`)
  console.log('★ 档位映射必须与 extra.resourceId 同族，否则 55000000 resource mismatch\n')

  let failed = 0
  let unmapped = 0
  for (const [voiceId, envKey] of Object.entries(VOICE_ENV_KEYS)) {
    const speaker = process.env[envKey]?.trim()
    if (!speaker) {
      unmapped += 1
      console.log(`⚠ ${voiceId.padEnd(16)} 未配 ${envKey} ⇒ 回落到默认音色「${provider.voiceId}」（该档位与默认档声音相同）`)
      continue
    }
    const outPath = join(tmpdir(), `tts-voice-${voiceId}-${Date.now()}.m4a`)
    const t0 = Date.now()
    try {
      await synthesizeNarration(TEXT, TARGET_MS, outPath, { ...provider, voiceId: speaker }, 30_000)
      const realMs = await probeDurationMs(outPath)
      const aligned = realMs !== null && Math.abs(realMs - TARGET_MS) <= TOLERANCE_MS
      if (!aligned) {
        failed += 1
        console.log(`✗ ${voiceId.padEnd(16)} ${speaker}  时长 ${realMs}ms ≠ ${TARGET_MS}ms（容差 ±${TOLERANCE_MS}）`)
      } else {
        console.log(`✓ ${voiceId.padEnd(16)} ${speaker}  ${realMs}ms  用时 ${Date.now() - t0}ms`)
      }
    } catch (error) {
      failed += 1
      console.log(`✗ ${voiceId.padEnd(16)} ${speaker}  合成失败：${(error as Error).message}`)
    } finally {
      await rm(outPath, { force: true }).catch(() => {})
    }
  }

  console.log(`\n结论：失败 ${failed} 个，未映射 ${unmapped} 个`)
  if (unmapped > 0) {
    console.log('★ 未映射的档位不是故障，但会让用户「换档位不改音色」——要么配 env，要么从面板撤掉。')
  }
  return failed > 0 ? 1 : 0
}

// ★ 先断开再退出：在 try 里直接 process.exit 会掐掉 finally 里的异步 disconnect
const prisma = new PrismaClient()
let code = 1
try {
  code = await run(prisma)
} catch (e) {
  console.error('校验异常:', e instanceof Error ? e.message : e)
} finally {
  await prisma.$disconnect().catch(() => {})
}
process.exit(code)
