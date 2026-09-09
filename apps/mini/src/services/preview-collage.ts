// 渲染预览 API：对接 /api/v1/render/preview-collage（免费，不扣豆）
import { http } from './request'

export interface PreviewShotItem {
  shotId: string
  seq: number
  title: string | null
  url: string | null
  dev: boolean
}
export interface PreviewCollageView {
  creationId: string
  shots: PreviewShotItem[]
  dev: boolean
  layout: { cols: number; rows: number }
}
export function previewCollage(creationId: string) {
  return http.post<PreviewCollageView>('/render/preview-collage', { creationId })
}
