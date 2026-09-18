/**
 * 验证「支付回调兜底通道」：主动查单 / 对账 sweeper / 后台补单 三条通道都真的能补回权益，
 * 且**都不会重复发放**。
 *
 * 为什么必须有这个脚本：
 *   微信的异步回调不是可靠通道。notify_url 不可达（本项目卡在备案上）、网络抖动、
 *   微信重试次数耗尽 —— 任何一种都会让回调**静默丢失**：用户钱付了、微信侧
 *   `trade_state=SUCCESS`，而我们本地订单永远停在 PENDING。**没有报错、没有告警**，
 *   只有用户投诉「付了钱没到账」。这一整条兜底链路（查单 → 金额校验 → 结算）
 *   任何一个环节写错都只会表现为「偶尔有用户拿不到权益」，线上极难复现。
 *
 * 本脚本**完全不联网、不碰真凭据**：查单函数是注入的（ReconcileDeps.query），
 * 所以能确定性地覆盖 SUCCESS / 金额不一致 / NOTPAY / CLOSED / NOT_EXIST 全部分支。
 *
 * 用法：npm run pay-reconcile:verify
 * 只用一个临时手机号造商户，跑完硬删；不动任何真实商户数据。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { devLogin } from '../src/auth/auth.service.js'
import { queryAndSettle, scanPendingOrders } from '../src/services/pay-reconcile.service.js'
import { getBalance } from '../src/bean/bean.service.js'
import type { WxQueryResult } from '../src/lib/wxpay.js'

const prisma = new PrismaClient()
const PHONE = '13900009998' // 与 membership:verify(…9999) 区分开，避免并行跑互相踩
const DAY = 24 * 60 * 60 * 1000

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

/** 注入用的假查单：按订单号给结果，并记录「到底查了哪几笔」 */
function fakeQuery(byOrder: Record<string, WxQueryResult>) {
  const calls: string[] = []
  const query = async (outTradeNo: string): Promise<WxQueryResult> => {
    calls.push(outTradeNo)
    const r = byOrder[outTradeNo]
    if (!r) throw new Error(`本脚本不应查询这笔订单：${outTradeNo}`)
    return r
  }
  return { query, calls }
}
/** 记录「到底关了哪几笔」的假关单桩 */
function fakeClose(result: { ok: boolean; note: string }) {
  const calls: string[] = []
  const close = async (outTradeNo: string) => {
    calls.push(outTradeNo)
    return result
  }
  return { close, calls }
}

/**
 * 真支付模式 + **默认关单成功**。
 * ★ 关单桩必须内建在这里：过期单会先关微信侧再置本地状态，
 *   任何裸 `...REAL` 的调用点若没带 close，就会用真 closeOrder 去打微信。
 */
const REAL = {
  payMode: () => 'real' as const,
  close: (async () => ({ ok: true, note: 'SUCCESS' })) as (outTradeNo: string) => Promise<{ ok: boolean; note: string }>,
}

async function cleanup(merchantId: bigint) {
  // 顺序受外键约束：membership 依赖 package/merchant
  await prisma.membershipReminder.deleteMany({ where: { merchantId } })
  await prisma.membership.deleteMany({ where: { merchantId } })
  await prisma.order.deleteMany({ where: { merchantId } })
  await prisma.beanLedger.deleteMany({ where: { merchantId } })
  await prisma.beanAccount.deleteMany({ where: { merchantId } })
  await prisma.store.deleteMany({ where: { merchantId } })
  await prisma.merchant.deleteMany({ where: { id: merchantId } })
}

