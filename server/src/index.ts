// 服务入口：Express 4 + 路由装配 + 全局错误处理
// 启动前需：npx prisma generate && npx prisma migrate dev
import './env.js'
import express, { type Express } from 'express'
import cors from 'cors'
import { prisma, redis } from './db.js'
import { ok, traceId } from './lib/result.js'
import { errorHandler } from './lib/errors.js'
import authRouter from './routes/auth.js'
import storeRouter from './routes/stores.js'
import dishRouter from './routes/dishes.js'
import creationRouter from './routes/creations.js'
import renderRouter from './routes/renders.js'
import mediaRouter from './routes/media.js'
import uploadRouter from './routes/upload.js'
import orderRouter from './routes/orders.js'
import payRouter from './routes/pay.js'
import adminRouter from './routes/admin.js'
import personaRouter from './routes/persona.js'
import shotLibraryRouter from './routes/shot-library.js'
import accountRouter from './routes/account.js'
import previewCollageRouter from './routes/preview-collage.js'
import systemSettingsRouter from './routes/system-settings.js'
import { ensureLocalStorage, isLocalStorage, localStorageRoot } from './lib/local-storage.js'

const app: Express = express()
const PORT = Number(process.env.PORT ?? 3000)

// 每个请求分配 traceId，便于排查
app.use((_req, res, next) => {
  res.locals.traceId = traceId()
  next()
})

app.set('json replacer', (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value,
)

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true, credentials: true }))
app.use('/api/v1/pay', express.raw({ type: 'application/json', limit: '1mb' }), payRouter)
app.use(express.json({ limit: '2mb' }))

// 健康检查（不鉴权）
app.get('/healthz', (_req, res) => ok(res, { ok: true, ts: Date.now() }))

// Payment callbacks are mounted above the JSON parser to preserve signed bytes.

// 业务路由
app.use('/api/v1/auth', authRouter)
app.use('/api/v1/stores', storeRouter)
app.use('/api/v1/stores/:storeId/dishes', dishRouter)
app.use('/api/v1/creations', creationRouter)
app.use('/api/v1/creations', renderRouter)
app.use('/api/v1/media', mediaRouter)
app.use('/api/v1/upload', uploadRouter)
app.use('/api/v1/orders', orderRouter)
// 本轮补全：人设 / 镜头库 / 账户查询 / 免费预览 / 公开系统设置
app.use('/api/v1/persona', personaRouter)
app.use('/api/v1/shot-library', shotLibraryRouter)
app.use('/api/v1/account', accountRouter)
app.use('/api/v1/render', previewCollageRouter)
// 公开（不鉴权）系统配置
app.use('/api/v1/system/settings', systemSettingsRouter)

// 后台管理（/admin/api/v1，单角色全权限）
app.use('/admin/api/v1', adminRouter)

// 兜底 404
app.use((_req, res) => {
  res.status(404).json({ code: 4040, message: '接口不存在', traceId: res.locals.traceId })
})

// 全局错误处理器（必须最后注册）
app.use(errorHandler)

async function bootstrap() {
  if (isLocalStorage()) {
    await ensureLocalStorage()
    console.log(`[server] 本地文件存储已启用: ${localStorageRoot()}`)
  }
  try {
    await redis.connect()
  } catch (e) {
    console.error('[redis] connect failed, continue without cache:', (e as Error).message)
  }
  await prisma.$connect()
  app.listen(PORT, () => {
    console.log(`[server] listening on :${PORT} (env=${process.env.NODE_ENV ?? 'development'})`)
    if (process.env.FFMPEG_WORKER !== 'true') {
      console.log('[server] 渲染为演示模式（FFMPEG_WORKER≠true，提交即模拟成功）；真实合成见 npm run worker')
    }
  })

  // 真实 FFmpeg worker：轮询 RenderTask(QUEUED)。生产建议 `npm run worker` 独立进程/独立机部署，
  // 这里同进程拉起只是为了让本地一条命令即可端到端联调
  if (process.env.FFMPEG_WORKER === 'true') {
    void import('./render/worker.js')
      .then((m) => {
        m.startRenderWorker()
        process.once('SIGINT', m.stopRenderWorker)
        process.once('SIGTERM', m.stopRenderWorker)
      })
      .catch((e) => console.error('[render-worker] 启动失败:', (e as Error).message))
  }

  // 精品（PREMIUM）SLA 超时 sweeper：无论演示/真实环境都常驻，
  // 超时未交付的精品任务自动退款（unfreeze）+ 标记 FAILED
  void import('./render/premium.js')
    .then((m) => {
      m.startPremiumSweeper()
      process.once('SIGINT', m.stopPremiumSweeper)
      process.once('SIGTERM', m.stopPremiumSweeper)
    })
    .catch((e) => console.error('[premium-sweeper] 启动失败:', (e as Error).message))

  // 机器任务卡死恢复 sweeper：worker 崩溃后 RUNNING 卡死 / QUEUED 长期无人处理的任务
  // 超时自动退款 + FAILED，常驻 API 进程不依赖 FFMPEG_WORKER（worker 独立部署挂掉也能兜底）
  void import('./render/worker.js')
    .then((m) => {
      m.startStuckSweeper()
      process.once('SIGINT', m.stopStuckSweeper)
      process.once('SIGTERM', m.stopStuckSweeper)
    })
    .catch((e) => console.error('[stuck-sweeper] 启动失败:', (e as Error).message))
}

bootstrap().catch((e) => {
  console.error('[server] bootstrap failed:', e)
  process.exit(1)
})
