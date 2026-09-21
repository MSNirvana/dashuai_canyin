// 支付风险巡检 —— 专治「钱收了，但本地不知道」，以及「知道了，但没人管」。
//
// ──────────────────────── 为什么需要这个 sweeper ────────────────────────
//
// `pay-reconcile.service.ts` 已经能兜住「回调丢了」：它扫近期 PENDING 单并主动查微信。
// 但它自己写着一条限制 —— **只看最近 48 小时的单**（`PAY_RECONCILE_WINDOW_HOURS`）。
// 于是有一类单会掉进两个 job 之间的空档，而且是**永久静默**的：
//
//   · 本地状态 PENDING，但微信侧确实收了钱（回调丢了、或结算一直失败）
//   · 对账 sweeper 每 5 分钟扫一次，每次都因为同一个确定性原因失败
//     （会员套餐被误停用 → PackageNotFoundError；金额写错 → 金额校验拒绝；
//       商户私钥配错 → 关单/查单抛错）
//   · 48 小时一到，这张单滑出扫描窗口 ⇒ **从此刻起，再也没有任何代码会看它一眼**
//
// 支付放开之前这个空档影响有限（会员只能后台手动开通，每笔都有人在场）；
// `PAYMENTS_ENABLED=true` 之后，这就是「用户付了 980 元、什么也没得到、而且系统里
// 连一个需要处理的标记都没有」。
//
// 本模块做两件事：
//   ① `scanStalePendingOrders()` —— 把**滑出窗口**的那批重新捞回来，逐笔查微信取证。
//      这是把「永久静默」变回「有结论」的那一步：查完要么补单成功、要么确定未支付、
//      要么留下一条必须人工处理的告警。**不再存在「谁也没管」这个状态。**
//   ② `auditPaidSettlements()` —— 对「订单已 PAID」核对结算回执。
//      这是对 `PAID ⇒ 权益已发` 这条不变量的机器化版本（它此前只存在于注释里）。
//
// ──────────────────────── 与「对账」的分工（同族但不同的问题）────────────────────────
//   pay-reconcile ：**处理**。窗口内、还会自愈的单，它负责补回来。
//   pay-risk      ：**发现**。窗口外、不会自愈的单，它负责让问题浮出水面。
//   → 两边共用 `RECONCILE_WINDOW_HOURS`，不存在「我以为是对方的责任」的空档。
import type { PrismaClient } from '@prisma/client'
import { type ReconcileDeps, RECONCILE_WINDOW_HOURS, queryAndSettle } from './pay-reconcile.service.js'
import { resolvePayMode } from './order.service.js'
import { raiseOpsAlert, type RaiseOpsAlertInput } from './ops-alert.service.js'

/** 一轮最多取证多少张窗口外的单 —— 每笔都是一次真实外网调用，不能敞开扫 */
const STALE_BATCH = Math.max(1, Number(process.env.PAY_RISK_STALE_BATCH ?? 20))
/** 窗口外取证的回溯上限：再早的单微信侧也可能查不到了，且大概率已被人工处理过 */
const STALE_LOOKBACK_HOURS = Math.max(1, Number(process.env.PAY_RISK_STALE_LOOKBACK_HOURS ?? 720)) // 30 天
/** 回执核对一轮看多少张已支付单 */
const AUDIT_BATCH = Math.max(1, Number(process.env.PAY_RISK_AUDIT_BATCH ?? 200))

export interface PayRiskDeps extends ReconcileDeps {
  /** 回执核对的回溯窗口（小时），默认 168 = 7 天 */
  auditLookbackHours?: number
  /** 窗口外取证的回溯上限（小时） */
  staleLookbackHours?: number
  /** 手动指定「回执从什么时刻开始算」；缺省时自动取最早一条回执的时间（见 auditPaidSettlements） */
  receiptSince?: Date
}

export interface StaleScanResult {
  skipped: boolean
  /** 本轮取证的窗口外待核对单数 */
  scanned: number
  /** 取证后补单成功（钱确实收了，现已发放） */
  recovered: number
  /** 取证后确认未支付，已正常收尾（关单/置过期） */
  closed: number
  /** ★ 取证本身失败 —— 这些单必须人工核对微信侧 */
  needsHuman: number
  /** 补单成功的订单号（便于日志/验证脚本核对具体是哪几笔） */
  recoveredNos: string[]
  /** ★ 需要人工核对的订单号 —— 这是本模块最该被看见的一个列表 */
  needsHumanNos: string[]
}

export interface AuditResult {
  skipped: boolean
  /** 因为「回执体系还没上线」而跳过的说明（非空时 checked 恒为 0） */
  reason: string | null
  checked: number
  /** 已 PAID 但查不到结算回执的单数 */
  missing: number
  /** 缺失回执的订单号（最多 20 个，供告警详情与验证脚本使用） */
  missingNos: string[]
}

