import { api } from './api'

/**
 * 工作台的数据层。
 *
 * 官网与小程序共用同一套业务接口（`/api/v1/*`，同一个 Bearer token、同一个 Merchant），
 * 所以这里没有第二套后端 —— 只是把小程序里那几个页面的读写搬到网页上。
 * 接口字段以 `server/src/routes/{stores,dishes,persona}.ts` 的 zod schema 为准。
 */

export interface Store {
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
}

export interface Dish {
  id: string
  name: string
  intro: string | null
  sellingPoints: string | null
  kind: 'SINGLE' | 'COMBO'
  priceFen: number | null
  originalPriceFen: number | null
  coverKey: string | null
  sort?: number
}

export interface Persona {
  bossTags: string | null
  activity: string | null
  updatedAt: string | null
}

/** 门店表单：与 storeInput 对齐（PUT 是全量覆盖，所以每次都提交完整对象） */
export interface StoreInput {
  name: string
  category?: string
  province?: string
  city?: string
  district?: string
  address?: string
  intro?: string
}

/** 菜品表单：价格用「元」输入、按「分」提交（与库里 price_fen 同口径） */
export interface DishInput {
  name: string
  intro?: string
  sellingPoints?: string
  priceFen?: number
  originalPriceFen?: number | null
  kind?: 'SINGLE' | 'COMBO'
}

export const listStores = () => api<Store[]>('/stores')
export const createStore = (body: StoreInput) => api<Store>('/stores', { method: 'POST', body })
export const updateStore = (id: string, body: StoreInput) => api<Store>(`/stores/${id}`, { method: 'PUT', body })

export const listDishes = (storeId: string) => api<Dish[]>(`/stores/${storeId}/dishes`)
export const createDish = (storeId: string, body: DishInput) =>
  api<Dish>(`/stores/${storeId}/dishes`, { method: 'POST', body })
export const updateDish = (storeId: string, id: string, body: DishInput) =>
  api<Dish>(`/stores/${storeId}/dishes/${id}`, { method: 'PUT', body })
export const deleteDish = (storeId: string, id: string) =>
  api<null>(`/stores/${storeId}/dishes/${id}`, { method: 'DELETE' })

export const getPersona = (storeId: string) => api<Persona>(`/stores/${storeId}/persona`)
export const savePersona = (storeId: string, body: { bossTags?: string | null; activity?: string | null }) =>
  api<Persona>(`/stores/${storeId}/persona`, { method: 'PUT', body })

/** 分（整数） → 「¥12.80」；null/undefined 显示占位 */
export function formatFen(fen: number | null | undefined): string {
  if (fen === null || fen === undefined) return '—'
  return `¥${(fen / 100).toFixed(2)}`
}

/** 「¥12.80」/「12.8」 → 分。空串返回 undefined（= 不改/不填） */
export function parseYuanToFen(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.round(value * 100)
}

/** 分 → 输入框里的「元」文本（12.8 而不是 12.80，避免用户每次都要删末尾 0） */
export function fenToYuanText(fen: number | null | undefined): string {
  if (fen === null || fen === undefined) return ''
  return String(fen / 100)
}
