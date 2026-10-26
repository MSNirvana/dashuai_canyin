import type { Prisma } from '@prisma/client'
import { getNumber } from '../lib/settings.js'
import { DEFAULT_COLOR, type ColorGrade } from '../services/render.service.js'

export const RENDER_COLOR_GROUP = 'render'

/**
 * AI 成片调色（四轴，可正可负）。
 *
 * ★ 顺序会被 verify-render-color-settings.ts 的「四项调色配置键齐全」逐字断言，
 *   加/删/挪都会让它变红 —— 这是刻意的：后台 UI 按这个顺序渲染，顺序变了运营要重新找。
 *   **美颜参数不要加进本数组**，走下面的 RENDER_BEAUTY_SETTINGS（取值范围也不同）。
 */
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

/** 调色的合法区间（可为负） */
export const COLOR_AXIS_RANGE = { min: -100, max: 100 } as const

/**
 * 基本美颜（与调色同分组、同页面呈现，但是**独立模块**）。
 *
 * ★ 为什么与调色分两个数组而不是合并：
 *   1. 语义不同 —— 调色是「整条片子的色彩」，磨皮是「对人像的处理」，后台也是两块 UI。
 *   2. **取值范围不同** —— 调色 -100~100，美颜 0~100（负数磨皮没有意义，只会让画面变脏）。
 *      合并进一个数组就得给每一项挂一个 range，"校验函数" 会变成查表，反而更容易漏。
 *   3. 上面那条守护脚本逐字断言调色四键的顺序，合并会直接让它红。
 *
 * ★ 磨皮用 FFmpeg 的 `bilateral`（双边滤波）：空间邻近 + 像素值相似双权重，
 *   压掉毛孔/细纹这类**低对比**细节，同时保住轮廓与菜品纹理。
 *   它是**全局**滤镜 —— 不知道哪里是皮肤，所以菜品和背景也会被轻微压平，
 *   这也是它上限给到 100 却仍然要保守映射的原因（见 ffmpeg.ts::buildBeautyFilter）。
 */
export const RENDER_BEAUTY_SETTINGS = [
  { axis: 'smooth', key: 'beauty_smooth', label: 'AI 成片磨皮', sort: 50 },
] as const satisfies ReadonlyArray<{
  axis: keyof ColorGrade
  key: string
  label: string
  sort: number
}>

/** 美颜的合法区间（只有非负） */
export const BEAUTY_AXIS_RANGE = { min: 0, max: 100 } as const

export type RenderColorSettingKey = (typeof RENDER_COLOR_SETTINGS)[number]['key']
export type RenderBeautySettingKey = (typeof RENDER_BEAUTY_SETTINGS)[number]['key']

function normalizeAxis(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(COLOR_AXIS_RANGE.min, Math.min(COLOR_AXIS_RANGE.max, Math.round(value)))
}

function normalizeBeautyAxis(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(BEAUTY_AXIS_RANGE.min, Math.min(BEAUTY_AXIS_RANGE.max, Math.round(value)))
}

export function isRenderColorSetting(groupKey: string, settingKey: string): settingKey is RenderColorSettingKey {
  return groupKey === RENDER_COLOR_GROUP && RENDER_COLOR_SETTINGS.some((item) => item.key === settingKey)
}

export function isRenderBeautySetting(groupKey: string, settingKey: string): settingKey is RenderBeautySettingKey {
  return groupKey === RENDER_COLOR_GROUP && RENDER_BEAUTY_SETTINGS.some((item) => item.key === settingKey)
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
  return (
    Number.isInteger(value) && value >= COLOR_AXIS_RANGE.min && value <= COLOR_AXIS_RANGE.max
  )
}

export function validateRenderBeautySetting(input: {
  groupKey: string
  settingKey: string
  settingVal: string
  valueType: string
}): boolean {
  if (!isRenderBeautySetting(input.groupKey, input.settingKey)) return true
  if (input.valueType !== 'INT') return false
  const value = Number(input.settingVal)
  return (
    Number.isInteger(value) && value >= BEAUTY_AXIS_RANGE.min && value <= BEAUTY_AXIS_RANGE.max
  )
}

/**
 * 后台统一控制 AI 成片调色 + 基本美颜。
 *
 * ★ 两组合并成**同一个 ColorGrade 返回**（美颜是可选字段）：`buildColorFilter(color)`
 *   在合成/预览/worker 里共有 8 处调用，签名保持不变，预览与成片就天然一致 ——
 *   否则漏掉任何一处就会出现「预览有磨皮、成片没有」这种最难查的偏差。
 *
 * ★ 默认全 0；只有非 0 项才会进入 FFmpeg filter graph（不挂滤镜 = 不增加 CPU）。
 *   任务 JSON 里的旧 color 字段继续保留给 BASIC / RECOLOR 历史链路，AI 合成只认这里。
 */
export async function readRenderColorSettings(prisma: Prisma.TransactionClient): Promise<ColorGrade> {
  const values = await Promise.all([
    ...RENDER_COLOR_SETTINGS.map((item) => getNumber(prisma, RENDER_COLOR_GROUP, item.key, DEFAULT_COLOR[item.axis])),
    ...RENDER_BEAUTY_SETTINGS.map((item) => getNumber(prisma, RENDER_COLOR_GROUP, item.key, 0)),
  ])
  const color = RENDER_COLOR_SETTINGS.reduce<ColorGrade>((acc, item, index) => {
    acc[item.axis] = normalizeAxis(values[index] ?? 0)
    return acc
  }, { ...DEFAULT_COLOR })
  return RENDER_BEAUTY_SETTINGS.reduce<ColorGrade>((acc, item, offset) => {
    acc[item.axis] = normalizeBeautyAxis(values[RENDER_COLOR_SETTINGS.length + offset] ?? 0)
    return acc
  }, color)
}