// ──────────────────────── ① 窗口外取证 ────────────────────────

/**
 * 捞回「已滑出自动对账窗口、但本地仍未结清」的订单，逐笔向微信取证。
 *
 * 候选的判据是 `wxPrepayId != null`：它意味着**微信侧真的存在这张单**，
 * 也就是「用户有能力付这笔钱」。从未拿到 prepay_id 的单（`createJsapiOrder` 就失败了）
 * 微信侧根本没有对应订单，不可能收过钱，扫它只是浪费外网调用。
 *
 * 分流：
 *   · SUCCESS + 金额一致 → 复用 `queryAndSettle` 补发权益（幂等），并告警「窗口外才发现」
 *   · 未支付且已过期     → 正常关单收尾（不告警：这是预期结局）
 *   · 取证抛错           → **CRITICAL 告警**。这才是真正的「扣款成功但开通失败」
 *                          现场：我们知道微信侧有这张单，但拿不到结论，必须人去看。
 */
export async function scanStalePendingOrders(
  prisma: PrismaClient,
  deps: PayRiskDeps = {},
  now = new Date(),
): Promise<StaleScanResult> {
  const result: StaleScanResult = {
    skipped: false,
    scanned: 0,
    recovered: 0,
    closed: 0,
    needsHuman: 0,
    recoveredNos: [],
    needsHumanNos: [],
  }
  const alert = deps.alert ?? ((i: RaiseOpsAlertInput) => raiseOpsAlert(prisma, i))

  if ((deps.payMode ?? resolvePayMode)() !== 'real') {
    result.skipped = true
    return result
  }

  const windowStart = new Date(now.getTime() - RECONCILE_WINDOW_HOURS * 3600 * 1000)
  const lookbackStart = new Date(
    now.getTime() - (deps.staleLookbackHours ?? STALE_LOOKBACK_HOURS) * 3600 * 1000,
  )

  const stale = await prisma.order.findMany({
    where: {
      status: 'PENDING',
      // 微信侧确实存在这张单（用户有能力付过钱）
      wxPrepayId: { not: null },
      // ★ 严格小于窗口起点：窗口内的归 pay-reconcile 管，两边不重叠、不重复查
      createdAt: { lt: windowStart, gte: lookbackStart },
      OR: [
        { orderNo: { startsWith: 'B' } },
        { orderNo: { startsWith: 'M' } },
      ],
    },
    select: { orderNo: true, amountFen: true, createdAt: true },
    // 最老的优先：它们已经静默最久，也最可能真的收过钱
    orderBy: { createdAt: 'asc' },
    take: STALE_BATCH,
  })
  result.scanned = stale.length

  for (const o of stale) {
    try {
      const r = await queryAndSettle(prisma, o.orderNo, { ...deps, now, source: 'RISK' })
      if (r.outcome === 'SETTLED') {
        result.recovered += 1
        result.recoveredNos.push(o.orderNo)
        // 单独再报一条：`queryAndSettle` 报的是「回调丢了，补单成功」，
        // 而这里要说的是更重的一句话 —— 「它是**在窗口外**才被发现的」。
        await alert({
          code: 'PAY_RECOVERED_OUTSIDE_WINDOW',
          severity: 'WARN',
          title: `订单在自动对账窗口外才被发现已支付，已补发权益（第 ${result.recovered} 笔）`,
          detail:
            `订单 ${o.orderNo}（金额 ${o.amountFen} 分，创建于 ${o.createdAt.toISOString()}）` +
            `微信侧已收款，但本地一直停在待支付，直到超过 ${RECONCILE_WINDOW_HOURS} 小时的对账窗口后才由风险巡检发现。` +
            `权益已补发（用户没有损失），但请查为什么自动对账没能兜住：` +
            `通常意味着结算在某段时间里**持续确定性失败**（套餐被停用 / 金额配错 / 凭据异常），` +
            `或 WX_PAY_NOTIFY_URL 长期不可达。**若本条成批出现，说明有用户在静默期内一直拿不到权益。**`,
          refType: 'order',
          refId: o.orderNo,
          dedupeKey: `PAY_RECOVERED_OUTSIDE_WINDOW:${o.orderNo}`,
        })
      } else if (r.status !== 'PENDING') {
        // 关单/置过期 = 预期结局（用户最终没付），不需要打扰任何人
        result.closed += 1
      }
    } catch (e) {
      result.needsHuman += 1
      result.needsHumanNos.push(o.orderNo)
      const reason = (e as Error).message
      console.error(`[pay-risk] 窗口外取证失败 order=${o.orderNo}:`, reason)
      // ★★ 这就是用户说的「扣款成功但开通失败」。
      //    已知：微信侧存在这张单；不知道：钱到底收没收到（取证失败）。
      //    已知：它已经滑出了自动通道的保护范围，**没有任何代码会再重试它**。
      //    ⇒ 必须人工，且必须是 CRITICAL。
      await alert({
        code: 'PAY_STALE_SETTLE_FAILED',
        severity: 'CRITICAL',
        title: '窗口外订单取证失败：可能已收款但无法开通，需人工核对',
        detail:
          `订单 ${o.orderNo}（本地金额 ${o.amountFen} 分，创建于 ${o.createdAt.toISOString()}）` +
          `已超出 ${RECONCILE_WINDOW_HOURS} 小时自动对账窗口，且本次向微信取证时抛错：${reason}。` +
          `**该单不会再被任何自动流程重试。** 请人工到微信商户平台按订单号 ${o.orderNo} 查这笔交易：` +
          `若已收款 → 立即在后台「订单」里用补单功能发放权益；若未收款 → 确认关单，避免留下可支付的敞口。`,
        refType: 'order',
        refId: o.orderNo,
        // 按订单去重：同一张单每小时都被巡检一次，但只应产生一条待处理告警
        dedupeKey: `PAY_STALE_SETTLE_FAILED:${o.orderNo}`,
      })
    }
  }

  return result
}

