// 整片调色预览：按当前四个调色参数，把「尚未调色的成片」快速重编出一版低码率预览。
//
// 为什么可以便宜（并且默认免费）：
//   正式合成是 归一化(可缓存) → 拼接(copy) → 调色(重编码一次)。
//   其中**归一化**是唯一的重活（源解码 + 缩放），而它按 (assetId, trim, 尺寸) 缓存，
//   与调色参数无关。所以只改调色时，预览只需 拼接 + 一遍调色 —— 与「仅调色重合成」
//   走的是同一条省电路径，只是把编码参数换成 ultrafast/crf32。
//
// ★ 保真铁律：预览与成片**共用同一个 buildColorFilter(color)**，且**不缩放、不降帧**。
//   锐化（unsharp）是像素半径卷积，一旦降分辨率，同样的参数看起来会明显更锐，
//   预览就会误导用户把锐化调过头。宁可文件大一点，也不让预览说谎。
//
// ★ 落盘位置：renders/_cache/{merchantId}/color-preview-{sha1}.mp4
//   故意放在**被 GC 排除的缓存前缀**下（见 cache-keys.ts 的说明）。预览是内容寻址、
//   可再生的中间产物，不属于「用户资产」，因此不需要落库、也不该被 GC 当成孤儿。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadToFile, uploadFile, objectExists } from '../lib/cos.js'
import { ffmpegNormalize, ffmpegApplyColor, ffmpegConcat, buildColorFilter } from './ffmpeg.js'
import { normalizedClipKey, colorPreviewHash, colorPreviewKey } from './cache-keys.js'
import type { ColorGrade, RenderClip } from '../services/render.service.js'

/** 单步 ffmpeg 的超时。预览是同步 HTTP 请求，失败也要尽快把话说明白 */
const PREVIEW_STEP_TIMEOUT_MS = 120_000

/** 预览用编码档位：ultrafast 换速度，crf 32 换体积。**不改分辨率、不改帧率** */
const PREVIEW_ENCODE = { preset: 'ultrafast', crf: 32 } as const

export class ColorPreviewNoopError extends Error {
  constructor() {
    super('调色参数全为 0，没有可预览的变化')
    this.name = 'ColorPreviewNoopError'
  }
}

export class ColorPreviewBusyError extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`调色预览请求过于频繁，请 ${retryAfterSec} 秒后再试`)
    this.name = 'ColorPreviewBusyError'
  }
}

export interface ColorPreviewInput {
  merchantId: bigint
  clips: RenderClip[]
  color: ColorGrade
  output: { width: number; height: number; fps: number }
}

export interface ColorPreviewResult {
  key: string
  /** 命中已有产物（含「同参数正在算，复用了同一次计算」） */
  cached: boolean
  elapsedMs: number
}

// ──────────────────────── 限流：滑动窗口（进程内） ────────────────────────

/**
 * 为什么用进程内 Map 而不是 Redis：API 以 pm2 fork 单实例运行，进程内计数已经够用，
 * 且这里防的是「反复松手把服务器打满」这种高频行为，重启丢计数无伤大雅。
 * 真正的兜底是下面的 in-flight 去重：同一组参数无论来多少次，只算一次。
 *
 * ★ 计数口径 = **新计算次数**，不是请求次数（见 buildColorPreview 里的调用位置）。
 *   命中已有产物、复用 in-flight 都不占名额 —— 否则「用户来回滑到同一个位置」这种
 *   零成本操作也会把名额吃掉，把限流变成误伤。额度据此放宽也只是抵消了这个差异。
 */
const RATE_WINDOW_MS = 60_000
const RATE_MAX = Math.max(1, Number(process.env.COLOR_PREVIEW_RATE_MAX ?? 30))
const rateHits = new Map<string, number[]>()

