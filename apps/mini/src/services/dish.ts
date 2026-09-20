// 菜品 API：对接 /api/v1/stores/:storeId/dishes
import { http } from './request'

/**
 * 菜单资产的类型。
 * ★ 套餐与单菜**共用同一张表、同一组接口**（服务端见 dish.service.ts 的说明）——
 *   这样「创作时选套餐」不需要新链路：`creation.dishId` 指向的仍然是一条 dish。
 * 前端拿到 kind 只做两件事：① 列表分组/筛选；② 编辑页决定显示哪套字段。
 */
export type DishKind = 'SINGLE' | 'COMBO'

/** 套餐里的一样东西：菜 + 份数。菜名由服务端一并带出，省掉一次查询 */
export interface DishComboItem {
  id: string
  dishId: string
  name: string
  quantity: number
  sort: number
  coverKey: string | null
}

export interface DishItem {
  id: string
  name: string
  intro: string | null
  sellingPoints: string | null
  coverKey: string | null
  videoKey: string | null
  kind: DishKind
  /** 单位：**分**。显示前过 utils/money.ts 的 fenToYuan */
  priceFen: number | null
  /** 划线原价，单位分。仅套餐使用，且必定 > priceFen */
  originalPriceFen: number | null
  comboItems?: DishComboItem[]
  sort: number
  createdAt: string
  media?: DishMedia[]
}

export interface DishMedia { id?: string; type: 'IMAGE' | 'VIDEO'; cosKey: string; coverKey?: string | null; sort: number; url?: string | null; coverUrl?: string | null }

export interface DishInput {
  name: string
  intro?: string
  sellingPoints?: string
  coverKey?: string
  videoKey?: string
  sort?: number
  media?: Array<{ type: 'IMAGE' | 'VIDEO'; cosKey: string; coverKey?: string; sort: number }>
  kind?: DishKind
  priceFen?: number
  /**
   * ★ `null` 是**有含义**的，别把它优化掉：表示「用户把划线价删掉了」。
   *   `undefined` = 没提这件事（服务端沿用库里已有的）。两者不能合并，
   *   否则原价一旦填过就再也删不掉（见服务端 dish.service.ts 的同名说明）。
   */
  originalPriceFen?: number | null
  /** `[]` = 清空明细，`undefined` = 沿用。同理不要用 `?? []` 把两者抹平 */
  comboItems?: Array<{ dishId: string; quantity: number; sort?: number }>
}

export function getDishMediaUrl(key: string) {
  return http.get<{ url: string | null; dev: boolean }>(`/media/play-url?key=${encodeURIComponent(key)}`)
}

function base(storeId: string) {
  return `/stores/${storeId}/dishes`
}

export function listDishes(storeId: string) {
  return http.get<DishItem[]>(base(storeId))
}

export function getDish(storeId: string, id: string) {
  return http.get<DishItem>(`${base(storeId)}/${id}`)
}

export function createDish(storeId: string, input: DishInput) {
  return http.post<DishItem>(base(storeId), input)
}

export function updateDish(storeId: string, id: string, input: DishInput) {
  return http.put<DishItem>(`${base(storeId)}/${id}`, input)
}

export function deleteDish(storeId: string, id: string) {
  return http.del<{ deleted: boolean }>(`${base(storeId)}/${id}`)
}