// ──────────────────────── ② 已支付单的回执核对 ────────────────────────

/**
 * 核对「订单已 PAID」是否都有结算回执，即把 `PAID ⇒ 权益已发` 变成可执行的断言。
 *
 * ★★ 关于「回执从什么时刻开始算」—— 这里有一个必须处理的假警报陷阱：
 *   回执表是**新加的**，上线之前所有已支付的订单都没有回执。
 *   如果不设起点，第一次跑就会把过去 7 天的每一张已支付单都报成「权益可能没发」，
 *   运营看到一批假警之后，就再也不会相信这个告警了 —— 而它本该是最后一道防线。
 *
 *   所以起点**自动推导**：取库里最早一条回执的 `createdAt`。
 *   任何在它之前支付完的单都属于「回执体系上线前」的历史，跳过。
 *   这条推导是自洽的：回执在结算事务内写入 ⇒ 只要有过一笔成功结算，起点就是对的；
 *   一笔回执都没有时整体跳过（而不是把全库报成异常）。
 *   `deps.receiptSince` 可显式覆盖（例如回执被误删后人工指定）。
 *
 *   代价：若有人删掉了最早的那些回执，起点会后移 ⇒ 漏报（而非假报）。
 *   这个方向是刻意选的 —— 这道防线宁可漏一次，也不能因为噪音被关掉。
 */
export async function auditPaidSettlements(
  prisma: PrismaClient,
  deps: PayRiskDeps = {},
  now = new Date(),
): Promise<AuditResult> {
  const result: AuditResult = { skipped: false, reason: null, checked: 0, missing: 0, missingNos: [] }
  const alert = deps.alert ?? ((i: RaiseOpsAlertInput) => raiseOpsAlert(prisma, i))

  let since = deps.receiptSince ?? null
  if (!since) {
    const earliest = await prisma.orderSettlement.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    })
    if (!earliest) {
      result.skipped = true
      result.reason = '库里还没有任何结算回执（回执体系刚上线）——跳过核对，避免把历史订单全报成异常'
      return result
    }
    since = earliest.createdAt
  }

  const lookbackStart = new Date(
    now.getTime() - (deps.auditLookbackHours ?? 168) * 3600 * 1000,
  )
  const from = since > lookbackStart ? since : lookbackStart

  const paid = await prisma.order.findMany({
    where: { status: 'PAID', paidAt: { not: null, gte: from } },
    select: { id: true, orderNo: true, orderType: true, amountFen: true, paidAt: true },
    orderBy: { paidAt: 'desc' },
    take: AUDIT_BATCH,
  })
  result.checked = paid.length
  if (paid.length === 0) return result

  const receipts = await prisma.orderSettlement.findMany({
    where: { orderId: { in: paid.map((o) => o.id) } },
    select: { orderId: true },
  })
  const have = new Set(receipts.map((r) => r.orderId.toString()))
  const missing = paid.filter((o) => !have.has(o.id.toString()))
  result.missing = missing.length
  result.missingNos = missing.slice(0, 20).map((o) => o.orderNo)

  if (missing.length > 0) {
    const sample = missing.slice(0, 5).map((o) => `${o.orderNo}(${o.amountFen}分)`)
    await alert({
      code: 'PAY_PAID_WITHOUT_RECEIPT',
      severity: 'CRITICAL',
      title: '订单显示已支付，但查不到结算回执（可能钱收了、权益没发）',
      detail:
        `在 ${from.toISOString()} 之后支付的 ${paid.length} 张单中，有 ${missing.length} 张查不到结算回执：` +
        `${sample.join('、')}${missing.length > 5 ? ` 等 ${missing.length} 张` : ''}。` +
        `结算回执与「订单转 PAID」在同一个事务内写入，因此**正常情况下不可能缺失**。` +
        `出现即意味着有人绕过了 markOrderPaid()（例如直接在库里改 status=PAID，` +
        `或新增了第二处写入点）。请逐一核对这些单的权益是否真的发放。`,
      refType: 'order',
      refId: missing[0]!.orderNo,
      // 粗粒度键：这是**代码回归**，不是逐笔的资金事件。合成一条、用 occurrences 计数
      dedupeKey: 'PAY_PAID_WITHOUT_RECEIPT',
    })
  }

  return result
}