let seq = 0
/** 造一张订单（直连 prisma，绕开需要微信 openid 的下单流程） */
async function mkOrder(
  merchantId: bigint,
  opts: {
    prefix: 'B' | 'M' | 'A'
    refId: bigint
    orderType: 'BEAN' | 'MEMBER'
    status?: string
    amountFen?: number
    expireAt?: Date
    createdAt?: Date
    beans?: bigint
  },
) {
  seq += 1
  const orderNo = `${opts.prefix}VERIFY${Date.now().toString().slice(-8)}${String(seq).padStart(2, '0')}`
  await prisma.order.create({
    data: {
      orderNo,
      merchantId,
      orderType: opts.orderType,
      refId: opts.refId,
      amountFen: opts.amountFen ?? 10000,
      originalAmountFen: opts.amountFen ?? 10000,
      memberDiscountApplied: false,
      beans: opts.beans ?? 1000n,
      status: opts.status ?? 'PENDING',
      expireAt: opts.expireAt ?? new Date(Date.now() + 15 * 60 * 1000),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  })
  return orderNo
}
const statusOf = async (orderNo: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { orderNo }, select: { status: true, paidAt: true, wxTransactionId: true } }))

const ok = (amountFen: number, txId = 'WXVERIFY0001'): WxQueryResult => ({
  tradeState: 'SUCCESS', transactionId: txId, amountFen,
})
const notpay: WxQueryResult = { tradeState: 'NOTPAY', transactionId: null, amountFen: null }
const closed: WxQueryResult = { tradeState: 'CLOSED', transactionId: null, amountFen: null }
const notExist: WxQueryResult = { tradeState: 'NOT_EXIST', transactionId: null, amountFen: null, wxCode: 'ORDER_NOT_EXIST' }

