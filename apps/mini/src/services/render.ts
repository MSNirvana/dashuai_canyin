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
  /**
   * **用户可见**的失败文案（服务端已脱敏）。
   *
   * ★ 服务端返回的是 `errorText` 而不是原始的 `error_msg`：后者是运维字段，里面有第三方
   *   产品名、服务端本机绝对路径、HTTP 报文原文（实测踩过）。展示错误**一律**只读这个字段，
   *   别去接口里找原文 —— 给用户的失败提示必须是能指导动作的一句话。
   */
  errorText: string | null
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

/** 档位能力（P0-5）：服务端告知哪些档位当前可用，用于把不可用档位标灰 */
export interface GradeCapability {
  key: RenderGrade
  available: boolean
  reason: string | null
}

/**
 * 拉取档位能力。服务端说不可用就真的不要提交 —— 服务端在 freeze 之前会硬拒（4013）。
 * 失败时返回 null，调用方应保守处理（按「全部可用」放行，让服务端做最终裁决）。
 */
export function getGradeCapabilities() {
  return http.get<{ grades: GradeCapability[] }>('/render/capabilities')
}

/** 按 cos key 签播放地址（合成产物等无 media_asset 行的文件） */
export function getResultPlayUrl(key: string) {
  return http.get<PlayUrl>(`/media/play-url?key=${encodeURIComponent(key)}`)
}

/** 整片调色预览的返回。url 是内容寻址的临时播放地址，可直接丢给 `<Video src>` */
export interface ColorPreviewResult {
  url: string | null
  dev: boolean
  /** 命中了已有产物（含「同参数正在算，复用了同一次计算」）—— 此时耗时基本为 0 */
  cached: boolean
  elapsedMs: number
}

/**
 * 整片调色预览：**不建任务、不冻积分、不扣费**，只按当前四个参数把成片重编一版低码率预览。
 * 和成片一样共用同一套调色滤镜、不缩放不降帧，所以看到的就是出片效果；差别只在编码档位。
 *
 * 单次请求的真实成本 = 拼接(copy) + 整片重编码一次（归一化片段走缓存，复用成片那次的结果）。
 * 因此**第一次**预览可能偏慢：若归一化缓存缺失，服务端会现场补归一化。之后同参数基本秒回。
 *
 * 服务端三道门槛，客户端都要能读懂：
 *   · 2005 需要订阅（预览在内容上等价于成片，不设门槛就等于免费拿片）
 *   · 4014 四个参数全 0 —— 没有可预览的变化，调用方本就不该发
 *   · 4029 触发防滥用限流（滑动窗口只计「真的新算一次」的请求，命中缓存不占额度）
 *
 * timeout 必须放大：服务端单步容许 120s，仍用默认的 30s 会在暖机路径上误报超时。
 * 超时也不算白干 —— 服务端有 in-flight 去重 + 内容寻址缓存，重试会直接命中那次已完成的计算。
 */
export function previewColor(creationId: string, color: ColorGrade) {
  return http.post<ColorPreviewResult>(`/creations/${creationId}/render/preview`, { color }, { timeout: 90000 })
}
