// 模型能力（`ai_model.capability`）的**唯一取值集合**。
//
// 为什么必须收敛成枚举而不是继续用自由文本输入框：
//   这个字段看起来只是「给运营看的标签」，实际上是**分类字段** —— 后台按能力筛选、
//   场景选模型、以及以后按能力路由（文本模型 / 视觉模型）都要读它。一旦出现
//   `text` / `TEXT ` / `对话` / `聊天` 这类自由文本，筛选就会静默漏掉这些行，
//   表现成「模型页分类乱了」，而且**没有任何报错**能指出是谁写错的。
//   → 写入侧由路由的 zod `z.enum` 兜死；读取侧用 normalize 容错（见下）。
//
// 取值来源：项目里实际出现过的能力语义（对话/推理、读图、出图、出片、语音合成、向量化）。
// 本期线上库存量全部是 TEXT，所以收敛不需要改任何已有行的值。
export const MODEL_CAPABILITIES = ['TEXT', 'VISION', 'IMAGE', 'VIDEO', 'TTS', 'EMBEDDING'] as const

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number]

export const DEFAULT_MODEL_CAPABILITY: ModelCapability = 'TEXT'

/** 中文标签，后台展示用（下拉里显示「文本 TEXT」，避免运营猜缩写）。 */
export const MODEL_CAPABILITY_LABELS: Record<ModelCapability, string> = {
  TEXT: '文本',
  VISION: '视觉',
  IMAGE: '图像',
  VIDEO: '视频',
  TTS: '语音',
  EMBEDDING: '向量',
}

export function isModelCapability(v: unknown): v is ModelCapability {
  return typeof v === 'string' && (MODEL_CAPABILITIES as readonly string[]).includes(v)
}

/**
 * 把任意值归一到枚举。
 *
 * ★ 只在**读取/兜底**路径用，不要用来「悄悄修正」运营的输入：
 *   认不出的值一律落回 TEXT，是为了让老行（或外部脚本直插的行）不至于把整页渲染搞崩，
 *   而不是为了吞掉拼错的值 —— 写入路径有 zod enum 直接 400。
 *   大小写与首尾空格不敏感（`text` / ` TEXT ` 都是 TEXT），因为这两种拼错最容易发生
 *   且语义无歧义。
 */
export function normalizeModelCapability(v: unknown): ModelCapability {
  if (typeof v !== 'string') return DEFAULT_MODEL_CAPABILITY
  const up = v.trim().toUpperCase()
  return isModelCapability(up) ? up : DEFAULT_MODEL_CAPABILITY
}
