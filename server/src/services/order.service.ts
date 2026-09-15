// 订阅 / 加油包服务（v5）
//  - 订阅：¥980 / 30 天 / 赠 98000 积分，是使用文案·分镜·合成的硬前提
//  - 加油包：¥100/200/300 → 1万/2万/3万 积分，**仅订阅用户可买**
//  - 下单：建 Order → 调微信支付（或演示支付）→ 返回 wx.requestPayment 参数
//  - 支付成功：标记 Order.PAID（幂等）→ 发积分 / 激活订阅（含续期）
// 规则见 docs/05 v5；v4 的「会员 8 折购豆」已废除。
// 对外统一称「积分」，底层仍复用 bean_* 账务表。
import type { PrismaClient, Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import { recharge, grant, getBalance, type Db } from '../bean/bean.service.js'
import { wxpayEnabled, createJsapiOrder, buildPayParams, decryptResource, type PayParams } from '../lib/wxpay.js'
import { getNumber } from '../lib/settings.js'
import { paymentsEnabled } from '../lib/config.js'
import { activeSubscription, getStorage, SubscriptionRequiredError } from './subscription.service.js'

export class OrderAlreadyPaidError extends Error {
  constructor() {
    super('订单已支付')
    this.name = 'OrderAlreadyPaidError'
  }
}
export class PackageNotFoundError extends Error {
  constructor() {
    super('档位不存在或未启用')
    this.name = 'PackageNotFoundError'
  }
}
export class NoOpenidError extends Error {
  constructor() {
    super('该账号未绑定微信 openid，无法发起真实支付')
    this.name = 'NoOpenidError'
  }
}
/** 支付能力被关闭（PAYMENTS_ENABLED=false）或凭据不全且非演示环境时抛出 */
export class PaymentUnavailableError extends Error {
  constructor(message = '支付功能暂未开放') {
    super(message)
    this.name = 'PaymentUnavailableError'
  }
}

/**
 * 支付运行态判定 —— 三态，取代原来散落在两个下单函数里的 `NODE_ENV === 'production' || ...` 判断。
 *
 *  real     ：真实微信支付可用（开关开启 且 七项凭据齐备）
 *  demo     ：演示支付（自动置 PAID + 写 TEST 交易号）。**硬性要求非生产 + 显式 PAYMENT_MODE=test**，
 *             这条约束在任何情况下都不放松，否则等于「缺配置就白送权益」。
 *  disabled ：直接拒绝下单。
 *
 * 与旧行为的关系：PAYMENTS_ENABLED 未设置时 paymentsEnabled() 返回 true，
 * 本函数退化成 `wxpayEnabled ? real : (非生产且 test ? demo : disabled)` —— 与改动前完全一致。
 */
export function resolvePayMode(env: NodeJS.ProcessEnv = process.env): 'real' | 'demo' | 'disabled' {
  if (paymentsEnabled(env) && wxpayEnabled) return 'real'
  if (env.NODE_ENV !== 'production' && env.PAYMENT_MODE === 'test') return 'demo'
  return 'disabled'
}

export interface MeView {
  balance: { available: string; balance: string; grantBalance: string; frozen: string }
  subscription: {
    active: boolean
    planName: string | null
    endAt: string | null
    grantPoints: string
  }
  storage: { usedBytes: string; quotaBytes: string; subscribed: boolean }
}

/** 当前有效会员（status=ACTIVE 且未过期） */
export async function activeMembership(prisma: PrismaClient, merchantId: bigint) {
  return prisma.membership.findFirst({
    where: { merchantId, status: 'ACTIVE', endAt: { gt: new Date() } },
    orderBy: { endAt: 'desc' },
    include: { package: true },
  })
}

export async function getOrderForMerchant(prisma: PrismaClient, merchantId: bigint, orderNo: string) {
  return prisma.order.findFirst({
    where: { orderNo, merchantId },
    select: { orderNo: true, status: true, orderType: true, amountFen: true, beans: true, paidAt: true, expireAt: true },
  })
}

export async function getMe(prisma: PrismaClient, merchantId: bigint): Promise<MeView> {
  const b = await getBalance(prisma, merchantId)
  const m = await activeMembership(prisma, merchantId)
  const st = await getStorage(prisma, merchantId)
  return {
    balance: {
      available: b.available.toString(),
      balance: b.balance.toString(),
      grantBalance: b.grantBalance.toString(),
      frozen: b.frozen.toString(),
    },
    subscription: {
      active: !!m,
      planName: m?.package.name ?? null,
      endAt: m?.endAt.toISOString() ?? null,
      grantPoints: m?.grantBeans.toString() ?? '0',
    },
    storage: {
      usedBytes: st.usedBytes.toString(),
      quotaBytes: st.quotaBytes.toString(),
      subscribed: st.subscribed,
    },
  }
}

export function listBeanPackages(prisma: PrismaClient) {
  return prisma.beanPackage.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } })
}

