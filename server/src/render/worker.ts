// 合成 Worker：轮询 RenderTask(QUEUED) → 拉素材 → FFmpeg 粗剪 → 回传 COS → 结算扣豆
// 与 API 服务解耦：CPU 密集的转码不在请求线程里跑，可独立进程/独立机器部署
// 计费铁律：submitRender 只 freeze 预留；本 worker 成功才 consume，失败 unfreeze 全额释放
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prisma } from '../db.js'
import {
  completeRender,
  failRender,
  DEFAULT_COLOR,
  RENDER_BEAN_FULL,
  type ColorGrade,
  type RenderClip,
} from '../services/render.service.js'
import { downloadToFile, uploadFile, objectExists, cosReady } from '../lib/cos.js'
import {
  ffmpegNormalize,
  ffmpegApplyColor,
  ffmpegConcat,
  probeDurationMs,
  buildColorFilter,
} from './ffmpeg.js'
import { applyAiSynthesis, type SynthesisShot } from './synthesis.js'
import { activeTtsProvider } from '../services/tts-provider.service.js'

const POLL_MS = Math.max(1000, Number(process.env.FFMPEG_POLL_MS ?? 3000))
const TASK_TIMEOUT_MS = Math.max(30_000, Number(process.env.FFMPEG_TASK_TIMEOUT_MS ?? 600_000))

let running = false
let timer: ReturnType<typeof setTimeout> | null = null

export function startRenderWorker(): void {
  if (running) return
  running = true
  if (!cosReady()) {
    console.warn('[render-worker] 警告：COS 未配置，真实合成无法下载素材/上传成片（FFMPEG_WORKER=true 时务必配 COS_*）')
  }
  console.log(`[render-worker] started (poll=${POLL_MS}ms, taskTimeout=${TASK_TIMEOUT_MS}ms)`)
  void loop()
}

export function stopRenderWorker(): void {
  running = false
  if (timer) clearTimeout(timer)
  timer = null
}

async function loop(): Promise<void> {
  if (!running) return
  try {
    await tick()
  } catch (e) {
    console.error('[render-worker] tick error:', (e as Error).message)
  }
  if (running) timer = setTimeout(() => void loop(), POLL_MS)
}

/** 取一个 QUEUED 任务并抢占标记 RUNNING（多 worker 并发时用 updateMany 条件更新抢锁） */
async function tick(): Promise<void> {
  // PREMIUM（人工精剪）任务不进机器队列，由管理后台剪辑工作台处理
  const task = await prisma.renderTask.findFirst({
    where: { status: 'QUEUED', grade: { not: 'PREMIUM' } },
    orderBy: { createdAt: 'asc' },
  })
  if (!task) return

  const claimed = await prisma.renderTask.updateMany({
    where: { id: task.id, status: 'QUEUED' },
    data: { status: 'RUNNING', startAt: new Date(), progress: 5 },
  })
  if (claimed.count === 0) return // 被其他 worker 抢走

  const startedAt = Date.now()
  try {
    await processTask(task)
    console.log(`[render-worker] task ${task.id} done in ${Date.now() - startedAt}ms`)
  } catch (e) {
    console.error(`[render-worker] task ${task.id} failed:`, (e as Error).message)
    await failRender(prisma, task.id, 'FFMPEG_FAILED', (e as Error).message)
  }
}

