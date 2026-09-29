/**
 * 口播裁剪：把一条素材里「没人说话」的区间剪掉，产出一段**连续**的新素材。
 *
 * ★★ 这是本次「AI 剪辑不删废片」修复的**落地方式**，选它的理由值得记下来：
 *
 *   需求是「素材内部也有要剪的地方」（头 1.55s、尾 0.76s、中间 4 处 1.65~2.95s 停顿），
 *   即在一条素材内部**挖掉若干区间**。有两条路：
 *
 *   A. 在下游时间轴上把一条素材排成多条 clip（ChatCut 的 clip 是**单区间**模型：
 *      `{assetId, fromFrame, durationInFrames, sourceStartFromInSeconds}`，没有 sourceEnd）
 *      ⇒ 要连带处理：转场余量怎么分给每一段、A1 配音轨按什么排、
 *        逐段帧数分配（floor 之后总和必须与配音轨严格相等，否则越往后越错位）、
 *        归一化缓存键要不要含剪法……
 *   B. **在上游把素材剪成一段连续文件**，下游看到的仍是一条普通素材，所有既有逻辑原样成立。
 *
 *   ⇒ 选 B。它把上面那一整类问题**一次消掉**；代价只是多一次本地 trim+concat 转码，
 *     而这次转码**命中缓存**（键含口播区间指纹，见 `cache-keys.ts::speechCutKey`），
 *     只在同一条素材的第一次合成时付；之后（含「仅改调色重合成」）直接复用。
 *
 * ★★ 三条边界，一条都不能松：
 *   1. **没有 keepRanges 就什么都不做**（返回 null）—— 判不出来时绝不能裁。
 *   2. **裁剪只做「删区间」，不做提速**。局部变速会改变音调与口型同步；
 *      而用户描述的症状是「卡顿」，删掉才是对症的。
 *   3. **补集用「超大尾部哨兵」而不是算出来的素材时长**。理由见下面 `TAIL_SENTINEL_MS`。
 */

import { join } from 'node:path'
import { downloadToFile, objectExists, uploadFile } from '../lib/cos.js'
import { speechCutKey } from './cache-keys.js'
import { ffmpegRemoveTimeRanges, probeDurationMs } from './ffmpeg.js'
import { cutRangesInWindow, sliceKeepRanges, type KeepRange } from './speech-range.js'
import type { RenderClip } from '../services/render.service.js'

/**
 * 尾部补集的哨兵值。
 *
 * ★★ 为什么不老老实实传「素材真实时长」：
 *   `ffmpegRemoveTimeRanges` 内部自己探一次输入文件的真实时长，并把传入区间**夹到**它，
 *   然后用「补集」作为要保留的片段。若我们传的时长**略小于**真实时长，
 *   它会把 `[传入时长, 真实时长)` 这一截当成「没被声明为要删除」而**保留下来**
 *   —— 于是尾部的废片又回来了，而且看不出来（只是「好像没剪干净」）。
 *   传一个远大于任何素材的值，夹取那一步就会把它收敛到真实时长，尾部被完整删掉。
 */
const TAIL_SENTINEL_MS = 24 * 60 * 60 * 1000

export interface SpeechCutResult {
  /** 裁剪产物在 COS 上的对象键 */
  cosKey: string
  /** 裁剪产物的本地路径（调用方负责所在目录的生命周期） */
  localPath: string
  /** 裁剪产物的真实时长（ms），探不到时为 null */
  durationMs: number | null
  /** 相对原素材剪掉了多少毫秒（仅用于日志与用户提示） */
  cutMs: number
}

/**
 * 确保「口播裁剪产物」存在，并返回它。
 *
 * 返回 `null` 表示**不需要/不能裁**（没有任何废片、或判据缺失），调用方必须原样使用原素材。
 *
 * @param input.clip           用它的 `assetId` / trim 窗口 / 口播区间算键与剪法
 * @param input.workDir        调用方的工作目录（产物与临时下载都放这里，由调用方清理）
 * @param input.localSourcePath 已经下好的原素材本地路径（省一次下载）
 */
