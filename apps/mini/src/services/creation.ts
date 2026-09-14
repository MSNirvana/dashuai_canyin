// 创作 API：对接 /api/v1/creations
import { http } from './request'

/** 文案四款：流量款 / 介绍款 / 质量款 / 种草型 */
export type CopyTrack = 'TRAFFIC' | 'INTRO' | 'QUALITY' | 'RECOMMEND'
/** 分镜复杂度：简单版 2~3 镜 / 复杂版 5~6 镜 / 精细版 6~9 镜 */
export type Complexity = 'SIMPLE' | 'COMPLEX' | 'FINE'

export const COPY_TRACK_OPTIONS: { value: CopyTrack; label: string; desc: string }[] = [
  { value: 'TRAFFIC', label: '流量款', desc: '同城引流 / 话题热度' },
  { value: 'INTRO', label: '介绍款', desc: '菜品讲解 / 套餐推广' },
  { value: 'QUALITY', label: '质量款', desc: '食材品质 / 匠心人设' },
  { value: 'RECOMMEND', label: '种草型', desc: '真实体验 / 消费决策' },
]

export const COMPLEXITY_OPTIONS: { value: Complexity; label: string; desc: string }[] = [
  { value: 'SIMPLE', label: '简单版', desc: '2~3 个分镜' },
  { value: 'COMPLEX', label: '复杂版', desc: '5~6 个分镜' },
  { value: 'FINE', label: '精细版', desc: '6~9 个分镜' },
]

export interface CreationItem {
  id: string
  title: string | null
  storeId: string
  dishId: string | null
  track: string
  complexity: string
  trackLabel?: string | null
  complexityLabel?: string | null
  copyText: string | null
  status: string
  createdAt: string
  _count?: { shots: number }
}

/** 分镜匹配到的镜头库拍摄手法 */
export interface LibraryShotRef {
  id: string
  code: string
  name: string
  category: string
  tips: string | null
  demoVideoKey: string | null
}

export interface ShotItem {
  id: string
  seq: number
  shotType: string | null
  /** 景别：远景/全景/中景/近景/特写/大特写 */
  shotSize: string | null
  durationSuggest: number | null
  line: string | null
  visualReq: string | null
  libraryShotId: string | null
  libraryShot?: LibraryShotRef | null
  assetId: string | null
  /** 已绑定素材的封面缩略图签名 URL（未生成/不可用时为 null） */
  coverUrl?: string | null
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

export function createCreation(input: {
  storeId: string
  dishId?: string
  title?: string
  track?: CopyTrack
  complexity?: Complexity
}) {
  return http.post<CreationDetail>('/creations', input)
}

/** 保存编辑：标题 / 文案正文 / 款式 / 复杂度（不扣积分） */
export function updateCreation(
  id: string,
  input: { title?: string; copyText?: string; track?: CopyTrack; complexity?: Complexity },
) {
  return http.patch<CreationDetail>(`/creations/${id}`, input)
}

export function generateCopy(id: string, requestId: string, track?: CopyTrack) {
  return http.post<{
    text: string
    beanCharged: number
    balance: Balance
    duplicated: boolean
    isFallbackTemplate: boolean
    track: CopyTrack
    trackLabel: string
  }>(`/creations/${id}/copy`, { requestId, track })
}

export function generateStoryboard(id: string, requestId: string, complexity?: Complexity) {
  return http.post<{
    shots: ShotItem[]
    raw?: string
    parsed: boolean
    beanCharged: number
    balance: Balance
    duplicated: boolean
    isFallbackTemplate: boolean
    complexity: Complexity
    complexityLabel: string
  }>(`/creations/${id}/storyboard`, { requestId, complexity })
}

/** 编辑分镜脚本（景别 / 时长 / 台词 / 画面要求），不涉及素材 */
export function updateShotContent(
  id: string,
  shotId: string,
  input: {
    shotType?: string | null
    shotSize?: string | null
    durationSuggest?: number | null
    line?: string | null
    visualReq?: string | null
  },
) {
  return http.put<ShotItem>(`/creations/${id}/shots/${shotId}`, input)
}

export function updateShotAsset(
  id: string,
  shotId: string,
  input: { assetId?: string; trimStartMs?: number; trimEndMs?: number },
) {
  return http.put<ShotItem>(`/creations/${id}/shots/${shotId}`, input)
}

/**
 * 为已上传但缺缩略图的分镜补生成封面（本地存储模式由服务端抽帧）。
 * 返回本次生成数量，前端据此决定是否重新拉取详情。
 */
export function ensureShotCovers(id: string) {
  return http.post<{ generated: number; pending: number }>(`/creations/${id}/ensure-covers`, {})
}

/** 素材播放地址（私有桶临时签名 URL），用于点击缩略图预览原视频 */
export function getAssetPlayUrl(assetId: string) {
  return http.get<{ url: string | null; dev: boolean }>(`/media/${assetId}/play-url`)
}
