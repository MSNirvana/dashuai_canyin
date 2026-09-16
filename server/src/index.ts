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
import worksRouter from './routes/works.js'
import accountRouter from './routes/account.js'
import previewCollageRouter from './routes/preview-collage.js'
import renderCapabilitiesRouter from './routes/render-capabilities.js'
import systemSettingsRouter from './routes/system-settings.js'
import { ensureLocalStorage, isLocalStorage, localStorageRoot } from './lib/local-storage.js'
import { smsTestCodeConfig } from './auth/sms.js'

const app: Express = express()
const PORT = Number(process.env.PORT ?? 3000)

// ── 进程级兜底（最后一道网）──
// 路由层已通过 createRouter() 把 async 异常交给 errorHandler（见 lib/async-router.ts），
// 这里是防止其它来源的异常打死进程：定时器里未 await 的 Promise、sweeper 的异步错误等。
// 取舍：uncaughtException 不退出进程——体验版期优先保可用性，卡死任务由 stuck-sweeper 兜底回收。
// 代价是异常后进程状态可能不可信，所以必须打醒目日志，后续接入告警。
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection（进程继续运行，需排查）:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException（进程继续运行，需排查）:', err)
})

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
// 本轮补全：人设（门店级，挂 stores 子路由）/ 镜头库 / 账户查询 / 免费预览 / 公开系统设置
app.use('/api/v1/stores/:storeId/persona', personaRouter)
app.use('/api/v1/shot-library', shotLibraryRouter)
// 首页「优秀作品」（运营内容，只读）
app.use('/api/v1/works', worksRouter)
app.use('/api/v1/account', accountRouter)
// 公开（不鉴权）合成档位能力探测：客户端据此把不可用档位标灰
// ⚠ 必须挂在 `app.use('/api/v1/render', ...)` 之前：Express 按注册顺序做前缀匹配，
//   后注册的更深路径虽然通常能靠 next() 兜到，但依赖它太脆弱，直接把精确路由放前面。
app.use('/api/v1/render/capabilities', renderCapabilitiesRouter)
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
    // 启动横幅上高亮后门状态：它能让人**一眼看到**自己正在跑一个「固定验证码可登录」的进程。
    // 写成 console.warn 而不是 log，是为了在刷屏的启动日志里能跳出来 —— 这类开关最大的风险
    // 不是被人恶意打开，而是**被忘在启用状态**：本地联调完忘了关，某天把 .env 整份复制到服务器
    // （NODE_ENV 一写错就生效）。只打手机号条数、**绝不回显码值**。
    const testSms = smsTestCodeConfig()
    if (testSms) {
      console.warn(
        `[server] ⚠ 短信测试码已启用（白名单 ${testSms.phones.length} 个手机号可用固定验证码登录）` +
          ' —— 这是登录后门，联调结束后请删掉 .env 里的 SMS_TEST_CODE / SMS_TEST_CODE_PHONES',
      )
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

  // 会员到期提醒：7/3/1 天窗口内创建站内提醒，唯一键保证幂等
  void import('./services/membership-reminder.service.js')
    .then((m) => {
      m.startMembershipReminderSweeper(prisma)
      process.once('SIGINT', () => m.stopMembershipReminderSweeper())
      process.once('SIGTERM', () => m.stopMembershipReminderSweeper())
    })
    .catch((e) => console.error('[membership-reminder] 启动失败:', (e as Error).message))

  // 赠豆到期清零：会员到期后把赠送的 AI 豆清零（docs/05 计费规则）
  // 修复「expireGrant 已实现但零调用」——不跑这个 job，订阅到期后赠豆永久保留，续费失去意义
  void import('./services/grant-expiry.service.js')
    .then((m) => {
      m.startGrantExpirySweeper(prisma)
      process.once('SIGINT', m.stopGrantExpirySweeper)
      process.once('SIGTERM', m.stopGrantExpirySweeper)
    })
    .catch((e) => console.error('[grant-expiry] 启动失败:', (e as Error).message))

  // 机器任务卡死恢复 sweeper：worker 崩溃后 RUNNING 卡死 / QUEUED 长期无人处理的任务
  // 超时自动退款 + FAILED，常驻 API 进程不依赖 FFMPEG_WORKER（worker 独立部署挂掉也能兜底）
  void import('./render/worker.js')
    .then((m) => {
      m.startStuckSweeper()
      process.once('SIGINT', m.stopStuckSweeper)
      process.once('SIGTERM', m.stopStuckSweeper)
    })
    .catch((e) => console.error('[stuck-sweeper] 启动失败:', (e as Error).message))

  // 支付对账：主动查微信，把「回调丢了 = 钱付了没权益」的单补回来。
  // 微信回调不是可靠通道（notify_url 域名被备案拦、网络抖动、重试耗尽都会静默丢），
  // 这是用户端主动查单之外的第二条兜底；两条都复用 markOrderPaid() 的终态 CAS，重复不会双发。
  // 支付未开启时内部直接跳过，不会产生无意义的外网请求。
  void import('./services/pay-reconcile.service.js')
    .then((m) => {
      m.startPayReconcileSweeper(prisma)
      process.once('SIGINT', m.stopPayReconcileSweeper)
      process.once('SIGTERM', m.stopPayReconcileSweeper)
    })
    .catch((e) => console.error('[pay-reconcile] 启动失败:', (e as Error).message))
}

bootstrap().catch((e) => {
  console.error('[server] bootstrap failed:', e)
  process.exit(1)
})
