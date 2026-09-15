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
export function createBeanOrder(packageId: string) {
  return http.post<CreateOrderResult>('/orders/recharge/order', { packageId })
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

export function createMemberOrder(packageId: string) {
  return http.post<CreateOrderResult>('/orders/membership/order', { packageId })
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
