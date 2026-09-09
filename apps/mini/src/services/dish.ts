// 菜品 API：对接 /api/v1/stores/:storeId/dishes
import { http } from './request'

export interface DishItem {
  id: string
  name: string
  intro: string | null
  sellingPoints: string | null
  coverKey: string | null
  videoKey: string | null
  sort: number
  createdAt: string
}

export interface DishInput {
  name: string
  intro?: string
  sellingPoints?: string
  coverKey?: string
  videoKey?: string
  sort?: number
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