export function listMemberPlans(prisma: PrismaClient) {
  return prisma.memberPackage.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } })
}

export interface CreateOrderResult {
  dev: boolean
  orderNo: string
  amountFen: number
  beans: string
  memberDiscountApplied: boolean
  payParams: PayParams | null
}

/** 加油包下单：仅订阅用户可买；v5 已废除 8 折 */
export async function createBeanOrder(
  prisma: PrismaClient,
  merchantId: bigint,
  packageId: bigint,
): Promise<CreateOrderResult> {
  const pkg = await prisma.beanPackage.findFirst({ where: { id: packageId, enabled: true } })
  if (!pkg) throw new PackageNotFoundError()

  // v5：加油包是订阅用户的补给通道，未订阅直接拒绝
  const sub = await activeSubscription(prisma, merchantId)
  if (!sub) throw new SubscriptionRequiredError('加油包仅订阅用户可购买')

  const amountFen = pkg.priceFen // 废除 8 折，统一原价
  const beans = pkg.beans + pkg.bonusBeans

  // 支付可用性检查放在建单之前：支付关闭时不该留下一行注定无法支付的 PENDING 订单。
  // 错误优先级不变：档位(3006) → 订阅(2005) → 支付(3008)。
  // 仅允许非生产、显式 PAYMENT_MODE=test 的隔离演示支付；缺真实配置不得隐式发放权益。
  const payMode = resolvePayMode()
  if (payMode === 'disabled') throw new PaymentUnavailableError()

  const orderNo = `B${Date.now().toString().slice(-10)}${randomUUID().slice(0, 6)}`
  const order = await prisma.order.create({
    data: {
      orderNo,
      merchantId,
      orderType: 'BEAN',
      refId: pkg.id,
      amountFen,
      originalAmountFen: pkg.priceFen,
      memberDiscountApplied: false, // v5 废除折扣
      beans,
      status: 'PENDING',
      expireAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  })

  if (payMode === 'demo') {
    await markOrderPaid(prisma, orderNo, `TEST${orderNo}`, true)
    return { dev: true, orderNo, amountFen, beans: beans.toString(), memberDiscountApplied: false, payParams: null }
  }

  const m = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!m?.wechatOpenid) throw new NoOpenidError()
  const { prepayId } = await createJsapiOrder({
    description: `大帅餐饮·加油包${beans}积分`,
    outTradeNo: orderNo,
    amountFen,
    openid: m.wechatOpenid,
  })
  await prisma.order.update({ where: { id: order.id }, data: { wxPrepayId: prepayId } })
  return {
    dev: false,
    orderNo,
    amountFen,
    beans: beans.toString(),
    memberDiscountApplied: false,
    payParams: buildPayParams(prepayId),
  }
}

/** 订阅下单（v5 唯一的准入套餐，替代 v4 月/季/年卡） */
export async function createMemberOrder(
  prisma: PrismaClient,
  merchantId: bigint,
  packageId: bigint,
): Promise<CreateOrderResult> {
  const pkg = await prisma.memberPackage.findFirst({ where: { id: packageId, enabled: true } })
  if (!pkg) throw new PackageNotFoundError()

  // 同 createBeanOrder：支付不可用时在建单之前就拒绝，避免悬空 PENDING 订单
  const payMode = resolvePayMode()
  if (payMode === 'disabled') throw new PaymentUnavailableError()

  const orderNo = `M${Date.now().toString().slice(-10)}${randomUUID().slice(0, 6)}`
  const order = await prisma.order.create({
    data: {
      orderNo,
      merchantId,
      orderType: 'MEMBER',
      refId: pkg.id,
      amountFen: pkg.priceFen,
      originalAmountFen: pkg.priceFen,
      memberDiscountApplied: false,
      beans: 0,
      status: 'PENDING',
      expireAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  })

  if (payMode === 'demo') {
    await markOrderPaid(prisma, orderNo, `TEST${orderNo}`, true)
    return { dev: true, orderNo, amountFen: pkg.priceFen, beans: '0', memberDiscountApplied: false, payParams: null }
  }

  const m = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!m?.wechatOpenid) throw new NoOpenidError()
  const { prepayId } = await createJsapiOrder({
    description: `大帅餐饮·${pkg.name}`,
    outTradeNo: orderNo,
    amountFen: pkg.priceFen,
    openid: m.wechatOpenid,
  })
  await prisma.order.update({ where: { id: order.id }, data: { wxPrepayId: prepayId } })
  return { dev: false, orderNo, amountFen: pkg.priceFen, beans: '0', memberDiscountApplied: false, payParams: buildPayParams(prepayId) }
}

