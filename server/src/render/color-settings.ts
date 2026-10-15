import type { Prisma } from '@prisma/client'
import { getNumber } from '../lib/settings.js'
import { DEFAULT_COLOR, type ColorGrade } from '../services/render.service.js'

export const RENDER_COLOR_GROUP = 'render'

export const RENDER_COLOR_SETTINGS = [
  { axis: 'brightness', key: 'color_brightness', label: 'AI 成片亮度', sort: 40 },
  { axis: 'contrast', key: 'color_contrast', label: 'AI 成片对比度', sort: 41 },
  { axis: 'saturation', key: 'color_saturation', label: 'AI 成片饱和度', sort: 42 },
  { axis: 'sharpen', key: 'color_sharpen', label: 'AI 成片锐化', sort: 43 },
] as const satisfies ReadonlyArray<{
  axis: keyof ColorGrade
  key: string
  label: string
  sort: number
}>

export type RenderColorSettingKey = (typeof RENDER_COLOR_SETTINGS)[number]['key']

function normalizeAxis(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-100, Math.min(100, Math.round(value)))
}

export function isRenderColorSetting(groupKey: string, settingKey: string): settingKey is RenderColorSettingKey {
  return groupKey === RENDER_COLOR_GROUP && RENDER_COLOR_SETTINGS.some((item) => item.key === settingKey)
}

export function validateRenderColorSetting(input: {
  groupKey: string
  settingKey: string
  settingVal: string
  valueType: string
}): boolean {
  if (!isRenderColorSetting(input.groupKey, input.settingKey)) return true
  if (input.valueType !== 'INT') return false
  const value = Number(input.settingVal)
  return Number.isInteger(value) && value >= -100 && value <= 100
}

/**
 * 后台统一控制 AI 成片调色。四项默认均为 0；只有非 0 项才会进入 FFmpeg filter graph。
 * 任务 JSON 里的旧 color 字段继续保留给 BASIC / RECOLOR 历史链路，AI 合成只认这里。
 */
export async function readRenderColorSettings(prisma: Prisma.TransactionClient): Promise<ColorGrade> {
  const values = await Promise.all(
    RENDER_COLOR_SETTINGS.map((item) => getNumber(prisma, RENDER_COLOR_GROUP, item.key, DEFAULT_COLOR[item.axis])),
  )
  return RENDER_COLOR_SETTINGS.reduce<ColorGrade>((color, item, index) => {
    color[item.axis] = normalizeAxis(values[index] ?? 0)
    return color
  }, { ...DEFAULT_COLOR })
}
