// 充值 / 会员 / 我的 API：对接 /api/v1/orders
import { http } from './request'

export interface BeanPackage {
  id: string
  name: string
  beans: string
  bonusBeans: string
  priceFen: number
  memberPriceFen: number
  tag: string | null
  sort: number
  enabled: boolean
}

export interface MemberPlan {
  id: string
  name: string
  code: string
  durationDays: number
  priceFen: number
  grantBeans: string
  rightsJson: { uploadQuotaBytes?: number; pointsPerYuan?: number } | null
  tag: string | null
  sort: number
}

export interface MeInfo {
  balance: { available: string; balance: string; grantBalance: string; frozen: string }
  subscription: { active: boolean; planName: string | null; endAt: string | null; grantPoints: string }
  storage: { usedBytes: string; quotaBytes: string; subscribed: boolean }
}

export interface PayParams {
  timeStamp: string
  nonceStr: string
  package: string
  signType: 'RSA'
  paySign: string
}

export interface CreateOrderResult {
  dev: boolean
  orderNo: string
  amountFen: number
  beans: string
  memberDiscountApplied: boolean
  payParams: PayParams | null
}

export function getMe() {
  return http.get<MeInfo>('/orders/me')
}
export function listBeanPackages() {
  return http.get<BeanPackage[]>('/orders/recharge/packages')
}
export function listMemberPlans() {
  return http.get<MemberPlan[]>('/orders/membership/plans')
}
/**
 * 下单。
 *
 * `wxLoginCode` = 支付前 `wx.login()` 拿到的 code，**可选**。
 * ★ 为什么必须有它：微信 JSAPI 支付要付款人的 `openid`，而**手机号验证码登录**的账号
 *   在服务端没有 openid（短信登录路径不取）⇒ 不带它就是 3007「账号未绑定微信，无法支付」。
 *   传上它，服务端会换出 openid 并按需绑定到当前账号；一键登录的账号传了也是幂等无变化。
 */
export function createBeanOrder(packageId: string, wxLoginCode?: string) {
  return http.post<CreateOrderResult>('/orders/recharge/order', { packageId, wxLoginCode })
}
export interface OrderStatus {
  orderNo: string
  status: 'PENDING' | 'PAID' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED' | string
  orderType: string
  amountFen: number
  beans: string
  paidAt: string | null
  expireAt: string | null
}

export function createMemberOrder(packageId: string, wxLoginCode?: string) {
  return http.post<CreateOrderResult>('/orders/membership/order', { packageId, wxLoginCode })
}

export function getOrderStatus(orderNo: string) {
  return http.get<OrderStatus>(`/orders/${encodeURIComponent(orderNo)}`)
}

export interface QueryOrderResult extends OrderStatus {
  /** 服务端本次主动查单的结果（outcome 见后端 ReconcileOutcome） */
  reconcile?: { outcome: string; message: string }
}

/**
 * 支付完成后**主动查单**。
 *
 * 与 getOrderStatus 的区别：后者只读本地库，前者会让服务端去微信查这笔单，
 * 确认已支付就**当场补发权益**。
 *
 * 为什么必须用这个：微信的支付回调不是可靠通道 —— notify_url 不可达（本项目卡在备案上）、
 * 网络抖动、微信重试耗尽都会让回调**静默丢失**。此时用户钱已付、微信侧已是 SUCCESS，
 * 而本地订单永远停在 PENDING，用户看到的就是「付了钱没到账」。
 */
export function queryOrder(orderNo: string) {
  return http.post<QueryOrderResult>(`/orders/${encodeURIComponent(orderNo)}/query`, {})
}

/** 订单列表里的一条。字段与服务端 `OrderListItem` 一一对应。 */
export interface OrderListItem {
  orderNo: string
  /** `MEMBER` 会员订阅 / `BEAN` 积分加油包 */
  orderType: string
  /** 套餐名（服务端补的；套餐下架后是兜底文案） */
  title: string
  status: 'PENDING' | 'PAID' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED' | string
  amountFen: number
  beans: string
  /** 支付时间；未支付为 null */
  paidAt: string | null
  createdAt: string
}

export interface OrderListPage {
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  list: OrderListItem[]
}

/**
 * 订单列表（「订单中心」页用）。
 *
 * ★★ 存在的理由不只是「给用户看历史订单」：微信自 2022-12-31 起要求有
 *   「选择商品/服务 → 下单 → 支付」完整流程的小程序，必须在小程序内设置**订单中心页**
 *   并把 path 同步给平台，页面须展示**所有涉及资金交易的订单明细**。
 *   本应用有会员订阅与积分加油包两条真实支付流程，此前只有「按单号查一笔」
 *   ⇒ 既没有可填给平台的 path，也兑现不了隐私政策里「可在『我的』查看订单」那句承诺。
 *
 * ★ 分页参数放进 query（`http.get` 的第二参会作为 query 下发），**不是** body。
 */
export function listOrders(page = 1, pageSize = 20) {
  return http.get<OrderListPage>('/orders', { page, pageSize })
}
