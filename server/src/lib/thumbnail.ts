// 视频封面抽帧：本地存储模式下服务端能直接读到落盘的视频文件，
// 用 ffmpeg 抽第 1 帧作为缩略图，供小程序 <image> 展示。
// 全程 best-effort：ffmpeg 未安装 / 抽帧失败都不应影响上传主流程。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { downloadToFile, objectExists, uploadFile } from './cos.js'
// 只借一个「探时长」的工具：候选帧要在整段时长里等分取点（见 extractCandidateFrames）。
// ★ 方向是 lib → render，反过来的引用不存在，不会有循环依赖。
import { probeDurationMs } from '../render/ffmpeg.js'

/** 由视频对象键推导同目录下的封面键：uploads/{m}/a.mp4 → uploads/{m}/covers/a.jpg */
export function coverKeyForVideoKey(videoKey: string): string {
  const dir = dirname(videoKey)
  const stem = basename(videoKey, extname(videoKey))
  return `${dir}/covers/${stem}.jpg`
}

/** ffmpeg 可执行文件路径（可用 FFMPEG_PATH 覆盖，便于测试/自定义安装位置） */
function ffmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg'
}

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} 超时`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${cmd} 退出码 ${code}`))
    })
  })
}

export interface CoverResult {
  ok: boolean
  /** 抽帧所在时间点（秒），失败时为 null */
  atSeconds: number | null
}/**
 * 从视频抽一帧写为 jpg。
 * 默认先试 1s（避开开场黑帧/转场），失败再退回第 0 帧。
 */
export async function generateVideoCover(
  videoPath: string,
  outPath: string,
  opts: { atSeconds?: number; width?: number } = {},
): Promise<CoverResult> {
  const width = opts.width ?? 640
  const candidates = opts.atSeconds !== undefined ? [opts.atSeconds] : [1, 0]
  try {
    await mkdir(dirname(outPath), { recursive: true })
  } catch {
    return { ok: false, atSeconds: null }
  }
  for (const at of candidates) {
    try {
      await run(ffmpegBin(), [
        '-y',
        // 输入前快进，避免解码整段视频
        '-ss', String(at),
        '-i', videoPath,
        '-frames:v', '1',
        // 等比缩放到宽 640，高自动取偶数（jpg 要求）
        '-vf', `scale=${width}:-2`,
        '-q:v', '4',
        outPath,
      ])
      const s = await stat(outPath)
      if (s.size > 0) return { ok: true, atSeconds: at }
    } catch {
      // 换下一个候选时间点
    }
  }
  return { ok: false, atSeconds: null }
}

/**
 * `ensureVideoCoverKey` 的结果。
 * 失败时带 `reason`：把存储层/ffmpeg 的真实原因透出来，
 * 否则运营只会看到「抽帧失败」，而实际原因可能是对象存储欠费、路径无权限等。
 */
export type CoverOutcome =
  | { ok: true; coverKey: string }
  | { ok: false; reason: string }

/**
 * 确保某个视频对象有配套封面：已有就直接复用，没有就抽一帧并写回对象存储。
 *
 * 与 `generateVideoCover` 的区别：那个只处理「本地文件 → 本地文件」，
 * 调用方还得自己判断 `isLocalStorage()`。这个走 `lib/cos.ts` 的
 * `downloadToFile` / `uploadFile`，**本地模式与 COS 模式都可用**，
 * 供「从成片入库」这类没有 media_asset 记录的场景（excellent_work）使用。
 *
 * 本函数不抛异常，失败一律以 `{ ok: false, reason }` 返回，方便调用方 best-effort 处理。
 */
