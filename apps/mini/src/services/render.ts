// 合成 API：对接 /api/v1/creations/:id/render 与 /api/v1/media/:assetId/play-url
import { http } from './request'

export interface ColorGrade {
  brightness: number
  contrast: number
  saturation: number
  sharpen: number
}

export interface RenderClip {
  shotId: string
  assetId: string
  cosKey: string
  coverKey: string | null
  trimStartMs: number
  trimEndMs: number | null
  durationMs: number | null
  line?: string | null
}

export const CHATCUT_VOICES = [
  { id: 'warm-female', name: '温暖女声', desc: '自然亲切，适合探店种草' },
  { id: 'bright-female', name: '活力女声', desc: '节奏明快，适合促销上新' },
  { id: 'gentle-male', name: '温和男声', desc: '沉稳自然，适合品牌介绍' },
  { id: 'magnetic-male', name: '磁性男声', desc: '质感突出，适合品质表达' },
  { id: 'energetic-youth', name: '活力青年', desc: '轻快有冲劲，适合同城引流' },
] as const

export type ChatCutOptions = {
  voiceId: typeof CHATCUT_VOICES[number]['id']
  subtitles: boolean
  subtitleStyle: 'CLEAN' | 'EMPHASIS' | 'SOCIAL'
  bgm: 'NONE' | 'LIGHT' | 'UPBEAT' | 'PREMIUM'
  pacing: 'NATURAL' | 'FAST' | 'STORY'
  transitions: 'CLEAN' | 'SMOOTH' | 'DYNAMIC'
  removeSilence: boolean
  normalizeAudio: boolean
  note: string
}

/** 产品档位：BASIC 粗剪 / AI 全自动 / PREMIUM 人工精剪 */
export type RenderGrade = 'BASIC' | 'AI' | 'PREMIUM'

export type RenderTaskStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'SETTLEMENT_PENDING'
  | 'MANUAL_PENDING'
  | 'MANUAL_DOING'

export interface RenderTask {
  id: string
  creationId: string
  status: RenderTaskStatus
  progress: number
  mode: 'FULL' | 'RECOLOR'
  grade: RenderGrade
  color: ColorGrade
  clips: RenderClip[]
  beanCharged: string
  cacheHit: boolean
  resultKey: string | null
  previewKey: string | null
  resultSize: string | null
  durationMs: number | null
  errorCode: string | null
  errorMsg: string | null
  createdAt: string
  finishAt: string | null
  assignedAt: string | null
  deadlineAt: string | null
}

export interface PlayUrl {
  url: string | null
  dev: boolean
}

export function submitRender(
  creationId: string,
  body: {
    mode?: 'FULL' | 'RECOLOR'
    grade?: RenderGrade
    color?: ColorGrade
    requestId: string
    aiMode?: boolean
    chatcut?: ChatCutOptions
  },
) {
  return http.post<{ task: RenderTask; duplicated: boolean }>(`/creations/${creationId}/render`, body)
}

export function listRenders(creationId: string) {
  return http.get<RenderTask[]>(`/creations/${creationId}/renders`)
}

export function getRender(creationId: string, taskId: string) {
  return http.get<RenderTask>(`/creations/${creationId}/render/${taskId}`)
}

export function getPlayUrl(assetId: string) {
  return http.get<PlayUrl>(`/media/${assetId}/play-url`)
}

/** 按 cos key 签播放地址（合成产物等无 media_asset 行的文件） */
export function getResultPlayUrl(key: string) {
  return http.get<PlayUrl>(`/media/play-url?key=${encodeURIComponent(key)}`)
}
