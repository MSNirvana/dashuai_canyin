/**
 * 验证「注册不赠豆 + 必须买会员才能用 AI」这条商业策略在账务与闸门上真的成立。
 *
 * 背景（2026-09-15 起）：产品决定取消新用户免费赠送，注册后必须购买 ¥980 会员
 * 才能使用 AI 生成与出片；支付通道未开放期间由后台手动开通会员。
 * 这条策略横跨**三处**互不相邻的实现，任何一处走偏都不会报错、只会静默错账：
 *   1. `auth.service.ts::grantRegisterBeanIfNeeded` —— 赠豆 = 0 时必须仍然置
 *      `registerGrantGranted`，否则每次登录都跑一遍事务
 *   2. `subscription.service.ts::requireSubscription` —— 真正的闸门
 *   3. `order.service.ts::adminActivateMembership` —— 后台开会员必须走**会员桶**，
 *      而不是随手调 `adjust()`（那个进的是 GRANT 桶，语义与到期清零都不同）
 *
 * 用法：npm run membership:verify
 * 只使用一个临时手机号，跑完硬删；不动任何真实商户数据。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { devLogin } from '../src/auth/auth.service.js'
import { adminActivateMembership, activeMembership } from '../src/services/order.service.js'
import { requireSubscription, SubscriptionRequiredError } from '../src/services/subscription.service.js'
import { getBalance, expireGrant } from '../src/bean/bean.service.js'

const prisma = new PrismaClient()
const PHONE = '13900009999'
const ADMIN_ID = 1n
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
const days = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY)

async function cleanup(merchantId: bigint) {
  // 顺序受外键约束：membership 依赖 package/merchant，reminder 依赖 membership
  await prisma.membershipReminder.deleteMany({ where: { merchantId } })
  await prisma.membership.deleteMany({ where: { merchantId } })
  await prisma.order.deleteMany({ where: { merchantId } })
  await prisma.beanLedger.deleteMany({ where: { merchantId } })
  await prisma.beanAccount.deleteMany({ where: { merchantId } })
  await prisma.store.deleteMany({ where: { merchantId } })
  await prisma.merchant.deleteMany({ where: { id: merchantId } })
}

async function main() {
  // 先清掉上一次跑残留（幂等重跑）
  const stale = await prisma.merchant.findUnique({ where: { phone: PHONE } })
  if (stale) {
    console.log(`（清理上次残留：商户 ${stale.id}）`)
    await cleanup(stale.id)
  }

  const grantRow = await prisma.systemSetting.findUnique({
    where: { groupKey_settingKey: { groupKey: 'bean', settingKey: 'register_grant_points' } },
  })
  const grantCfg = Number(grantRow?.settingVal ?? 30)
  const subGrant = await prisma.systemSetting.findUnique({
    where: { groupKey_settingKey: { groupKey: 'subscription', settingKey: 'grant_points' } },
  })
  const subDuration = await prisma.systemSetting.findUnique({
    where: { groupKey_settingKey: { groupKey: 'subscription', settingKey: 'duration_days' } },
  })
  const wantGrant = BigInt(grantCfg)

  console.log(`\n配置：bean.register_grant_points = ${grantCfg}（策略${grantCfg === 0 ? '：注册不赠豆' : '：注册赠豆'}）`)
  console.log(`      subscription.grant_points = ${subGrant?.settingVal} / duration_days = ${subDuration?.settingVal}`)

  // ── 节 ①：新用户注册 ──────────────────────────────────────────────
  console.log('\n════ ① 新用户注册（赠豆配置生效）════')
  await devLogin(prisma, PHONE)
  const m1 = await prisma.merchant.findUniqueOrThrow({ where: { phone: PHONE } })
  const mid = m1.id

  check(m1.registerGrantGranted, '注册后 registerGrantGranted = true（0 豆也要置位，否则每次登录重复跑事务）')
  const bal1 = await getBalance(prisma, mid)
  check(
    bal1.grantRegisterBalance === wantGrant && bal1.grantMembershipBalance === 0n,
    `注册赠豆进**注册桶** = ${wantGrant}，会员桶 = 0`,
    `实际 注册桶=${bal1.grantRegisterBalance} 会员桶=${bal1.grantMembershipBalance}`,
  )
  check(bal1.available === wantGrant, `可用积分 = ${wantGrant}`, `实际 ${bal1.available}`)
  const regLedger = await prisma.beanLedger.count({ where: { merchantId: mid, bizType: 'REGISTER' } })
  check(
    grantCfg === 0 ? regLedger === 0 : regLedger === 1,
    grantCfg === 0 ? '赠豆 = 0 时不写任何 REGISTER 流水（不留 0 元账）' : '赠豆 > 0 时写 1 条 REGISTER 流水',
    `实际 ${regLedger} 条`,
  )

  // 重复登录：不应有任何变化（幂等）
  await devLogin(prisma, PHONE)
  const regLedger2 = await prisma.beanLedger.count({ where: { merchantId: mid, bizType: 'REGISTER' } })
  const bal2 = await getBalance(prisma, mid)
  check(
    regLedger2 === regLedger && bal2.grantRegisterBalance === bal1.grantRegisterBalance,
    '重复登录不会重复发放（幂等）',
    `流水 ${regLedger} → ${regLedger2}`,
  )

  // ── 节 ②：闸门 ────────────────────────────────────────────────────
  console.log('\n════ ② 未订阅时的闸门（文案 / 分镜 / 合成 三处同一个入口）════')
  const before = await activeMembership(prisma, mid)
  check(before === null, '新用户没有有效会员')
  let threw = false
  try {
    await requireSubscription(prisma, mid, '文案生成')
  } catch (e) {
    threw = e instanceof SubscriptionRequiredError
  }
  check(threw, 'requireSubscription 抛出 SubscriptionRequiredError（路由层映射 403 + 2005）')

  // ── 节 ③：后台手动开通会员 ────────────────────────────────────────
  console.log('\n════ ③ 后台手动开通会员（走支付回调的同一条结算链）════')
  const r1 = await adminActivateMembership(prisma, mid, ADMIN_ID, '端到端验证（线下转账 980）')
  check(!r1.renewed, '首次开通 renewed = false')
  check(days(new Date(), new Date(r1.endAt)) === Number(subDuration?.settingVal ?? 30), `到期时间 = 现在 + ${subDuration?.settingVal} 天`)

  const order1 = await prisma.order.findUniqueOrThrow({ where: { orderNo: r1.orderNo } })
  check(order1.orderType === 'MEMBER', '生成 MEMBER 订单留痕')
  check(order1.amountFen === 0, '订单金额 = 0（线下收款，不走微信支付）')
  check(order1.status === 'PAID', '订单直接终态 PAID')
  check(order1.orderNo.startsWith('A'), '单号前缀 A = 后台单，与线上充值 B / 线上会员 M 可区分')
  check(order1.wxTransactionId === null, '无微信交易号（未经过支付）')

  const ms1 = await activeMembership(prisma, mid)
  check(!!ms1, '开通后 activeMembership 有值 ⇒ 闸门放行')
  check(ms1?.sourceOrderId === order1.id, 'membership.sourceOrderId 指向该订单（可追溯）')
  check(ms1?.grantBeans === BigInt(subGrant?.settingVal ?? 98000), `membership.grantBeans = ${subGrant?.settingVal}`)

  const bal3 = await getBalance(prisma, mid)
  check(
    bal3.grantMembershipBalance === BigInt(subGrant?.settingVal ?? 98000) && bal3.grantRegisterBalance === wantGrant,
    `赠豆进**会员桶** = ${subGrant?.settingVal}（注册桶维持 ${wantGrant} 不变）`,
    `实际 会员桶=${bal3.grantMembershipBalance} 注册桶=${bal3.grantRegisterBalance}`,
  )
  const gl = await prisma.beanLedger.findFirst({
    where: { merchantId: mid, bizType: 'MEMBERSHIP', type: 'GRANT' },
    orderBy: { id: 'desc' },
  })
  check(gl?.bucket === 'GRANT' && gl?.grantRegisterAmount === 0n, '流水 grantRegisterAmount = 0（全算会员桶）')
  check(gl?.requestId === `membership:${order1.id}`, '幂等键 = membership:<orderId>', `实际 ${gl?.requestId}`)
  check(!!gl?.remark?.includes('后台手动开通'), '流水备注记录「后台手动开通」+ 操作人', `实际 ${gl?.remark}`)

  let ok = true
  try {
    await requireSubscription(prisma, mid, '合成出片')
  } catch {
    ok = false
  }
  check(ok, '开通后 requireSubscription 不再抛错（AI 与出片解锁）')

  // ── 节 ④：再次开通 = 续期顺延 ─────────────────────────────────────
  console.log('\n════ ④ 再次开通 = 续期顺延（不是覆盖，也不是复用旧订单）════')
  const endBefore = ms1!.endAt
  const r2 = await adminActivateMembership(prisma, mid, ADMIN_ID, '续期验证')
  check(r2.renewed, '第二次开通 renewed = true')
  check(r2.orderNo !== r1.orderNo, '每次开通各生成一张订单（幂等键不重复 ⇒ 每次都是真续期）')
  const ms2 = await activeMembership(prisma, mid)
  check(
    days(endBefore, ms2!.endAt) === Number(subDuration?.settingVal ?? 30),
    `到期时间在原有基础上顺延 ${subDuration?.settingVal} 天`,
    `${endBefore.toISOString()} → ${ms2!.endAt.toISOString()}`,
  )
  const giftSum = BigInt(subGrant?.settingVal ?? 98000) * 2n
  const bal4 = await getBalance(prisma, mid)
  check(bal4.grantMembershipBalance === giftSum, `两次开通共赠 ${giftSum} 豆（累加不覆盖）`, `实际 ${bal4.grantMembershipBalance}`)

  // ── 节 ⑤：会员到期清零只清会员桶 ─────────────────────────────────
  console.log('\n════ ⑤ 会员到期清零：只清会员桶，不动注册桶 ════')
  // 造一个「老用户」场景：注册桶里还有 30 豆
  await prisma.beanAccount.update({
    where: { merchantId: mid },
    data: { grantRegisterBalance: 30n, version: { increment: 1 } },
  })
  await prisma.$transaction(async (tx) => expireGrant(tx, { merchantId: mid }))
  const bal5 = await getBalance(prisma, mid)
  check(bal5.grantMembershipBalance === 0n, '会员桶归零', `实际 ${bal5.grantMembershipBalance}`)
  check(bal5.grantRegisterBalance === 30n, '注册桶保留 = 30（不随会员到期作废）', `实际 ${bal5.grantRegisterBalance}`)

  return mid
}

let merchantId: bigint | null = null
main()
  .then((id) => {
    merchantId = id
  })
  .catch((e) => {
    console.error('\n✗ 验证异常：', e)
    process.exitCode = 1
  })
  .finally(async () => {
    // 无论成败都清干净：这个手机号是专供验证的临时账号
    const m = await prisma.merchant.findUnique({ where: { phone: PHONE } })
    if (m) {
      await cleanup(m.id)
      console.log(`\n已清理临时商户 ${m.id}（${PHONE}）`)
    }
    await prisma.$disconnect()
    console.log(`\n结果：${pass} 通过 / ${failed} 失败`)
    if (failed > 0) process.exitCode = 1
    void merchantId
  })