/** 标记订单已支付并结算（终态 CAS：仅 PENDING→PAID 可发放权益，并发重复回调天然幂等）
 *
 * `wxTransactionId` 允许为 null —— 后台手动开通会员没有微信交易号，走的也是这个函数，
 * 这样「赠豆进哪个桶 / 到期怎么清 / 续期怎么顺延 / 幂等键怎么算」只有一份实现，
 * 不会出现「后台开的会员和付钱买的会员账务口径不一样」。
 */
export async function markOrderPaid(
  prisma: PrismaClient,
  orderNo: string,
  wxTransactionId: string | null,
  _dev = false,
  grantRemark?: string,
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { orderNo } })
  if (!order) throw new Error(`order not found: ${orderNo}`)
  if (order.status === 'PAID') return

  // 订阅参数后台可改，在事务外读取（getNumber 不接受 TransactionClient）
  const subDurationDays = await getNumber(prisma, 'subscription', 'duration_days', 30)
  const subGrantPoints = BigInt(
    Math.round(await getNumber(prisma, 'subscription', 'grant_points', 98000)),
  )

  await prisma.$transaction(async (tx: Db) => {
    // 终态 CAS：条件更新仅允许 PENDING → PAID。
    // 微信回调会重试，两个并发回调可能同时通过外层「已 PAID」快照检查；
    // 只有抢到状态流转的那一个会发放权益，另一个 count=0 直接返回，杜绝双重发豆/双开会员。
    const claimed = await tx.order.updateMany({
      where: { orderNo, status: 'PENDING' },
      data: { status: 'PAID', paidAt: new Date(), wxTransactionId },
    })
    if (claimed.count === 0) return
    if (order.orderType === 'BEAN') {
      await recharge(tx, { merchantId: order.merchantId, amount: order.beans, bizId: order.orderNo })
    } else if (order.orderType === 'MEMBER') {
      await activateMembership(tx, order.merchantId, order.refId, order.id, {
        durationDays: subDurationDays,
        grantPoints: subGrantPoints,
        grantRemark,
      })
    }
  })
}

/** 激活 / 续期订阅，并发放赠送积分 */
async function activateMembership(
  tx: Db,
  merchantId: bigint,
  packageId: bigint,
  sourceOrderId: bigint | null,
  override?: { durationDays: number; grantPoints: bigint; grantRemark?: string },
): Promise<void> {
  const pkg = await tx.memberPackage.findUnique({ where: { id: packageId } })
  if (!pkg) throw new PackageNotFoundError()
  const now = new Date()
  // 后台可改：SystemSetting.subscription.* 优先于套餐默认值
  const durationDays = override?.durationDays ?? pkg.durationDays
  const grantPoints = override?.grantPoints ?? pkg.grantBeans
  const durationMs = durationDays * 24 * 60 * 60 * 1000

  const existing = await tx.membership.findFirst({
    where: { merchantId, status: 'ACTIVE', endAt: { gt: now } },
    orderBy: { endAt: 'desc' },
  })

  if (existing) {
    // 续期：在现有结束时间上顺延
    const newEnd = new Date(existing.endAt.getTime() + durationMs)
    await tx.membership.update({
      where: { id: existing.id },
      data: { endAt: newEnd, grantBeans: { increment: grantPoints }, grantExpireAt: newEnd },
    })
  } else {
    const endAt = new Date(now.getTime() + durationMs)
    await tx.membership.create({
      data: {
        merchantId,
        packageId,
        startAt: now,
        endAt,
        sourceOrderId,
        grantBeans: grantPoints,
        grantExpireAt: endAt,
        status: 'ACTIVE',
      },
    })
  }
  // 赠送积分（独立记账，订阅到期清零）
  if (grantPoints > 0n) {
    await grant(tx, {
      merchantId,
      amount: grantPoints,
      bizId: sourceOrderId?.toString(),
      source: 'MEMBERSHIP', // 会员周期赠豆：会随会员到期清零
      remark: override?.grantRemark,
    })
  }
}

