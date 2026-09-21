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
      expireAt: new Date(Date.now() + ORDER_TTL_MS),
    },
  })

  if (payMode === 'demo') {
    await markOrderPaid(prisma, orderNo, `TEST${orderNo}`, true, undefined, 'DEMO')
    return { dev: true, orderNo, amountFen, beans: beans.toString(), memberDiscountApplied: false, payParams: null }
  }

  const m = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!m?.wechatOpenid) throw new NoOpenidError()
  const { prepayId } = await createJsapiOrder({
    description: `大帅餐饮·加油包${beans}积分`,
    outTradeNo: orderNo,
    amountFen,
    openid: m.wechatOpenid,
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
    await markOrderPaid(prisma, orderNo, `TEST${orderNo}`, true, undefined, 'DEMO')
    return { dev: true, orderNo, amountFen: pkg.priceFen, beans: '0', memberDiscountApplied: false, payParams: null }
  }

  const m = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!m?.wechatOpenid) throw new NoOpenidError()
  const { prepayId } = await createJsapiOrder({
    description: `大帅餐饮·${pkg.name}`,
    outTradeNo: orderNo,
    amountFen: pkg.priceFen,
    openid: m.wechatOpenid,
    // 与本地 expireAt 严格一致（见 ORDER_TTL_MS 的说明）
    timeExpire: toRfc3339(order.expireAt),
  })
  await prisma.order.update({ where: { id: order.id }, data: { wxPrepayId: prepayId } })
  return { dev: false, orderNo, amountFen: pkg.priceFen, beans: '0', memberDiscountApplied: false, payParams: buildPayParams(prepayId) }
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
