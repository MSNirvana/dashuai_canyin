export type PayScene = 'NATIVE' | 'H5'
export type OrderKind = 'MEMBER' | 'BEAN'

export interface LoginResult {
  token: string
  refreshToken: string
  merchant: { id: string; phone: string; nickname: string | null; avatarUrl: string | null; isNew: boolean }
  member: { isMember: boolean; endAt: string | null }
  bean: { balance: string; grantBalance: string; available: string; frozen: string }
}

export interface CatalogPlan {
  id: string
  name: string
  priceFen: number
  durationDays: number
  grantBeans: number | string
}

export interface CatalogPackage {
  id: string
  name: string
  priceFen: number
  beans: number | string
  bonusBeans: number | string
}

export interface Catalog {
  plans: CatalogPlan[]
  packages: CatalogPackage[]
  capabilities: { native: boolean; h5: boolean }
}

export interface AccountInfo {
  balance: { available: string; balance: string; grantBalance: string; frozen: string }
  subscription: { active: boolean; planName: string | null; endAt: string | null; grantPoints: string }
  storage: { usedBytes: string; quotaBytes: string; subscribed: boolean }
}

export interface OrderItem {
  orderNo: string
  orderType: string
  title?: string
  status: string
  amountFen: number
  beans: string
  paidAt: string | null
  createdAt?: string
  expireAt?: string
}

export interface OrderPage {
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  list: OrderItem[]
}

export interface PayOrder {
  orderNo: string
  amountFen: number
  expireAt: string
  codeUrl?: string
  h5Url?: string
}

export interface PendingPayment extends PayOrder {
  kind: OrderKind
  packageId: string
  scene: PayScene
  merchantId: string
  title: string
}
