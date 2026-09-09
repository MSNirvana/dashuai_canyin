// 独立 worker 进程入口：npm run worker
// 部署机上需已安装 ffmpeg / ffprobe，且配置好 COS_* 与 DATABASE_URL
import '../env.js'
import { prisma } from '../db.js'
import { startRenderWorker, stopRenderWorker } from './worker.js'
import { ensureLocalStorage, isLocalStorage, localStorageRoot } from '../lib/local-storage.js'

if (isLocalStorage()) {
  await ensureLocalStorage()
  console.log(`[render-worker] 本地文件存储已启用: ${localStorageRoot()}`)
}
startRenderWorker()

let stopping = false
async function shutdown(sig: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`[render-worker] ${sig} received, stopping...`)
  stopRenderWorker()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
