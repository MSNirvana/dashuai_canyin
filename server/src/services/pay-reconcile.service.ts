// 支付对账 / 主动查单 —— 微信异步回调的**兜底通道**
//
// 背景（为什么必须有这个东西）：
//   微信的异步回调**不是可靠通道**。`notify_url` 域名不可达（本项目正卡在备案上）、
//   网络抖动、微信重试次数耗尽 —— 任何一种都会让回调**静默丢失**。
//   此时用户钱确实付了、微信侧 `trade_state=SUCCESS`，而我们本地订单永远停在 PENDING：
//   没有报错、没有告警，只有用户投诉「付了钱没到账」。
//
// 三条通道，优先级从高到低：
//   ① 用户端支付成功后主动查单   —— routes/orders.ts `POST /:orderNo/query`，延迟最低（秒级）
//   ② 后台低频对账 sweeper        —— 兜住「用户没回到页面 / 直接杀掉小程序」的情况
//   ③ 后台人工补单                —— routes/admin.ts，兜住前两条都失效的极端情况
//
// ★ 三条通道全部复用 `markOrderPaid()`：它用「PENDING → PAID 的终态 CAS」做幂等，
//   所以回调 + 查单 + 人工补单**同时发生也只发一次权益**。
//   千万不要在查单路径里另写一套发权益逻辑 —— 那必然出现双重发豆。
//
// 安全：查单响应必须验签通过（见 lib/wxpay.ts::queryOrderByOutTradeNo，fail-closed），
// 且**金额必须与本地订单一致**才结算（否则等于「用 1 分钱买 980 元会员」）。
import type { PrismaClient } from '@prisma/client'
import { queryOrderByOutTradeNo, type WxQueryResult, type WxTradeState } from '../lib/wxpay.js'
import { markOrderPaid, resolvePayMode } from './order.service.js'

/** 只有线上单（B=充值 / M=会员）在微信侧有对应订单；A=后台线下单，查不到也不该查 */
const QUERYABLE_PREFIXES = ['B', 'M']

export type ReconcileOutcome =
  | 'ALREADY_PAID' // 本地已是 PAID，未调微信
  | 'SETTLED' // 查单确认已支付 → 本次完成结算
  | 'NOT_PAID' // 微信侧未支付 / 支付中，本地保持 PENDING
  | 'CLOSED' // 微信侧已关闭/撤销/支付失败 → 本地置终态
  | 'NOT_EXIST' // 微信侧查无此单 → 本地过期则置终态
  | 'SKIPPED' // 不该查的单（后台单 / 演示支付 / 支付未开启）

export interface ReconcileResult {
  orderNo: string
  outcome: ReconcileOutcome
  /** 微信侧 trade_state；未查微信时为 null */
  tradeState: WxTradeState | null
  /** 本地订单最新状态 */
  status: string
  /** 人类可读的说明（会进日志 / 返回给后台） */
  message: string
}

/** 可注入的依赖 —— 让测试能在不联网、不碰真凭据的前提下覆盖各分支 */
export interface ReconcileDeps {
  query?: (outTradeNo: string) => Promise<WxQueryResult>
  payMode?: () => 'real' | 'demo' | 'disabled'
}

export interface QueryAndSettleOptions extends ReconcileDeps {
  /** 传入则校验订单归属该商户（用户端接口必须传，后台不传） */
  merchantId?: bigint
  now?: Date
}

async function closeLocal(
  prisma: PrismaClient,
  orderNo: string,
  next: 'EXPIRED' | 'CANCELLED',
): Promise<void> {
  // 条件更新：只关 PENDING 的单。并发下若已被 markOrderPaid 抢成 PAID，这里 count=0，绝不覆盖终态。
  await prisma.order.updateMany({ where: { orderNo, status: 'PENDING' }, data: { status: next } })
}

/**
 * 查单并按结果结算。**幂等**：本地已 PAID 直接返回，不调微信。
 */