export async function ensureVideoCoverKey(
  videoKey: string,
  opts: { atSeconds?: number; width?: number } = {},
): Promise<CoverOutcome> {
  const coverKey = coverKeyForVideoKey(videoKey)
  try {
    if (await objectExists(coverKey)) return { ok: true, coverKey }
  } catch {
    // 查不到就当没有，继续尝试生成
  }

  const stamp = randomUUID()
  const tmpVideo = join(tmpdir(), `ds-cover-src-${stamp}${extname(videoKey) || '.mp4'}`)
  const tmpCover = join(tmpdir(), `ds-cover-out-${stamp}.jpg`)
  try {
    try {
      await downloadToFile(videoKey, tmpVideo)
    } catch (e) {
      return { ok: false, reason: `读不到视频对象（${(e as Error).message}）` }
    }

    const r = await generateVideoCover(tmpVideo, tmpCover, opts)
    if (!r.ok) return { ok: false, reason: 'ffmpeg 抽帧失败（确认服务端已安装 ffmpeg，且视频可解码）' }

    try {
      await uploadFile(tmpCover, coverKey, 'image/jpeg')
    } catch (e) {
      return { ok: false, reason: `封面写回存储失败（${(e as Error).message}）` }
    }
    return { ok: true, coverKey }
  } finally {
    await Promise.all([
      rm(tmpVideo, { force: true }).catch(() => undefined),
      rm(tmpCover, { force: true }).catch(() => undefined),
    ])
  }
}

/**
 * 从一段视频里**等分抽取多张候选帧**，供封面的「AI 选帧」使用。
 *
 * 与上面两个函数的区别（别混用，用途不同）：
 *   · generateVideoCover      —— 一个视频取**一张**固定位置的缩略图（列表封面）
 *   · ensureVideoCoverKey     —— 同上，但对象存储入口、把结果写回存储
 *   · extractCandidateFrames  —— 取**多张**代表画面，交给视觉模型去挑（本函数）
 *
 * ★ 为什么要去掉片头片尾：实测片头多半是黑帧/对焦过程、片尾多半是转场或静止收尾，
 *   两端各跳 8% 能显著降低「挑到一张全黑」的概率；剩下的区间里等分取点。
 * ★ 输出压到 `width` 宽：视觉模型按图计费，而且**每张图有固定开销**
 *   （2026-09-24 实测：640px 的帧约 **1.3k prompt token / 张**，与图大小关系不大；6 张 ≈ 10k token）。
 *   原图（1080×1920、几 MB）换来的判断力提升微乎其微，token 与上传时间却翻几倍。
 *   ⚠ 这个宽度**只影响「喂给模型看的候选图」**：封面底图另按同一时间点、以
 *     `BASE_FRAME_WIDTH`（= 底图目标宽）再抽一份高清帧（见 publish-material.service.ts），
 *     所以这里**不必**为了底图质量而放大 —— 放大了只是白花 token 与上传时间。
 * ★ 单帧失败就跳过该帧、**不抛错**：少一张候选不影响主流程。
 *   一张都抽不到时返回空数组，由调用方决定怎么降级（见 publish-material.service.ts）。
 * ★ 竖拍素材不必在这里处理旋转：ffmpeg 的 `scale` 滤镜默认带 autorotate，
 *   拿到的是显示方向正确的画面（见 render/ffmpeg.ts 里 rotateToDisplay 的说明）。
 */
