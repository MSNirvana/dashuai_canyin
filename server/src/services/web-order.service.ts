import type { PrismaClient, Order } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { paymentsEnabled } from '../lib/config.js'
import { createWebPayOrder, wxpayEnabled, type WebPayScene } from '../lib/wxpay.js'
import { PackageNotFoundError, PaymentUnavailableError } from './order.service.js'
import { queryAndSettle } from './pay-reconcile.service.js'
import { activeSubscription, SubscriptionRequiredError } from './subscription.service.js'

export class WebOrderError extends Error {
  constructor(readonly code: number, message: string, readonly status: number) {
    super(message)
    this.name = 'WebOrderError'
  }
}

export function webPayCapabilities(env: NodeJS.ProcessEnv = process.env) {
  const enabled = wxpayEnabled && paymentsEnabled(env)
  return {
    native: enabled && env.WEB_PAY_NATIVE_ENABLED === 'true',
    h5: enabled && env.WEB_PAY_H5_ENABLED === 'true',
  }
}

// 依赖注入仅用于离线验证；线上始终使用真实微信通道。
export interface WebOrderDeps {
  capabilities?: typeof webPayCapabilities
  createPay?: typeof createWebPayOrder
  reconcile?: typeof queryAndSettle
}

function requireChannel(scene: WebPayScene, deps: WebOrderDeps) {
  const caps = (deps.capabilities ?? webPayCapabilities)()
  if (!(scene === 'NATIVE' ? caps.native : caps.h5)) throw new PaymentUnavailableError('网页支付通道暂未开放')
}

function requireAmount(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new WebOrderError(3012, '套餐金额无效，暂不可购买', 422)
}

function payerIp(scene: WebPayScene, ip?: string) {
  const normalized = ip?.replace(/^::ffff:/, '')
  if (scene === 'H5' && (!normalized || !isIP(normalized))) throw new WebOrderError(4000, '无法获取付款客户端 IP', 400)
  return normalized
}

export async function getWebCatalog(prisma: PrismaClient) {
  /**
   * ★★★ 展示口径 = 套餐行自己的值（`member_package.duration_days` / `grant_beans`）。
   *
   * 曾经这里读的是 `SystemSetting.subscription.{duration_days,grant_points}`，
   * 与套餐行的值**并存两套**。代价在 2026-10-14 上线后立刻现形：
   * 套餐叫「订阅 · 3年」（`member_package.name`，后台「会员套餐」页配的）、
   * `member_package.duration_days` 也是 1095，但线上有效期显示 **30 天** ——
   * 因为 SystemSetting 那一条是 30，而它**压过了**套餐行。
   * 于是同一个商品在**名称里写 3 年、在有效期里写 30 天**，公开页面自相矛盾。
   *
   * 为什么唯一源必须是套餐行而不是 SystemSetting：
   *   ① 套餐天然是**多档**的（每行一套周期/赠积分），SystemSetting 是**全局单值** ——
   *      用它覆盖等于宣布「多档套餐永远只能同周期」，那这个表就不用按档建了；
   *   ② 后台「会员套餐」页编辑的正是这两个字段（`admin-extra.service.ts::updatePackage`），
   *      而**全仓没有任何地方写 `subscription.duration_days`** ⇒ 运营在后台改完、保存成功、
   *      线上毫无变化，且没有任何报错 —— 最典型的静默失效。
   *   ③ 产品定义本身也是 3 年：`lib/xpay.ts` 的商品表逐条写着
   *      `{ productId: 'SUBSCRIPTION', goodsPriceFen: 98000, 说明: '订阅 · 3年' }`。
   *   ⇒ 30 天是那条遗留配置的错，不是这里该迁就的对象。
   *
   * ⚠ `system_setting` 里的 `subscription.duration_days` / `grant_points` 自此**不再被读取**，
   *   仅为历史留痕。改会员周期请去后台「会员套餐」页。
   */
  const [plans, packages] = await Promise.all([
    prisma.memberPackage.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } }),
    prisma.beanPackage.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } }),
  ])
  return {
    plans: plans.map(p => ({
      id: p.id.toString(),
      name: p.name,
      priceFen: p.priceFen,
      durationDays: p.durationDays,
      grantBeans: p.grantBeans.toString(),
    })),
    packages: packages.map(p => ({ id: p.id.toString(), name: p.name, priceFen: p.priceFen, beans: p.beans.toString(), bonusBeans: p.bonusBeans.toString() })),
    capabilities: webPayCapabilities(),
  }
}

