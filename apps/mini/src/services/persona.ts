// 人设 API：对接 /api/v1/stores/:storeId/persona（老板人设标签 + 门店活动，门店级）
import { http } from './request'

export interface PersonaItem {
  bossTags: string | null
  activity: string | null
  updatedAt: string | null
}

function base(storeId: string) {
  return `/stores/${storeId}/persona`
}

export function getPersona(storeId: string) {
  return http.get<PersonaItem>(base(storeId))
}

export function savePersona(storeId: string, input: { bossTags?: string | null; activity?: string | null }) {
  return http.put<PersonaItem>(base(storeId), input)
}
