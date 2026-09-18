// 合成 Worker：轮询 RenderTask(QUEUED) → 拉素材 → FFmpeg 粗剪 → 回传 COS → 结算扣积分
// 与 API 服务解耦：CPU 密集的转码不在请求线程里跑，可独立进程/独立机器部署
// 计费铁律：submitRender 只 freeze 预留；本 worker 成功才 consume，失败 unfreeze 全额释放
import { mkdtemp, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '../db.js'
import { normalizedClipKey } from './cache-keys.js'
import {
  completeRender,
  failRender,
  sweepSettlementPending,
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
  probeVideo,
  buildColorFilter,
  ffmpegSupportsSubtitles,
} from './ffmpeg.js'
import { applyAiSynthesis, type SynthesisShot } from './synthesis.js'
import { activeTtsProvider } from '../services/tts-provider.service.js'
import { signedObjectUrl } from '../lib/cos.js'
import {
  chatCutConfigured,
  DEFAULT_CHATCUT_OPTIONS,
  type ChatCutOptions,
} from './chatcut.js'
import {
  pollChatCutRender,
  startChatCutRender,
  type ChatCutJobState,
} from './chatcut-driver.js'

const POLL_MS = Math.max(1000, Number(process.env.FFMPEG_POLL_MS ?? 3000))
const TASK_TIMEOUT_MS = Math.max(30_000, Number(process.env.FFMPEG_TASK_TIMEOUT_MS ?? 600_000))

// ────────────────────── RUNNING 任务的租约（进程存活证明） ──────────────────────
// ★ 为什么需要：任务被 `tick()` 认领成 RUNNING 之后，**唯一**能推进它的就是这个进程。
//   进程一死（kill -9 / OOM / 部署重启 / 本地 `tsx watch` 热重载），任务就永久停在认领时
//   写下的 progress=5，而且没有任何代码会再碰它 —— `tick()` 只认领 QUEUED，
//   `pollChatCutTasks()` 又要求 `paramsJson.chatcutJob.projectId` 已存在（AI 档在启动阶段
//   还没建出项目，实测卡住的 990025 就是 phase=null / projectId=null）。用户看到的就是
//   「一直卡在合成中 5%」，预留积分一直冻着，必须干等 30 分钟 stuck-sweeper 才退款。
//   修法：认领时写租约，运行期间心跳；心跳停了 = 进程没了 ⇒ 回收重跑。
// ⚠ 心跳只改 paramsJson 里的一个 key（走原生 JSON_SET），**不做 read-modify-write** ——
//   否则会和 `storeChatCutState` 的全量替换 paramsJson 撞成读改写竞态、把 chatcutJob 洗掉。
const WORKER_ID = `${process.pid}@${Date.now()}`
const HEARTBEAT_MS = Math.max(5_000, Number(process.env.RENDER_HEARTBEAT_MS ?? 30_000))
/** 心跳超过这个时长没刷新 ⇒ 认定持有它的进程已死 */
const HEARTBEAT_STALE_MS = Math.max(30_000, Number(process.env.RENDER_HEARTBEAT_STALE_MS ?? 120_000))
/** 刚认领（心跳还没落库）的任务不参与回收，避免误杀正在启动的任务 */
const ORPHAN_MIN_AGE_MS = Math.max(30_000, Number(process.env.RENDER_ORPHAN_MIN_AGE_MS ?? 120_000))
/** 孤儿扫描间隔（每轮 tick 都查太频） */
const ORPHAN_SWEEP_MS = Math.max(10_000, Number(process.env.RENDER_ORPHAN_SWEEP_MS ?? 60_000))
/** 同一任务最多被重跑几次，超了直接退款 —— 防「一启动就崩」的任务无限重试烧远端额度 */
const MAX_RESUME = Math.max(1, Number(process.env.RENDER_MAX_RESUME ?? 3))
/** 启动阶段的进度上报节流：十几个阶段节点不必逐条打库 */
const PHASE_MIN_INTERVAL_MS = Math.max(200, Number(process.env.RENDER_PHASE_MIN_INTERVAL_MS ?? 3000))

let running = false
let timer: ReturnType<typeof setTimeout> | null = null
let lastOrphanSweepAt = 0

export function startRenderWorker(): void {
  if (running) return
  running = true
  if (!cosReady()) {
    console.warn('[render-worker] 警告：COS 未配置，真实合成无法下载素材/上传成片（FFMPEG_WORKER=true 时务必配 COS_*）')
  }
  // 字幕烧录依赖 ffmpeg 的 libass（subtitles 滤镜）；精简版 ffmpeg 没有，AI 档会静默降级为无字幕
  void ffmpegSupportsSubtitles().then((ok) => {
    if (!ok) {
      console.warn(
        '[render-worker] 警告：ffmpeg 未编译 libass（缺少 subtitles 滤镜），AI 档只出配音轨、不烧字幕。' +
          'macOS：brew install ffmpeg-full 并设 FFMPEG_PATH；Linux：安装带 libass 的 ffmpeg 与 fonts-noto-cjk。',
      )
    }
  })
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

/** 刷新租约：只原子地改 paramsJson 里的一个 key */
async function touchLease(taskId: bigint): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE render_task
      SET params_json = JSON_SET(
        COALESCE(params_json, JSON_OBJECT()),
        '$.worker.heartbeatAtMs',
        ${Date.now()}
      )
      WHERE id = ${taskId} AND status = 'RUNNING'
    `
  } catch (e) {
    console.warn(`[render-worker] task ${taskId} 心跳写入失败:`, (e as Error).message)
  }
}

/**
 * 回收「上一个进程留下的 RUNNING 孤儿」。
 *
 * 判据（须全部满足）：
 *   ① status=RUNNING，且不是 PREMIUM（人工档由剪辑工作台接管，与机器心跳无关）
 *   ② start_at 早于 ORPHAN_MIN_AGE_MS —— 给刚认领、心跳还没落库的任务留窗口
 *   ③ 心跳缺失或已过期 —— 缺失 = 本补丁之前遗留的卡死任务；过期 = 持有它的进程没了
 *   ④ 无 `chatcutJob.projectId` —— 已有项目 id 的任务远端存在状态，归 `pollChatCutTasks()` 推进
 *
 * 处置：**重置回 QUEUED 重跑**（正常路径）；重跑次数超 MAX_RESUME 则退款收尾。
 * ⚠ 重置不碰积分：提交时已 freeze，重跑不会重复冻结，只有最终成功才 consume。
 */
async function reclaimOrphanedRuns(): Promise<void> {
  if (Date.now() - lastOrphanSweepAt < ORPHAN_SWEEP_MS) return
  lastOrphanSweepAt = Date.now()
  const staleMs = Date.now() - HEARTBEAT_STALE_MS
  const ageBefore = new Date(Date.now() - ORPHAN_MIN_AGE_MS)
  const orphans = await prisma.$queryRaw<Array<{ id: bigint; retryCount: number }>>`
    SELECT id, retry_count AS retryCount
    FROM render_task
    WHERE status = 'RUNNING'
      AND grade <> 'PREMIUM'
      AND start_at IS NOT NULL
      AND start_at < ${ageBefore}
      AND JSON_EXTRACT(params_json, '$.chatcutJob.projectId') IS NULL
      AND (
        JSON_EXTRACT(params_json, '$.worker.heartbeatAtMs') IS NULL
        OR CAST(JSON_EXTRACT(params_json, '$.worker.heartbeatAtMs') AS SIGNED) < ${staleMs}
      )
    LIMIT 20
  `
  for (const orphan of orphans) {
    try {
      if (orphan.retryCount >= MAX_RESUME) {
        const state = await failRender(
          prisma,
          orphan.id,
          'WORKER_TIMEOUT',
          '合成进程多次中断，已自动退款，可重新提交',
        )
        console.warn(`[render-worker] task ${orphan.id} 中断已达 ${orphan.retryCount} 次，回收为 ${state}`)
        continue
      }
      const reset = await prisma.renderTask.updateMany({
        where: { id: orphan.id, status: 'RUNNING' },
        data: { status: 'QUEUED', progress: 0, startAt: null, retryCount: orphan.retryCount + 1, errorCode: null, errorMsg: null },
      })
      if (reset.count > 0) {
        console.warn(
          `[render-worker] task ${orphan.id} 租约过期（持有它的进程已中断），已重置回 QUEUED 重跑` +
            `（第 ${orphan.retryCount + 1}/${MAX_RESUME} 次）`,
        )
      }
    } catch (e) {
      console.error(`[render-worker] task ${orphan.id} 孤儿回收失败:`, (e as Error).message)
    }
  }
}

/**
 * 启动阶段的进度上报：把 ChatCut 侧的 0~1 阶段映射到 5%~29%。
 * 30% 之后由 `storeChatCutState`（按 `chatcutJob.phase` 决定 30/60）接管。
 * ★ 必须节流：启动阶段有十几个阶段节点，逐条 UPDATE 纯属白打库。
 */
function makePhaseReporter(taskId: bigint): (info: { ratio: number; label: string }) => void {
  let last = 5
  let lastAt = 0
  return (info) => {
    const pct = Math.min(29, 5 + Math.round(info.ratio * 24))
    const now = Date.now()
    if (pct <= last || now - lastAt < PHASE_MIN_INTERVAL_MS) return
    last = pct
    lastAt = now
    console.log(`[render-worker] task ${taskId} 启动阶段 ${pct}%：${info.label}`)
    void prisma.renderTask
      .updateMany({ where: { id: taskId, status: 'RUNNING' }, data: { progress: pct } })
      .catch((e) => console.warn(`[render-worker] task ${taskId} 阶段进度写入失败:`, (e as Error).message))
  }
}

/** 取一个 QUEUED 任务并抢占标记 RUNNING（多 worker 并发时用条件更新抢锁） */
async function tick(): Promise<void> {
  await reclaimOrphanedRuns() // 先捡回上个进程留下的孤儿，再取新任务

  // PREMIUM（人工精剪）任务不进机器队列，由管理后台剪辑工作台处理
  const task = await prisma.renderTask.findFirst({
    where: { status: 'QUEUED', grade: { not: 'PREMIUM' } },
    orderBy: { createdAt: 'asc' },
  })
  if (!task) {
    await pollChatCutTasks()
    return
  }

  // 认领 + 落租约一次写完。走原生 JSON_SET 只加 `$.worker` 一个 key，
  // 不把整个 paramsJson 读出来重写（那会和并发写 chatcutJob 的路径打架）。
  const claimed = await prisma.$executeRaw`
    UPDATE render_task
    SET status = 'RUNNING',
        start_at = ${new Date()},
        progress = 5,
        params_json = JSON_SET(
          COALESCE(params_json, JSON_OBJECT()),
          '$.worker',
          JSON_OBJECT('id', ${WORKER_ID}, 'heartbeatAtMs', ${Date.now()})
        )
    WHERE id = ${task.id} AND status = 'QUEUED'
  `
  if (claimed === 0) return // 被其他 worker 抢走

  const lease = setInterval(() => void touchLease(task.id), HEARTBEAT_MS)
  const startedAt = Date.now()
  try {
    await processTask(task)
    console.log(`[render-worker] task ${task.id} done in ${Date.now() - startedAt}ms`)
  } catch (e) {
    console.error(`[render-worker] task ${task.id} failed:`, (e as Error).message)
    // ★ 错误码按档位归因：AI 档走 ChatCut，根本没跑 ffmpeg。旧代码一律报 FFMPEG_FAILED，
    //   后台按错误码排查会被带偏（实测 990022 的素材探测 403 也记成了 FFMPEG_FAILED）。
    const isAi = Boolean((task.paramsJson as { aiMode?: boolean } | null)?.aiMode)
    await failRender(prisma, task.id, isAi ? 'CHATCUT_FAILED' : 'FFMPEG_FAILED', (e as Error).message)
  } finally {
    clearInterval(lease)
  }
}

async function processTask(task: {
  id: bigint
  merchantId: bigint
  creationId: bigint
  paramsJson: unknown
}): Promise<void> {
  const p = (task.paramsJson ?? {}) as {
    clips?: RenderClip[]
    color?: ColorGrade
    aiMode?: boolean
    chatcut?: ChatCutOptions
    creationId?: string
    title?: string
    output?: { width: number; height: number; fps: number }
  }
  if (p.aiMode && chatCutConfigured()) {
    await processChatCutTask(task, p)
    return
  }
  if (p.aiMode && !chatCutConfigured()) {
    throw new Error('AI 档需要先完成 ChatCut MCP 授权和工具映射')
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

      // 中间产物缓存：key 由 (assetId, trim, 尺寸) 决定，与调色无关，故重调色可复用。
      // ⚠ 键的计算在 render/cache-keys.ts —— 调色预览要用**同一个键**才能命中这里的产物
      const cacheKey = normalizedClipKey(task.merchantId, clip, output)
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
    //    相比首次合成省掉全部源解码与缩放 —— 这正是 RECOLOR 只收 10 积分的成本依据
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
      // 兼容历史 AI 任务：新 AI 任务由 ChatCut 处理；旧快照仍可走本地 TTS + 字幕。
      const tts = await activeTtsProvider(prisma).catch(() => null)
      if (tts) {
        console.log(`[render-worker] task ${task.id} 使用 TTS 供应商 ${tts.code}，调用失败时按镜头静音兜底`)
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

    // 4) 结算扣积分 + 落产物（幂等：requestId rc:<taskId>）
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
 * AI 档（外部剪辑）—— 走 ChatCut 多步驱动。
 *
 * ★ 这里只负责「启动」：建项目、推素材、排轨、设角色，返回一个待轮询的状态。
 *   导出**不在这一轮提交** —— 字幕依赖配音轨的 ASR 转录，转录要几分钟，
 *   不能在一次 tick 里干等。后续阶段（开字幕 → 提交导出 → 轮询成片）由
 *   `pollChatCutTasks()` 每轮推进，状态存在 `paramsJson.chatcutJob` 里。
 */
async function processChatCutTask(
  task: { id: bigint; merchantId: bigint; creationId: bigint; paramsJson: unknown },
  params: {
    clips?: RenderClip[]
    chatcut?: ChatCutOptions
    creationId?: string
    title?: string
    output?: { width: number; height: number; fps: number }
  },
): Promise<void> {
  const clips = params.clips ?? []
  const sourceClips = await Promise.all(clips.map(async (clip) => ({
    shotId: clip.shotId,
    assetId: clip.assetId,
    sourceUrl: await signedObjectUrl(clip.cosKey, 6 * 3600),
    trimStartMs: clip.trimStartMs,
    trimEndMs: clip.trimEndMs,
    durationMs: clip.durationMs,
    line: clip.line,
  })))
  const result = await startChatCutRender({
    taskId: task.id.toString(),
    merchantId: task.merchantId.toString(),
    creationId: params.creationId ?? task.creationId.toString(),
    title: params.title?.trim() || `大帅餐饮成片-${task.id.toString()}`,
    clips: sourceClips,
    options: params.chatcut ?? DEFAULT_CHATCUT_OPTIONS,
    output: params.output ?? { width: 1080, height: 1920, fps: 30 },
    // ★ 启动阶段本身就是分钟级（建项目 → 探素材 → 逐镜头 TTS → 上传全部字节 → 排轨），
    //   不报阶段的话这整段时间进度都停在 tick() 写的 5%，就是用户看到的「一直卡在 5%」
    onPhase: makePhaseReporter(task.id),
  })
  await storeChatCutState(task.id, result.state, result.status)
  for (const notice of result.state.notices ?? []) {
    console.warn(`[render-worker] ChatCut 任务 ${task.id} 提示：${notice}`)
  }
  if (result.status === 'FAILED') throw new Error(result.errorMessage || 'ChatCut 启动失败')
}

/**
 * 把 `chatcutJob` 的阶段 + 阶段内比例换算成用户可见的百分比。
 *
 * 分段：启动阶段 5~29（由 `onPhase` 负责）→ PREPARE 30~55 → RENDER 60~95 → 成功 100。
 * ★ 没有阶段内比例时**必须**退回阶段起点值，绝不能倒退回上一段 ——
 *   进度倒退比停在原地更让人以为出了故障。
 */
function chatCutProgress(job: ChatCutJobState): number {
  const base = job.phase === 'RENDER' ? 60 : 30
  const span = job.phase === 'RENDER' ? 35 : 25
  const ratio = job.stageRatio
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return base
  return base + Math.round(Math.max(0, Math.min(1, ratio)) * span)
}

async function storeChatCutState(
  taskId: bigint,
  chatcutJob: ChatCutJobState,
  status: 'RUNNING' | 'SUCCESS' | 'FAILED',
): Promise<void> {
  const task = await prisma.renderTask.findUnique({ where: { id: taskId } })
  if (!task) return
  const params = (task.paramsJson ?? {}) as Record<string, unknown>
  await prisma.renderTask.update({
    where: { id: taskId },
    data: {
      // 外部任务已受理后，本地固定为 RUNNING，避免下一轮 Worker 重复提交。
      status: status === 'FAILED' ? 'FAILED' : 'RUNNING',
      progress: chatCutProgress(chatcutJob),
      paramsJson: { ...params, chatcutJob } as never,
    },
  })
}

/** 轮询连续失败上限：到这个次数仍未恢复就明确失败，而不是永远安静重试 */
const MAX_POLL_ERRORS = Math.max(3, Number(process.env.CHATCUT_MAX_POLL_ERRORS ?? 40))

/**
 * 轮询连续失败的处置。
 *
 * ★ 这条兜底存在的理由：`catch` 里「保持 RUNNING，下一轮重试」本身是对的（网络抖动不该杀任务），
 *   但如果失败原因是**必然性**的（参数永远不合法、权限永远不够），任务就会安静地无限重试，
 *   库里只留下一个不动的 progress。实测踩到：`track_progress` 漏传必填的 `action`，
 *   每次调用都被 MCP 拒（-32602），错误只落在被吞掉的 catch 里
 *   ⇒ 任务在 PREPARE/30% 卡了 6 分钟、**库里零线索**。
 *   ⇒ 计数到上限就按真实原因失败退款 —— 让这类问题**可见**，而不是让它装成「网慢」。
 */
async function escalatePollFailure(taskId: bigint, state: ChatCutJobState, error: Error): Promise<void> {
  const errors = (state.pollErrors ?? 0) + 1
  console.warn(`[render-worker] ChatCut 任务 ${taskId} 查询失败（第 ${errors}/${MAX_POLL_ERRORS} 次）:`, error.message)
  if (errors < MAX_POLL_ERRORS) {
    await storeChatCutState(taskId, { ...state, pollErrors: errors }, 'RUNNING')
    return
  }
  const finalState = await failRender(
    prisma,
    taskId,
    'CHATCUT_POLL_FAILED',
    `连续 ${errors} 次查询云端任务状态失败：${error.message}`,
  )
  console.warn(`[render-worker] ChatCut 任务 ${taskId} 轮询持续失败，已终止（结果 ${finalState}）`)
}

async function pollChatCutTasks(): Promise<void> {
  if (!chatCutConfigured()) return
  const tasks = await prisma.renderTask.findMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] }, grade: 'AI' },
    orderBy: { createdAt: 'asc' },
    take: 5,
  })
  for (const task of tasks) {
    const params = (task.paramsJson ?? {}) as { chatcutJob?: ChatCutJobState }
    const state = params.chatcutJob
    // 没有状态 = 还没启动过（或旧格式的历史任务），交给 processTask 去启动
    if (!state?.projectId) continue
    try {
      const result = await pollChatCutRender(state)
      // 查询成功即清零失败计数（只有「连续」失败才有意义）
      await storeChatCutState(task.id, { ...result.state, pollErrors: 0 }, result.status)
      for (const notice of result.state.notices ?? []) {
        if (!state.notices?.includes(notice)) console.warn(`[render-worker] ChatCut 任务 ${task.id} 提示：${notice}`)
      }
      if (result.status === 'FAILED') {
        await failRender(prisma, task.id, 'CHATCUT_FAILED', result.errorMessage || 'ChatCut 处理失败')
      } else if (result.status === 'SUCCESS') {
        try {
          await finishChatCutTask(task, result.resultUrl)
        } catch (e) {
          if (e instanceof ExternalResultInvalidError) {
            // 上游报成功但产物不可用：立即退款 + 终态，不让用户为坏片付费，
            // 也不把任务留在 RUNNING 等 30 分钟 sweeper 兜底
            const state2 = await failRender(prisma, task.id, 'EXTERNAL_RESULT_INVALID', `成片校验未通过：${e.detail}`)
            console.warn(`[render-worker] ChatCut 任务 ${task.id} 成片无效，已退款（结果 ${state2}）：${e.detail}`)
          } else {
            throw e
          }
        }
      }
    } catch (error) {
      // 网络抖动 / 查询失败：保持 RUNNING，下一轮重试；**连续**失败超上限则明确终止（见 escalatePollFailure）
      await escalatePollFailure(task.id, state, error as Error).catch((e) =>
        console.warn(`[render-worker] ChatCut 任务 ${task.id} 失败计数写入异常:`, (e as Error).message),
      )
    }
  }
}

/** 外部成片校验不通过：不结算，直接退款并把原因写进任务 */
export class ExternalResultInvalidError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'ExternalResultInvalidError'
  }
}

async function finishChatCutTask(
  task: { id: bigint; merchantId: bigint },
  resultUrl: string | undefined,
): Promise<void> {
  // ChatCut 只给成片地址（它不会把产物推到我们的 COS），所以只有一条分支。
  // ★ 扣费前必须校验：HTTP 200 只代表「下载成功」，不代表「内容是视频」。
  //   上游返回 HTML 错误页 / JSON / 0 字节文件时，旧代码会把坏文件当真成片入库并扣全额积分。
  if (!resultUrl) throw new ExternalResultInvalidError('ChatCut 已完成但未返回成片地址')

  const dir = await mkdtemp(join(tmpdir(), 'dashuai-chatcut-'))
  try {
    const target = join(dir, 'result.mp4')
    const response = await fetch(resultUrl, { signal: AbortSignal.timeout(TASK_TIMEOUT_MS) })
    if (!response.ok || !response.body) throw new Error(`下载 ChatCut 成片失败：HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target))

    const probe = await probeVideo(target)
    if (!probe.ok) throw new ExternalResultInvalidError(probe.reason ?? '下载到的文件不是可播放视频')

    const resultKey = `renders/${task.merchantId.toString()}/${task.id.toString()}.mp4`
    const resultSize = BigInt(await uploadFile(target, resultKey, 'video/mp4'))

    await prisma.$transaction((tx) => completeRender(tx, task.merchantId, task.id, {
      resultKey,
      resultSize,
      durationMs: probe.durationMs,
      cacheHit: false,
    }))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

  // 结算悬空补偿：原 sweeper 只扫 RUNNING/QUEUED，SETTLEMENT_PENDING 会永久卡住、
  // 预留额度永久占用、用户账上冻结积分永远解不开（前端一直显示「退款确认中」）。
  try {
    const r = await sweepSettlementPending(prisma)
    if (r.scanned > 0) {
      console.log(
        `[stuck-sweeper] 结算悬空补偿：扫描 ${r.scanned}，恢复 ${r.recovered}，仍待处理 ${r.stillPending}，已放弃 ${r.gaveUp}`,
      )
    }
  } catch (e) {
    console.error('[stuck-sweeper] 结算悬空补偿失败:', (e as Error).message)
  }
}