async function buildPayment(order: Order, scene: WebPayScene, ip: string | undefined, deps: WebOrderDeps) {
  requireAmount(order.amountFen)
  if (order.status === 'PAID') throw new WebOrderError(3009, '订单已支付', 409)
  if (order.status !== 'PENDING' || order.expireAt.getTime() <= Date.now()) throw new WebOrderError(3010, '订单已失效，请重新下单', 409)
  const urls = await (deps.createPay ?? createWebPayOrder)({
    description: order.orderType === 'MEMBER' ? '大帅餐饮·会员订阅' : '大帅餐饮·积分加油包',
    outTradeNo: order.orderNo,
    amountFen: order.amountFen,
    timeExpire: order.expireAt.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    scene,
    payerClientIp: ip,
  })
  return { orderNo: order.orderNo, amountFen: order.amountFen, expireAt: order.expireAt.toISOString(), ...urls }
}

export async function createWebOrder(
  prisma: PrismaClient,
  merchantId: bigint,
  input: { kind: 'MEMBER' | 'BEAN'; packageId: bigint; scene: WebPayScene },
  clientIp?: string,
  deps: WebOrderDeps = {},
) {
  requireChannel(input.scene, deps)
  const ip = payerIp(input.scene, clientIp)
  const pkg = input.kind === 'MEMBER'
    ? await prisma.memberPackage.findFirst({ where: { id: input.packageId, enabled: true } })
    : await prisma.beanPackage.findFirst({ where: { id: input.packageId, enabled: true } })
  if (!pkg) throw new PackageNotFoundError()
  if (input.kind === 'BEAN' && !await activeSubscription(prisma, merchantId)) throw new SubscriptionRequiredError('加油包仅订阅用户可购买')
  requireAmount(pkg.priceFen)
  const beans = 'beans' in pkg ? pkg.beans + pkg.bonusBeans : 0n
  // 微信 out_trade_no 最长 32 字符，前缀兼容现有查单与 sweeper。
  const orderNo = `${input.kind === 'MEMBER' ? 'M' : 'B'}W${randomUUID().replace(/-/g, '').slice(0, 30)}`
  const order = await prisma.order.create({ data: {
    orderNo, merchantId, orderType: input.kind, refId: pkg.id,
    amountFen: pkg.priceFen, originalAmountFen: pkg.priceFen,
    memberDiscountApplied: false, beans, status: 'PENDING',
    expireAt: new Date(Math.floor(Date.now() / 1000) * 1000 + 15 * 60 * 1000),
    wxPrepayId: `WEB:${input.scene}`,
  } })
  // 微信下单超时可能已经受理，保留占位与 PENDING，允许同场景查单后重试。
  try { return await buildPayment(order, input.scene, ip, deps) }
  catch (error) {
    if (error instanceof Error) Object.assign(error, { orderNo })
    throw error
  }
}

export async function payWebOrder(
  prisma: PrismaClient, merchantId: bigint, orderNo: string,
  scene: WebPayScene, clientIp?: string, deps: WebOrderDeps = {},
) {
  const order = await prisma.order.findFirst({ where: { orderNo, merchantId } })
  if (!order || !/^[MB]W[0-9a-f]{30}$/.test(orderNo) || !['WEB:NATIVE', 'WEB:H5'].includes(order.wxPrepayId ?? '')) {
    throw new WebOrderError(3004, '网页订单不存在', 404)
  }
  if (order.wxPrepayId !== `WEB:${scene}`) throw new WebOrderError(3011, '订单支付场景不可变更，请重新下单', 409)
  if (order.status === 'PAID') throw new WebOrderError(3009, '订单已支付', 409)
  if (order.status !== 'PENDING') throw new WebOrderError(3010, '订单已失效，请重新下单', 409)
  requireChannel(scene, deps)
  const ip = payerIp(scene, clientIp)
  const result = await (deps.reconcile ?? queryAndSettle)(prisma, orderNo, { merchantId, source: 'QUERY' })
  if (result.status === 'PAID') throw new WebOrderError(3009, '订单已支付', 409)
  if (result.tradeState === 'SUCCESS' || result.tradeState === 'REFUND' || result.outcome === 'SKIPPED') {
    throw new WebOrderError(3013, '订单状态待核对，请稍后重试', 409)
  }
  const fresh = await prisma.order.findFirst({ where: { orderNo, merchantId } })
  if (!fresh) throw new WebOrderError(3004, '订单不存在', 404)
  return buildPayment(fresh, scene, ip, deps)
}
