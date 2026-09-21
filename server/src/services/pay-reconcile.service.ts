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
//   千万不要在查单路径里另写一套发权益逻辑 —— 那必然出现双重发积分。
//
// 安全：查单响应必须验签通过（见 lib/wxpay.ts::queryOrderByOutTradeNo，fail-closed），
// 且**金额必须与本地订单一致**才结算（否则等于「用 1 分钱买 980 元会员」）。
import type { PrismaClient } from '@prisma/client'
import { queryOrderByOutTradeNo, closeOrder, type WxQueryResult, type WxTradeState } from '../lib/wxpay.js'
import { markOrderPaid, resolvePayMode, type SettlementSource } from './order.service.js'
import { raiseOpsAlert, type RaiseOpsAlertInput } from './ops-alert.service.js'

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
  /**
   * 关闭微信侧订单。过期判定前会先调它（见 queryAndSettle 里的说明），
   * 因此必须可注入 —— 否则测试会真的向微信发请求。
   */
  close?: (outTradeNo: string) => Promise<{ ok: boolean; note: string }>
  payMode?: () => 'real' | 'demo' | 'disabled'
  /**
   * 告警出口。缺省写 `ops_alert` 表（并可能推 webhook）。
   * 验证脚本注入收集器，既避免真的推送，又能断言「该报的时候真的报了」。
   */
  alert?: (input: RaiseOpsAlertInput) => Promise<unknown>
}

