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
