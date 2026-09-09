// 创作 API：对接 /api/v1/creations
import { http } from './request'

export interface CreationItem {
  id: string
  title: string | null
  storeId: string
  dishId: string | null
  track: string
  complexity: string
  copyText: string | null
  status: string
  createdAt: string
  _count?: { shots: number }
}

export interface ShotItem {
  id: string
  seq: number
  shotType: string | null
  durationSuggest: number | null
  line: string | null
  visualReq: string | null
  assetId: string | null
  trimStartMs: number
  trimEndMs: number | null
  /** 素材实际时长（ms）：未设置 trim 时合成按此计价 */
  assetDurationMs?: number | null
  status: string
}

export interface CreationDetail extends CreationItem {
  shots: ShotItem[]
  dish: { id: string; name: string } | null
  store: { id: string; name: string } | null
}

export interface Balance {
  balance: number
  grantBalance: number
  available: number
}

export function listCreations(storeId?: string) {
  return http.get<CreationItem[]>('/creations', storeId ? { storeId } : undefined)
}

export function getCreation(id: string) {
  return http.get<CreationDetail>(`/creations/${id}`)
}

export function createCreation(input: { storeId: string; dishId?: string; title?: string }) {
  return http.post<CreationDetail>('/creations', input)
}

export function generateCopy(id: string, requestId: string) {
  return http.post<{ text: string; beanCharged: number; balance: Balance; duplicated: boolean; isFallbackTemplate: boolean }>(
    `/creations/${id}/copy`,
    { requestId },
  )
}

export function generateStoryboard(id: string, requestId: string) {
  return http.post<{
    shots: ShotItem[]
    raw?: string
    parsed: boolean
    beanCharged: number
    balance: Balance
    duplicated: boolean
    isFallbackTemplate: boolean
  }>(`/creations/${id}/storyboard`, { requestId })
}

export function updateShotAsset(
  id: string,
  shotId: string,
  input: { assetId?: string; trimStartMs?: number; trimEndMs?: number },
) {
  return http.put<ShotItem>(`/creations/${id}/shots/${shotId}`, input)
}