export async function ensureSpeechCutClip(input: {
  merchantId: bigint
  clip: RenderClip
  workDir: string
  timeoutMs: number
  localSourcePath?: string | null
  /** 原素材真实时长（ms）。只用于把「剪掉多少」算准；不参与剪法 */
  materialDurationMs?: number | null
}): Promise<SpeechCutResult | null> {
  const ranges = input.clip.keepRanges
  if (!ranges || ranges.length === 0) return null

  // 窗口 = 用户已经选好的 trim 区间：语音区间**不能越过它**（用户明确表示不要的部分不许再剪进来）。
  // ★ 上界在 `trimEndMs` 为空时用哨兵 —— 哨兵只在「夹保留区间」这一步用；
  //   下面算补集时**永远**用哨兵，所以尾部空白一定会被删掉（无论窗口上界是多少）。
  const windowStart = Math.max(0, Math.round(input.clip.trimStartMs ?? 0))
  const requestedEnd = Math.round(input.clip.trimEndMs ?? 0)
  const windowEnd = requestedEnd > windowStart ? requestedEnd : TAIL_SENTINEL_MS
  const kept = sliceKeepRanges(ranges, windowStart, windowEnd)
  if (kept.length === 0) return null

  // 补集 = 要删掉的区间。坐标相对**素材起点**（窗口下界传 0），正好是 ffmpeg 需要的口径。
  const cuts = cutRangesInWindow(kept, 0, TAIL_SENTINEL_MS)
  if (cuts.length === 0) return null

  /**
   * 实际剪掉多少毫秒。
   * ★ 必须把哨兵那一刀夹回**素材真实时长**再相加 —— 否则会报出
   *   「剪掉 86400000ms」这种数字，而这条日志是给运维判断「剪得对不对」用的，
   *   报错了比不报还糟（会让人以为判据失控）。
   * ★ 素材时长取 `materialDurationMs` / `clip.durationMs`（上传确认时登记的值）；
   *   拿不到时就只统计「头部 + 内部停顿」，**不把尾部哨兵算进去**。
   */
  const materialMs = Math.round(input.materialDurationMs ?? input.clip.durationMs ?? 0)
  const tailStart = Math.max(0, Math.round(kept[kept.length - 1]!.endMs))
  const cutMs = cuts.reduce((sum, range) => {
    const start = Math.max(0, Math.round(range.startMs))
    const rawEnd = Math.round(range.endMs)
    if (rawEnd >= TAIL_SENTINEL_MS) {
      return sum + (materialMs > 0 ? Math.max(0, materialMs - Math.max(start, tailStart)) : 0)
    }
    return sum + Math.max(0, rawEnd - start)
  }, 0)
  const key = speechCutKey(input.merchantId, input.clip)
  const hash = key.slice(key.lastIndexOf('/') + 1, key.lastIndexOf('.'))
  // ★ 临时文件名带上缓存键哈希：两个分镜复用同一段素材时不会互相覆盖同一个中转文件
  const localPath = join(input.workDir, `cut-${hash}.mp4`)

  if (await objectExists(key)) {
    await downloadToFile(key, localPath)
    return { cosKey: key, localPath, durationMs: await probeDurationMs(localPath), cutMs }
  }

  let source = input.localSourcePath ?? null
  if (!source) {
    source = join(input.workDir, `cut-src-${hash}.mp4`)
    await downloadToFile(input.clip.cosKey, source)
  }
  await ffmpegRemoveTimeRanges(source, localPath, cuts, input.timeoutMs)
  // 回写缓存失败不阻塞渲染（下次重算即可）
  await uploadFile(localPath, key, 'video/mp4').catch((error) =>
    console.warn(`[speech-cut] 裁剪产物回写缓存失败 ${key}：`, (error as Error).message),
  )
  return { cosKey: key, localPath, durationMs: await probeDurationMs(localPath), cutMs }
}

/**
 * 只按**已知的**口播区间裁；不知道就返回 null —— 绝不在这里触发 ASR。
 *
 * ★ 给 `preview.ts`（调色预览）用：预览是用户滑一下调色就发起的轻操作，
 *   不该因为一次 ASR 卡上几秒。库里已经有结论时它跟着裁（与正式合成同一份产物、同一个键），
 *   还没有结论时它就按原素材出预览 —— 两条路算出的缓存键不同（指纹 `n` vs 真实指纹），
 *   所以**不会**互相污染；代价仅仅是「第一次预览看到的是没剪过的素材」。
 */
export async function ensureSpeechCutClipIfKnown(input: {
  merchantId: bigint
  clip: RenderClip
  workDir: string
  timeoutMs: number
}): Promise<SpeechCutResult | null> {
  if (!input.clip.keepRanges?.length) return null
  return ensureSpeechCutClip(input).catch((error) => {
    console.warn(`[speech-cut] 预览侧裁剪失败（退回原素材）：`, (error as Error).message)
    return null
  })
}

/** 供诊断：把一组保留区间换算成「要删的区间」（素材绝对坐标）。 */
export function cutRangesForKeep(keptRanges: readonly KeepRange[]): KeepRange[] {
  return cutRangesInWindow(keptRanges, 0, TAIL_SENTINEL_MS)
}
