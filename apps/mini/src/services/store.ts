// 门店 API：对接 /api/v1/stores
import { http } from './request'

export interface StoreItem {
  id: string
  name: string
  category: string | null
  province: string | null
  city: string | null
  district: string | null
  address: string | null
  coverKey: string | null
  intro: string | null
  videoKey: string | null
  isDefault: boolean
  createdAt: string
  _count?: { dishes: number }
}

export interface StoreInput {
  name: string
  category?: string
  province?: string
  city?: string
  district?: string
  address?: string
  coverKey?: string | null
  intro?: string | null
  videoKey?: string | null
  isDefault?: boolean
}

export function listStores() {
  return http.get<StoreItem[]>('/stores')
}

export function getStore(id: string) {
  return http.get<StoreItem>(`/stores/${id}`)
}

export function createStore(input: StoreInput) {
  return http.post<StoreItem>('/stores', input)
}

export function updateStore(id: string, input: StoreInput) {
  return http.put<StoreItem>(`/stores/${id}`, input)
}

export function deleteStore(id: string) {
  return http.del<{ deleted: boolean }>(`/stores/${id}`)
}

/**
 * 取门店图片 / 视频的播放地址（私有桶临时签名，有效期 1 小时）。
 * 原名叫 getStoreCoverUrl，门店加了视频后改名，调用方同步改为 getStoreMediaUrl。
 */
export function getStoreMediaUrl(key: string) {
  return http.get<{ url: string | null; dev: boolean }>(`/media/play-url?key=${encodeURIComponent(key)}`)
}
