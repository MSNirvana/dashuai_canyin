/**
 * 验证「支付风控巡检」：窗口外订单取证 + 结算回执核对 + 告警出口本身。
 *
 * 为什么必须有这个脚本：
 *   这一整条链路对付的是**支付放开后唯一一类无人看管的钱**——
 *   `pay-reconcile` 只扫最近 48 小时的 PENDING 单，超窗口之后：
 *     · 本地是 PENDING，微信侧可能已经收了钱（回调丢了 / 结算确定性失败）
 *     · 没有任何代码会再看它一眼，也没有任何告警
 *   也就是说，这段逻辑写错的后果不是「报个错」，而是**静默地把用户的钱留在系统外面**。
 *   所以每个分支都必须能离线、确定性地验证。
 *
 * 本脚本**完全不联网、不推 webhook**：查单/关单/告警全部注入桩。
 * 用法：npm run pay-risk:verify
 * 只用一个临时手机号造商户，跑完硬删；不动任何真实商户数据。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { devLogin } from '../src/auth/auth.service.js'
import {
  RECONCILE_WINDOW_HOURS,
  type ReconcileDeps,
} from '../src/services/pay-reconcile.service.js'
import {
  auditPaidSettlements,
  scanStalePendingOrders,
  scanPaymentRisks,
} from '../src/services/pay-risk.service.js'
import {
  ackOpsAlert,
  listOpsAlerts,
  OpsAlertNotFoundError,
  raiseOpsAlert,
  __resetOpsAlertThrottle,
  type RaiseOpsAlertInput,
} from '../src/services/ops-alert.service.js'
import { getBalance } from '../src/bean/bean.service.js'
import type { WxQueryResult } from '../src/lib/wxpay.js'

const prisma = new PrismaClient()
const PHONE = '13900009997' // 与 pay-reconcile:verify(…9998)/membership:verify(…9999) 区分开
const HOUR = 3600 * 1000

let pass = 0
let failed = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${extra ? `  （${extra}）` : ''}`)
  }
}

/** 收集告警的桩：不落库、不推送，只记录 —— 用来断言「该报的时候真的报了」 */
function alertCollector() {
  const raised: RaiseOpsAlertInput[] = []
  const alert = (async (i: RaiseOpsAlertInput) => {
    raised.push(i)
    return { id: 1n, merged: false, pushStatus: 'SKIPPED' as const, persisted: true }
  }) as NonNullable<ReconcileDeps['alert']>
  return { alert, raised, codes: () => raised.map((r) => r.code) }
}

/** 注入用的假查单：按订单号给结果，并记录查了哪几笔（未登记的订单被查到 = 直接失败） */
function fakeQuery(byOrder: Record<string, WxQueryResult>) {
  const calls: string[] = []
  const query = async (outTradeNo: string): Promise<WxQueryResult> => {
    calls.push(outTradeNo)
    const r = byOrder[outTradeNo]
    if (!r) throw new Error(`本脚本不应查询这笔订单：${outTradeNo}`)
    if (r instanceof Error) throw r
    return r
  }
  return { query, calls }
}

const closeOk = (async () => ({ ok: true, note: 'SUCCESS' })) as (
  n: string,
) => Promise<{ ok: boolean; note: string }>

/**
 * 清掉「窗口外 + 有 prepayId + 仍 PENDING」的悬空单。
 *
 * ★ 为什么每个断言「本轮只应处理这几笔」的小节都要先调用它：
 *   这个扫描是**扫全表**的（不是按订单号查）。前面小节故意留下的悬空单
 *   会被下一轮一并取证，于是它们以「本脚本不应查询这笔订单」的形式抛错，
 *   混进 needsHuman / 告警列表里，把真实断言掩盖掉 —— 测试自己制造噪音。
 */
async function clearStaleCandidates(merchantId: bigint, now: Date) {
  await prisma.order.deleteMany({
    where: {
      merchantId,
      status: 'PENDING',
      wxPrepayId: { not: null },
      createdAt: { lt: new Date(now.getTime() - RECONCILE_WINDOW_HOURS * HOUR) },
    },
  })
}

let tempMerchantId: bigint | null = null
const testCodes: string[] = []
const testOrderNos: string[] = []

