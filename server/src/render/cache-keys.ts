// 合成链路的**缓存键唯一源**。
//
// 为什么必须单独成文件：缓存键有两处消费者 —— 正式合成的 worker、以及「整片调色预览」
// （render/preview.ts）。两者必须算出**完全相同**的归一化缓存键，否则后果是静默的：
// 预览会每次都判定「缓存未命中」→ 把全部素材从头归一化一遍 → 慢几十秒、白烧 CPU、
// 还往桶里灌一堆其实重复的中间产物。没有任何报错，只是「预览很慢」。
//
// 所以：键的计算只在这里实现一次，两侧都 import。改键 = 改这里一处。
import { createHash } from 'node:crypto'
import type { RenderClip } from '../services/render.service.js'

/**
 * 中间产物缓存目录前缀。
 * ⚠ 这个前缀**不是随便取的**：孤儿对象 GC（scripts/gc-orphan-objects.ts）用
 *   `CACHE_PREFIX = 'renders/_cache/'` 把整个目录排除在「未落库 = 孤儿」的判定之外。
 *   调色预览也放在这个前缀下（见 previewCacheKey），就是**为了搭上这条排除规则**，
 *   免得它被 GC 当孤儿删掉。
 */
export const INTERMEDIATE_CACHE_PREFIX = 'renders/_cache/'

/**
 * 中间产物缓存版本：**归一化产出语义变化时必须递增**，否则会命中旧产物。
 *   v1 → v2：归一化从「丢弃原声挂静音轨」改为「保留原声」，v1 缓存全是静音片段，必须失效。
 */
export const INTERMEDIATE_CACHE_VERSION = 'v2'

/**
 * 中间产物缓存键：(缓存版本, assetId, trim 起止, 输出尺寸) → sha1
 * 不含调色参数，因此「仅改调色重合成」能命中缓存，只跑一遍调色+拼接（对应 10 豆计费）
 */
export function intermediateKey(
  clip: RenderClip,
  startMs: number,
  endMs: number,
  output: { width: number; height: number },
): string {
  const raw = `${INTERMEDIATE_CACHE_VERSION}:${clip.assetId}:${startMs}:${endMs}:${output.width}x${output.height}`
  return createHash('sha1').update(raw).digest('hex')
}

/** 归一化产物的完整对象键。worker 与预览都必须走这个函数拼。 */
export function normalizedClipKey(
  merchantId: bigint,
  clip: RenderClip,
  output: { width: number; height: number },
): string {
  // trimEndMs 为空表示「到素材结尾」，与 worker 里的 `endMs = clip.trimEndMs ?? 0` 口径一致
  const startMs = clip.trimStartMs ?? 0
  const endMs = clip.trimEndMs ?? 0
  return `${INTERMEDIATE_CACHE_PREFIX}${merchantId.toString()}/${intermediateKey(clip, startMs, endMs, output)}.mp4`
}

/**
 * 调色预览的缓存键：**内容寻址** —— 由「全部分镜的归一化缓存键 + 输出尺寸 + 调色参数」
 * 共同决定。同一组参数反复请求只会算出同一个键，天然去重；
 * 换了任一参数（哪怕只动一个滑块）就是另一个键，互不覆盖。
 * 不含 merchantId：商家前缀在拼完整对象键时才加（不同商家素材不同，本来就不会撞）。
 */
export function colorPreviewHash(
  clips: RenderClip[],
  output: { width: number; height: number },
  color: ColorGradeLike,
): string {
  const clipPart = clips
    .map((c) => intermediateKey(c, c.trimStartMs ?? 0, c.trimEndMs ?? 0, output))
    .join(',')
  const colorPart = [color.brightness, color.contrast, color.saturation, color.sharpen].join(':')
  const raw = `colorpreview:${COLOR_PREVIEW_VERSION}:${output.width}x${output.height}:${colorPart}:${clipPart}`
  return createHash('sha1').update(raw).digest('hex')
}

/**
 * 调色预览的编码版本：**编码参数（preset/crf/分辨率）变化时必须递增**。
 * 与 INTERMEDIATE_CACHE_VERSION 同理 —— 否则会继续命中按旧参数编出来的预览。
 */
export const COLOR_PREVIEW_VERSION = 'v1'

/** 调色预览的完整对象键（落在被 GC 排除的缓存目录下） */
export function colorPreviewKey(merchantId: bigint, hash: string): string {
  return `${INTERMEDIATE_CACHE_PREFIX}${merchantId.toString()}/color-preview-${hash}.mp4`
}

/** 只取用得到的三个字段，避免为一个类型把 render.service 整个拖进来 */
export interface ColorGradeLike {
  brightness: number
  contrast: number
  saturation: number
  sharpen: number
}