async function main() {
  const stale = await prisma.merchant.findUnique({ where: { phone: PHONE } })
  if (stale) {
    console.log(`（清理上次残留：商户 ${stale.id}）`)
    await cleanup(stale.id)
  }

  const beanPkg = await prisma.beanPackage.findFirst({ where: { enabled: true }, orderBy: { sort: 'asc' } })
  if (!beanPkg) throw new Error('没有启用的加油包档位，无法造单')
  await devLogin(prisma, PHONE)
  const mid = (await prisma.merchant.findUniqueOrThrow({ where: { phone: PHONE } })).id
  tempMerchantId = mid // 交给 teardown —— 断言中途失败也保证不留下临时数据
  const beanRef = beanPkg.id

  // ── ① 本地已 PAID ⇒ 不查微信 ────────────────────────────────────
  console.log('\n════ ① 本地已是已支付 ⇒ 直接返回，不查微信（省一次外网调用）════')
  {
    const no = await mkOrder(mid, { prefix: 'B', refId: beanRef, orderType: 'BEAN', status: 'PAID' })
    const { query, calls } = fakeQuery({})
    const r = await queryAndSettle(prisma, no, { query, ...REAL })
    check(r.outcome === 'ALREADY_PAID', 'outcome = ALREADY_PAID', r.outcome)
    check(calls.length === 0, '完全没有调用微信查单', `calls=${calls.length}`)
  }

  // ── ② SUCCESS + 金额一致 ⇒ 补发权益，且幂等 ──────────────────────
  console.log('\n════ ② 微信侧 SUCCESS + 金额一致 ⇒ 结算（这就是「回调丢了」的补救）════')
  {
    const before = await getBalance(prisma, mid)
    const no = await mkOrder(mid, { prefix: 'B', refId: beanRef, orderType: 'BEAN', amountFen: 10000, beans: 1234n })
    const { query, calls } = fakeQuery({ [no]: ok(10000, 'WXVERIFY_TX_1') })
    const r = await queryAndSettle(prisma, no, { query, ...REAL })
    const st = await statusOf(no)
    const after = await getBalance(prisma, mid)

    check(r.outcome === 'SETTLED', 'outcome = SETTLED', r.outcome)
    check(st.status === 'PAID', '本地订单已变 PAID', st.status)
    check(st.paidAt !== null, 'paidAt 已写入')
    check(st.wxTransactionId === 'WXVERIFY_TX_1', '微信交易号已落库', String(st.wxTransactionId))
    check(after.balance - before.balance === 1234n, '积分已到账 +1234', String(after.balance - before.balance))
    check(calls.length === 1, '只查了一次微信', `calls=${calls.length}`)

    // 幂等：再来一次（模拟「用户端查单」与「对账 sweeper」同时命中）
    const again = await queryAndSettle(prisma, no, { query, ...REAL })
    const after2 = await getBalance(prisma, mid)
    check(again.outcome === 'ALREADY_PAID', '重复查单 → ALREADY_PAID（终态 CAS 生效）', again.outcome)
    check(after2.balance === after.balance, '★ 积分没有被重复发放', `${after.balance} → ${after2.balance}`)
    check(calls.length === 1, '重复调用没有再查微信', `calls=${calls.length}`)
  }

  // ── ③ SUCCESS 但金额不一致 ⇒ 拒绝结算 ───────────────────────────
  console.log('\n════ ③ 微信侧 SUCCESS 但金额与本地不一致 ⇒ 拒绝自动结算（防「改金额白拿权益」）════')
  {
    const before = await getBalance(prisma, mid)
    const no = await mkOrder(mid, { prefix: 'M', refId: beanRef, orderType: 'BEAN', amountFen: 10000, beans: 98000n })
    const { query } = fakeQuery({ [no]: ok(1, 'WXVERIFY_TX_CHEAP') }) // 微信侧只付了 1 分
    const r = await queryAndSettle(prisma, no, { query, ...REAL })
    const st = await statusOf(no)
    const after = await getBalance(prisma, mid)

    check(r.outcome === 'NOT_PAID', 'outcome = NOT_PAID（拒结算）', r.outcome)
    check(/金额/.test(r.message), 'message 明确说明是金额不一致', r.message)
    check(st.status === 'PENDING', '订单保持 PENDING，未被误结算', st.status)
    check(after.balance === before.balance, '★ 一分积分都没发', `${before.balance} → ${after.balance}`)
  }

  // ── ④ 未支付 / 支付中 ───────────────────────────────────────────
  console.log('\n════ ④ 微信侧未支付 ════')
  {
    const noFresh = await mkOrder(mid, { prefix: 'B', refId: beanRef, orderType: 'BEAN' })
    const noExpired = await mkOrder(mid, {
      prefix: 'B', refId: beanRef, orderType: 'BEAN', expireAt: new Date(Date.now() - 60_000),
    })
    const { query } = fakeQuery({ [noFresh]: notpay, [noExpired]: notpay })
    const fc = fakeClose({ ok: true, note: 'SUCCESS' })

    const rFresh = await queryAndSettle(prisma, noFresh, { query, ...REAL, close: fc.close })
    check(rFresh.outcome === 'NOT_PAID', '未过期 → NOT_PAID', rFresh.outcome)
    check((await statusOf(noFresh)).status === 'PENDING', '未过期订单保持 PENDING（用户还可能去付）')

    const rExpired = await queryAndSettle(prisma, noExpired, { query, ...REAL, close: fc.close })
    check(rExpired.outcome === 'CLOSED', '已过期 → CLOSED', rExpired.outcome)
    check((await statusOf(noExpired)).status === 'EXPIRED', '已过期订单置为 EXPIRED', rExpired.status)
    check(
      fc.calls.length === 1 && fc.calls[0] === noExpired,
      '★ 只为「已过期且未支付」那一笔调了微信关单',
      `calls=[${fc.calls.join(',')}]`,
    )
  }

  // ── ⑤ 关闭 / 撤销类状态 ────────────────────────────────────────
  console.log('\n════ ⑤ 微信侧已关闭 ⇒ 本地一并置终态 ════')
  {
    const no = await mkOrder(mid, { prefix: 'B', refId: beanRef, orderType: 'BEAN' })
    const { query } = fakeQuery({ [no]: closed })
    const r = await queryAndSettle(prisma, no, { query, ...REAL })
    check(r.outcome === 'CLOSED', 'outcome = CLOSED', r.outcome)
    check((await statusOf(no)).status === 'CANCELLED', '未过期 → CANCELLED（前端据此提示「订单未完成」）', r.status)
  }

  // ── ⑥ 查无此单 ────────────────────────────────────────────────
  console.log('\n════ ⑥ 微信侧查无此单（预下单没成功 / 超期）════')
  {
    const noFresh = await mkOrder(mid, { prefix: 'B', refId: beanRef, orderType: 'BEAN' })
    const noExpired = await mkOrder(mid, {
      prefix: 'B', refId: beanRef, orderType: 'BEAN', expireAt: new Date(Date.now() - 60_000),
    })
    const { query } = fakeQuery({ [noFresh]: notExist, [noExpired]: notExist })
    const rFresh = await queryAndSettle(prisma, noFresh, { query, ...REAL })
    check(rFresh.outcome === 'NOT_EXIST', '未过期 → NOT_EXIST', rFresh.outcome)
    check((await statusOf(noFresh)).status === 'PENDING', '未过期不关单（可能只是刚下单还没落库）')
    const rExpired = await queryAndSettle(prisma, noExpired, { query, ...REAL })
    check((await statusOf(noExpired)).status === 'EXPIRED', '已过期则关掉，不留悬空 PENDING', rExpired.status)
  }

  // ── ⑦ 不该查的单 ──────────────────────────────────────────────
  console.log('\n════ ⑦ 不该查的单：后台线下单 / 支付未开启 ════')
  {
    const adminNo = await mkOrder(mid, { prefix: 'A', refId: beanRef, orderType: 'BEAN' })
    const { query, calls } = fakeQuery({})
    const r = await queryAndSettle(prisma, adminNo, { query, ...REAL })
    check(r.outcome === 'SKIPPED', '后台单（A 前缀）→ SKIPPED', r.outcome)
    check(calls.length === 0, '后台单不去查微信（微信侧根本没有这笔）', `calls=${calls.length}`)

    const no = await mkOrder(mid, { prefix: 'B', refId: beanRef, orderType: 'BEAN' })
    const rDemo = await queryAndSettle(prisma, no, { query, payMode: () => 'demo' })
    check(rDemo.outcome === 'SKIPPED', '演示模式 → SKIPPED', rDemo.outcome)
    check(calls.length === 0, '演示模式不查微信（避免拿到误导性的 NOT_EXIST）', `calls=${calls.length}`)
    const rOff = await queryAndSettle(prisma, no, { query, payMode: () => 'disabled' })
    check(rOff.outcome === 'SKIPPED', '支付未开启 → SKIPPED', rOff.outcome)
  }

  // ── ⑧ 越权 ────────────────────────────────────────────────────
  console.log('\n════ ⑧ 越权：拿别人的订单号查单 ════')
  {
    const no = await mkOrder(mid, { prefix: 'B', refId: beanRef, orderType: 'BEAN' })
    const { query } = fakeQuery({ [no]: ok(10000) })
    const r = await queryAndSettle(prisma, no, { query, ...REAL, merchantId: mid + 999999n })
    check(r.status === 'NOT_FOUND', '非本商户 → NOT_FOUND（用户端接口必须带 merchantId）', r.status)
    check((await statusOf(no)).status === 'PENDING', '订单未被结算', (await statusOf(no)).status)
  }

  // ── ⑩ 关单失败 ⇒ 绝不置 EXPIRED ────────────────────────────────
  console.log('\n════ ⑩ 关单失败 ⇒ 绝不置为 EXPIRED（否则留下「本地已关、微信可付」的不可恢复状态）════')
  {
    const no = await mkOrder(mid, {
      prefix: 'B', refId: beanRef, orderType: 'BEAN', expireAt: new Date(Date.now() - 60_000),
    })
    const { query } = fakeQuery({ [no]: notpay })
    const failClose = fakeClose({ ok: false, note: 'WX_PAY_PRIVATE_KEY not set' })

    const r = await queryAndSettle(prisma, no, { query, ...REAL, close: failClose.close })
    check(r.outcome === 'NOT_PAID', '关单失败 → NOT_PAID（不是 CLOSED）', r.outcome)
    check(
      (await statusOf(no)).status === 'PENDING',
      '★ 订单保持 PENDING，未被置为 EXPIRED',
      (await statusOf(no)).status,
    )
    check(failClose.calls.length === 1, '确实尝试过微信关单', `calls=${failClose.calls.length}`)

    // 下一轮：关单恢复正常 ⇒ 这时才允许置过期（证明「保持 PENDING 等重试」是有效的）
    const okClose = fakeClose({ ok: true, note: 'SUCCESS' })
    const r2 = await queryAndSettle(prisma, no, { query, ...REAL, close: okClose.close })
    check(r2.outcome === 'CLOSED', '下一轮关单成功 → CLOSED', r2.outcome)
    check((await statusOf(no)).status === 'EXPIRED', '此时才置为 EXPIRED', r2.status)
    check(okClose.calls.length === 1, '下一轮确实重试了关单', `calls=${okClose.calls.length}`)
  }

  // ── ⑨ sweeper：窗口内才查、且不重复补 ──────────────────────────
  console.log('\n════ ⑨ 对账 sweeper：只扫窗口内的单，且重复扫描不重复补发 ════')
  {
    // sweeper 是「扫全表」的：先把前面几节特意造出来的悬空 PENDING 清掉，
    // 否则它们会以「查单失败」的形式混进结果，掩盖真实断言。
    await prisma.order.deleteMany({ where: { merchantId: mid, status: 'PENDING' } })
    const inA = await mkOrder(mid, { prefix: 'B', refId: beanRef, orderType: 'BEAN', amountFen: 10000, beans: 77n })
    const inB = await mkOrder(mid, { prefix: 'B', refId: beanRef, orderType: 'BEAN' })
    // 72 小时前创建：超出 48h 窗口，sweeper 不该碰它
    const old = await mkOrder(mid, {
      prefix: 'B', refId: beanRef, orderType: 'BEAN', amountFen: 10000, beans: 55n,
      createdAt: new Date(Date.now() - 72 * 3600 * 1000),
    })
    const { query, calls } = fakeQuery({ [inA]: ok(10000, 'WXVERIFY_SWEEP'), [inB]: notpay, [old]: ok(10000) })
    const before = await getBalance(prisma, mid)

    const r1 = await scanPendingOrders(prisma, { query, ...REAL })
    check((await statusOf(inA)).status === 'PAID', '窗口内已支付的单被补回', (await statusOf(inA)).status)
    check((await statusOf(inB)).status === 'PENDING', '窗口内未支付的单不动', (await statusOf(inB)).status)
    check((await statusOf(old)).status === 'PENDING', '★ 窗口外的单不被扫描（不反复打扰微信）', (await statusOf(old)).status)
    check(!calls.includes(old), '确实没有查窗口外那笔', calls.join(',').slice(0, 80))
    check(r1.scanned >= 2, '本次扫描到至少 2 笔', `scanned=${r1.scanned}`)

    const after1 = await getBalance(prisma, mid)
    check(after1.balance - before.balance === 77n, '只补发了窗口内那一笔的 77 分', String(after1.balance - before.balance))

    // 再跑一轮：已 PAID 的不应再查、更不能再发积分
    const callsBefore = calls.length
    const r2 = await scanPendingOrders(prisma, { query, ...REAL })
    const after2 = await getBalance(prisma, mid)
    check(after2.balance === after1.balance, '★ 第二轮扫描没有再发一次积分', `${after1.balance} → ${after2.balance}`)
    check(!calls.slice(callsBefore).includes(inA), '已结算的单不再被查', `新增查询=${calls.length - callsBefore}`)
    check(r2.settled === 0, '第二轮 settled = 0', String(r2.settled))
  }
}

/** 临时商户 id：一旦建出来就登记，保证断言中途抛错也会被清掉 */
let tempMerchantId: bigint | null = null

async function teardown() {
  if (tempMerchantId === null) return
  console.log('\n（清理临时商户…）')
  await cleanup(tempMerchantId)
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
    await teardown().catch((x) => console.error('清理临时商户失败，请手动删除：', (x as Error).message))
    await prisma.$disconnect()
    process.exit(1)
  })
