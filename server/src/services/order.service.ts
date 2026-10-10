// 订阅 / 加油包服务（v5）
//  - 订阅：¥980 / 30 天 / 赠 98000 积分，是使用文案·分镜·合成的硬前提
//  - 加油包：¥100/200/300 → 1万/2万/3万 积分，**仅订阅用户可买**
//  - 下单：建 Order → 调微信支付（或演示支付）→ 返回 wx.requestPayment 参数
//  - 支付成功：标记 Order.PAID（幂等）→ 发积分 / 激活订阅（含续期）
// 规则见 docs/05 v5；v4 的「会员 8 折购积分」已废除。
// 对外统一称「积分」，底层仍复用 bean_* 账务表。
import type { PrismaClient, Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import { recharge, grant, getBalance, lockMerchantAccount, type Db } from '../bean/bean.service.js'
import { wxpayEnabled, createJsapiOrder, buildPayParams, decryptResource, type PayParams } from '../lib/wxpay.js'
import {
  vpEnabled,
  vpLegacyJsapiAllowed,
  buildVirtualPayParams,
  memberProductId,
  beanProductId,
  type VirtualPayParams,
} from '../lib/xpay.js'
import { getNumber } from '../lib/settings.js'
import { paymentsEnabled } from '../lib/config.js'
import { activeSubscription, getStorage, SubscriptionRequiredError } from './subscription.service.js'
import { raiseOpsAlert, type RaiseOpsAlertInput } from './ops-alert.service.js'

/**
 * 结算来源。只用于回执留痕与告警文案，**不参与任何业务判断**。
 * 它的存在意义：事后有人翻到一张可疑订单时，能立刻知道「它是被哪条通道结算的」——
 * `RISK` 意味着「这笔差点永久丢在窗口外」，`RECONCILE` 意味着「人工补的」。
 */
export type SettlementSource = 'NOTIFY' | 'QUERY' | 'RECONCILE' | 'RISK' | 'ADMIN' | 'DEMO'

export class OrderAlreadyPaidError extends Error {
  constructor() {
    super('订单已支付')
    this.name = 'OrderAlreadyPaidError'
  }
}

/**
 * 订单有效期。本地 `order.expireAt` 与微信侧 `time_expire` **必须用同一个值**。
 *
 * ★ 不一致的后果（改动前就是不一致的：本地 15 分钟、微信默认 7 天）：
 *   本地先判过期 → 置 EXPIRED（旧代码还没关微信单）→ 用户在这段时间里付了钱 →
 *   回调进来时本地状态已不是 PENDING → CAS 更新 0 行 → 钱收了、权益静默不发。
 */
const ORDER_TTL_MS = 15 * 60 * 1000

/** 转成微信要求的 RFC3339（含时区偏移）。用本机偏移而不是硬编码 +08:00，避免服务器时区不同导致误解。 */
function toRfc3339(d: Date): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`
  )
}
export class PackageNotFoundError extends Error {
  constructor() {
    super('档位不存在或未启用')
    this.name = 'PackageNotFoundError'
  }
}
export class NoOpenidError extends Error {
  constructor() {
    super('该账号未完成快捷登录，无法发起真实支付')
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

/**
 * `payMode === 'disabled'` 时也算「有真实收款能力」的另一条通道：小程序虚拟支付。
 *
 * ★★ 为什么必须单独有这个判据：`resolvePayMode()` 是**普通微信支付（JSAPI）中心**的 ——
 *   它只看 `wxpayEnabled`。而虚拟商品**只能**走虚拟支付，所以「迁移完成后下线旧商户号」
 *   是一个正常且推荐的终局。若各处门禁仍写 `resolvePayMode() !== 'real'`，
 *   那个终局会**静默关掉对账与风控**（`pay-reconcile` / `pay-risk` 的调度直接 return），
 *   而它们恰恰是「钱收了没发权益」的唯一兜底。
 * ⇒ 凡是要表达「这个环境能不能真实收款」，用本函数，不要再用 `resolvePayMode()`。
 */
export function realCollectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolvePayMode(env) === 'real' || (paymentsEnabled(env) && vpEnabled(env))
}

/**
 * 本次**订单**走哪条收款通道。
 *
 * ★★ 两个输入缺一不可：
 *   ① 「环境能不能」—— `WX_VP_*` 是否配齐（`vpEnabled`）；
 *   ② 「**本次请求的客户端**认不认识」—— `clientVpCapable`，由端上随下单上报
 *      （`platform.payCapabilities.virtualPay`）。
 *
 * ★★ 为什么必须带 ②、而不能只看 ①：只看 ① 时它是**进程级**的 —— 填上凭据并重启会让
 *   **所有**新单立刻下发 `{signData,paySig,signature,mode}`。而线上随时有大量**已安装、
 *   尚未升级**的客户端，它们会把这四件套当成 JSAPI 参数交给 `Taro.requestPayment`，
 *   现场表现是「点了付款没反应 / 支付失败」⇒ **全体用户付不了款**。
 *   微信侧的版本发布不由我们控制（用户下次冷启动才拉到新版），
 *   所以「切通道」只能**按请求**走，且默认落在安全侧。
 *
 * ★ `clientVpCapable` **故意不给默认值**：逼每个调用点显式回答「这个客户端认识四件套吗」，
 *   免得将来有人漏传，就把旧客户端打进一条它无法调起的路径。
 *
 * ★ 过渡期行为：老客户端（`clientVpCapable=false`）**默认仍放行普通微信支付**
 *   （`WX_VP_LEGACY_JSAPI`，默认 true）。置 false 后老客户端也会拿到四件套
 *   ⇒ 只在小程序后台**全量发布新版之后**才可动，见 `vpLegacyJsapiAllowed` 的注释。
 */
export function resolvePayChannel(input: {
  env?: NodeJS.ProcessEnv
  /** 本次请求的客户端是否声明认识虚拟支付四件套。缺省/未知一律按 `false` 处理。 */
  clientVpCapable: boolean
}): PayChannel {
  const env = input.env ?? process.env
  // 环境没配 VirtualPay ⇒ 只有 JSAPI 一条路可走（老行为，完全不变）
  if (!vpEnabled(env)) return 'jsapi'
  // 客户端认识四件套 ⇒ 直接走虚拟支付
  if (input.clientVpCapable) return 'vp'
  // 老客户端：过渡期放行 JSAPI；切齐开关置 false 后才强制 vp
  return vpLegacyJsapiAllowed(env) ? 'jsapi' : 'vp'
}

export type PayChannel = 'vp' | 'jsapi'

/** 下单返回的调起参数：普通微信支付（JSAPI）或虚拟支付，二选一。 */
export type OrderPayParams = PayParams | VirtualPayParams

/** 虚拟支付不可用（缺 `session_key`）：code 换不出身份时无法签用户态签名。 */
export class VpCredentialMissingError extends Error {
  constructor() {
    super('支付凭证已过期，请返回重新进入后再试')
    this.name = 'VpCredentialMissingError'
  }
}

/**
 * 构建虚拟支付的调起参数。
 *
 * ★ 只做一件事：把「订单」翻译成微信要的四件套。产品映射与价格的一致性约束见
 *   `lib/xpay.ts` 的 `VP_PRODUCT_CONTRACT`。
 */
function buildVpParams(input: {
  orderType: 'BEAN' | 'MEMBER'
  orderNo: string
  merchantId: bigint
  productId: string
  amountFen: number
  vpSessionKey?: string
}): VirtualPayParams {
  if (!input.vpSessionKey) throw new VpCredentialMissingError()
  const params = buildVirtualPayParams({
    productId: input.productId,
    // ★ 价格取自**本地订单金额**，而它又来自套餐当前配置。微信会拿它与 MP 后台的道具价比对，
    //   对不上直接 -15013 ⇒ 改价流程必须连带同步 MP 后台（VP_PRODUCT_CONTRACT 有清单）。
    goodsPriceFen: input.amountFen,
    outTradeNo: input.orderNo,
    attach: `${input.orderType}:${input.merchantId}`,
    sessionKey: input.vpSessionKey,
  })
  // 留一行可检索的现场：事后核对「这笔钱换的是哪个道具」时不必再去翻签名原文。
  console.log(
    `[pay/vp] 下单 ${input.orderNo} 道具=${input.productId} 金额=${input.amountFen}分 类型=${input.orderType}`,
  )
  return params
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

/** 订单列表里的一条。字段命名与 `GET /orders/:orderNo` 保持一致，前端可以共用一套渲染。 */
export interface OrderListItem {
  orderNo: string
  orderType: string
  /** 套餐名。订单表只存 `ref_id`，名字要去对应套餐表里补 —— 补不到才用兜底文案 */
  title: string
  status: string
  amountFen: number
  beans: string
  paidAt: string | null
  createdAt: string
}

export interface OrderListView {
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  list: OrderListItem[]
}

/** 订单列表一页最多给多少条。取 50 是防「前端传 pageSize=9999 把整张表拉走」。 */
const ORDER_PAGE_SIZE_MAX = 50

/**
 * 订单列表（小程序「订单中心」页用）。
 *
 * ★★ 为什么必须有这个接口：微信 2022-12-31《关于小程序订单中心页设置的公告》要求
 *   「有『选择商品/服务 → 下单 → 支付』完整流程」的小程序在小程序内设置订单中心页，
 *   并把 path 同步给平台，且该页须展示**所有涉及资金交易的订单明细或订单分类入口**。
 *   本应用有会员订阅与积分加油包两条真实支付流程，此前却只有「按单号查一笔」
 *   ⇒ 用户在「我的」里**看不到自己的历史订单**（连隐私政策里那句承诺都落了空）。
 *
 * ★ 归属一律由 `merchantId` 限定：前端传什么都不会查到别人的订单。
 * ★ 排序用 `id desc` 而不是 `createdAt desc`：`@@index([merchantId, createdAt])` 虽在，
 *   但 `id` 是自增主键，同毫秒落库的多条订单排序也稳定（`createdAt` 只到毫秒）。
 */
export async function listOrdersForMerchant(
  prisma: PrismaClient,
  merchantId: bigint,
  opts: { page?: number; pageSize?: number } = {},
): Promise<OrderListView> {
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(ORDER_PAGE_SIZE_MAX, Math.max(1, Math.floor(opts.pageSize ?? 20)))

  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where: { merchantId },
      orderBy: { id: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        orderNo: true,
        orderType: true,
        refId: true,
        status: true,
        amountFen: true,
        beans: true,
        paidAt: true,
        createdAt: true,
      },
    }),
    prisma.order.count({ where: { merchantId } }),
  ])

  // 补套餐名。★ BEAN 与 MEMBER 的 `ref_id` 指向**两张不同的表**，各自的 id 空间不通用，
  //   所以必须分开查 —— 合起来用一次 `IN` 会把「积分包 id=1」当成「会员套餐 id=1」。
  type PkgName = { id: bigint; name: string }
  const none: PkgName[] = []
  const beanIds = rows.filter((r) => r.orderType === 'BEAN').map((r) => r.refId)
  const memberIds = rows.filter((r) => r.orderType === 'MEMBER').map((r) => r.refId)
  const [beanPkgs, memberPkgs] = await Promise.all([
    beanIds.length
      ? prisma.beanPackage.findMany({ where: { id: { in: beanIds } }, select: { id: true, name: true } })
      : none,
    memberIds.length
      ? prisma.memberPackage.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } })
      : none,
  ])
  const beanName = new Map(beanPkgs.map((p) => [p.id.toString(), p.name]))
  const memberName = new Map(memberPkgs.map((p) => [p.id.toString(), p.name]))

  /**
   * 套餐名兜底。
   * ★ 套餐可能已被后台**下架/删除**（`bean_package` 有 `enabled`，运营改配置时也可能整行删掉），
   *   这时订单仍在、名字查不到。给一句通用文案，绝不能让列表因为一个 join 不上就报错 ——
   *   订单中心页挂了，微信那条 path 校验也就跟着挂。
   */
  const fallbackTitle = (orderType: string) =>
    orderType === 'BEAN' ? '积分加油包' : orderType === 'MEMBER' ? '会员订阅' : '订单'

  const list: OrderListItem[] = rows.map((r) => {
    const key = r.refId.toString()
    const title = (r.orderType === 'BEAN' ? beanName.get(key) : memberName.get(key)) ?? fallbackTitle(r.orderType)
    return {
      orderNo: r.orderNo,
      orderType: r.orderType,
      title,
      status: r.status,
      amountFen: r.amountFen,
      beans: r.beans.toString(),
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }
  })

  return { total, page, pageSize, hasMore: page * pageSize < total, list }
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
  /**
   * 本次走哪条收款通道。
   * ★ 客户端也可以只判 `payParams` 里有没有 `signData` —— 给出这个字段是为了让
   *   服务端日志与前端分支都**显式**，而不是靠字段存在性推断。
   */
  payChannel: PayChannel
  payParams: OrderPayParams | null
}

/** 加油包下单：仅订阅用户可买；v5 已废除 8 折 */
export async function createBeanOrder(
  prisma: PrismaClient,
  merchantId: bigint,
  packageId: bigint,
  /** 本次付款人的 openid（下单口用 `wx.login` 的 code 换出）；缺省时回退账号已存的那枚 */
  payOpenid?: string,
  /**
   * 本次付款人的 `session_key`，与 `payOpenid` 是**同一次** code2Session 的产物
   * （`wx.login` 的 code 一次性 ⇒ 不能分两次换）。虚拟支付的用户态签名要用它；
   * 普通微信支付不需要。★ 不落库、不下发，算完即弃。
   */
  vpSessionKey?: string,
  /**
   * 本次下单的客户端是否声明认识虚拟支付四件套。
   * ★ 缺省 = `false`（老客户端）⇒ 继续走普通微信支付，见 `resolvePayChannel`。
   */
  vpCapable = false,
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
  // ★ 虚拟支付是**独立通道**（`resolvePayMode` 只看普通微信支付）：它可用就不算「支付关闭」。
  //   通道优先级：虚拟支付 > 普通微信支付 > 演示 > 拒绝。虚拟商品**只能**走第一条。
  const vpActive = paymentsEnabled() && resolvePayChannel({ clientVpCapable: vpCapable }) === 'vp'
  if (payMode === 'disabled' && !vpActive) throw new PaymentUnavailableError()

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
      expireAt: new Date(Date.now() + ORDER_TTL_MS),
    },
  })

  // ── 通道分流：虚拟商品**必须**走虚拟支付（普通支付对虚拟类目会被平台关停）──
  if (vpActive) {
    return {
      dev: false,
      orderNo,
      amountFen,
      beans: beans.toString(),
      memberDiscountApplied: false,
      payChannel: 'vp',
      payParams: buildVpParams({
        orderType: 'BEAN',
        orderNo,
        merchantId,
        // 道具ID 由「基础积分数」推导（**不含赠送**）—— 见 xpay.beanProductId 的说明
        productId: beanProductId(pkg.beans),
        amountFen,
        vpSessionKey,
      }),
    }
  }

  if (payMode === 'demo') {
    await markOrderPaid(prisma, orderNo, `TEST${orderNo}`, true, undefined, 'DEMO')
    return {
      dev: true,
      orderNo,
      amountFen,
      beans: beans.toString(),
      memberDiscountApplied: false,
      payChannel: 'jsapi',
      payParams: null,
    }
  }

  const m = await prisma.merchant.findUnique({ where: { id: merchantId } })
  // ★ 优先用「本次付款人」的 openid（由下单口拿 wx.login 的 code 换出，见 resolvePayerOpenid）；
  //   账号里存的那枚只作兜底（老客户端不传 code / code 换不出来时）。
  //   为什么必须这样：微信 JSAPI 只认「payer.openid == 当前调起支付的用户」，
  //   而 merchant.wechat_openid 是**账号属性**（上次用哪个微信登录的），两者未必同一个 ——
  //   用后者下单会让「换过手机号/换过微信」的用户永远付不了款（微信弹「下单账号与支付账号不一致」）。
  const openid = payOpenid ?? m?.wechatOpenid
  if (!openid) throw new NoOpenidError()
  const { prepayId } = await createJsapiOrder({
    description: `大帅餐饮·加油包${beans}积分`,
    outTradeNo: orderNo,
    amountFen,
    openid,
    // 与本地 expireAt 严格一致（见 ORDER_TTL_MS 的说明）
    timeExpire: toRfc3339(order.expireAt),
  })
  await prisma.order.update({ where: { id: order.id }, data: { wxPrepayId: prepayId } })
  return {
    dev: false,
    orderNo,
    amountFen,
    beans: beans.toString(),
    memberDiscountApplied: false,
    payChannel: 'jsapi',
    payParams: buildPayParams(prepayId),
  }
}

/** 订阅下单（v5 唯一的准入套餐，替代 v4 月/季/年卡） */
export async function createMemberOrder(
  prisma: PrismaClient,
  merchantId: bigint,
  packageId: bigint,
  /** 本次付款人的 openid（下单口用 `wx.login` 的 code 换出）；缺省时回退账号已存的那枚 */
  payOpenid?: string,
  /** 同 createBeanOrder：本次付款人的 session_key（虚拟支付用户态签名要用） */
  vpSessionKey?: string,
  /** 同 createBeanOrder：本次下单的客户端是否声明认识虚拟支付四件套。缺省 = 不认识 */
  vpCapable = false,
): Promise<CreateOrderResult> {
  const pkg = await prisma.memberPackage.findFirst({ where: { id: packageId, enabled: true } })
  if (!pkg) throw new PackageNotFoundError()

  // 同 createBeanOrder：支付不可用时在建单之前就拒绝，避免悬空 PENDING 订单
  const payMode = resolvePayMode()
  // 同 createBeanOrder：虚拟支付可用即不算「支付关闭」
  const vpActive = paymentsEnabled() && resolvePayChannel({ clientVpCapable: vpCapable }) === 'vp'
  if (payMode === 'disabled' && !vpActive) throw new PaymentUnavailableError()

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

  // ── 通道分流：订阅属于「订阅内容」，是运营指南点名的虚拟商品 ⇒ 必须走虚拟支付 ──
  if (vpActive) {
    return {
      dev: false,
      orderNo,
      amountFen: pkg.priceFen,
      beans: '0',
      memberDiscountApplied: false,
      payChannel: 'vp',
      payParams: buildVpParams({
        orderType: 'MEMBER',
        orderNo,
        merchantId,
        // 用套餐的 `code`（唯一索引）而不是自增 id —— 见 xpay.memberProductId 的说明
        productId: memberProductId(pkg.code),
        amountFen: pkg.priceFen,
        vpSessionKey,
      }),
    }
  }

  if (payMode === 'demo') {
    await markOrderPaid(prisma, orderNo, `TEST${orderNo}`, true, undefined, 'DEMO')
    return {
      dev: true,
      orderNo,
      amountFen: pkg.priceFen,
      beans: '0',
      memberDiscountApplied: false,
      payChannel: 'jsapi',
      payParams: null,
    }
  }

  const m = await prisma.merchant.findUnique({ where: { id: merchantId } })
  // ★ 优先用「本次付款人」的 openid（由下单口拿 wx.login 的 code 换出，见 resolvePayerOpenid）；
  //   账号里存的那枚只作兜底（老客户端不传 code / code 换不出来时）。
  //   为什么必须这样：微信 JSAPI 只认「payer.openid == 当前调起支付的用户」，
  //   而 merchant.wechat_openid 是**账号属性**（上次用哪个微信登录的），两者未必同一个 ——
  //   用后者下单会让「换过手机号/换过微信」的用户永远付不了款（微信弹「下单账号与支付账号不一致」）。
  const openid = payOpenid ?? m?.wechatOpenid
  if (!openid) throw new NoOpenidError()
  const { prepayId } = await createJsapiOrder({
    description: `大帅餐饮·${pkg.name}`,
    outTradeNo: orderNo,
    amountFen: pkg.priceFen,
    openid,
    // 与本地 expireAt 严格一致（见 ORDER_TTL_MS 的说明）
    timeExpire: toRfc3339(order.expireAt),
  })
  await prisma.order.update({ where: { id: order.id }, data: { wxPrepayId: prepayId } })
  return {
    dev: false,
    orderNo,
    amountFen: pkg.priceFen,
    beans: '0',
    memberDiscountApplied: false,
    payChannel: 'jsapi',
    payParams: buildPayParams(prepayId),
  }
}

/** 标记订单已支付并结算（终态 CAS：仅 PENDING→PAID 可发放权益，并发重复回调天然幂等）
 *
 * `wxTransactionId` 允许为 null —— 后台手动开通会员没有微信交易号，走的也是这个函数，
 * 这样「赠积分进哪个桶 / 到期怎么清 / 续期怎么顺延 / 幂等键怎么算」只有一份实现，
 * 不会出现「后台开的会员和付钱买的会员账务口径不一样」。
 *
 * ★ 本函数是「订单变 PAID」的**唯一**写入点（全仓已核对），因此它同时负责写
 *   `order_settlement` 回执 —— 回执存在 ⟺ 事务提交 ⟺ 权益已发。
 *   这条不变量是 `pay-risk.service.ts` 的核对依据；一旦将来有人在事务外
 *   补一句 `order.update({status:'PAID'})`，回执核对会立刻报出来。
 */
export async function markOrderPaid(
  prisma: PrismaClient,
  orderNo: string,
  wxTransactionId: string | null,
  _dev = false,
  grantRemark?: string,
  source: SettlementSource = 'NOTIFY',
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { orderNo } })
  if (!order) throw new Error(`order not found: ${orderNo}`)
  if (order.status === 'PAID') return

  // 订阅参数后台可改，在事务外读取（getNumber 不接受 TransactionClient）
  const subDurationDays = await getNumber(prisma, 'subscription', 'duration_days', 30)
  const subGrantPoints = BigInt(
    Math.round(await getNumber(prisma, 'subscription', 'grant_points', 98000)),
  )

  /**
   * 事务内**收集**、提交后**才发**的告警。
   *
   * ★ 不能在事务内直接 raiseOpsAlert：它要发 HTTP，把网络往返塞进持有行锁的事务里，
   *   等于用一个第三方服务的超时去阻塞一笔资金事务。收集起来提交后再发，
   *   代价是「事务提交成功但进程在发告警前崩了 ⇒ 这条告警只丢在日志里」——
   *   可接受，因为回执已经落库，`auditPaidSettlements()` 的下一次扫描仍能发现问题。
   */
  const afterCommitAlerts: RaiseOpsAlertInput[] = []

  // ★ isolationLevel 必须显式设为 READ COMMITTED，否则 activateMembership 里那把商户锁**形同虚设**：
  //   MySQL 默认 REPEATABLE READ 下，「一致读」的读视图由事务内第一条**非锁定** SELECT 建立。
  //   本事务在拿锁之前就先读了 member_package，读视图在那一刻就被定死了 ——
  //   即便随后 lockMerchantAccount 会阻塞到对手提交，锁内的 membership 查询仍然用旧快照，
  //   于是「锁内重新读当前会员」读到的还是「没有有效会员」→ 两笔订单各建一行、各算同一个到期时间。
  //   实测：不加这一行，两笔并发会员订单只续一期且留下两行重叠的 ACTIVE 会员。
  //   （同族的坑见 domain/request.ts::claimBusinessRequest 的注释。）
  await prisma.$transaction(async (tx: Db) => {
    // 微信回调会重试、并发回调也可能同时通过外层「已 PAID」的快照检查；
    // 只有抢到状态流转的那一个会发放权益，另一个 count=0 直接返回，
    // 靠这一步杜绝双重发积分 / 双开会员。
    //
    // ★ 允许的来源状态除 PENDING 外，还包括 EXPIRED / CANCELLED。
    //   这两种状态意味着「本地已经判定它不会再付了」；但用户完全可能在关闭之前就付了钱
    //   （关单与支付之间的竞态），或者关单失败。回调此时依然会到达 ——
    //   若只认 PENDING，这次更新就是 0 行，权益被**静默吞掉**：钱收了、货没发，
    //   而且库里连一行线索都不留（旧实现的这条路径上没有任何日志）。
    //   真实收款必须兑现，所以这里把它收敛为「补发权益」，并留下告警供对账核查。
    const claimed = await tx.order.updateMany({
      where: { orderNo, status: { in: ['PENDING', 'EXPIRED', 'CANCELLED'] } },
      data: { status: 'PAID', paidAt: new Date(), wxTransactionId },
    })
    if (claimed.count === 0) return
    if (order.status !== 'PENDING') {
      console.warn(
        `[pay] 订单 ${orderNo} 在本地状态为 ${order.status} 时收到支付成功，已按补发处理` +
          `（关单/过期与支付之间的竞态）。本地过期时间 ${order.expireAt.toISOString()}，请核对微信侧交易号 ${wxTransactionId ?? '-'}`,
      )
      // 这是「钱已经收了、货差点没发」的现场 —— 必须有人知道，不能只有一行 console.warn
      afterCommitAlerts.push({
        code: 'PAY_SETTLE_AFTER_TERMINAL',
        severity: 'CRITICAL',
        title: `订单在终态（${order.status}）下收到支付成功，已按补发处理`,
        detail:
          `订单 ${orderNo} 本地状态曾是 ${order.status}（过期时间 ` +
          `${order.expireAt.toISOString()}），微信侧仍完成了收款（交易号 ${wxTransactionId ?? '-'}）。` +
          `系统已补发权益，但需核对：是否真的收到了钱、以及「本地已关单、微信仍可付」这个窗口是怎么出现的。`,
        refType: 'order',
        refId: orderNo,
        // 按订单去重：同一张单的重复回调不该重复告警
        dedupeKey: `PAY_SETTLE_AFTER_TERMINAL:${orderNo}`,
      })
    }

    let grantedBeans = 0n
    let membershipEndAt: Date | null = null
    if (order.orderType === 'BEAN') {
      await recharge(tx, { merchantId: order.merchantId, amount: order.beans, bizId: order.orderNo })
      grantedBeans = order.beans
    } else if (order.orderType === 'MEMBER') {
      const activated = await activateMembership(tx, order.merchantId, order.refId, order.id, {
        durationDays: subDurationDays,
        grantPoints: subGrantPoints,
        grantRemark,
      })
      grantedBeans = activated.grantedPoints
      membershipEndAt = activated.endAt
    }

    // ★ 结算回执：与上面的 CAS、发权益在**同一事务**内。
    //   用 upsert 而不是 create：orderId 上有唯一索引，正常情况下 create 足够
    //   （CAS 保证一张单只结算一次）；但万一有人把已 PAID 的单手工改回 PENDING 再走一次结算，
    //   create 会抛唯一键冲突 ⇒ 整个事务回滚 ⇒ 订单永远卡在 PENDING 且没有任何线索。
    //   upsert 让「重复结算」退化成无害的幂等写，把那种极端情形的影响限制在「回执保留首次值」。
    await tx.orderSettlement.upsert({
      where: { orderId: order.id },
      create: {
        orderId: order.id,
        orderNo: order.orderNo,
        merchantId: order.merchantId,
        orderType: order.orderType,
        amountFen: order.amountFen,
        grantedBeans,
        membershipEndAt,
        source,
        wxTransactionId,
      },
      update: {},
    })
  }, { isolationLevel: 'ReadCommitted' })

  // ── 提交后补发告警（永不抛错，见 ops-alert.service.ts 的契约）──
  for (const a of afterCommitAlerts) {
    await raiseOpsAlert(prisma, a)
  }
}

/** 激活 / 续期订阅，并发放赠送积分。
 *
 * 返回值供**结算回执**留痕：本次结算后会员到哪天、实际发了多少积分。
 * 之所以要返回而不是让调用方自己再查一遍：`grantedPoints` 是「本次实际发放」，
 * 而 `grantPoints > 0n` 的短路意味着「发了 0」也可能是一个合法结果 ——
 * 只有在这里才能把「本该发多少」与「实际发了多少」一次说清。
 */
async function activateMembership(
  tx: Db,
  merchantId: bigint,
  packageId: bigint,
  sourceOrderId: bigint | null,
  override?: { durationDays: number; grantPoints: bigint; grantRemark?: string },
): Promise<{ endAt: Date; grantedPoints: bigint; renewed: boolean }> {
  const pkg = await tx.memberPackage.findUnique({ where: { id: packageId } })
  if (!pkg) throw new PackageNotFoundError()
  const now = new Date()
  // 后台可改：SystemSetting.subscription.* 优先于套餐默认值
  const durationDays = override?.durationDays ?? pkg.durationDays
  const grantPoints = override?.grantPoints ?? pkg.grantBeans
  const durationMs = durationDays * 24 * 60 * 60 * 1000

  // ★★ 必须在读 existing 之前先拿商户级锁，否则「续期少一期」：
  //   两笔会员订单各自完成订单 CAS 后，都读到同一个 existing.endAt（例如 T），
  //   各自算出同一个新结束时间 T+30d 并覆盖写入 ——
  //   两笔都 PAID、两次都发了赠积分，但会员期只增加了一次。
  //   首次开通同理：两笔都查不到有效会员 → 各建一行 → 出现两行重叠的 ACTIVE。
  //   锁与帐务用的是同一把（bean_account 行锁），所以与结算/清零天然互斥。
  await lockMerchantAccount(tx, merchantId)

  const existing = await tx.membership.findFirst({
    where: { merchantId, status: 'ACTIVE', endAt: { gt: now } },
    orderBy: { endAt: 'desc' },
  })

  let endAt: Date
  if (existing) {
    // 续期：在现有结束时间上顺延
    const newEnd = new Date(existing.endAt.getTime() + durationMs)
    await tx.membership.update({
      where: { id: existing.id },
      data: { endAt: newEnd, grantBeans: { increment: grantPoints }, grantExpireAt: newEnd },
    })
    endAt = newEnd
  } else {
    // 锁内重判后仍无有效会员，才允许新建。同时把历史遗留的 ACTIVE 但已过期的行收口，
    // 避免「一行已过期仍 ACTIVE + 一行新 ACTIVE」在到期扫描里被反复当成候选。
    await tx.membership.updateMany({
      where: { merchantId, status: 'ACTIVE', endAt: { lte: now } },
      data: { status: 'EXPIRED' },
    })
    endAt = new Date(now.getTime() + durationMs)
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
      source: 'MEMBERSHIP', // 会员周期赠积分：会随会员到期清零
      remark: override?.grantRemark,
    })
  }
  return { endAt, grantedPoints: grantPoints, renewed: !!existing }
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
 *   · 赠积分走 `grant(source:'MEMBERSHIP')` → 进**会员桶**，随会员到期清零（与线上购买完全一致）
 *   · 幂等键 = `membership:<orderId>`，每次开通都是一张新订单 ⇒ 重复开通就是真续期，不会双发
 *   · 在后台「最近订单」里留下一行可追溯记录（orderNo 以 `A` 开头 = 后台单，无微信交易号）
 *   · 时长 / 赠积分取 `SystemSetting.subscription.*`，与线上购买共用同一份配置
 *
 * 操作人记录在赠积分流水的 remark 里（BeanLedger 是唯一有留痕字段的账务表）。
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
    'ADMIN',
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

/** 微信支付回调：解密 → 落库（幂等）
 *
 * ★ 这个函数的所有失败路径原本都只返回 `{code:'FAIL'}` —— 对微信有意义（它会重试），
 *   对**我们**毫无意义：重试 15 次后微信也放弃，本地就永久停在 PENDING，而没有任何人知道。
 *   所以每个失败分支都必须留下一行告警。这就是「扣款成功但开通失败」最直接的现场。
 *
 * 关于阻塞：告警里有一次 webhook 推送（最长 `OPS_ALERT_TIMEOUT_MS`）。放在这里可以接受 ——
 *   ① 只有**首次**出现才会推（同键后续都命中去重，只剩一次 DB 写）；
 *   ② 走到这里本来就要返回 FAIL、微信本来就要重试，慢一点不改变结局；
 *   ③ 一条 5 秒的推送换「有人知道钱收错了」，很划算。
 */
export async function handleNotify(prisma: PrismaClient, rawBody: string): Promise<{ code: 'SUCCESS' | 'FAIL'; message?: string }> {
  let outTradeNo = ''
  try {
    const payload = JSON.parse(rawBody) as { resource?: { ciphertext: string; nonce: string; associated_data?: string } }
    if (!payload.resource) throw new Error('missing resource')
    const decrypted = decryptResource(payload.resource)
      if (decrypted.appid !== (process.env.WX_APPID ?? '') || decrypted.mchid !== (process.env.WX_PAY_MCH_ID ?? '')) throw new Error('payment merchant mismatch')
    outTradeNo = decrypted.outTradeNo
    if (decrypted.tradeState === 'SUCCESS') {
      const order = await prisma.order.findUnique({ where: { orderNo: decrypted.outTradeNo }, select: { amountFen: true } })
      // ★ 查无此单与金额不符是**两件事**，必须给不同的 message：
      //   下面那个 catch 用 message 判断「是否已单独告警过」，共用一个字符串会让
      //   「收到一笔本地根本不存在的订单的钱」这条更严重的情况被静默跳过。
      if (!order) throw new Error('order not found for notify')
      if (order.amountFen !== decrypted.amountFen) {
        // ★ 单独拉出来：这不是「回调处理失败」，而是**资金对不上**。
        //   本地会永久拒绝结算（对账查单走同一条金额校验，同样拒），
        //   所以它不是「重试一下就好了」，必须人工核对 —— 用 CRITICAL。
        await raiseOpsAlert(prisma, {
          code: 'PAY_AMOUNT_MISMATCH',
          severity: 'CRITICAL',
          title: '微信回调查询金额与本地订单不一致，已拒绝结算',
          detail:
            `订单 ${decrypted.outTradeNo}：微信侧收款 ${decrypted.amountFen} 分，本地订单 ${order.amountFen} 分。` +
            `本地已按「拒绝结算」处理（防止用错误金额发放权益），该单会**一直停在待支付**直到人工介入。` +
            `微信交易号 ${decrypted.transactionId ?? '-'}。请核对是本地金额写错、还是这笔钱不属于这张单。`,
          refType: 'order',
          refId: decrypted.outTradeNo,
          dedupeKey: `PAY_AMOUNT_MISMATCH:${decrypted.outTradeNo}`,
        })
        throw new Error('payment amount mismatch')
      }
      await markOrderPaid(prisma, decrypted.outTradeNo, decrypted.transactionId, false, undefined, 'NOTIFY')
    }
    return { code: 'SUCCESS' }
  } catch (e) {
    const message = (e as Error).message
    // 金额不一致已经在上面单独告警过；这里只兜「其他」失败，避免同一个原因报两次。
    if (message !== 'payment amount mismatch') {
      await raiseOpsAlert(prisma, {
        code: 'PAY_NOTIFY_FAILED',
        severity: 'WARN',
        title: '微信支付回调处理失败（已返回 FAIL，微信会重试）',
        detail:
          `订单 ${outTradeNo || '(未解析出订单号)'} 回调处理抛错：${message}。` +
          `微信会重试，但重试耗尽后本单将永久停在待支付 —— 若持续失败请人工介入。`,
        refType: outTradeNo ? 'order' : undefined,
        refId: outTradeNo || undefined,
        // 按订单+原因去重：微信 15 次重试只应产生一条告警
        dedupeKey: `PAY_NOTIFY_FAILED:${outTradeNo || 'unknown'}:${message.slice(0, 60)}`,
      })
    }
    return { code: 'FAIL', message }
  }
}

export type { Prisma }