async function processTask(task: {
  id: bigint
  merchantId: bigint
  paramsJson: unknown
}): Promise<void> {
  const p = (task.paramsJson ?? {}) as {
    clips?: RenderClip[]
    color?: ColorGrade
    aiMode?: boolean
    output?: { width: number; height: number; fps: number }
  }
  const clips = p.clips ?? []
  if (clips.length === 0) throw new Error('合成任务没有可用素材')
  const output = p.output ?? { width: 1080, height: 1920, fps: 30 }
  const color = p.color ?? DEFAULT_COLOR
  const aiMode = p.aiMode ?? true // v5：默认 AI 合成

  const dir = await mkdtemp(join(tmpdir(), 'dashuai-render-'))
  try {
    // 1) 逐镜头：归一化（命中缓存则跳过）→ 调色
    const tmpClips: string[] = []
    let hitCount = 0
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]
      if (!clip) continue
      await prisma.renderTask.update({
        where: { id: task.id },
        data: { progress: 10 + Math.round((i / clips.length) * 60) },
      })

      const startMs = clip.trimStartMs ?? 0
      const endMs = clip.trimEndMs ?? 0
      const normPath = join(dir, `norm_${i}.mp4`)

      // 中间产物缓存：key 由 (assetId, trim, 尺寸) 决定，与调色无关，故重调色可复用
      const cacheKey = `renders/_cache/${task.merchantId.toString()}/${intermediateKey(clip, startMs, endMs, output)}.mp4`
      if (await objectExists(cacheKey)) {
        await downloadToFile(cacheKey, normPath)
        hitCount++
      } else {
        const rawPath = join(dir, `in_${i}.mp4`)
        await downloadToFile(clip.cosKey, rawPath)
        await ffmpegNormalize(rawPath, normPath, {
          width: output.width,
          height: output.height,
          startMs,
          endMs,
          timeoutMs: TASK_TIMEOUT_MS,
        })
        // 回写缓存失败不阻塞主流程（下次重算即可）
        await uploadFile(normPath, cacheKey, 'video/mp4').catch((e) =>
          console.warn(`[render-worker] 缓存回写失败 ${cacheKey}:`, (e as Error).message),
        )
      }

      // 无调色时归一化物即成片片段；这里只收集，调色统一放到拼接后做（见下）
      tmpClips.push(normPath)
    }
    const allCacheHit = tmpClips.length > 0 && hitCount === clips.length

    // 2) 硬切拼接（copy，不重编码）
    await prisma.renderTask.update({ where: { id: task.id }, data: { progress: 75 } })
    const concatPath = join(dir, 'concat.mp4')
    await ffmpegConcat(tmpClips, concatPath, TASK_TIMEOUT_MS)

    // 3) 整片调色：放在拼接后做单一 pass，而不是逐镜头各做一次。
    //    这样 N 个镜头只编码 1 次；重调色时可完全复用归一化缓存，只跑「拼接 + 一遍调色」，
    //    相比首次合成省掉全部源解码与缩放 —— 这正是 RECOLOR 只收 10 豆的成本依据
    let finalPath = concatPath
    if (buildColorFilter(color)) {
      finalPath = join(dir, 'final.mp4')
      await ffmpegApplyColor(concatPath, finalPath, color, TASK_TIMEOUT_MS)
    }

    // 3.5) AI 合成（aiMode=true，默认）：AI 配音 + 字幕 + 智能节奏，叠加到成片
    if (aiMode) {
      await prisma.renderTask.update({ where: { id: task.id }, data: { progress: 82 } })
      // 逐分镜探测实际时长（归一化产物），并携带口播文案，供配音/字幕按时间轴布时
      const shots: SynthesisShot[] = []
      for (let i = 0; i < tmpClips.length; i++) {
        const tp = tmpClips[i]
        const clip = clips[i]
        if (!tp || !clip) continue
        shots.push({ line: clip.line, durationMs: (await probeDurationMs(tp)) ?? 0 })
      }
      if (shots.length > 0) {
        const aiPath = join(dir, 'ai.mp4')
        // 从后台读取当前生效的 TTS 供应商（真实合成尚未实现，此处仅透传配置用于后续 vendor 分支）
        const tts = await activeTtsProvider(prisma).catch(() => null)
        if (tts) {
          console.log(`[render-worker] task ${task.id} 使用 TTS 供应商 ${tts.code}（真实配音尚未实现，暂静音兜底）`)
        } else {
          console.log('[render-worker] 未配置 TTS 供应商，AI 合成以「静音 + 字幕」出片')
        }
        const { subtitled } = await applyAiSynthesis(finalPath, shots, aiPath, TASK_TIMEOUT_MS, tts)
        finalPath = aiPath
        console.log(`[render-worker] task ${task.id} AI合成完成（字幕=${subtitled ? '是' : '否'}）`)
      }
    }

    // 4) 回传 COS
    await prisma.renderTask.update({ where: { id: task.id }, data: { progress: 90 } })
    const key = `renders/${task.merchantId.toString()}/${task.id.toString()}.mp4`
    const size = await uploadFile(finalPath, key, 'video/mp4')
    const durationMs = await probeDurationMs(finalPath)

    // 4) 结算扣豆 + 落产物（幂等：requestId rc:<taskId>）
    await prisma.$transaction((tx) =>
      completeRender(tx, task.merchantId, task.id, {
        resultKey: key,
        resultSize: BigInt(size),
        durationMs,
        cacheHit: allCacheHit,
      }),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 中间产物缓存键：(assetId, trim 起止, 输出尺寸) → sha1
 * 不含调色参数，因此「仅改调色重合成」能命中缓存，只跑一遍调色+拼接（对应 10 豆计费）
 */
function intermediateKey(
  clip: RenderClip,
  startMs: number,
  endMs: number,
  output: { width: number; height: number },
): string {
  const raw = `${clip.assetId}:${startMs}:${endMs}:${output.width}x${output.height}`
  return createHash('sha1').update(raw).digest('hex')
}

// ──────────────────────── 卡死任务恢复 sweeper ────────────────────────
// worker 进程在 RUNNING 中途被杀（kill -9 / 断电 / OOM）时，任务会永久卡在 RUNNING；
// QUEUED 任务在 worker 长期不在线时同样会卡住，并阻塞该创作的再次提交。
// 本 sweeper 常驻 API 进程（与 premium sweeper 一样不依赖 FFMPEG_WORKER），
// 超时任务统一走 failRender：unfreeze 全额退款 + FAILED(WORKER_TIMEOUT)，用户可重新提交。
const STUCK_SWEEP_MS = Math.max(60_000, Number(process.env.RENDER_STUCK_SWEEP_MS ?? 300_000))
const STUCK_TIMEOUT_MS = Math.max(120_000, Number(process.env.RENDER_STUCK_MS ?? 1_800_000))

let stuckSweeping = false
let stuckTimer: ReturnType<typeof setInterval> | null = null

export function startStuckSweeper(): void {
  if (stuckSweeping) return
  stuckSweeping = true
  console.log(`[stuck-sweeper] started (interval=${STUCK_SWEEP_MS}ms, timeout=${STUCK_TIMEOUT_MS}ms)`)
  stuckTimer = setInterval(() => void sweepStuck(), STUCK_SWEEP_MS)
}

export function stopStuckSweeper(): void {
  stuckSweeping = false
  if (stuckTimer) clearInterval(stuckTimer)
  stuckTimer = null
}

/** 超时的机器任务（RUNNING 卡死 / QUEUED 长期无人处理）：退款 + FAILED(WORKER_TIMEOUT) */
async function sweepStuck(): Promise<void> {
  if (!stuckSweeping) return
  const deadline = new Date(Date.now() - STUCK_TIMEOUT_MS)
  const stuck = await prisma.renderTask.findMany({
    where: {
      grade: { not: 'PREMIUM' },
      OR: [
        { status: 'RUNNING', OR: [{ startAt: { lt: deadline } }, { startAt: null }] },
        { status: 'QUEUED', createdAt: { lt: deadline } },
      ],
    },
    take: 50,
  })
  for (const task of stuck) {
    try {
      const state = await failRender(prisma, task.id, 'WORKER_TIMEOUT', '合成超时未完成，已自动退款，可重新提交')
      console.warn(`[stuck-sweeper] task ${task.id}(${task.status}) 超时回收，结果 ${state}`)
    } catch (e) {
      console.error(`[stuck-sweeper] task ${task.id} 回收失败:`, (e as Error).message)
    }
  }
}