export interface AdminMembershipResult {
  orderNo: string
  packageName: string
  /** true = 在现有到期时间上顺延；false = 新开 */
  renewed: boolean
  endAt: string
  /** 本次开通赠送的积分数 */
  grantPoints: string
}

/**
 * 后台手动开通会员（用户线下付款 / 备案未通过期间的兜底通道）。
 *
 * 设计取舍：**不另写一套开会员逻辑**，而是造一张 amountFen=0 的 MEMBER 订单再调 `markOrderPaid`。
 * 这样：
 *   · 赠豆走 `grant(source:'MEMBERSHIP')` → 进**会员桶**，随会员到期清零（与线上购买完全一致）
 *   · 幂等键 = `membership:<orderId>`，每次开通都是一张新订单 ⇒ 重复开通就是真续期，不会双发
 *   · 在后台「最近订单」里留下一行可追溯记录（orderNo 以 `A` 开头 = 后台单，无微信交易号）
 *   · 时长 / 赠豆取 `SystemSetting.subscription.*`，与线上购买共用同一份配置
 *
 * 操作人记录在赠豆流水的 remark 里（BeanLedger 是唯一有留痕字段的账务表）。
 */
export async function adminActivateMembership(
  prisma: PrismaClient,
  merchantId: bigint,
  operatorId: bigint,
  remark?: string,
): Promise<AdminMembershipResult> {
  const pkg = await prisma.memberPackage.findFirst({ where: { code: 'SUBSCRIPTION' } })
  if (!pkg) throw new PackageNotFoundError()
  if (!pkg.enabled) throw new PackageNotFoundError()

  const before = await activeMembership(prisma, merchantId)
  // 与 markOrderPaid 读的是同一份配置（SystemSetting.subscription.*），仅用于回显
  const grantedThisTime = BigInt(Math.round(await getNumber(prisma, 'subscription', 'grant_points', 98000)))

  // 单号前缀 A = ADMIN，与线上充值 B / 线上会员 M 区分
  const orderNo = `A${Date.now().toString().slice(-10)}${randomUUID().slice(0, 6)}`
  await prisma.order.create({
    data: {
      orderNo,
      merchantId,
      orderType: 'MEMBER',
      refId: pkg.id,
      amountFen: 0, // 线下收款 / 赠送，不走微信支付，故为 0
      originalAmountFen: pkg.priceFen,
      memberDiscountApplied: false,
      beans: 0,
      status: 'PENDING',
      expireAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  })
  await markOrderPaid(
    prisma,
    orderNo,
    null,
    false,
    remark?.trim()
      ? `后台手动开通会员（操作人 admin#${operatorId}）：${remark.trim()}`
      : `后台手动开通会员（操作人 admin#${operatorId}）`,
  )

  const after = await activeMembership(prisma, merchantId)
  if (!after) throw new Error('会员激活后未查到有效会员，请检查配置')
  return {
    orderNo,
    packageName: after.package.name,
    renewed: !!before,
    endAt: after.endAt.toISOString(),
    grantPoints: grantedThisTime.toString(),
  }
}

/** 微信支付回调：解密 → 落库（幂等） */
export async function handleNotify(prisma: PrismaClient, rawBody: string): Promise<{ code: 'SUCCESS' | 'FAIL'; message?: string }> {
  try {
    const payload = JSON.parse(rawBody) as { resource?: { ciphertext: string; nonce: string; associated_data?: string } }
    if (!payload.resource) throw new Error('missing resource')
    const decrypted = decryptResource(payload.resource)
      if (decrypted.appid !== (process.env.WX_APPID ?? '') || decrypted.mchid !== (process.env.WX_PAY_MCH_ID ?? '')) throw new Error('payment merchant mismatch')
    if (decrypted.tradeState === 'SUCCESS') {
      const order = await prisma.order.findUnique({ where: { orderNo: decrypted.outTradeNo }, select: { amountFen: true } })
      if (!order || order.amountFen !== decrypted.amountFen) throw new Error('payment amount mismatch')
      await markOrderPaid(prisma, decrypted.outTradeNo, decrypted.transactionId)
    }
    return { code: 'SUCCESS' }
  } catch (e) {
    return { code: 'FAIL', message: (e as Error).message }
  }
}

export type { Prisma }