async function cleanup(merchantId: bigint) {
  await prisma.membershipReminder.deleteMany({ where: { merchantId } })
  await prisma.membership.deleteMany({ where: { merchantId } })
  await prisma.orderSettlement.deleteMany({ where: { merchantId } })
  await prisma.order.deleteMany({ where: { merchantId } })
  await prisma.beanLedger.deleteMany({ where: { merchantId } })
  await prisma.beanAccount.deleteMany({ where: { merchantId } })
  await prisma.store.deleteMany({ where: { merchantId } })
  await prisma.merchant.deleteMany({ where: { id: merchantId } })
}
/** 本脚本造的告警行单独清掉：按测试专用 code 前缀 + 测试订单号两条线索 */
async function cleanupAlerts() {
  await prisma.opsAlert.deleteMany({ where: { code: { startsWith: 'VERIFY_' } } })
  if (testOrderNos.length > 0) {
    await prisma.opsAlert.deleteMany({ where: { refId: { in: testOrderNos } } })
  }
}

let seq = 0
async function mkOrder(
  merchantId: bigint,
  opts: {
    prefix?: 'B' | 'M' | 'A'
    orderType?: 'BEAN' | 'MEMBER'
    refId: bigint
    status?: string
    amountFen?: number
    beans?: bigint
    createdAt?: Date
    paidAt?: Date | null
    /** undefined = 不写（数据库 NULL），表示微信侧根本没有这张单 */
    wxPrepayId?: string | null
  },
) {
  seq += 1
  const orderNo = `${opts.prefix ?? 'B'}VRISK${Date.now().toString().slice(-8)}${String(seq).padStart(2, '0')}`
  await prisma.order.create({
    data: {
      orderNo,
      merchantId,
      orderType: opts.orderType ?? 'BEAN',
      refId: opts.refId,
      amountFen: opts.amountFen ?? 10000,
      originalAmountFen: opts.amountFen ?? 10000,
      memberDiscountApplied: false,
      beans: opts.beans ?? 1000n,
      status: opts.status ?? 'PENDING',
      expireAt: new Date(Date.now() + 15 * 60 * 1000),
      wxPrepayId: opts.wxPrepayId === undefined ? `wx-prepay-${orderNo}` : opts.wxPrepayId,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.paidAt !== undefined ? { paidAt: opts.paidAt } : {}),
    },
  })
  testOrderNos.push(orderNo)
  return orderNo
}
const statusOf = async (orderNo: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { orderNo }, select: { status: true } })).status
const receiptOf = async (orderNo: string) => {
  const o = await prisma.order.findUniqueOrThrow({ where: { orderNo }, select: { id: true } })
  return prisma.orderSettlement.findUnique({ where: { orderId: o.id } })
}

const ok = (amountFen: number, txId = 'WXRISK0001'): WxQueryResult => ({
  tradeState: 'SUCCESS',
  transactionId: txId,
  amountFen,
})
const notpay: WxQueryResult = { tradeState: 'NOTPAY', transactionId: null, amountFen: null }

