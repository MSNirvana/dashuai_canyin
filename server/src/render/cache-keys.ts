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
 *   v2 → v3：归一化补上 `fps=`（逐段统一帧率/时间基）。v2 缓存里可能有**非 30fps 的异质片段**
 *            （实测 asset 56 是 7500/253 + timebase 1/15000），它们正是 `-c copy` 拼接
 *            丢帧卡顿的来源。**不递增就等于这两处修复在旧素材上完全不生效** ——
 *            键里不含编码参数，改了滤镜也照样命中旧产物。
 *            （代价：v2 键整体作废，下一次合成对每段素材各多跑一次归一化。）
 *
 * ★ 2026-09-29 引入口播裁剪时**没有**再递增版本号：键里新增了「口播区间指纹」这一段，
 *   新旧 raw 字符串结构不同，旧条目**天然**不会被命中 ⇒ 再递增一次只是重复一遍同样的作废，
 *   而每次作废都意味着「线上每段素材重跑一次归一化」的真实成本。
 *   （代价同样是全线重跑一次归一化 —— 这次改动本身就换了产物内容，躲不掉。）
 */
export const INTERMEDIATE_CACHE_VERSION = 'v3'

/**
 * 中间产物缓存键：(缓存版本, assetId, trim 起止, **口播保留区间指纹**, 输出尺寸) → sha1
 * 不含调色参数，因此「仅改调色重合成」能命中缓存，只跑一遍调色+拼接（对应 10 积分计费）
 *
 * ★★ 为什么键里必须含「口播保留区间指纹」（2026-09-29 语音裁剪上线时）：
 *   同一条素材、同一段 trim 窗口，剪法可能不同（`Shot.keepRanges` 还没探测 vs 已探测）。
 *   键里不带这个指纹，就会出现**同键不同内容**：先按「不裁」产出一份归一化产物写进桶，
 *   之后的合成按「裁掉中间 4 段」算出**同一个键**、直接命中那份没裁的产物
 *   ⇒ 语音裁剪上线后**看起来完全没生效**，而且不报任何错、只是「改了跟没改一样」。
 *   （`[]` 与 `null` 共用同一个指纹 —— 它们的**产物**确实相同：都不裁。）
 *
 * ⚠ 键里**只有** `clip` 自己的 trim（= 库里的值），**不含**任何渲染期推导出来的窗口：
 *   窗口是 (trim ∧ 视觉探针 ∧ 口播区间) 的函数，而视觉探针结果不落库、两次可能不同。
 *   把它塞进键里，就会造出 `preview.ts`（只看库里的值）永远对不上的键 ⇒ 预览每次都全量重跑。
 *   这是本次改动顺带修掉的一处旧隐患（原来 worker 把探针结果写回 clip 再算键）。
 */

/**
 * 口播保留区间的指纹：`n` = 不裁（含「还没探测」），否则是区间的短哈希。只在键里用。
 *
 * ⚠ 用 sha1 而不是把区间直接拼进键：一条素材可能被切成十几段，直接拼会让键长到无法排查；
 *   而且键本身已经是 sha1，两级哈希不损失唯一性。
 */
export function keepFingerprintOf(
  clip: { keepRanges?: ReadonlyArray<{ startMs: number; endMs: number }> | null },
): string {
  const ranges = clip.keepRanges
  if (!ranges || ranges.length === 0) return 'n'
  const raw = ranges.map((range) => `${Math.round(range.startMs)}-${Math.round(range.endMs)}`).join(',')
  return createHash('sha1').update(raw).digest('hex').slice(0, 10)
}

export function intermediateKey(
  clip: RenderClip,
  startMs: number,
  endMs: number,
  output: { width: number; height: number },
  keepFingerprint = keepFingerprintOf(clip),
): string {
  const raw = `${INTERMEDIATE_CACHE_VERSION}:${clip.assetId}:${startMs}:${endMs}:${keepFingerprint}:${output.width}x${output.height}`
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
  // ⚠ 传进来的 `clip` 必须是**库里的原始值**（不是渲染期推导出的窗口），见 intermediateKey 的注释
  return `${INTERMEDIATE_CACHE_PREFIX}${merchantId.toString()}/${intermediateKey(clip, startMs, endMs, output)}.mp4`
}

