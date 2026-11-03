export type PayScene = 'NATIVE' | 'H5'
export type OrderKind = 'MEMBER' | 'BEAN'

export interface LoginResult {
  token: string
  refreshToken: string
  /**
   * 官网**免登录**的只读演示会话（服务端 `scope='demo'`）。真实登录返回里没有这个字段。
   * ★ 有它 = 只读：写操作会被服务端 1007 拦掉，前端也不该渲染写按钮。
   * ★ 它没有 refreshToken（服务端刻意不发），所以 401 时不要走刷新，直接重新取演示会话。
   */
  demo?: boolean
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
