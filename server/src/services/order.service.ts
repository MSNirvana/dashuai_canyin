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

  // 仅允许非生产、显式 PAYMENT_MODE=test 的隔离演示支付；缺真实配置不得隐式发放权益。
  if (!wxpayEnabled) {
    if (process.env.NODE_ENV === 'production' || process.env.PAYMENT_MODE !== 'test') {
      throw new Error('真实支付未配置，暂不可下单')
    }
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

  if (!wxpayEnabled) {
    if (process.env.NODE_ENV === 'production' || process.env.PAYMENT_MODE !== 'test') throw new Error('真实支付未配置，暂不可下单')
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

/** 标记订单已支付并结算（幂等：已 PAID 直接返回） */
export async function markOrderPaid(prisma: PrismaClient, orderNo: string, wxTransactionId: string, _dev = false): Promise<void> {
  const order = await prisma.order.findUnique({ where: { orderNo } })
  if (!order) throw new Error(`order not found: ${orderNo}`)
  if (order.status === 'PAID') return

  // 订阅参数后台可改，在事务外读取（getNumber 不接受 TransactionClient）
  const subDurationDays = await getNumber(prisma, 'subscription', 'duration_days', 30)
  const subGrantPoints = BigInt(
    Math.round(await getNumber(prisma, 'subscription', 'grant_points', 98000)),
  )

  await prisma.$transaction(async (tx: Db) => {
    await tx.order.update({
      where: { orderNo },
      data: { status: 'PAID', paidAt: new Date(), wxTransactionId },
    })
    if (order.orderType === 'BEAN') {
      await recharge(tx, { merchantId: order.merchantId, amount: order.beans, bizId: order.orderNo })
    } else if (order.orderType === 'MEMBER') {
      await activateMembership(tx, order.merchantId, order.refId, order.id, {
        durationDays: subDurationDays,
        grantPoints: subGrantPoints,
      })
    }
  })
}

/** 激活 / 续期订阅，并发放赠送积分 */
async function activateMembership(
  tx: Db,
  merchantId: bigint,
  packageId: bigint,
  sourceOrderId: bigint,
  override?: { durationDays: number; grantPoints: bigint },
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
    await grant(tx, { merchantId, amount: grantPoints, bizId: sourceOrderId.toString() })
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