export function checkColorPreviewRate(merchantId: bigint): void {
  const now = Date.now()
  const id = merchantId.toString()
  const list = (rateHits.get(id) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (list.length >= RATE_MAX) {
    rateHits.set(id, list)
    throw new ColorPreviewBusyError(Math.ceil((RATE_WINDOW_MS - (now - list[0]!)) / 1000))
  }
  list.push(now)
  rateHits.set(id, list)
  // 顺手清理长期不活跃的商家，避免 Map 无限增长
  if (rateHits.size > 500) for (const [k, v] of rateHits) if (!v.length || now - v[v.length - 1]! > RATE_WINDOW_MS * 5) rateHits.delete(k)
}

// ──────────────────────── in-flight 去重 ────────────────────────

/**
 * 同一 hash 的并发请求共享同一次计算。
 * 这不只是省 CPU：前端「松手 → 请求超时 → 重试」是常态，去重后第二次请求
 * 会等到第一次算完并直接命中产物，用户看到的是「重试一下就好了」。
 */
const inflight = new Map<string, Promise<ColorPreviewResult>>()

// ──────────────────────── 主流程 ────────────────────────

export async function buildColorPreview(input: ColorPreviewInput): Promise<ColorPreviewResult> {
  const { merchantId, clips, color, output } = input
  if (clips.length === 0) throw new Error('预览失败：该创作没有可用素材')
  // 全 0 调色没有可预览的变化，且 ffmpegApplyColor 会直接抛错 —— 在入口拦掉，
  // 让前端能拿到一句准确的话（前端在调用前也应自行判断，这里只是纵深防御）
  if (!buildColorFilter(color)) throw new ColorPreviewNoopError()

  const hash = colorPreviewHash(clips, output, color)
  const key = colorPreviewKey(merchantId, hash)

  // 便宜的路径先走完，再谈限流：
  //   命中已有产物 = 一次 HEAD；复用 in-flight = 等别人的计算结果。两者都不消耗服务器算力，
  //   给它们也记一个名额，只会让「反复滑回同一个参数」的用户被无谓地拦下来。
  //   限流真正要管住的是**下面那一次新计算**（拼接 + 整片重编码）。
  //   ⚠ 调用位置就是这条口径本身：别把它挪回函数开头（路由层更不行），挪回去就等于按请求数限流。
  if (await objectExists(key)) return { key, cached: true, elapsedMs: 0 }

  const running = inflight.get(key)
  if (running) return { ...(await running), cached: true }

  checkColorPreviewRate(merchantId)

  const job = renderPreview({ merchantId, clips, color, output, key })
    .finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

async function renderPreview(args: {
  merchantId: bigint
  clips: RenderClip[]
  color: ColorGrade
  output: { width: number; height: number; fps: number }
  key: string
}): Promise<ColorPreviewResult> {
  const { merchantId, clips, color, output, key } = args
  const startedAt = Date.now()
  const dir = await mkdtemp(join(tmpdir(), 'dashuai-color-preview-'))
  try {
    // 1) 取归一化片段：命中缓存直接下载；缺失（缓存被清、素材换过）才重新归一化并回写。
    //    这一步的存在让预览能自愈，代价是极端情况下会走一次重活。
    const normPaths: string[] = []
    let missCount = 0
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]!
      const local = join(dir, `norm_${i}.mp4`)
      const cacheKey = normalizedClipKey(merchantId, clip, output)
      if (await objectExists(cacheKey)) {
        await downloadToFile(cacheKey, local)
      } else {
        missCount++
        const raw = join(dir, `in_${i}.mp4`)
        await downloadToFile(clip.cosKey, raw)
        await ffmpegNormalize(raw, local, {
          width: output.width,
          height: output.height,
          startMs: clip.trimStartMs ?? 0,
          endMs: clip.trimEndMs ?? 0,
          timeoutMs: PREVIEW_STEP_TIMEOUT_MS,
        })
        await rm(raw, { force: true })
        await uploadFile(local, cacheKey, 'video/mp4').catch((e) =>
          console.warn(`[color-preview] 归一化缓存回写失败 ${cacheKey}:`, (e as Error).message),
        )
      }
      normPaths.push(local)
    }

    // 2) 拼接（-c copy，不重编码）→ 3) 调色（唯一的重编码，参数与成片完全同源）
    const concatPath = join(dir, 'concat.mp4')
    await ffmpegConcat(normPaths, concatPath, PREVIEW_STEP_TIMEOUT_MS)
    const outPath = join(dir, 'preview.mp4')
    await ffmpegApplyColor(concatPath, outPath, color, PREVIEW_STEP_TIMEOUT_MS, PREVIEW_ENCODE)

    await uploadFile(outPath, key, 'video/mp4')
    const elapsedMs = Date.now() - startedAt
    if (missCount > 0) {
      // 这条日志用来解释「为什么第一次预览特别慢」：归一化缓存没命中，只能现场补
      console.log(`[color-preview] 缓存未命中 ${missCount}/${clips.length} 段素材，已现场归一化（${elapsedMs}ms）`)
    }
    return { key, cached: false, elapsedMs }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 供测试/观测：清空进程内状态 */
export function __resetColorPreviewState(): void {
  rateHits.clear()
  inflight.clear()
}