export async function queryAndSettle(
  prisma: PrismaClient,
  orderNo: string,
  options: QueryAndSettleOptions = {},
): Promise<ReconcileResult> {
  const query = options.query ?? queryOrderByOutTradeNo
  const payMode = (options.payMode ?? resolvePayMode)()
  const now = options.now ?? new Date()

  const order = await prisma.order.findFirst({
    where: { orderNo, ...(options.merchantId !== undefined ? { merchantId: options.merchantId } : {}) },
    select: {
      orderNo: true,
      status: true,
      orderType: true,
      amountFen: true,
      expireAt: true,
      wxPrepayId: true,
      wxTransactionId: true,
    },
  })
  if (!order) {
    return { orderNo, outcome: 'SKIPPED', tradeState: null, status: 'NOT_FOUND', message: '订单不存在' }
  }
  // 终态直接返回：既省一次外网调用，也避免重复结算
  if (order.status === 'PAID') {
    return {
      orderNo,
      outcome: 'ALREADY_PAID',
      tradeState: null,
      status: 'PAID',
      message: '订单已是已支付状态，无需查单',
    }
  }
  if (order.status !== 'PENDING') {
    return {
      orderNo,
      outcome: 'SKIPPED',
      tradeState: null,
      status: order.status,
      message: `订单已是终态 ${order.status}，不查单`,
    }
  }
  if (!QUERYABLE_PREFIXES.includes(orderNo.slice(0, 1))) {
    return {
      orderNo,
      outcome: 'SKIPPED',
      tradeState: null,
      status: order.status,
      message: '线下单（后台手动开通）在微信侧没有对应订单，不查单',
    }
  }
  if (payMode !== 'real') {
    // 演示/关闭态下本地单不会出现在微信侧，查单只会拿到误导性的 NOT_EXIST
    return {
      orderNo,
      outcome: 'SKIPPED',
      tradeState: null,
      status: order.status,
      message: `当前支付模式为 ${payMode}，微信侧无此单，不查单`,
    }
  }

  const q = await query(orderNo)

  if (q.tradeState === 'SUCCESS') {
    // 金额校验：查单结果会直接发权益，金额对不上宁可人工介入，也不能按错金额结算
    if (q.amountFen !== order.amountFen) {
      console.error(
        `[pay-reconcile] 金额不一致，拒绝结算 order=${orderNo} 本地=${order.amountFen} 微信=${q.amountFen}`,
      )
      return {
        orderNo,
        outcome: 'NOT_PAID',
        tradeState: q.tradeState,
        status: order.status,
        message: `微信侧金额（${q.amountFen}）与本地订单（${order.amountFen}）不一致，已拒绝自动结算，请人工核对`,
      }
    }
    await markOrderPaid(prisma, orderNo, q.transactionId)
    console.log(`[pay-reconcile] 补单成功 order=${orderNo}（回调丢失，由查单结算）`)
    return {
      orderNo,
      outcome: 'SETTLED',
      tradeState: q.tradeState,
      status: 'PAID',
      message: '查单确认已支付，已补发权益',
    }
  }

  if (q.tradeState === 'REFUND') {
    // 本项目的会员/充值没有退款入口，走到这里说明状态异常 —— 不自动动账，交给人工
    console.error(`[pay-reconcile] 微信侧为已退款但本地未支付，需人工核对 order=${orderNo}`)
    return {
      orderNo,
      outcome: 'NOT_PAID',
      tradeState: q.tradeState,
      status: order.status,
      message: '微信侧显示已退款但本地未支付，状态异常，已跳过（请人工核对）',
    }
  }

  if (q.tradeState === 'NOTPAY' || q.tradeState === 'USERPAYING') {
    const expired = order.expireAt.getTime() <= now.getTime()
    if (expired) {
      await closeLocal(prisma, orderNo, 'EXPIRED')
      return {
        orderNo,
        outcome: 'CLOSED',
        tradeState: q.tradeState,
        status: 'EXPIRED',
        message: '订单已过支付有效期且微信侧未支付，已置为已过期',
      }
    }
    return {
      orderNo,
      outcome: 'NOT_PAID',
      tradeState: q.tradeState,
      status: order.status,
      message: '微信侧尚未支付',
    }
  }

  if (q.tradeState === 'CLOSED' || q.tradeState === 'REVOKED' || q.tradeState === 'PAYERROR') {
    const next = order.expireAt.getTime() <= now.getTime() ? 'EXPIRED' : 'CANCELLED'
    await closeLocal(prisma, orderNo, next)
    return {
      orderNo,
      outcome: 'CLOSED',
      tradeState: q.tradeState,
      status: next,
      message: `微信侧订单状态 ${q.tradeState}，本地已置为 ${next}`,
    }
  }

  // NOT_EXIST：微信侧查无此单。
  // · 已过期 → 直接关掉（预下单没成功 / 超期），不留悬空 PENDING；
  // · 未过期 → **不动**，可能只是刚下单、微信侧还没落库。
  if (order.expireAt.getTime() <= now.getTime()) {
    await closeLocal(prisma, orderNo, 'EXPIRED')
    return {
      orderNo,
      outcome: 'NOT_EXIST',
      tradeState: q.tradeState,
      status: 'EXPIRED',
      message: '微信侧查无此单且本地已过期，已置为已过期',
    }
  }
  return {
    orderNo,
    outcome: 'NOT_EXIST',
    tradeState: q.tradeState,
    status: order.status,
    message: '微信侧暂未查到该订单，本地保持待支付',
  }
}

