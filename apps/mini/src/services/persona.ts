// 人设 API：对接 /api/v1/persona（老板人设标签 + 门店活动）
import { http } from './request'

export interface PersonaItem {
  bossTags: string | null
  activity: string | null
  updatedAt: string | null
}

export function getPersona() {
  return http.get<PersonaItem>('/persona')
}

export function savePersona(input: { bossTags?: string | null; activity?: string | null }) {
  return http.put<PersonaItem>('/persona', input)
}
