// 优秀作品 API：对接 /api/v1/works（运营内容，只读）
import { http } from './request'

export interface WorkItem {
  id: string
  title: string
  category: string
  subCategory: string | null
  tags: string[] | null
  coverKey: string | null
  videoKey: string | null
  durationMs: number | null
  sort: number
  viewCount: number
  cloneCount: number
  publishedAt: string | null
  /** 服务端签好的封面地址（列表与详情都带），无封面时为 null */
  coverUrl?: string | null
}

/**
 * 同款配方：与 creation 的 track / complexity 取值一一对应。
 * ★ 这里的 track 是**服务端存下来的原值**，历史上出现过四代：
 *   新五款（TRAFFIC/PERSONA/KNOWLEDGE/PRODUCT/RECOMMEND）、改型前的 INTRO/QUALITY、
 *   以及更早的 NORMAL。所以类型里**显式留着老值**，而不是只写新款 ——
 *   只写新款等于对 TypeScript 撒谎，调用方会以为拿到的永远是新值而省略归一。
 *   用之前必须过 `creation.ts` 的 `toDishTrack()`。
 */
export interface WorkRecipe {
  track?:
    | 'TRAFFIC' | 'PERSONA' | 'KNOWLEDGE' | 'PRODUCT' | 'RECOMMEND'
    | 'INTRO' | 'QUALITY' | 'NORMAL'
  complexity?: 'SIMPLE' | 'COMPLEX' | 'FINE'
  titleHint?: string
  voiceId?: string
  shotSkeleton?: Array<{
    shotType?: string
    shotSize?: string
    durationSuggest?: number
    line?: string
    visualReq?: string
  }>
  notes?: string
}

export interface WorkDetail extends WorkItem {
  recipeJson: WorkRecipe
  sourceType: string
  /** 服务端签好的播放地址（私有桶有效期 1 小时），无素材时为 null */
  coverUrl: string | null
  videoUrl: string | null
}

export interface WorkListResult {
  page: number
  pageSize: number
  total: number
  hasMore: boolean
  items: WorkItem[]
}

export interface WorkCategory {
  category: string
  count: number
}

export function listWorks(params: { category?: string; page?: number; pageSize?: number } = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  return http.get<WorkListResult>(`/works${qs ? `?${qs}` : ''}`)
}

export function listWorkCategories() {
  return http.get<WorkCategory[]>('/works/categories')
}

export function getWork(id: string) {
  return http.get<WorkDetail>(`/works/${id}`)
}

/**
 * 播放计一次浏览；失败不影响播放。
 * ★ 2026-10-26：原来是详情页 `onLoad` 调它，详情页删除后改由首页卡片点播时调
 *   （见 pages/home/index.tsx::playWork，只在需要重新取播放地址时才计，避免反复点播刷数）。
 */
export function markWorkView(id: string) {
  return http.post<{ counted: boolean }>(`/works/${id}/view`, {})
}

/**
 * 统计「哪条作品最带货」。
 * ⚠ 2026-10-26 起**没有任何调用点**：「生成同款」按钮已随详情页/首页卡片一起删除。
 *   后端接口还在（`POST /works/:id/clone`），留着这个封装是为了恢复入口时不用重写。
 */
export function markWorkClone(id: string) {
  return http.post<{ counted: boolean }>(`/works/${id}/clone`, {})
}
