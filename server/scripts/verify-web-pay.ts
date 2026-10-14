// 官网（Web）支付与公开服务目录的**离线**契约校验：不连数据库、不调用微信。
//
// 为什么单独钉这几条：
//   线上小程序的下单路径有 `verify-payments-switch` / `pay-openid` / `pay-reconcile` 一堆守护，
//   而官网这条是**新增的第二条下单入口**。它复用同一张 order 表、同一个 markOrderPaid，
//   所以任何一处口径不对都不是「官网自己的小问题」，而是会污染线上资金与权益。
//
// 本脚本按「判据」而不是「实现」来断言，共四组：
//   A. 闸门：通道未开 / 总闸关闭时**必须拒绝，且不得落库**（拒绝晚一步就留下垃圾待支付单）
//   B. 建单：订单号前缀、占位 wxPrepayId、金额、到账积分、H5 必带付款人 IP
//   C. 重付：场景不可变更、已支付/已失效拒绝、非网页单不许走这条路
//   D. 目录：**展示口径必须等于结算口径**（显示 1095 天就必须按 1095 天发，否则是误售）
import type { PrismaClient } from '@prisma/client'
import { invalidate } from '../src/lib/settings.js'
import { PackageNotFoundError, PaymentUnavailableError } from '../src/services/order.service.js'
import { SubscriptionRequiredError } from '../src/services/subscription.service.js'
import {
  createWebOrder,
  getWebCatalog,
  payWebOrder,
  WebOrderError,
  webPayCapabilities,
} from '../src/services/web-order.service.js'

let pass = 0
let fail = 0
/**
 * ★ 必须自己处理 BigInt：订单金额/积分是 `bigint`，而 `JSON.stringify(12000n)` 直接抛
 *   `TypeError: Do not know how to serialize a BigInt` —— 比较器一崩，整份守护就变成
 *   「本地跑不过」的假红灯，真正的断言反而没人看。
 */
function norm(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v))
}
function check(label: string, actual: unknown, expected: unknown): void {
  if (norm(actual) === norm(expected)) {
    console.log(`通过：${label}`)
    pass++
  } else {
    console.error(`失败：${label}，实际 ${norm(actual)}，期望 ${norm(expected)}`)
    fail++
  }
}
async function rejection(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e as Error
  }
}
/** 断言「必须被拒」，并核对错误类型与业务码（码错了客户端文案就错了） */
async function checkReject(
  label: string,
  fn: () => Promise<unknown>,
  expectedName: string,
  expectedCode?: number,
): Promise<void> {
  const error = await rejection(fn)
  if (!error) {
    check(`${label}（必须被拒）`, '未抛错', `抛 ${expectedName}`)
    return
  }
  check(`${label} → ${expectedName}`, error.name, expectedName)
  if (expectedCode !== undefined) {
    check(`${label} → 业务码 ${expectedCode}`, (error as { code?: number }).code, expectedCode)
  }
}

interface PlanRow {
  id: string
  name: string
  priceFen: number
  durationDays: number
  grantBeans: bigint
}
interface PackageRow {
  id: string
  name: string
  priceFen: number
  beans: bigint
  bonusBeans: bigint
}

interface DbOptions {
  plans?: PlanRow[]
  packages?: PackageRow[]
  settings?: Record<string, string>
  member?: boolean
  order?: Record<string, unknown> | null
}

/** 假库：只实现被测函数真正会碰到的几个查询，并把入参记下来供断言 */
function makeDb(options: DbOptions = {}) {
  const created: Record<string, unknown>[] = []
  const inputArgs: Record<string, unknown> = {}
  const db = {
    created,
    inputArgs,
    systemSetting: {
      findUnique: async ({ where }: { where: { groupKey_settingKey: { groupKey: string; settingKey: string } } }) => {
        const { groupKey, settingKey } = where.groupKey_settingKey
        const value = options.settings?.[`${groupKey}.${settingKey}`]
        return value === undefined ? null : { settingVal: value }
      },
    },
    memberPackage: {
      findMany: async (args: unknown) => {
        inputArgs.memberPlans = args
        return options.plans ?? []
      },
      findFirst: async ({ where }: { where: { id: bigint } }) =>
        (options.plans ?? []).find((p) => BigInt(p.id) === where.id) ?? null,
    },
    beanPackage: {
      findMany: async (args: unknown) => {
        inputArgs.beanPackages = args
        return options.packages ?? []
      },
      findFirst: async ({ where }: { where: { id: bigint } }) =>
        (options.packages ?? []).find((p) => BigInt(p.id) === where.id) ?? null,
    },
    membership: {
      findFirst: async () => (options.member ? { id: 1n } : null),
    },
    order: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
        return { id: BigInt(created.length), ...data }
      },
      findFirst: async (args: { where: { orderNo: string; merchantId?: bigint } }) => {
        inputArgs.orderFindFirst = args
        const row = options.order
        // ★ 必须按 merchantId 过滤：桩若不比对，就等于把「服务端有没有做归属校验」这件事
        //   测成了「桩自己怎么写的」—— 那是最典型的自证式假绿。
        if (!row || String(row.orderNo) !== args.where.orderNo) return null
        if (args.where.merchantId !== undefined && String(args.where.merchantId) !== String(row.merchantId)) return null
        return row
      },
    },
  }
  return db as unknown as PrismaClient & {
    created: Record<string, unknown>[]
    inputArgs: Record<string, unknown>
  }
}