// ──────────────────────── 对账 sweeper（照抄 grant-expiry 骨架） ────────────────────────

const SWEEP_INTERVAL_MS = Math.max(60_000, Number(process.env.PAY_RECONCILE_SWEEP_MS ?? 300_000))
/** 只看最近 N 小时创建的单：更早的早已过期，反复查微信没有意义 */
const WINDOW_HOURS = Math.max(1, Number(process.env.PAY_RECONCILE_WINDOW_HOURS ?? 48))
const BATCH = 50

export interface ScanResult {
  /** 支付未开启（或演示模式）时整体跳过 */
  skipped: boolean
  scanned: number
  settled: number
  closed: number
  failed: number
}

/**
 * 扫描近期 PENDING 订单并逐笔查单。
 *
 * 为什么不按「已过期」过滤：用户可能**在有效期内付了钱、回调却丢了**，
 * 这类单正是最需要兜的（过期时间点在支付前后都可能）。
 * 所以窗口内所有 PENDING 都查：SUCCESS 就补发；未支付且已过期就关单。
 */
export async function scanPendingOrders(
  prisma: PrismaClient,
  deps: ReconcileDeps = {},
  now = new Date(),
): Promise<ScanResult> {
  const result: ScanResult = { skipped: false, scanned: 0, settled: 0, closed: 0, failed: 0 }

  const payMode = (deps.payMode ?? resolvePayMode)()
  if (payMode !== 'real') {
    result.skipped = true
    return result
  }

  const since = new Date(now.getTime() - WINDOW_HOURS * 3600 * 1000)
  const pending = await prisma.order.findMany({
    where: {
      status: 'PENDING',
      createdAt: { gte: since },
      // 只有线上单在微信侧有对应订单
      OR: QUERYABLE_PREFIXES.map((p) => ({ orderNo: { startsWith: p } })),
    },
    select: { orderNo: true },
    orderBy: { createdAt: 'desc' },
    take: BATCH,
  })
  result.scanned = pending.length

  for (const o of pending) {
    try {
      const r = await queryAndSettle(prisma, o.orderNo, { ...deps, now })
      if (r.outcome === 'SETTLED') result.settled += 1
      else if (r.outcome === 'CLOSED' || r.outcome === 'NOT_EXIST') {
        if (r.status !== 'PENDING') result.closed += 1
      }
    } catch (e) {
      // 单笔失败不影响其余（例如微信侧偶发超时 / 验签失败）；下一轮会重试
      result.failed += 1
      console.error(`[pay-reconcile] 查单失败 order=${o.orderNo}:`, (e as Error).message)
    }
  }
  return result
}

let timer: NodeJS.Timeout | undefined
let running = false

async function tick(prisma: PrismaClient): Promise<void> {
  if (running) return // 上一轮未结束则跳过本轮，避免叠加
  running = true
  try {
    const r = await scanPendingOrders(prisma)
    if (r.skipped) return
    if (r.settled > 0 || r.closed > 0 || r.failed > 0) {
      console.log(
        `[pay-reconcile] 扫描 ${r.scanned} 笔待支付：补单 ${r.settled} / 关单 ${r.closed} / 失败 ${r.failed}`,
      )
    }
  } catch (e) {
    console.error('[pay-reconcile] 扫描失败:', (e as Error).message)
  } finally {
    running = false
  }
}

export function startPayReconcileSweeper(prisma: PrismaClient): void {
  if (timer) return
  // 支付未开启时不必起：tick 内部也会跳过，这里提前返回让日志干净
  if (resolvePayMode() !== 'real') {
    console.log('[pay-reconcile] 未启用（支付未开启或为演示模式），跳过对账调度')
    return
  }
  void tick(prisma) // 启动时先跑一轮
  timer = setInterval(() => void tick(prisma), SWEEP_INTERVAL_MS)
  timer.unref()
  console.log(`[pay-reconcile] started (interval=${SWEEP_INTERVAL_MS}ms, window=${WINDOW_HOURS}h)`)
}

export function stopPayReconcileSweeper(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