/**
 * 「口播裁剪产物」的完整对象键 —— 语音裁剪的中间产物（一段**已经剪掉废片**的连续素材）。
 *
 * ★★ 为什么要有这层产物，而不是让两条渲染路线各自去「挖洞」：
 *   ChatCut 的 clip 是**单区间**模型（`{assetId, fromFrame, durationInFrames,
 *   sourceStartFromInSeconds}`，**没有 sourceEnd**）⇒ 想在它的时间轴上跳过中间一段，
 *   必须把一条素材排成多条 clip，并连带重算转场余量、A1 配音轨的对齐、帧数分配……
 *   而「先在本地把素材剪成一段连续文件、再往下游递」把这一整类问题**一次消掉**：
 *   下游看到的仍然是一条普通素材，所有既有逻辑原样成立。
 *   代价是多一次本地转码 —— 但它**命中缓存**（键含口播区间指纹），只在第一次付。
 *
 * ★ 键里不含输出尺寸：这一步只做 trim+concat 重编码，与最终画布无关，
 *   预览与正式合成因此能共用同一份产物（它们**必须**共用，否则又会同键不同内容）。
 */
export const SPEECH_CUT_VERSION = 'v1'

export function speechCutKey(merchantId: bigint, clip: RenderClip): string {
  const startMs = clip.trimStartMs ?? 0
  const endMs = clip.trimEndMs ?? 0
  const raw = `speechcut:${SPEECH_CUT_VERSION}:${clip.assetId}:${startMs}:${endMs}:${keepFingerprintOf(clip)}`
  const hash = createHash('sha1').update(raw).digest('hex')
  return `${INTERMEDIATE_CACHE_PREFIX}${merchantId.toString()}/speechcut-${hash}.mp4`
}

/**
 * 「**整段**素材」归一化产物的完整对象键 —— **AI 档『本地打底』路线专用**（2026-09-22）。
 *
 * ★★ 为什么必须与 `normalizedClipKey` 分开实现，而不是直接复用它：
 *   `normalizedClipKey` 的键里含 `trimStartMs/trimEndMs`，产出的是**已经剪好的片段**。
 *   而 AI 档要的是**整段**：裁切由云端驱动自己按 trim + 转场余量算
 *   （见 `chatcut-driver.ts` 的 `sourceStartMs = trimStart + handleMsOf(index)`）。
 *   若把剪好的片段递给它，`handle` 会直接越界（ChatCut 会拒单：transition exceeds feasible limit）。
 *   所以这里把 trim 固定成 `0, 0` —— 与 worker 里 `endMs = 0 ⇒ 不带 -to`（直到素材结尾）同口径。
 *
 * ★ 与本地管线**不冲突、可共用缓存**：本地管线在 trim 恰为 0/0 时算出的键与这里**完全相同**，
 *   而产物语义也完全相同（同一 assetId、同一输出尺寸、同样保留原声 v2）
 *   ⇒ 命中即复用，两条路线不会互相覆盖，也不会算出「同键不同内容」。
 */
export function normalizedFullClipKey(
  merchantId: bigint,
  clip: RenderClip,
  output: { width: number; height: number },
): string {
  /**
   * ⚠ 这里必须跟着 `clip` 的口播区间指纹走，**不能**写死 'n'。
   *
   * ★★ 依赖一条不变量（`worker.ts::processChatCutTask` 维持它，改那边之前先读这段）：
   *     `clip.cosKey` 是**原素材** ⟺ `keepRanges` 为空；
   *     `clip.cosKey` 是**口播裁剪产物** ⟺ `keepRanges` 非空。
   *   成立时，指纹就精确对应「这一份字节是什么」，于是：
   *     · 原素材打底   → 指纹 'n'
   *     · 裁剪产物打底 → 指纹 = 区间哈希
   *   两者**不会**算成同一个键。写死 'n' 就会同键不同内容 ——
   *   先打底的整段产物被后面的裁剪产物「命中」，等于裁剪静默失效。
   */
  return `${INTERMEDIATE_CACHE_PREFIX}${merchantId.toString()}/${intermediateKey(clip, 0, 0, output, keepFingerprintOf(clip))}.mp4`
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