const MERCHANT = 42n
const H5_IP = '203.0.113.9'
const OPEN = () => ({ native: true, h5: true })
const CLOSED = () => ({ native: false, h5: false })

const PLANS: PlanRow[] = [{ id: '7', name: '大帅年卡', priceFen: 98000, durationDays: 30, grantBeans: 0n }]
const PACKAGES: PackageRow[] = [
  { id: '3', name: '加油包·小', priceFen: 9900, beans: 10000n, bonusBeans: 2000n },
]

async function main(): Promise<void> {
  console.log('A. 闸门：未开放的通道一律拒绝，且不得落库')
  const gateOff = makeDb({ plans: PLANS, packages: PACKAGES, member: true })
  await checkReject(
    'Native 通道未开时建单',
    () => createWebOrder(gateOff, MERCHANT, { kind: 'MEMBER', packageId: 7n, scene: 'NATIVE' }, undefined, {
      capabilities: CLOSED,
    }),
    'PaymentUnavailableError',
  )
  await checkReject(
    'H5 通道未开时建单',
    () => createWebOrder(gateOff, MERCHANT, { kind: 'BEAN', packageId: 3n, scene: 'H5' }, H5_IP, {
      capabilities: CLOSED,
    }),
    'PaymentUnavailableError',
  )
  check('拒绝发生在落库之前（无残留待支付单）', gateOff.created.length, 0)

  check('缺 WEB_PAY_* 开关 ⇒ 网页通道关闭', webPayCapabilities({ WEB_PAY_NATIVE_ENABLED: 'true' }).h5, false)
  check('只有 WEB_PAY_* 而总闸关闭 ⇒ 仍关闭', webPayCapabilities({
    PAYMENTS_ENABLED: 'false', WEB_PAY_NATIVE_ENABLED: 'true', WEB_PAY_H5_ENABLED: 'true',
  }), { native: false, h5: false })

  console.log('B. 建单：订单号、占位 prepayId、金额与到账积分')
  const beanOff = makeDb({ plans: PLANS, packages: PACKAGES, member: false })
  await checkReject(
    '非会员买加油包',
    () => createWebOrder(beanOff, MERCHANT, { kind: 'BEAN', packageId: 3n, scene: 'NATIVE' }, undefined, {
      capabilities: OPEN,
    }),
    'SubscriptionRequiredError',
  )
  check('非会员被拦时不落库', beanOff.created.length, 0)

  const zero = makeDb({ plans: [], packages: [{ id: '9', name: '零元包', priceFen: 0, beans: 0n, bonusBeans: 0n }], member: true })
  await checkReject(
    '金额为 0 的套餐',
    () => createWebOrder(zero, MERCHANT, { kind: 'BEAN', packageId: 9n, scene: 'NATIVE' }, undefined, {
      capabilities: OPEN,
    }),
    'WebOrderError',
    3012,
  )
  await checkReject(
    '包不存在',
    () => createWebOrder(makeDb({ plans: PLANS }), MERCHANT, { kind: 'MEMBER', packageId: 999n, scene: 'NATIVE' }, undefined, { capabilities: OPEN }),
    'PackageNotFoundError',
  )
  await checkReject(
    'H5 拿不到付款人 IP',
    () => createWebOrder(makeDb({ plans: PLANS }), MERCHANT, { kind: 'MEMBER', packageId: 7n, scene: 'H5' }, undefined, { capabilities: OPEN }),
    'WebOrderError',
    4000,
  )

  const beanOk = makeDb({ plans: PLANS, packages: PACKAGES, member: true })
  const payCalls: Array<Record<string, unknown>> = []
  const beanResult = await createWebOrder(
    beanOk, MERCHANT, { kind: 'BEAN', packageId: 3n, scene: 'H5' }, H5_IP,
    { capabilities: OPEN, createPay: async (input) => { payCalls.push(input as unknown as Record<string, unknown>); return { h5Url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=x' } } },
  )
  const beanRow = beanOk.created[0]
  if (!beanRow) throw new Error('未创建加油包订单，后续断言无意义')
  check('加油包订单类型', beanRow.orderType, 'BEAN')
  check('加油包到账 = 基础 + 赠送', beanRow.beans, 12000n)
  check('金额取套餐价', beanRow.amountFen, 9900)
  check('订单号形如 BW+30 位（与现有查单前缀兼容）', /^BW[0-9a-f]{30}$/.test(String(beanRow.orderNo)), true)
  check('下单即写占位，避免与小程序 prepay_id 混淆', beanRow.wxPrepayId, 'WEB:H5')
  check('初始状态为待支付', beanRow.status, 'PENDING')
  check('订单归属当前商户', String(beanRow.merchantId), String(MERCHANT))
  check('到期时间在 14~16 分钟内', Math.abs(Number(beanRow.expireAt) - Date.now() - 15 * 60 * 1000) < 60 * 1000, true)
  check('返回 H5 跳转地址', typeof beanResult.h5Url, 'string')
  check('H5 上报付款人真实 IP', payCalls[0]?.payerClientIp, H5_IP)
  check('微信侧收单号 = 本地订单号', payCalls[0]?.outTradeNo, beanRow.orderNo)
  check('金额按分下发且一致', payCalls[0]?.amountFen, 9900)
  check('time_expire 用 RFC3339（微信只认这种）', String(payCalls[0]?.timeExpire).endsWith('+00:00'), true)

  const memberOk = makeDb({ plans: PLANS, member: false })
  const memberCalls: Array<Record<string, unknown>> = []
  const memberResult = await createWebOrder(
    memberOk, MERCHANT, { kind: 'MEMBER', packageId: 7n, scene: 'NATIVE' }, undefined,
    { capabilities: OPEN, createPay: async (input) => { memberCalls.push(input as unknown as Record<string, unknown>); return { codeUrl: 'weixin://wxpay/bizpayurl?pr=abc' } } },
  )
  const memberRow = memberOk.created[0]
  if (!memberRow) throw new Error('未创建会员订单，后续断言无意义')
  check('会员订单类型', memberRow.orderType, 'MEMBER')
  check('会员单不发放积分（积分由结算时按后台配置给）', memberRow.beans, 0n)
  check('会员订单号形如 MW+30 位', /^MW[0-9a-f]{30}$/.test(String(memberRow.orderNo)), true)
  check('Native 单不要求付款人 IP', memberCalls[0]?.payerClientIp, undefined)
  check('Native 返回二维码链接', typeof memberResult.codeUrl, 'string')
  check('未打折标记为 false（网页按套餐原价）', memberRow.memberDiscountApplied, false)

  console.log('C. 重付：场景不可变更、终态拒绝、非网页单不许走')
  const webOrder = (over: Record<string, unknown> = {}) => ({
    orderNo: `MW${'a'.repeat(30)}`,
    merchantId: MERCHANT,
    orderType: 'MEMBER',
    amountFen: 98000,
    status: 'PENDING',
    wxPrepayId: 'WEB:NATIVE',
    expireAt: new Date(Date.now() + 10 * 60 * 1000),
    ...over,
  })
  /**
   * ★ 所有拒绝类用例都注入「一被调用就喊」的查单桩。
   *   否则默认走真 `queryAndSettle`：一旦某条用例突破了预期的那道闸，
   *   它就会真的向微信发一次查单请求 —— 守护脚本**绝不能联网**。
   *   注入后同一情形会以一句「本用例不应触发微信查单」当场失败，定位也更快。
   */
  const denyReconcile = async (): Promise<never> => {
    throw new Error('本用例不应触发微信查单')
  }
  await checkReject(
    'NATIVE 单改用 H5 重付',
    () => payWebOrder(makeDb({ order: webOrder() }), MERCHANT, `MW${'a'.repeat(30)}`, 'H5', H5_IP, { capabilities: OPEN, reconcile: denyReconcile }),
    'WebOrderError',
    3011,
  )
  await checkReject(
    '已支付订单再付',
    () => payWebOrder(makeDb({ order: webOrder({ status: 'PAID' }) }), MERCHANT, `MW${'a'.repeat(30)}`, 'NATIVE', undefined, { capabilities: OPEN, reconcile: denyReconcile }),
    'WebOrderError',
    3009,
  )
  await checkReject(
    '已失效订单再付',
    () => payWebOrder(makeDb({ order: webOrder({ status: 'EXPIRED' }) }), MERCHANT, `MW${'a'.repeat(30)}`, 'NATIVE', undefined, { capabilities: OPEN, reconcile: denyReconcile }),
    'WebOrderError',
    3010,
  )
  await checkReject(
    '小程序单（无 WEB 占位）不得从网页重付',
    () => payWebOrder(makeDb({ order: webOrder({ wxPrepayId: 'wx1234567890' }) }), MERCHANT, `MW${'a'.repeat(30)}`, 'NATIVE', undefined, { capabilities: OPEN, reconcile: denyReconcile }),
    'WebOrderError',
    3004,
  )
  const stolen = makeDb({ order: webOrder() })
  await checkReject(
    '别人家的订单号不得重付',
    () => payWebOrder(stolen, 43n, `MW${'a'.repeat(30)}`, 'NATIVE', undefined, { capabilities: OPEN, reconcile: denyReconcile }),
    'WebOrderError',
    3004,
  )
  check(
    '重付查库必须带 merchantId 过滤（否则可越权付别人的单）',
    String((stolen.inputArgs.orderFindFirst as { where: { merchantId?: bigint } } | undefined)?.where.merchantId),
    '43',
  )
  await checkReject(
    '通道关闭时不重付',
    () => payWebOrder(makeDb({ order: webOrder() }), MERCHANT, `MW${'a'.repeat(30)}`, 'NATIVE', undefined, { capabilities: CLOSED, reconcile: denyReconcile }),
    'PaymentUnavailableError',
  )

  console.log('D. 目录：展示口径 = 结算口径')
  // ★★ 这里的 `settings` 是**故意写成与套餐行不同**的值（1095/30000 vs 套餐行 30/0），
  //   用来证明 `SystemSetting.subscription.*` 已经**不再影响目录**。
  //
  //   ⚠ 这段断言在 2026-10-14 之前期望值是**反的**（「会员周期取后台配置而不是套餐原值」）：
  //     它把「套餐名写『订阅 · 3年』、有效期却显示 30 天」这个线上矛盾**固化成了契约**，
  //     于是真实的数据源缺陷被守护照单全收、测试全绿。
  //     ⇒ 守护断言一旦写反，红灯永远等不到。改这里时必须让 settings 与套餐行**不同**，
  //       否则「读没读 settings」根本区分不出来（两边相等时怎么读都通过）。
  invalidate()
  const catalogDb = makeDb({
    plans: PLANS,
    packages: PACKAGES,
    settings: { 'subscription.duration_days': '1095', 'subscription.grant_points': '30000' },
  })
  const catalog = await getWebCatalog(catalogDb)
  check('只列启用的会员套餐', JSON.stringify((catalogDb.inputArgs.memberPlans as { where?: unknown })?.where), JSON.stringify({ enabled: true }))
  check('只列启用的加油包', JSON.stringify((catalogDb.inputArgs.beanPackages as { where?: unknown })?.where), JSON.stringify({ enabled: true }))
  check('会员周期取套餐行原值，不被 SystemSetting 覆盖', catalog.plans[0]?.durationDays, PLANS[0]!.durationDays)
  check('赠送积分取套餐行原值，不被 SystemSetting 覆盖', catalog.plans[0]?.grantBeans, PLANS[0]!.grantBeans.toString())
  check('价格仍来自套餐行', catalog.plans[0]?.priceFen, 98000)
  check('加油包原价直出不本地打折', catalog.packages[0]?.priceFen, 9900)
  check('目录能力位与服务端开关同源', catalog.capabilities, webPayCapabilities())

  invalidate()
  const emptyDb = makeDb({ settings: { 'subscription.duration_days': '30', 'subscription.grant_points': '98000' } })
  const empty = await getWebCatalog(emptyDb)
  check('无套餐时给空数组而不是报错', [empty.plans.length, empty.packages.length], [0, 0])
  invalidate()

  // 顺带确认这些错误类型确实是路由层要映射的那几个（改名会让路由的 catch 静默漏掉）
  check('PaymentUnavailableError 名称稳定', new PaymentUnavailableError('x').name, 'PaymentUnavailableError')
  check('SubscriptionRequiredError 名称稳定', new SubscriptionRequiredError('x').name, 'SubscriptionRequiredError')
  check('PackageNotFoundError 名称稳定', new PackageNotFoundError().name, 'PackageNotFoundError')

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