export async function extractCandidateFrames(
  videoPath: string,
  outDir: string,
  opts: { count?: number; width?: number; durationMs?: number } = {},
): Promise<{ atSeconds: number; path: string }[]> {
  const count = Math.max(1, Math.min(opts.count ?? 5, 12))
  const width = opts.width ?? 640
  const durationMs = opts.durationMs ?? (await probeDurationMs(videoPath).catch(() => null))
  if (!durationMs || durationMs <= 0) return []

  try {
    await mkdir(outDir, { recursive: true })
  } catch {
    return []
  }

  // 跳过片头片尾各 8%，在剩下的区间里等分取点
  const head = durationMs * 0.08
  const span = Math.max(1, durationMs * 0.92 - head)
  const frames: { atSeconds: number; path: string }[] = []

  for (let i = 0; i < count; i++) {
    // 只要一张时取区间中点 —— 首尾两端恰好是最不稳定的画面
    const atMs = count === 1 ? head + span / 2 : head + (span * i) / (count - 1)
    const atSeconds = Number((atMs / 1000).toFixed(3))
    const framePath = join(outDir, `pick-${String(i).padStart(2, '0')}.jpg`)
    try {
      await run(ffmpegBin(), [
        '-y',
        // 输入前快进：只解码目标帧附近，不必解整段
        '-ss', atSeconds.toFixed(3),
        '-i', videoPath,
        '-frames:v', '1',
        // 等比缩放到指定宽，高自动取偶数（jpg 要求）
        '-vf', `scale=${width}:-2`,
        '-q:v', '4',
        framePath,
      ])
      const s = await stat(framePath)
      if (s.size > 0) frames.push({ atSeconds, path: framePath })
    } catch {
      // 换下一个时间点；单帧失败不该让整批失败
    }
  }
  return frames
}

/**
 * 把一帧真实画面做成 **3:4 的封面底图**（纯 ffmpeg 几何操作，零 AI、零重绘）。
 *
 * ★★ 为什么必须有这一步（2026-09-24 的实测结论）：
 *   此前是「把 9:16 的原帧直接交给出图模型，让它自己变成 3:4」。实测证明**这条路走不通**：
 *   把成品与源帧做「缩放比 × 偏移」的二维搜索，**所有组合的最佳匹配都只有约 13 dB**
 *   （同一张图应为 ∞，视觉相近 25~35 dB）⇒ 成品的像素**根本不是从源帧变换来的**。
 *   对照图更直接：源帧是「脸占满画面」的大特写，成品却被**拉远了**，还补出了原图里没有的背景。
 *
 *   原因不是模型不听话，而是我们**给了它两条互相冲突的指令**：
 *   一边要求「主体完整入画」，一边要求「标题放在留白处、不许遮挡主体」——
 *   而那一帧**没有留白**（脸占满）。模型只能靠**缩小主体 + 凭空补背景**来腾出放字的地方。
 *
 *   ⇒ 结论：**比例换算和取景是几何问题，必须由 ffmpeg 确定性解决**，
 *     模型的职责收窄成「在给定画面上设计标题」这一件事。
 *
 * 做法（full-bleed）：等比放大到**铺满**目标框，再居中裁掉多余部分。
 *   ★ 不选「两侧插虚化条」：抖音封面是满幅的，插条会显得廉价（见 PUBLISH_COVER_PROMPT 的说明）。
 *   ★ 不选「等比缩放到框内」：那会在四周留白，同样不是满幅。
 *   ⚠ 代价：9:16 → 3:4 要**裁掉约 25% 的高度**。这是比例关系的硬约束，不是实现缺陷；
 *     缓解办法是**选帧时偏好带一点上/下余量的画面**（见 COVER_SHOT_PRIORITY 与选帧提示词）。
 *
 * 返回是否成功；失败时调用方应退回用原帧（best-effort，不能因为这一步让封面挂掉）。
 */
export async function buildCoverBase(
  framePath: string,
  outPath: string,
  opts: { width?: number; height?: number } = {},
): Promise<boolean> {
  const W = opts.width ?? 1080
  const H = opts.height ?? 1440
  if (W % 2 !== 0 || H % 2 !== 0) return false
  const filter =
    `scale=${W}:${H}:force_original_aspect_ratio=increase,` +
    `crop=${W}:${H}` +
    // 轻微降饱和 + 压暗：满幅裁切后画面常常偏亮，而标题（尤其浅色字）需要一个压得住的底
    `,eq=saturation=0.94:brightness=-0.02`
  try {
    await run(ffmpegBin(), [
      '-y',
      '-i', framePath,
      '-frames:v', '1',
      '-vf', filter,
      '-q:v', '2',
      outPath,
    ], 20000)
    const s = await stat(outPath)
    return s.size > 0
  } catch {
    return false
  }
}
