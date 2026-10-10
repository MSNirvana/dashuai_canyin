// 充值 / 会员 / 我的 API：对接 /api/v1/orders
import { http } from './request'
import { platform } from '../platform'

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

/** 普通微信支付（v3 JSAPI）。 */
export interface PayParams {
  timeStamp: string
  nonceStr: string
  package: string
  signType: 'RSA'
  paySign: string
}

/**
 * 小程序虚拟支付（`wx.requestVirtualPayment`）—— 服务端签好的四件套。
 *
 * ★ 为什么必须走它：微信《虚拟支付业务运营指南》要求小程序内的**虚拟商品**
 *   （订阅内容、虚拟代币、付费功能……）购买与支付**均须接入小程序虚拟支付**，
 *   并会**关闭**这类小程序在安卓及其余非 iOS 系统的普通微信支付能力。
 *   本项目的「会员订阅」与「积分加油包」两件商品都命中 ⇒ 原来的 JSAPI 已不通。
 * ★ `signData` 是**已序列化好的字符串**：从这个类型到 `wx.requestVirtualPayment`
 *   全程**原样透传**，任何一处重新 `JSON.stringify` 都会让签名失效。
 */
export interface VirtualPayParams {
  signData: string
  paySig: string
  signature: string
  mode: string
}

/** 服务端按 `resolvePayChannel()` 下发其中一组。 */
export type OrderPayParams = PayParams | VirtualPayParams

export interface CreateOrderResult {
  dev: boolean
  orderNo: string
  amountFen: number
  beans: string
  memberDiscountApplied: boolean
  /** 服务端本次走的是哪条收款通道（便于排查与埋点，不参与前端的支付动作） */
  payChannel?: 'vp' | 'jsapi'
  payParams: OrderPayParams | null
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
 *
 * ★★ `vpCapable` 由 `platform.payCapabilities.virtualPay` 如实上报，**必须带**：
 *   服务端据此决定下发 JSAPI 五件套还是虚拟支付四件套。若服务端按「本环境配没配
 *   `WX_VP_*`」判定，切通道就成了**进程级**的 —— 一旦服务端填上虚拟支付凭据，
 *   **已安装的旧版本**客户端会收到它无法调起的四件套（表现：点了付款没反应）。
 *   由端上报后，旧版本继续走 JSAPI、新版本走虚拟支付，两侧各自都能付款。
 */
export function createBeanOrder(packageId: string, wxLoginCode?: string) {
  return http.post<CreateOrderResult>('/orders/recharge/order', {
    packageId,
    wxLoginCode,
    vpCapable: platform.payCapabilities.virtualPay,
  })
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
  return http.post<CreateOrderResult>('/orders/membership/order', {
    packageId,
    wxLoginCode,
    // 同 createBeanOrder：如实上报本端能不能接虚拟支付四件套
    vpCapable: platform.payCapabilities.virtualPay,
  })
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
