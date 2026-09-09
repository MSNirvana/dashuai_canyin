// 账户查询 API：积分流水 / AI 调用日志 / 当前订阅 / 公开系统设置 / 镜头库
import { http } from './request'

// ───────────── 积分流水 ─────────────
export interface BeanLedgerItem {
  id: string
  type: string
  bucket: string
  amount: string
  balanceAfter: string
  grantAfter: string
  frozenAfter: string
  bizType: string | null
  bizId: string | null
  remark: string | null
  createdAt: string
}
export function listBeanLedger(page = 1, pageSize = 20) {
  return http.get<{ list: BeanLedgerItem[]; total: number; page: number; pageSize: number }>('/account/bean/ledger', {
    page,
    pageSize,
  })
}

// ───────────── AI 调用日志 ─────────────
export interface AiLogItem {
  id: string
  sceneCode: string
  requestId: string
  isFallback: boolean
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costFen: number
  beanCharged: string
  beanBucket: string | null
  latencyMs: number
  status: string
  errorCode: string | null
  errorMsg: string | null
  createdAt: string
}
export function listAiLogs(page = 1, pageSize = 20) {
  return http.get<{ list: AiLogItem[]; total: number; page: number; pageSize: number }>('/account/bean/ai-logs', {
    page,
    pageSize,
  })
}

// ───────────── 当前订阅 ─────────────
export interface CurrentMembership {
  active: boolean
  planName: string | null
  planCode: string | null
  startAt: string | null
  endAt: string | null
  grantPoints: string
  grantExpireAt: string | null
  status: string | null
}
export function getCurrentMembership() {
  return http.get<CurrentMembership>('/account/membership/current')
}

// ───────────── 公开系统设置（启动拉取） ─────────────
export interface PublicSettingItem {
  key: string
  value: string | number | boolean | null | unknown[]
  valueType: string
  displayName: string
}
export interface PublicSettings {
  updatedAt: string
  groups: Record<string, PublicSettingItem[]>
}
export function getPublicSettings() {
  // 公开接口，无鉴权
  return http.get<PublicSettings>('/system/settings', undefined, { autoRefresh: false })
}

// ───────────── 镜头库 ─────────────
export interface ShotLibraryItem {
  id: string
  code: string
  name: string
  category: string
  tips: string | null
  demoVideoKey: string | null
  demoCoverKey: string | null
  sort: number
}
export function listShotLibrary(category?: string) {
  return http.get<ShotLibraryItem[]>('/shot-library', category ? { category } : undefined)
}

export function getShotDemoPlayUrl(id: string) {
  return http.get<{ url: string | null; dev: boolean }>(`/shot-library/${id}/demo-play-url`)
}