async function main() {
  const stale = await prisma.merchant.findUnique({ where: { phone: PHONE } })
  if (stale) {
    console.log(`（清理上次残留：商户 ${stale.id}）`)
    await cleanup(stale.id)
  }
  await cleanupAlerts()

  const beanPkg = await prisma.beanPackage.findFirst({ where: { enabled: true }, orderBy: { sort: 'asc' } })
  if (!beanPkg) throw new Error('没有启用的加油包档位，无法造单')
  await devLogin(prisma, PHONE)
  const mid = (await prisma.merchant.findUniqueOrThrow({ where: { phone: PHONE } })).id
  tempMerchantId = mid
  const ref = beanPkg.id

  const NOW = new Date()
  const windowMs = RECONCILE_WINDOW_HOURS * HOUR
  /** 稳在窗口外（默认 48h 窗口 ⇒ 72 小时前必然在窗外） */
  const outside = new Date(NOW.getTime() - Math.max(72, RECONCILE_WINDOW_HOURS + 24) * HOUR)
  /** 稳在窗口内 */
  const inside = new Date(NOW.getTime() - 1 * HOUR)

  console.log(
    `（对账窗口 = ${RECONCILE_WINDOW_HOURS}h；本脚本用「${((NOW.getTime() - outside.getTime()) / HOUR).toFixed(0)}h 前」造窗口外单）`,
  )

  // ── ① 零回执时整体跳过回执核对（防「历史订单全被报成异常」的假警）──────
  console.log('\n════ ① 库里没有任何结算回执 ⇒ 回执核对整体跳过，且**不产生任何告警** ════')
  {
    // 用一个只实现 findFirst 的桩：只走到「零回执」那一层就返回，
    // 这样不必为了造这个状态去删真实数据。
    const emptyStub = {
      orderSettlement: { findFirst: async () => null },
    } as unknown as PrismaClient
    const ac = alertCollector()
    const r = await auditPaidSettlements(emptyStub, { alert: ac.alert })
    check(r.skipped === true, 'skipped = true', String(r.skipped))
    check(!!r.reason, 'reason 说明了为什么跳过', r.reason ?? '（空）')
    check(r.checked === 0 && r.missing === 0, '没有检查任何订单、也没有判缺失')
    check(ac.raised.length === 0, '★ 一条告警都没发（这条防线不能被历史数据刷成噪音）', ac.codes().join(','))
  }

  // ── ② 窗口外 + 微信已支付 + 金额一致 ⇒ 补单 + 回执 + 告警 ──────────
  console.log('\n════ ② 窗口外订单，微信侧确实收了钱 ⇒ 补发权益 + 留下「窗口外才发现」的告警 ════')
  {
    const before = await getBalance(prisma, mid)
    const no = await mkOrder(mid, { refId: ref, amountFen: 10000, beans: 4321n, createdAt: outside })
    const { query, calls } = fakeQuery({ [no]: ok(10000, 'WXRISK_OUTSIDE_1') })
    const ac = alertCollector()

    const r = await scanStalePendingOrders(
      prisma,
      { query, close: closeOk, payMode: () => 'real', alert: ac.alert },
      NOW,
    )
    const after = await getBalance(prisma, mid)
    const receipt = await receiptOf(no)

    check(r.scanned === 1, '取证的正好是那 1 笔窗口外单', `scanned=${r.scanned}`)
    check(r.recovered === 1, 'recovered = 1', `recovered=${r.recovered}`)
    check(r.needsHuman === 0, 'needsHuman = 0', `needsHuman=${r.needsHuman}`)
    check((await statusOf(no)) === 'PAID', '订单已补成 PAID', await statusOf(no))
    check(after.balance - before.balance === 4321n, '★ 积分已补发 +4321', String(after.balance - before.balance))
    check(calls.length === 1, '只查了一次微信', `calls=${calls.length}`)
    check(receipt !== null, '结算回执已写入')
    check(receipt?.source === 'RISK', '回执来源标记为 RISK（事后能看出是风险巡检补的）', String(receipt?.source))
    check(
      ac.codes().includes('PAY_RECOVERED_OUTSIDE_WINDOW'),
      '★★ 报出了「窗口外才发现」的告警（成批出现 ⇒ 有用户在静默期拿不到权益）',
      ac.codes().join(',') || '无告警',
    )
    check(
      ac.codes().includes('PAY_SETTLED_BY_RECONCILE'),
      '同时留下底层「回调丢失、由查单补单」的告警（两条信息互补）',
      ac.codes().join(','),
    )
  }

  // ── ③ 窗口外 + 金额不符 ⇒ 拒绝结算（不能按错金额发权益）────────────
  console.log('\n════ ③ 窗口外订单，微信侧金额与本地不一致 ⇒ 拒绝结算 + CRITICAL 告警 ════')
  {
    const before = await getBalance(prisma, mid)
    const no = await mkOrder(mid, { refId: ref, amountFen: 10000, beans: 99999n, createdAt: outside })
    const { query } = fakeQuery({ [no]: ok(1, 'WXRISK_CHEAP') })
    const ac = alertCollector()

    const r = await scanStalePendingOrders(
      prisma,
      { query, close: closeOk, payMode: () => 'real', alert: ac.alert },
      NOW,
    )
    const after = await getBalance(prisma, mid)
    const mism = ac.raised.find((a) => a.code === 'PAY_AMOUNT_MISMATCH')

    check(r.recovered === 0, '没有被当成「补单成功」', `recovered=${r.recovered}`)
    check((await statusOf(no)) === 'PENDING', '订单保持 PENDING（拒绝按错误金额结算）', await statusOf(no))
    check(after.balance === before.balance, '★ 一分积分都没发', `${before.balance} → ${after.balance}`)
    check(!!mism, '报出了 PAY_AMOUNT_MISMATCH', ac.codes().join(',') || '无告警')
    check(mism?.severity === 'CRITICAL', '级别是 CRITICAL（涉及资金）', String(mism?.severity))
  }

  // ── ④ 窗口外 + 取证抛错 ⇒ 必须人工（★ 本模块存在的理由）────────────
  console.log('\n════ ④ 窗口外订单，向微信取证时抛错 ⇒ needsHuman + CRITICAL「扣款成功但开通失败」告警 ════')
  {
    await clearStaleCandidates(mid, NOW) // ③ 留下的悬空单不该出现在本轮结果里
    const no = await mkOrder(mid, { refId: ref, amountFen: 98000, beans: 98000n, createdAt: outside })
    // 让查单对这个订单号抛错（模拟微信超时 / 验签失败 / 凭据异常）
    const query = async (outTradeNo: string): Promise<WxQueryResult> => {
      if (outTradeNo === no) throw new Error('mock 微信查单超时')
      throw new Error(`本脚本不应查询这笔订单：${outTradeNo}`)
    }
    const ac = alertCollector()

    const r = await scanStalePendingOrders(
      prisma,
      { query, close: closeOk, payMode: () => 'real', alert: ac.alert },
      NOW,
    )
    const a = ac.raised.find((x) => x.code === 'PAY_STALE_SETTLE_FAILED')

    check(r.needsHuman === 1, '★ needsHuman = 1（计入待人工）', `needsHuman=${r.needsHuman}`)
    check((await statusOf(no)) === 'PENDING', '订单仍是 PENDING（没被误判成未支付而关掉）', await statusOf(no))
    check(!!a, '★★ 报出了 PAY_STALE_SETTLE_FAILED', ac.codes().join(',') || '无告警')
    check(a?.severity === 'CRITICAL', '级别是 CRITICAL（钱可能收了、货一定没发）', String(a?.severity))
    check(
      a?.dedupeKey === `PAY_STALE_SETTLE_FAILED:${no}`,
      '去重键按订单区分 —— 每小时巡检一次但只留一条待处理告警',
      String(a?.dedupeKey),
    )
    check(!!a?.detail && a.detail.includes(no), '详情里带了订单号，运维能直接去微信商户平台查')
    check(!!a?.detail && a.detail.includes('不会再被任何自动流程重试'), '详情明确说了「不会再自动重试」')
  }

  // ── ⑤ 窗口外 + 确实没付款 ⇒ 安静收尾，不打扰任何人 ────────────────
  console.log('\n════ ⑤ 窗口外订单，微信侧确认未支付 ⇒ 正常关单收尾，**不产生告警** ════')
  {
    await clearStaleCandidates(mid, NOW) // ④ 留下的失败单不该混进本轮（否则会带出它不是本轮的告警）
    const no = await mkOrder(mid, {
      refId: ref,
      createdAt: outside,
      status: 'PENDING',
    })
    await prisma.order.update({ where: { orderNo: no }, data: { expireAt: new Date(Date.now() - 60_000) } })
    const { query } = fakeQuery({ [no]: notpay })
    const ac = alertCollector()

    const r = await scanStalePendingOrders(
      prisma,
      { query, close: closeOk, payMode: () => 'real', alert: ac.alert },
      NOW,
    )
    check(r.closed === 1, 'closed = 1（预期结局）', `closed=${r.closed}`)
    check((await statusOf(no)) === 'EXPIRED', '订单已置为 EXPIRED', await statusOf(no))
    check(ac.raised.length === 0, '★ 没有告警（正常收尾不该打扰人）', ac.codes().join(',') || '无告警')
  }

  // ── ⑥ 边界：窗口内 / 无微信单 都必须被排除 ────────────────────────
  console.log('\n════ ⑥ 边界：窗口内的单归对账管、没有微信单的不可能收过钱 ⇒ 一律不碰 ════')
  {
    // ★ 扫描是「扫全表」的：先清掉前面小节留下的悬空「窗口外 + 有 prepayId」单，
    //   否则它们会被本轮取证到、以「本脚本不应查询这笔订单」的形式掩盖真实断言。
    //   （同款处理见 verify-pay-reconcile.ts 的 sweeper 一节。）
    await clearStaleCandidates(mid, NOW)

    const inWindow = await mkOrder(mid, { refId: ref, createdAt: inside })
    const noPrepay = await mkOrder(mid, { refId: ref, createdAt: outside, wxPrepayId: null })
    const adminOrder = await mkOrder(mid, { refId: ref, createdAt: outside, prefix: 'A' })
    // 若扫描错误地碰到这三笔中任意一笔，fakeQuery 会抛「本脚本不应查询这笔订单」⇒ 直接暴露
    const { query, calls } = fakeQuery({})
    const r = await scanStalePendingOrders(
      prisma,
      { query, close: closeOk, payMode: () => 'real', alert: alertCollector().alert },
      NOW,
    )
    check(r.scanned === 0, '窗口内 / 无 prepayId / 后台单 都没有被取证', `scanned=${r.scanned}`)
    check(calls.length === 0, '★ 一次微信都没查', `calls=${calls.length}`)
    check((await statusOf(inWindow)) === 'PENDING', '窗口内的单保持原状（归 pay-reconcile 管）')
    check((await statusOf(noPrepay)) === 'PENDING', '无 prepayId 的单不动（微信侧不可能有这张单）')
    check((await statusOf(adminOrder)) === 'PENDING', '后台线下单不动')
  }

  // ── ⑦ 支付未开启 ⇒ 整体跳过，且不查微信 ───────────────────────────
  console.log('\n════ ⑦ 支付未开启 / 演示模式 ⇒ 整体跳过，不发任何外网请求 ════')
  {
    const { query, calls } = fakeQuery({})
    const r = await scanStalePendingOrders(prisma, { query, payMode: () => 'disabled' }, NOW)
    check(r.skipped === true, 'skipped = true', String(r.skipped))
    check(calls.length === 0, '一次微信都没查', `calls=${calls.length}`)

    const demo = await scanPaymentRisks(prisma, { query, payMode: () => 'demo' }, NOW)
    check(demo.skipped === true, '总入口在演示模式下也整体跳过')
    check(demo.stale.scanned === 0 && demo.audit.checked === 0, '总入口两个部分都没有动作')
  }

  // ── ⑧ 回执核对的自动起点（防假警的关键）──────────────────────────
  console.log('\n════ ⑧ 回执核对：起点自动取最早一条回执 ⇒ 回执体系上线前的历史单不被误报 ════')
  {
    // 此刻库里已有 ② 写下的回执（createdAt ≈ 现在），所以：
    //   · 1 小时前支付完的单 → 早于起点 → 应被跳过
    //   · 稍稍晚于此刻支付完的单 → 晚于起点 → 应被检查，且因为没写回执而被判缺失
    const historical = await mkOrder(mid, {
      refId: ref,
      status: 'PAID',
      paidAt: new Date(NOW.getTime() - 1 * HOUR),
      createdAt: outside,
    })
    const fresh = await mkOrder(mid, {
      refId: ref,
      status: 'PAID',
      paidAt: new Date(Date.now() + 5000),
      createdAt: inside,
    })
    const ac = alertCollector()
    const r = await auditPaidSettlements(prisma, { alert: ac.alert }, NOW)

    check(r.skipped === false, '有回执之后不再整体跳过', String(r.skipped))
    check(r.checked >= 1, `检查了至少 1 张已支付单（实际 ${r.checked}）`, `checked=${r.checked}`)
    // ★ 用「订单号是否在缺失集合里」断言，而不是用总数：
    //   本地库里可能有其他会话/其他脚本留下的已支付单，用 `missing === 1` 会随环境波动。
    check(r.missingNos.includes(fresh), '★ 认出「已 PAID 但没有回执」的那张单', r.missingNos.join(',') || '（空）')
    check(
      ac.codes().includes('PAY_PAID_WITHOUT_RECEIPT'),
      '报出了 PAY_PAID_WITHOUT_RECEIPT（「PAID ⇒ 权益已发」这条不变量被破坏）',
      ac.codes().join(',') || '无告警',
    )
    check(
      !r.missingNos.includes(historical),
      '★★ 起点之前的历史单没有被误报（否则第一次上线就会刷出一批假警，这道防线会被关掉）',
      r.missingNos.join(','),
    )
    check(
      !ac.raised.some((a) => a.refId === historical),
      '告警里也没有出现那张历史单',
      ac.raised.map((a) => a.refId).join(','),
    )
    check((await receiptOf(fresh)) === null, '（确认那张单确实没有回执 —— 断言的前提成立）')
  }

  // ── ⑨ 告警出口：落库 / 去重 / ack 后复发 / 推送失败 ────────────────
  console.log('\n════ ⑨ 告警出口本身：去重合并、ack 后复发重新提醒、推送失败不影响落库 ════')
  {
    __resetOpsAlertThrottle() // 清掉进程内推送限流窗口，让本节的断言不受前面用例影响
    const code = `VERIFY_ALERT_${Date.now()}`
    testCodes.push(code)
    const pushed: string[] = []
    const pushOk = async (content: string) => {
      pushed.push(content)
      return { ok: true, note: 'mock HTTP 200' }
    }

    const first = await raiseOpsAlert(
      prisma,
      { code, severity: 'CRITICAL', title: '测试告警 A', detail: '第一次', dedupeKey: code },
      { push: pushOk },
    )
    check(first.persisted && first.merged === false, '首次触发：新建一行', JSON.stringify(first.merged))
    check(first.pushStatus === 'SENT', '推送成功', first.pushStatus)
    check(pushed.length === 1, '推送了 1 次', `pushed=${pushed.length}`)
    check(pushed[0]!.includes('测试告警 A'), '推送正文里带了标题')

    // 同键再触发一次 ⇒ 合并，不新增行、不重复推送
    const second = await raiseOpsAlert(
      prisma,
      { code, severity: 'CRITICAL', title: '测试告警 A', detail: '第二次', dedupeKey: code },
      { push: pushOk },
    )
    const row = await prisma.opsAlert.findUniqueOrThrow({ where: { id: first.id! } })
    check(second.merged === true, '★ 同键第二次触发被合并（不新增行）', String(second.merged))
    check(row.occurrences === 2, 'occurrences 累加到 2', String(row.occurrences))
    check(pushed.length === 1, '★ 没有重复推送（否则运营两小时后就再也不看告警了）', `pushed=${pushed.length}`)
    check(row.detail === '第二次', '★ detail 刷新为最近一次的原因（不是永远停在第一次）', String(row.detail))

    // ack 之后同键再现 ⇒ 新开一条（问题复发必须重新提醒）
    await ackOpsAlert(prisma, first.id!, 1n, '已处理')
    const third = await raiseOpsAlert(
      prisma,
      { code, severity: 'CRITICAL', title: '测试告警 A', detail: '复发', dedupeKey: code },
      { push: pushOk },
    )
    check(third.id !== first.id, '★ ack 后复发 ⇒ 新开一条（不并进已处理的那条）', `${first.id} vs ${third.id}`)

    // 推送失败 ⇒ 落库照样成功，只是标记 FAILED
    const failCode = `VERIFY_ALERT_FAIL_${Date.now()}`
    testCodes.push(failCode)
    const failPush = async () => ({ ok: false, note: 'mock 连接被拒' })
    const failedRow = await raiseOpsAlert(
      prisma,
      { code: failCode, title: '推送必然失败', dedupeKey: failCode },
      { push: failPush },
    )
    const failedDb = await prisma.opsAlert.findUniqueOrThrow({ where: { id: failedRow.id! } })
    check(failedRow.persisted === true, '★ 推送失败仍然落库成功（推送只是触达手段）', String(failedRow.persisted))
    check(failedRow.pushStatus === 'FAILED', 'push_status = FAILED', failedRow.pushStatus)
    check(!!failedDb.pushError && failedDb.pushError.includes('连接被拒'), 'push_error 记下了失败原因')

    // 每分钟推送限流：超过上限的只落库
    const limited = await raiseOpsAlert(
      prisma,
      { code: failCode, title: '限流测试', dedupeKey: `${failCode}:limit` },
      { push: pushOk, maxPushPerMinute: 0 },
    )
    check(limited.persisted === true, '限流时仍然落库', String(limited.persisted))
    check(limited.pushStatus === 'SKIPPED', '★ 超过每分钟上限 ⇒ 只落库不推送（防机器人被停用）', limited.pushStatus)

    // 告警存储整体不可用 ⇒ 绝不向上抛错
    const brokenPrisma = {
      opsAlert: {
        findFirst: async () => {
          throw new Error('mock DB down')
        },
      },
    } as unknown as PrismaClient
    let threw = false
    const broken = await raiseOpsAlert(brokenPrisma, { code: 'VERIFY_BROKEN', title: '库挂了' }).catch(() => {
      threw = true
      return null
    })
    check(!threw, '★★ 告警落库失败也没有抛错（绝不能因为告警把支付主流程带崩）', String(threw))
    check(broken?.persisted === false, '返回值如实标出 persisted = false', String(broken?.persisted))
  }

  // ── ⑩ 后台查询与处理 ─────────────────────────────────────────────
  console.log('\n════ ⑩ 后台：未处理列表 / 已处理过滤 / 重复 ack 被拒 ════')
  {
    const code = `VERIFY_LIST_${Date.now()}`
    testCodes.push(code)
    const r1 = await raiseOpsAlert(prisma, { code, title: '列表测试', dedupeKey: code })
    const open = await listOpsAlerts(prisma, { status: 'OPEN', code })
    check(open.items.length === 1, 'OPEN 过滤能查到它', `len=${open.items.length}`)
    check(open.openCount >= 1, 'openCount 统计了未处理总数', `openCount=${open.openCount}`)
    check(open.items[0]!.severity === 'WARN', '缺省级别是 WARN', open.items[0]!.severity)

    await ackOpsAlert(prisma, r1.id!, 42n, '测试处理')
    const openAfter = await listOpsAlerts(prisma, { status: 'OPEN', code })
    const acked = await listOpsAlerts(prisma, { status: 'ACKED', code })
    check(openAfter.items.length === 0, 'ack 后不再出现在 OPEN 列表')
    check(acked.items.length === 1, '出现在 ACKED 列表', `len=${acked.items.length}`)
    check(acked.items[0]!.ackedBy === '42', '记录了处理人', String(acked.items[0]!.ackedBy))
    check(acked.items[0]!.ackNote === '测试处理', '记录了处理备注', String(acked.items[0]!.ackNote))

    let rejected = false
    try {
      await ackOpsAlert(prisma, r1.id!, 43n)
    } catch (e) {
      rejected = e instanceof OpsAlertNotFoundError
    }
    check(rejected, '★ 重复 ack 被拒（不覆盖首次处理人与备注）', String(rejected))
  }

  // ── ⑪ 总入口：两部分互相独立，一个炸不影响另一个 ───────────────────
  console.log('\n════ ⑪ 总入口：即使取证整体炸了，回执核对仍照常完成 ════')
  {
    // 造一笔窗口外待核对单，让「查单全面不可用」有东西可以失败
    await clearStaleCandidates(mid, NOW)
    const no = await mkOrder(mid, { refId: ref, amountFen: 6600, createdAt: outside })
    const boomQuery = async (outTradeNo: string): Promise<WxQueryResult> => {
      if (outTradeNo === no) throw new Error('mock 查单全面不可用')
      throw new Error(`本脚本不应查询这笔订单：${outTradeNo}`)
    }
    const ac = alertCollector()
    const r = await scanPaymentRisks(
      prisma,
      { query: boomQuery, close: closeOk, payMode: () => 'real', alert: ac.alert },
      NOW,
    )
    check(r.skipped === false, '总入口没有整体跳过', String(r.skipped))
    check(typeof r.audit.checked === 'number', '★ 回执核对仍然跑完了（两部分独立）', `checked=${r.audit.checked}`)
    check(r.stale.needsHumanNos.includes(no), '★ 取证失败的窗口外单被计入 needsHuman', r.stale.needsHumanNos.join(',') || '（空）')
    check(
      ac.codes().includes('PAY_STALE_SETTLE_FAILED'),
      '并留下了必须人工处理的 CRITICAL 告警',
      ac.codes().join(',') || '无告警',
    )
  }
}

async function teardown() {
  console.log('\n（清理临时数据…）')
  await cleanupAlerts()
  if (tempMerchantId !== null) await cleanup(tempMerchantId)
}

main()
  .then(async () => {
    await teardown()
    console.log(`\n★ ${failed === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${failed} 失败\n`)
    await prisma.$disconnect()
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch(async (e) => {
    console.error('\n脚本异常：', e)
    await teardown().catch((x) => console.error('清理失败，请手动删除临时数据：', (x as Error).message))
    await prisma.$disconnect()
    process.exit(1)
  })
