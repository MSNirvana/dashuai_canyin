import { api } from './api'

/**
 * 合成（出成片）的数据层。
 *
 * ★ 与小程序 `services/render.ts` 同一套接口：`/creations/:id/render`、
 *   `/creations/:id/render/:taskId`、`/creations/:id/renders`。
 * ★ 三档的价格**必须来自服务端**（`/render/capabilities`）。客户端按住时长自己算一遍，
 *   就是「页面显示 5000、实际扣 300」的成因 —— 价目表在后台可改，改了不发版。
 */

export type RenderGrade = 'BASIC' | 'AI' | 'PREMIUM'

export interface GradeCapability {
  key: RenderGrade
  available: boolean
  /** 不可用或需要额外说明时给用户看的文案 */
  reason: string | null
  /** 提交一次的**固定扣费**（积分），与成片时长无关 */
  beans: number
}

export interface RenderTask {
  id: string
  creationId: string
  status: string
  /** 0~100 */
  progress: number
  mode: string
  grade: RenderGrade
  aiMode: boolean
  beanCharged: string
  cacheHit: boolean
  resultKey: string | null
  previewKey: string | null
  resultSize: string | null
  durationMs: number | null
  errorCode: string | null
  /** 用户可见的失败文案（服务端已脱敏） */
  errorText: string | null
  createdAt?: string
  finishAt?: string | null
}

export interface SubmitRenderResult {
  task: RenderTask
  duplicated: boolean
}

/**
 * 服务端 `RENDER_ACTIVE_STATES` 的镜像。
 *
 * ★★ 只有这两个集合之外的状态才是终态。写成「等于 SUCCESS 才停」会让失败/取消的任务
 *   被无限轮询；写成「不等于 RUNNING 就停」又会在排队阶段就收手。
 * ★ 改动这里之前先看 `server/src/services/render.service.ts` 的同名常量 ——
 *   两边不一致的表现是「合成完了页面还在转」或「刚提交就说失败」。
 */
export const RENDER_ACTIVE_STATES = [
  'PENDING_RESERVATION',
  'QUEUED',
  'RUNNING',
  'MANUAL_PENDING',
  'MANUAL_DOING',
  'SETTLEMENT_PENDING',
] as const

export const isRenderActive = (status: string) => (RENDER_ACTIVE_STATES as readonly string[]).includes(status)

export const getRenderGrades = () =>
  api<{ grades: GradeCapability[]; chatcut?: { configured?: boolean } }>('/render/capabilities')

export interface SubmitRenderInput {
  grade?: RenderGrade
  /** FULL = 整片重出；RECOLOR = 只重调色（便宜，但对没素材的任务无意义） */
  mode?: 'FULL' | 'RECOLOR'
}

export const submitRender = (creationId: string, body: SubmitRenderInput = {}) =>
  api<SubmitRenderResult>(`/creations/${creationId}/render`, {
    method: 'POST',
    body: {
      mode: 'FULL',
      // ★ requestId 按「一次点击」新生成：服务端按它做幂等，
      //   复用同一个 id 会让第二次提交直接拿到第一次的任务（看着像「点了没反应」）。
      requestId: crypto.randomUUID(),
      ...body,
    },
  })

export const getRenderTask = (creationId: string, taskId: string) =>
  api<RenderTask>(`/creations/${creationId}/render/${taskId}`)

export const listRenders = (creationId: string) => api<RenderTask[]>(`/creations/${creationId}/renders`)

/** 合成任务的短文案。与 `creations-data.ts` 的 `renderStatusLabel` 同源，避免两处说法不一 */
export function renderTaskLabel(status: string): string {
  switch (status) {
    case 'SUCCESS': return '已合成成片'
    case 'RUNNING': return '成片合成中'
    case 'MANUAL_DOING': return '剪辑师制作中'
    case 'MANUAL_PENDING': return '等待剪辑师接单'
    case 'QUEUED': return '合成排队中'
    case 'SETTLEMENT_PENDING': return '结算处理中'
    case 'PENDING_RESERVATION': return '合成准备中'
    case 'FAILED': return '合成失败'
    case 'CANCELLED': return '已取消'
    default: return '状态未知'
  }
}

export const GRADE_LABELS: Record<RenderGrade, { title: string; desc: string }> = {
  BASIC: { title: '基础档', desc: '只按分镜顺序拼接、裁成竖版，不加字幕配音' },
  AI: { title: 'AI 档', desc: '自动加字幕、配音、调色，多数情况选这档' },
  PREMIUM: { title: '精修档', desc: '提交后排人工剪辑，适合要发重要节点的时候' },
}