export interface QueryAndSettleOptions extends ReconcileDeps {
  /** 传入则校验订单归属该商户（用户端接口必须传，后台不传） */
  merchantId?: bigint
  now?: Date
  /**
   * 结算来源，只进回执留痕。
   * 缺省 `RECONCILE`（对账/后台补单）；用户端查单传 `QUERY`，窗口外取证扫描传 `RISK`。
   */
  source?: SettlementSource
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
  const close = options.close ?? closeOrder
  const payMode = (options.payMode ?? resolvePayMode)()
  const now = options.now ?? new Date()
  const alert = options.alert ?? ((i: RaiseOpsAlertInput) => raiseOpsAlert(prisma, i))
  const source: SettlementSource = options.source ?? 'RECONCILE'

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
      // ★ 这条 MUST 告警：它不是一个会自愈的失败。对账每轮都会走到这里、每轮都拒绝，
      //   48 小时后这张单滑出扫描窗口 ⇒ 永久静默。而它背后是真实的资金差异。
      await alert({
        code: 'PAY_AMOUNT_MISMATCH',
        severity: 'CRITICAL',
        title: '微信侧金额与本地订单不一致，已拒绝结算',
        detail:
          `订单 ${orderNo}：微信侧收款 ${q.amountFen} 分，本地订单 ${order.amountFen} 分。` +
          `系统按「拒绝结算」处理（防止用错误金额发放权益），该单会一直停在待支付直到人工介入。` +
          `请核对是本地金额写错、还是这笔钱不属于这张单。`,
        refType: 'order',
        refId: orderNo,
        // 与 handleNotify 用同一个键：无论回调还是查单先发现，同一张单只留一条告警
        dedupeKey: `PAY_AMOUNT_MISMATCH:${orderNo}`,
      })
      return {
        orderNo,
        outcome: 'NOT_PAID',
        tradeState: q.tradeState,
        status: order.status,
        message: `微信侧金额（${q.amountFen}）与本地订单（${order.amountFen}）不一致，已拒绝自动结算，请人工核对`,
      }
    }
    await markOrderPaid(prisma, orderNo, q.transactionId, false, undefined, source)
    console.log(`[pay-reconcile] 补单成功 order=${orderNo}（回调丢失，由查单结算）`)
    // ★ 补单成功是好事，但仍然必须可见：
    //   它意味着「微信的异步回调丢了，而且自动通道直到现在才发现」。
    //   单笔看是兜底生效，成批出现就是 notify_url 或网络出了问题 ——
    //   没有这条告警，运营永远不会知道回调链路已经坏了一整天。
    await alert({
      code: 'PAY_SETTLED_BY_RECONCILE',
      severity: 'WARN',
      title: '微信回调丢失，已由查单/对账补发权益',
      detail:
        `订单 ${orderNo}（金额 ${order.amountFen} 分）微信侧已支付，但本地一直停在待支付，` +
        `本次由「${source}」通道查单后补发权益。若此类告警成批出现，请检查 WX_PAY_NOTIFY_URL 是否可达。`,
      refType: 'order',
      refId: orderNo,
      dedupeKey: `PAY_SETTLED_BY_RECONCILE:${orderNo}`,
    })
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
    await alert({
      code: 'PAY_REFUND_ANOMALY',
      severity: 'CRITICAL',
      title: '微信侧订单已退款，但本地订单从未结算',
      detail:
        `订单 ${orderNo}（本地 ${order.amountFen} 分）微信侧状态为已退款，而本地一直是 ${order.status}。` +
        `本项目没有退款入口，出现这个组合说明账实不符。系统**不自动动账**，需人工核对。`,
      refType: 'order',
      refId: orderNo,
      dedupeKey: `PAY_REFUND_ANOMALY:${orderNo}`,
    })
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
      // ★★ 顺序至关重要：**先关微信侧订单，成功了才允许把本地置为 EXPIRED**。
      //
      //   旧实现只改本地状态，于是留下一个窗口：本地已判过期，微信侧却仍可支付
      //   （新增 time_expire 之后窗口变窄，但网络超时/关单失败仍会留下它）。
      //   用户在这个窗口里付款成功 → 回调进来时本地已不是 PENDING → CAS 更新 0 行
      //   → 钱收了、权益不发，而且旧代码在这条路径上没有任何日志。
      //
      //   关单失败时不置过期：订单留在 PENDING，下一轮对账会重试。
      //   宁可让订单多挂一会儿（用户可能还能支付成功并拿到权益），
      //   也不要造出「本地已关、微信可付」的不可恢复状态。
      const closed = await close(orderNo)
      if (!closed.ok) {
        console.warn(`[pay-reconcile] 订单 ${orderNo} 已过期但微信关单失败（${closed.note}），暂不置为过期，下轮重试`)
        // 单次失败会自动重试，不必惊动人；`occurrences` 会把它累计成「一直关不掉」。
        // 真正需要人介入的时候，是它累计出几十次 —— 那种「本地一直留着可支付的单」是敞口。
        await alert({
          code: 'PAY_CLOSE_FAILED',
          severity: 'WARN',
          title: '微信侧关单失败，订单保持待支付等下一轮重试',
          detail:
            `订单 ${orderNo} 已过支付有效期、微信侧仍未支付，但调用关单失败：${closed.note}。` +
            `订单保持待支付（宁可多挂一会儿，也不要造出「本地已关、微信仍可付」的不可恢复状态）。` +
            `若本条累计次数持续增长，说明关单一直失败，请检查商户私钥/证书配置。`,
          refType: 'order',
          refId: orderNo,
          dedupeKey: `PAY_CLOSE_FAILED:${orderNo}`,
        })
        return {
          orderNo,
          outcome: 'NOT_PAID',
          tradeState: q.tradeState,
          status: order.status,
          message: `微信关单失败（${closed.note}），订单保持待支付以便下一轮重试`,
        }
      }
      await closeLocal(prisma, orderNo, 'EXPIRED')
      return {
        orderNo,
        outcome: 'CLOSED',
        tradeState: q.tradeState,
        status: 'EXPIRED',
        message: `订单已过支付有效期且微信侧未支付，已关单并置为已过期（微信返回 ${closed.note}）`,
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
/**
 * 导出给 `pay-risk.service.ts` 用。
 *
 * ★ 这个数字是**风险扫描的起点**：本 sweeper 只负责窗口内的单，
 *   窗口外那批「真实微信单 + 本地未结清」必须由风险扫描接手 ——
 *   两边共用同一个常量，才不会出现「我以为是别人的责任」的空档。
 */
export const RECONCILE_WINDOW_HOURS = WINDOW_HOURS
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
      const reason = (e as Error).message
      console.error(`[pay-reconcile] 查单失败 order=${o.orderNo}:`, reason)
      // ★ 用**粗粒度**去重键（不含订单号）：微信侧整体不可用时会有几十笔同时失败，
      //   逐笔记一条会把告警表刷成噪音。合并成一条、用 occurrences 说话，
      //   运维看到「查单失败 累计 137 次」比看到 137 条一模一样的告警有用得多。
      await (deps.alert ?? ((i: RaiseOpsAlertInput) => raiseOpsAlert(prisma, i)))({
        code: 'PAY_QUERY_FAILED',
        severity: 'WARN',
        title: '向微信查单失败（订单仍可下一轮重试）',
        detail:
          `最近一次失败：订单 ${o.orderNo} —— ${reason}。` +
          `单笔失败会由下一轮重试覆盖，无需处理；但若本条累计次数持续增长，` +
          `说明查单通道整体不可用（网络 / 商户凭据 / 微信侧限流），此时**所有订单的兜底都失效**，必须立刻介入。`,
        refType: 'order',
        refId: o.orderNo,
        dedupeKey: 'PAY_QUERY_FAILED',
      })
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
