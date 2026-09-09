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
  contact: string | null
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
  contact?: string
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