// ──────────────────────── 总入口 + 定时调度 ────────────────────────

export interface PayRiskScanResult {
  skipped: boolean
  stale: StaleScanResult
  audit: AuditResult
}

/** 完整跑一轮风险巡检（两个部分互相独立，一个失败不影响另一个） */
export async function scanPaymentRisks(
  prisma: PrismaClient,
  deps: PayRiskDeps = {},
  now = new Date(),
): Promise<PayRiskScanResult> {
  const skipped = (deps.payMode ?? resolvePayMode)() !== 'real'
  const emptyStale: StaleScanResult = {
    skipped,
    scanned: 0,
    recovered: 0,
    closed: 0,
    needsHuman: 0,
    recoveredNos: [],
    needsHumanNos: [],
  }
  const emptyAudit: AuditResult = { skipped, reason: null, checked: 0, missing: 0, missingNos: [] }
  if (skipped) return { skipped, stale: emptyStale, audit: emptyAudit }

  let stale = emptyStale
  let audit = emptyAudit
  try {
    stale = await scanStalePendingOrders(prisma, deps, now)
  } catch (e) {
    console.error('[pay-risk] 窗口外取证整体失败:', (e as Error).message)
  }
  try {
    audit = await auditPaidSettlements(prisma, deps, now)
  } catch (e) {
    console.error('[pay-risk] 回执核对整体失败:', (e as Error).message)
  }
  return { skipped, stale, audit }
}

/** 巡检间隔。窗口外取真要打微信接口，不必太频繁；默认 1 小时 */
const SWEEP_INTERVAL_MS = Math.max(60_000, Number(process.env.PAY_RISK_SWEEP_MS ?? 3_600_000))

let timer: NodeJS.Timeout | undefined
let running = false

async function tick(prisma: PrismaClient): Promise<void> {
  if (running) return
  running = true
  try {
    const r = await scanPaymentRisks(prisma)
    if (r.skipped) return
    const s = r.stale
    const a = r.audit
    // 只在「有内容」时打日志，避免每小时一行噪音把 pm2 日志淹掉
    if (s.scanned > 0 || a.missing > 0 || a.checked === 0) {
      console.log(
        `[pay-risk] 巡检：窗口外待核对 ${s.scanned} 笔（补单 ${s.recovered} / 收尾 ${s.closed} / **待人工 ${s.needsHuman}**）` +
          `｜回执核对 ${a.checked} 笔${a.missing > 0 ? `（**缺失 ${a.missing}**）` : ''}` +
          `${a.reason ? `｜${a.reason}` : ''}`,
      )
    }
  } catch (e) {
    console.error('[pay-risk] 巡检失败:', (e as Error).message)
  } finally {
    running = false
  }
}

export function startPayRiskSweeper(prisma: PrismaClient): void {
  if (timer) return
  if (resolvePayMode() !== 'real') {
    console.log('[pay-risk] 未启用（支付未开启或为演示模式），跳过风险巡检调度')
    return
  }
  void tick(prisma)
  timer = setInterval(() => void tick(prisma), SWEEP_INTERVAL_MS)
  timer.unref()

  // ★ 启动时必须直说「告警能不能到人手上」。
  //   巡检本身只负责**发现**；发现之后没人知道等于白发现。
  //   没有推送渠道时告警只落库，所以这句话必须显式喊出来，不能让人误以为有手机推送。
  const hasWebhook = (process.env.OPS_ALERT_WEBHOOK ?? '').trim().length > 0
  console.log(
    `[pay-risk] started (interval=${SWEEP_INTERVAL_MS}ms, 窗口外取证=${RECONCILE_WINDOW_HOURS}h 之后, ` +
      `批量=${STALE_BATCH})｜告警渠道：` +
      (hasWebhook
        ? '企业微信 webhook 已配置（落库 + 推送）'
        : '⚠ **未配置 OPS_ALERT_WEBHOOK** —— 告警只落库、不会推到手机，请查后台「异常告警」'),
  )
}

export function stopPayRiskSweeper(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
