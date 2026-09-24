// 合成 Worker：轮询 RenderTask(QUEUED) → 自动规划/质量筛选 → FFmpeg 渲染 → 回传 COS → 结算扣积分
// 与 API 服务解耦：CPU 密集的转码不在请求线程里跑，可独立进程/独立机器部署
// AI 默认走本地自动剪辑；ChatCut 只有在任务显式指定 engine=CHATCUT 且通道可用时才启用。
// 计费铁律：submitRender 只 freeze 预留；本 worker 成功才 consume，失败 unfreeze 全额释放
import { mkdtemp, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '../db.js'
import { normalizedClipKey, normalizedFullClipKey } from './cache-keys.js'
import {
  completeRender,
  failRender,
  sweepSettlementPending,
  FenceLostError,
  DEFAULT_COLOR,
  RENDER_BEAN_FULL,
  type ColorGrade,
  type RenderClip,
  type RenderFence,
} from '../services/render.service.js'
import { downloadToFile, uploadFile, objectExists, cosReady } from '../lib/cos.js'
import {
  ffmpegNormalize,
  ffmpegApplyColor,
  ffmpegConcat,
  ffmpegConcatWithTransitions,
  ffmpegExtendVideo,
  ffmpegGenerateBackgroundMusic,
  ffmpegRemoveTimeRanges,
  probeDurationMs,
  probeClipMeta,
  probeVisualQuality,
  probeMeaningfulRange,
  probeRemovableFreezeSilenceRanges,
  probeVideo,
  buildColorFilter,
  ffmpegSupportsFilter,
  ffmpegSupportsSubtitles,
} from './ffmpeg.js'
import { applyAiSynthesis, fitShotDurationsToTimeline, shouldExtendForNarration, type SynthesisShot } from './synthesis.js'
import { resolveBgmTrack } from './bgm-library.js'
import { activeTtsProvider, providerForVoice } from '../services/tts-provider.service.js'
import { estimateSpeechMs } from './tts.js'
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
import {
  applyAutoEditPlan,
  buildAutoEditPlan,
  resolveAutoChatcutOptions,
  validateOutputQuality,
  type AutoEditPlan,
  type AutoEditProfile,
} from './auto-edit.js'
import type { RenderEngine } from '../services/render.service.js'

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
/**
 * 租约有效期：认领时写入 `lease_expire_at = now + TTL`，心跳只把它往后推。
 * ★ 判据用「过期时间」而不是「上次心跳时间」，好处是：
 *   ① 刚认领的任务自带一个未来时间 ⇒ 天然不会被误杀，不再需要额外的「最小年龄」窗口；
 *   ② 心跳写入失败（DB 抖动）只是让租约停在旧值，后果与「进程真的死了」完全一致，语义单一。
 * 必须 ≥ 单轮最坏处理耗时（远端下载 + 上传可能几十秒），否则任务还在推进就被判成孤儿重跑。
 */
const LEASE_TTL_MS = Math.max(60_000, Number(process.env.RENDER_LEASE_TTL_MS ?? 180_000))
/** 存量兜底窗口：只在「租约为空」时用于识别本补丁之前遗留的 RUNNING 行 */
const ORPHAN_MIN_AGE_MS = Math.max(30_000, Number(process.env.RENDER_ORPHAN_MIN_AGE_MS ?? 120_000))
/**
 * 远端任务轮询的独立节流。
 * ★ 它必须与「当前有没有新任务」解耦：原实现把轮询放在 `if (!task)` 分支里，
 *   于是只要队列持续有新 QUEUED 任务，已提交给远端的 AI 任务就永远轮不到 ——
 *   远端早就出片了，本地却一直不下载结算，最后被超时 sweeper 退款。
 */
const CHATCUT_POLL_INTERVAL_MS = Math.max(3_000, Number(process.env.CHATCUT_POLL_INTERVAL_MS ?? 8_000))
/** 孤儿扫描间隔（每轮 tick 都查太频） */
const ORPHAN_SWEEP_MS = Math.max(10_000, Number(process.env.RENDER_ORPHAN_SWEEP_MS ?? 60_000))
/** 同一任务最多被重跑几次，超了直接退款 —— 防「一启动就崩」的任务无限重试烧远端额度 */
const MAX_RESUME = Math.max(1, Number(process.env.RENDER_MAX_RESUME ?? 3))
/** 启动阶段的进度上报节流：十几个阶段节点不必逐条打库 */
const PHASE_MIN_INTERVAL_MS = Math.max(200, Number(process.env.RENDER_PHASE_MIN_INTERVAL_MS ?? 3000))

let running = false
let timer: ReturnType<typeof setTimeout> | null = null
let lastOrphanSweepAt = 0
/** 远端轮询上次执行时间（独立于 task 队列的节流锚点） */
let lastChatCutPollAt = 0

export function startRenderWorker(): void {
  if (running) return
  running = true
  if (!cosReady()) {
    console.warn('[render-worker] 警告：COS 未配置，真实合成无法下载素材/上传成片（FFMPEG_WORKER=true 时务必配 COS_*）')
  }
  // 优先用 libass；精简版 FFmpeg 可通过 Sharp 生成字幕 PNG，再用 overlay 烧录。
  void Promise.all([ffmpegSupportsSubtitles(), ffmpegSupportsFilter('overlay')]).then(([libass, overlay]) => {
    if (!libass && !overlay) {
      console.warn('[render-worker] 警告：ffmpeg 同时缺少 subtitles 与 overlay 滤镜，字幕无法烧录')
    } else if (!libass) {
      console.info('[render-worker] ffmpeg 缺少 libass，字幕将使用 PNG overlay 回退')
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

/**
 * 刷新租约。**必须带 owner + version 条件**。
 * ★ 旧实现只按 `WHERE id AND status='RUNNING'` 更新心跳，于是任何进程 —— 包括已经被回收的
 *   旧执行者 —— 都能刷新同一个任务的租约，`reclaimOrphanedRuns` 因此永远看不到「过期」，
 *   失权隔离形同虚设（实测：任务已被重置回 QUEUED 并重跑，旧进程仍在刷新心跳并继续上传结算）。
 * 返回 false = 本进程已不再持有该任务（被回收或已被别人接管），调用方必须停止后续副作用。
 */
async function touchLease(taskId: bigint, fence: RenderFence): Promise<boolean> {
  try {
    const n = await prisma.$executeRaw`
      UPDATE render_task
      SET lease_expire_at = ${new Date(Date.now() + LEASE_TTL_MS)}
      WHERE id = ${taskId}
        AND status = 'RUNNING'
        AND lease_owner = ${fence.owner}
        AND lease_version = ${fence.version}
    `
    return n > 0
  } catch (e) {
    console.warn(`[render-worker] task ${taskId} 心跳写入失败:`, (e as Error).message)
    // DB 抖动不等于失权：返回 true 让任务继续，租约若真的过期会被回收流程正常接管。
    return true
  }
}

/** 认领一个任务：原子地写 owner / 递增 version / 设定租约过期时间，返回本次执行权凭证 */
export async function claimTask(taskId: bigint, opts?: { onlyQueued?: boolean }): Promise<RenderFence | null> {
  const onlyQueued = opts?.onlyQueued ?? true
  const now = new Date()
  const expireAt = new Date(Date.now() + LEASE_TTL_MS)
  const claimed = onlyQueued
    ? await prisma.$executeRaw`
        UPDATE render_task
        SET status = 'RUNNING',
            start_at = ${now},
            progress = 5,
            lease_owner = ${WORKER_ID},
            lease_version = lease_version + 1,
            lease_expire_at = ${expireAt}
        WHERE id = ${taskId} AND status = 'QUEUED'
      `
    : await prisma.$executeRaw`
        UPDATE render_task
        SET lease_owner = ${WORKER_ID},
            lease_version = lease_version + 1,
            lease_expire_at = ${expireAt}
        WHERE id = ${taskId}
          AND status IN ('QUEUED', 'RUNNING')
          AND (lease_expire_at IS NULL OR lease_expire_at < ${now})
      `
  if (claimed === 0) return null
  const row = await prisma.renderTask.findUnique({
    where: { id: taskId },
    select: { leaseVersion: true },
  })
  if (!row) return null
  return { owner: WORKER_ID, version: row.leaseVersion }
}

/**
 * 回收「上一个进程留下的 RUNNING 孤儿」。
 *
 * 判据（须全部满足）：
 *   ① status=RUNNING，且不是 PREMIUM（人工档由剪辑工作台接管，与机器心跳无关）
 *   ② 租约已过期；存量行（lease_expire_at 为空）退回用 start_at + ORPHAN_MIN_AGE_MS 判定
 *   ③ 无 `chatcutJob.projectId` —— 已有项目 id 的任务远端存在状态，归 `pollChatCutTasks()` 推进
 *
 * 处置：**原子 CAS 重置回 QUEUED 重跑**（正常路径）；重跑次数超 MAX_RESUME 则退款收尾。
 * ⚠ 重置必须带「租约仍已过期或为空」的条件，并在同一条 UPDATE 里 `lease_version + 1`：
 *   否则两个扫描者会先后重置同一个任务，把**已经被别人认领并正在跑**的任务又踢回 QUEUED
 *   （实测：已刷新租约的任务仍被旧扫描结果回收）。version 自增后，旧持有者的所有写入都会
 *   变成 0 行，天然失权 —— 不需要额外的分布式锁。
 * ⚠ 重置不碰积分：提交时已 freeze，重跑不会重复冻结，只有最终成功才 consume。
 */
async function reclaimOrphanedRuns(): Promise<void> {
  if (Date.now() - lastOrphanSweepAt < ORPHAN_SWEEP_MS) return
  lastOrphanSweepAt = Date.now()
  const ageBefore = new Date(Date.now() - ORPHAN_MIN_AGE_MS)
  const now = new Date()
  const orphans = await prisma.$queryRaw<Array<{ id: bigint; retryCount: number }>>`
    SELECT id, retry_count AS retryCount
    FROM render_task
    WHERE status = 'RUNNING'
      AND grade <> 'PREMIUM'
      AND (
        (lease_expire_at IS NOT NULL AND lease_expire_at < ${now})
        OR (lease_expire_at IS NULL AND start_at IS NOT NULL AND start_at < ${ageBefore})
      )
      AND JSON_EXTRACT(params_json, '$.chatcutJob.projectId') IS NULL
    LIMIT 20
  `
  for (const orphan of orphans) {
    try {
      if (orphan.retryCount >= MAX_RESUME) {
        // 先原子抢占成失败终态（仍是过期/无租约才抢得到），再让 failRender 走「已是 FAILED ⇒
        // 补释放预留」的分支。分两步是为了避免直接 failRender 误杀刚被别人认领重跑的任务。
        const killed = await prisma.$executeRaw`
          UPDATE render_task
          SET status = 'FAILED',
              error_code = 'WORKER_TIMEOUT',
              error_msg = '合成进程多次中断，已自动退款，可重新提交',
              finish_at = ${now},
              lease_owner = NULL,
              lease_expire_at = NULL
          WHERE id = ${orphan.id}
            AND status = 'RUNNING'
            AND (lease_expire_at IS NULL OR lease_expire_at < ${now})
        `
        if (killed > 0) {
          const state = await failRender(
            prisma,
            orphan.id,
            'WORKER_TIMEOUT',
            '合成进程多次中断，已自动退款，可重新提交',
          )
          console.warn(
            `[render-worker] task ${orphan.id} 中断已达 ${orphan.retryCount} 次，回收为 ${state}（预留已释放）`,
          )
        }
        continue
      }
      const reset = await prisma.$executeRaw`
        UPDATE render_task
        SET status = 'QUEUED',
            progress = 0,
            start_at = NULL,
            retry_count = retry_count + 1,
            error_code = NULL,
            error_msg = NULL,
            lease_owner = NULL,
            lease_expire_at = NULL,
            lease_version = lease_version + 1
        WHERE id = ${orphan.id}
          AND status = 'RUNNING'
          AND (lease_expire_at IS NULL OR lease_expire_at < ${now})
      `
      if (reset > 0) {
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
function makePhaseReporter(taskId: bigint, fence?: RenderFence): (info: { ratio: number; label: string }) => void {
  let last = 5
  let lastAt = 0
  return (info) => {
    const pct = Math.min(29, 5 + Math.round(info.ratio * 24))
    const now = Date.now()
    if (pct <= last || now - lastAt < PHASE_MIN_INTERVAL_MS) return
    last = pct
    lastAt = now
    console.log(`[render-worker] task ${taskId} 启动阶段 ${pct}%：${info.label}`)
    void reportProgress(taskId, pct, fence)
  }
}

/** 取一个 QUEUED 任务并抢占标记 RUNNING（多 worker 并发时用条件更新抢锁） */
async function tick(): Promise<void> {
  await reclaimOrphanedRuns() // 先捡回上个进程留下的孤儿，再取新任务
  // ★ 远端轮询必须与「有没有新任务」解耦，且放在取任务之前。
  //   原实现把它放在 `if (!task)` 分支里：只要队列持续有新 QUEUED 任务，
  //   已提交给远端的 AI 任务就永远轮不到 —— 远端早就出片，本地一直不下载结算。
  await pollChatCutTasks()

  // PREMIUM（人工精剪）任务不进机器队列，由管理后台剪辑工作台处理
  const task = await prisma.renderTask.findFirst({
    where: { status: 'QUEUED', grade: { not: 'PREMIUM' } },
    orderBy: { createdAt: 'asc' },
  })
  if (!task) return

  // 认领即落租约（owner + version + 过期时间），三者一次原子写完
  const fence = await claimTask(task.id, { onlyQueued: true })
  if (!fence) return // 被其他 worker 抢走

  const lease = setInterval(() => {
    void touchLease(task.id, fence).then((held) => {
      if (!held) {
        console.warn(
          `[render-worker] task ${task.id} 执行权已被回收（租约版本落后），本进程将不再写入该任务`,
        )
      }
    })
  }, HEARTBEAT_MS)
  const startedAt = Date.now()
  try {
    await processTask(task, fence)
    console.log(`[render-worker] task ${task.id} done in ${Date.now() - startedAt}ms`)
  } catch (e) {
    if (e instanceof FenceLostError) {
      // 失权不是失败：任务已归别人推进，这里绝不能把它写成 FAILED
      console.warn(`[render-worker] task ${task.id} 收尾时执行权已转移，已放弃写入：${e.message}`)
    } else {
      console.error(`[render-worker] task ${task.id} failed:`, (e as Error).message)
      // ★ 错误码按档位归因：AI 档走 ChatCut，根本没跑 ffmpeg。旧代码一律报 FFMPEG_FAILED，
      //   后台按错误码排查会被带偏（实测 990022 的素材探测 403 也记成了 FFMPEG_FAILED）。
      const taskParams = (task.paramsJson as { aiMode?: boolean; engine?: RenderEngine } | null) ?? {}
      const isExternalAi = Boolean(taskParams.aiMode && taskParams.engine === 'CHATCUT')
      const state = await failRender(
        prisma,
        task.id,
        isExternalAi ? 'CHATCUT_FAILED' : 'FFMPEG_FAILED',
        (e as Error).message,
        fence,
      )
      if (state === 'SUPERSEDED') {
        console.warn(`[render-worker] task ${task.id} 失败收尾时执行权已转移，未写入终态`)
      }
    }
  } finally {
    clearInterval(lease)
  }
}

/**
 * 进度上报。带 fence 时失权者的写入会变成 0 行，不会覆盖新执行者的进度。
 * ★ 进度看似无害，但它会掩盖真相：旧执行者把 75% 写回去，用户看到的就是「进度倒退」，
 *   而真正在跑的那个人推进到 90% 又被改回 75%，日志和 UI 对不上。
 */
async function reportProgress(taskId: bigint, progress: number, fence?: RenderFence): Promise<void> {
  await prisma.renderTask
    .updateMany({
      where: {
        id: taskId,
        status: 'RUNNING',
        ...(fence ? { leaseOwner: fence.owner, leaseVersion: fence.version } : {}),
      },
      data: { progress },
    })
    .catch((e) => console.warn(`[render-worker] task ${taskId} 进度写入失败:`, (e as Error).message))
}

/** 保存本次自动剪辑的可解释快照，便于后台排查「为什么选了这些镜头」。 */
async function storeAutoEditPlan(taskId: bigint, plan: AutoEditPlan, fence?: RenderFence): Promise<void> {
  const row = await prisma.renderTask.findUnique({ where: { id: taskId }, select: { paramsJson: true } })
  if (!row) return
  const current = (row.paramsJson ?? {}) as Record<string, unknown>
  const snapshot = {
    profile: plan.profile,
    confidence: plan.confidence,
    targetDurationMs: plan.targetDurationMs,
    warnings: plan.warnings,
    candidates: plan.candidates.map((item) => ({
      shotId: item.clip.shotId,
      sourceIndex: item.sourceIndex,
      role: item.role,
      score: item.score,
      targetDurationMs: item.targetDurationMs,
      reason: item.reason,
    })),
  }
  await prisma.renderTask.updateMany({
    where: {
      id: taskId,
      status: 'RUNNING',
      ...(fence ? { leaseOwner: fence.owner, leaseVersion: fence.version } : {}),
    },
    data: { paramsJson: { ...current, autoEdit: snapshot } as never },
  })
}

async function processTask(
  task: {
    id: bigint
    merchantId: bigint
    creationId: bigint
    paramsJson: unknown
  },
  fence?: RenderFence,
): Promise<void> {
  const p = (task.paramsJson ?? {}) as {
    clips?: RenderClip[]
    color?: ColorGrade
    aiMode?: boolean
    engine?: RenderEngine
    profile?: AutoEditProfile
    chatcut?: ChatCutOptions
    customVoiceKey?: string
    customVoiceDurationMs?: number
    creationId?: string
    title?: string
    output?: { width: number; height: number; fps: number }
  }
  if (p.aiMode && p.engine === 'CHATCUT') {
    if (chatCutConfigured()) {
      await processChatCutTask(task, p, fence)
      return
    }
    console.warn(`[render-worker] task ${task.id} ChatCut 不可用，自动降级到本地自动剪辑`)
  }
  const inputClips = p.clips ?? []
  if (inputClips.length === 0) throw new Error('合成任务没有可用素材')
  const output = p.output ?? { width: 1080, height: 1920, fps: 30 }
  const color = p.color ?? DEFAULT_COLOR
  const aiMode = p.aiMode ?? true // v5：默认 AI 合成
  // AUTO is intentionally conservative. Older clients may send a stale
  // transition selection, so do not let that state re-enable xfade.
  const isAutoEdit = aiMode && (p.chatcut?.editMode ?? 'AUTO') === 'AUTO'
  const plan = aiMode ? buildAutoEditPlan(inputClips, p.profile) : null
  const plannedClips = plan ? applyAutoEditPlan(plan) : inputClips
  const effectiveChatcut = aiMode
    ? ((p.chatcut?.editMode ?? 'AUTO') === 'AUTO'
        ? resolveAutoChatcutOptions(p.chatcut ?? DEFAULT_CHATCUT_OPTIONS, plan?.profile ?? 'MIXED', inputClips)
        : p.chatcut ?? DEFAULT_CHATCUT_OPTIONS)
    : DEFAULT_CHATCUT_OPTIONS
  const customVoiceKey = p.chatcut?.editMode === 'ADVANCED' ? p.customVoiceKey : undefined
  const voiceEnabled = Boolean(customVoiceKey) || effectiveChatcut.voiceId !== 'none'
  // 紧凑节奏只压缩无台词画面；有台词的镜头以完整语句时长为硬下限。
  const clips = aiMode && effectiveChatcut.pacing === 'FAST'
    ? plannedClips.map((clip) => {
        const start = Math.max(0, clip.trimStartMs ?? 0)
        const end = clip.trimEndMs !== null && clip.trimEndMs > start
          ? clip.trimEndMs
          : clip.durationMs ?? 0
        const available = end > start ? end - start : 0
        if (available <= 900) return clip
        const speechFloor = clip.line?.trim()
          ? Math.min(12_000, Math.max(1_500, estimateSpeechMs(clip.line.trim()) + 350))
          : 0
        const target = Math.max(speechFloor, Math.round(available * 0.78))
        return target < available - 100 ? { ...clip, trimEndMs: start + target } : clip
      })
    : plannedClips
  if (plan) {
    await storeAutoEditPlan(task.id, plan, fence)
    await reportProgress(task.id, 8, fence)
  }

  const dir = await mkdtemp(join(tmpdir(), 'dashuai-render-'))
  try {
    // 1) 逐镜头：归一化（命中缓存则跳过）→ 调色
    const tmpClips: string[] = []
    const renderedClips: RenderClip[] = []
    let hitCount = 0
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]
      if (!clip) continue
      await reportProgress(task.id, 10 + Math.round((i / clips.length) * 60), fence)

      const rawPath = join(dir, `in_${i}.mp4`)
      let effectiveClip = clip
      // 默认模式先识别首尾明显无效区间，再把裁切写回本次 EDL。
      // 只剪首尾，避免把中间一句话切断；没有可靠信号时保留原始时间窗。
      if (aiMode) {
        await downloadToFile(clip.cosKey, rawPath)
        const range = await probeMeaningfulRange(rawPath, TASK_TIMEOUT_MS).catch(() => null)
        if (range) {
          const requestedStart = Math.max(0, clip.trimStartMs ?? 0)
          const requestedEnd = clip.trimEndMs && clip.trimEndMs > requestedStart
            ? clip.trimEndMs
            : range.durationMs
          const candidateStart = Math.min(requestedEnd - 300, Math.max(requestedStart, range.startMs))
          const candidateEnd = Math.max(candidateStart + 300, Math.min(requestedEnd, range.endMs))
          if (candidateStart > requestedStart + 450 || candidateEnd < requestedEnd - 450) {
            effectiveClip = { ...clip, trimStartMs: candidateStart, trimEndMs: candidateEnd }
            console.log(
              `[render-worker] task ${task.id} 裁掉素材 ${clip.shotId} 首尾无效区间 ` +
              `(${requestedStart}-${requestedEnd}ms -> ${candidateStart}-${candidateEnd}ms)`,
            )
          }
        }
      }

      const startMs = effectiveClip.trimStartMs ?? 0
      const endMs = effectiveClip.trimEndMs ?? 0
      const normPath = join(dir, `norm_${i}.mp4`)

      // 中间产物缓存：key 由 (assetId, trim, 尺寸) 决定，与调色无关，故重调色可复用。
      // ⚠ 键的计算在 render/cache-keys.ts —— 调色预览要用**同一个键**才能命中这里的产物
      const cacheKey = normalizedClipKey(task.merchantId, effectiveClip, output)
      if (await objectExists(cacheKey)) {
        await downloadToFile(cacheKey, normPath)
        hitCount++
      } else {
        if (!aiMode) await downloadToFile(effectiveClip.cosKey, rawPath)
        await ffmpegNormalize(rawPath, normPath, {
          width: output.width,
          height: output.height,
          startMs,
          endMs,
          // ★ 必须传：不统一帧率就会在 -c copy 拼接处丢帧（见 ffmpegNormalize 注释）
          fps: output.fps,
          timeoutMs: TASK_TIMEOUT_MS,
        })
        // 回写缓存失败不阻塞主流程（下次重算即可）
        await uploadFile(normPath, cacheKey, 'video/mp4').catch((e) =>
          console.warn(`[render-worker] 缓存回写失败 ${cacheKey}:`, (e as Error).message),
        )
      }

      let preparedPath = normPath
      // 默认模式只压缩“画面冻结 + 音频静音”同时持续的高置信度无效停顿。
      // 两侧保留短暂停顿，避免把正常呼吸或语义边界剪成硬拼。
      if (isAutoEdit) {
        const removable = await probeRemovableFreezeSilenceRanges(normPath, TASK_TIMEOUT_MS).catch(() => [])
        if (removable.length) {
          const cleanedPath = join(dir, `clean_${i}.mp4`)
          await ffmpegRemoveTimeRanges(normPath, cleanedPath, removable, TASK_TIMEOUT_MS)
          preparedPath = cleanedPath
          console.log(`[render-worker] task ${task.id} 压缩素材 ${clip.shotId} 的 ${removable.length} 处冻结静音停顿`)
        }
      }

      // AI 档额外淘汰明显黑帧/冻结片段；检测失败只记录，不阻断出片。
      if (aiMode) {
        const signals = await probeVisualQuality(preparedPath, TASK_TIMEOUT_MS).catch(() => null)
        const blackRatio = signals?.blackRatio ?? 0
        const freezeRatio = signals?.freezeRatio ?? 0
        if (blackRatio > 0.65 || freezeRatio > 0.75) {
          console.warn(
            `[render-worker] task ${task.id} 跳过低质量片段 ${clip.shotId}（black=${blackRatio.toFixed(2)}, freeze=${freezeRatio.toFixed(2)}）`,
          )
          continue
        }
      }

      // 含口播的镜头必须先保证画面时长容得下完整句子。只延长临时片段，
      // 不写回归一化缓存，避免同一素材因不同文案共享错误时长。
      if (aiMode && voiceEnabled && effectiveClip.line?.trim()) {
        const visualMs = await probeDurationMs(preparedPath)
        const speechMs = Math.min(12_000, Math.max(1_500, estimateSpeechMs(effectiveClip.line.trim()) + 350))
        if (shouldExtendForNarration(voiceEnabled, effectiveClip.line, visualMs, speechMs)) {
          const extendedPath = join(dir, `speech_${i}.mp4`)
          await ffmpegExtendVideo(preparedPath, extendedPath, speechMs, TASK_TIMEOUT_MS)
          preparedPath = extendedPath
        }
      }

      // 无调色时归一化物即成片片段；这里只收集，调色统一放到拼接后做（见下）
      tmpClips.push(preparedPath)
      renderedClips.push(effectiveClip)
    }
    if (tmpClips.length === 0) throw new Error('素材画面质量不足，无法生成可用成片')
    const allCacheHit = tmpClips.length > 0 && hitCount === renderedClips.length

    // 2) 按用户选择拼接：硬切保持无损，柔和/动态档真实使用 xfade + acrossfade。
    await reportProgress(task.id, 75, fence)
    const concatPath = join(dir, 'concat.mp4')
    const transition = isAutoEdit ? 'CLEAN' : (aiMode ? effectiveChatcut.transitions : 'CLEAN')
    await ffmpegConcatWithTransitions(tmpClips, concatPath, transition, TASK_TIMEOUT_MS)

    // 3) 整片调色：放在拼接后做单一 pass，而不是逐镜头各做一次。
    //    这样 N 个镜头只编码 1 次；重调色时可完全复用归一化缓存，只跑「拼接 + 一遍调色」，
    //    相比首次合成省掉全部源解码与缩放 —— 这正是 RECOLOR 只收 10 积分的成本依据
    let finalPath = concatPath
    if (buildColorFilter(color)) {
      finalPath = join(dir, 'final.mp4')
      await ffmpegApplyColor(concatPath, finalPath, color, TASK_TIMEOUT_MS)
    }

    // 3.5) AI 合成：支持多音色、自定义配音和独立的原声 ASR 字幕。
    if (aiMode) {
      await reportProgress(task.id, 82, fence)
      // 逐分镜探测实际时长（归一化产物），并携带口播文案，供配音/字幕按时间轴布时
      const rawShots: SynthesisShot[] = []
      for (let i = 0; i < tmpClips.length; i++) {
        const tp = tmpClips[i]
        const clip = renderedClips[i]
        if (!tp || !clip) continue
        rawShots.push({ line: clip.line, durationMs: (await probeDurationMs(tp)) ?? 0 })
      }
      const renderedDurationMs = (await probeDurationMs(finalPath)) ?? rawShots.reduce((sum, shot) => sum + shot.durationMs, 0)
      const shots = fitShotDurationsToTimeline(rawShots, renderedDurationMs)
      const subtitleMode = effectiveChatcut.subtitles === false ? 'OFF' : (effectiveChatcut.subtitleMode ?? (voiceEnabled ? 'VOICE' : 'OFF'))
      if (shots.length > 0 || customVoiceKey || subtitleMode === 'SOURCE_AUDIO' || subtitleMode === 'VOICE_AND_SOURCE') {
        const aiPath = join(dir, 'ai.mp4')
        let backgroundMusicPath: string | undefined
        if (effectiveChatcut.bgm !== 'NONE') {
          /**
           * 配乐取用顺序（**三级**，越靠前越优先）：
           *   ① 本地曲库里该风格的那一首（`assets/bgm/<风格>.<ext>`）——
           *      由 `npm run bgm:generate` 用 ChatCut 的 `submit_music`（mureka-9）生成后落盘；
           *      运营也可以直接丢一个**已获授权**的文件进去，命名成 `LIGHT.mp3` 即可，不用改代码。
           *   ② `DEFAULT_BGM_PATH` 指定的单个文件（老配置：所有风格共用一首，保留兼容）。
           *   ③ 合成垫底 `ffmpegGenerateBackgroundMusic`。
           *
           * ★★ 曲库为什么排在 `DEFAULT_BGM_PATH` 前面：风格**已经识别出来了**
           *   （`resolveAutoChatcutOptions` 按素材画像给出 LIGHT/UPBEAT/PREMIUM），
           *   曲库能按风格各给一首；而 `DEFAULT_BGM_PATH` 只有一个文件 ——
           *   能分风格就别退化成一首通用曲子。
           *
           * ★★ 曲库命中是**纯本地文件读取**：生产出片**不依赖 ChatCut 在线**，
           *   联网只发生在 `bgm:generate` 那个运维动作里。这是刻意的 ——
           *   把第三方的可用性/额度挡在出片链路之外。
           *
           * ⚠ 三级全落空也不会失败：垫底那条 `aevalsrc` 合成一定会给出一个文件，
           *   最坏是「有一条长音垫底」（实测约 -37dBFS，听感是嗡不是曲子），而不是没有配乐。
           */
          const style = effectiveChatcut.bgm
          const styleTrack = resolveBgmTrack(style)
          const configuredBgm = process.env.DEFAULT_BGM_PATH?.trim()
          if (styleTrack) {
            backgroundMusicPath = styleTrack
            console.log(`[render-worker] task ${task.id} 配乐取自曲库 ${style}：${styleTrack}`)
          } else if (configuredBgm && existsSync(configuredBgm)) {
            backgroundMusicPath = configuredBgm
            console.log(`[render-worker] task ${task.id} 曲库无 ${style}，配乐取 DEFAULT_BGM_PATH：${configuredBgm}`)
          } else {
            const durationMs = (await probeDurationMs(finalPath)) ?? 1_000
            backgroundMusicPath = join(dir, 'default-bgm.m4a')
            console.warn(
              `[render-worker] task ${task.id} 曲库无 ${style} 且未配 DEFAULT_BGM_PATH ⇒ 退回合成垫底` +
                `（只保证「有背景音」，听感不是曲子；用 npm run bgm:generate 补曲库）`,
            )
            await ffmpegGenerateBackgroundMusic(
              backgroundMusicPath,
              durationMs,
              style === 'UPBEAT' || style === 'PREMIUM' ? style : 'LIGHT',
              TASK_TIMEOUT_MS,
            ).catch((e) => {
              console.warn(`[render-worker] 默认 BGM 生成失败，继续无配乐出片：`, (e as Error).message)
              backgroundMusicPath = undefined
            })
          }
        }
        let customVoicePath: string | undefined
        if (customVoiceKey) {
          customVoicePath = join(dir, 'custom-voice.m4a')
          await downloadToFile(customVoiceKey, customVoicePath)
        }
        const baseTts = await activeTtsProvider(prisma).catch(() => null)
        const tts = providerForVoice(baseTts, effectiveChatcut.voiceId)
        if (tts) {
          console.log(`[render-worker] task ${task.id} 使用 TTS 供应商 ${tts.code}（voice=${effectiveChatcut.voiceId}），调用失败时按镜头静音兜底`)
      } else {
          console.log('[render-worker] 未配置 TTS 供应商，AI 合成以「静音 + 字幕」出片')
        }
        const { subtitled } = await applyAiSynthesis(
          finalPath,
          shots,
          aiPath,
          TASK_TIMEOUT_MS,
          tts,
          {
            voiceEnabled,
            subtitles: subtitleMode !== 'OFF',
            subtitleMode,
            customVoicePath,
            sourceAudioPath: finalPath,
            normalizeAudio: effectiveChatcut.normalizeAudio,
            removeSilence: effectiveChatcut.removeSilence,
            backgroundMusicPath,
            backgroundMusicGain: 0.10,
          },
        )
        finalPath = aiPath
        console.log(`[render-worker] task ${task.id} AI合成完成（字幕=${subtitled ? '是' : '否'}）`)
      }
    }

    // 4) 上传前进行内容级质检，坏文件、错误比例和异常时长都不能进入成功结算。
    const meta = await probeClipMeta(finalPath, TASK_TIMEOUT_MS)
    const quality = validateOutputQuality(meta, { maxDurationMs: aiMode ? 65_000 : 6 * 60 * 60 * 1000 })
    if (!quality.ok) {
      throw new Error(`成片质量校验失败：${quality.warnings.join('；')}`)
    }

    // 5) 回传 COS
    await reportProgress(task.id, 90, fence)
    const key = `renders/${task.merchantId.toString()}/${task.id.toString()}.mp4`
    const size = await uploadFile(finalPath, key, 'video/mp4')
    const durationMs = await probeDurationMs(finalPath)

    // 4) 结算扣积分 + 落产物（幂等：requestId rc:<taskId>）
    await prisma.$transaction((tx) =>
      completeRender(
        tx,
        task.merchantId,
        task.id,
        {
          resultKey: key,
          resultSize: BigInt(size),
          durationMs,
          cacheHit: allCacheHit,
        },
        fence,
      ),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 「本地打底」路线（AI 档可选，2026-09-22）：把**整段**素材先在本机转成成片画布，再交给云端。
 *
 * 目的：把「素材几何」这件事在本地一次性定死。
 *   · ffmpeg 的 `scale`/`crop` **默认 autorotate** ⇒ 手机拍摄的旋转信息在这里就被转正，
 *     送上去的文件**本身就是 1080×1920** ⇒ 云端 `fit:"cover"` 只会 1:1 落位、不可能再算错
 *     （2026-09-22 事故：容器 960×540 + `rotation=-90` 被当横屏，云端多放大 1.78 倍）。
 *   · 代价：多一道本地转码 ⇒ 出片更慢 + 多一次编解码、画质略降。所以**不是默认**。
 *
 * ★★ 为什么传的是**整段**（trim 固定 0/0）而不是像本地管线那样传剪好的片段：
 *    AI 档的裁切由云端驱动自己算（`sourceStartMs = trimStart + handleMsOf(index)`，
 *    转场还要两侧各留 handle）⇒ 递剪好的片段会让 handle 直接越界、被 ChatCut 拒单。
 *    见 `cache-keys.ts` 的 `normalizedFullClipKey`。
 *
 * ★★ 失败**绝不外抛**：打底只是「让几何更确定」的增强，不是出片的前提。
 *    转码失败就退回原文件（B0 之后云端已有 rotation 兜底）——
 *    绝不能因为「增强没做成」把一条本来能出的片子搞失败。
 */
async function prepClipLocally(
  merchantId: bigint,
  taskId: bigint,
  clip: RenderClip,
  output: { width: number; height: number; fps: number },
): Promise<string> {
  const key = normalizedFullClipKey(merchantId, clip, output)
  try {
    if (await objectExists(key)) return key // 缓存命中：同一段素材重合成/重试时不重转
    const dir = await mkdtemp(join(tmpdir(), 'dashuai-prep-'))
    try {
      const raw = join(dir, 'in.mp4')
      const out = join(dir, 'out.mp4')
      await downloadToFile(clip.cosKey, raw)
      // startMs=0 / endMs=0 ⇒ 不带 -ss/-to = 整段（裁切留给云端驱动）
      await ffmpegNormalize(raw, out, {
        width: output.width,
        height: output.height,
        startMs: 0,
        endMs: 0,
        // ★ 与本地管线同一口径：整段打底也必须统一帧率，否则云端/本地拼接都可能撞接缝丢帧
        fps: output.fps,
        timeoutMs: TASK_TIMEOUT_MS,
      })
      await uploadFile(out, key, 'video/mp4')
      return key
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } catch (error) {
    console.warn(
      `[render-worker] task ${taskId} 素材本地打底失败，已退回原文件（${clip.cosKey}）：`,
      (error as Error).message,
    )
    return clip.cosKey
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
  fence?: RenderFence,
): Promise<void> {
  const clips = params.clips ?? []
  const output = params.output ?? { width: 1080, height: 1920, fps: 30 }
  /**
   * 素材路线：`ORIGINAL`（默认，原路线，原文直传）／`NORMALIZED`（先本地打底再传）。
   * ★ 老任务 / 老客户端的 `params.chatcut` 里没有这个字段 ⇒ 必须落到默认值，
   *   行为与改动前**完全一致**（这就是「不覆盖原来 AI 生成路线」的落点）。
   */
  const rawChatcut = params.chatcut ?? DEFAULT_CHATCUT_OPTIONS
  const effectiveChatcut = rawChatcut.editMode === 'AUTO'
    ? resolveAutoChatcutOptions(rawChatcut, buildAutoEditPlan(clips).profile, clips)
    : rawChatcut
  const clipPrep = effectiveChatcut.clipPrep
  /**
   * ★★ 阶段上报器**只建一个**，打底阶段与驱动阶段共用。
   *    不能各建一个：`makePhaseReporter` 的单调性靠它自己的闭包变量 `last`，
   *    两个实例各记各的 ⇒ 驱动阶段报 5% 而打底阶段已报 15%，**进度会倒退**，
   *    而下面的注释写得很清楚「进度倒退比停在原地更让人以为出了故障」。
   */
  const phase = makePhaseReporter(task.id, fence)
  const sourceCosKeys = clips.map((clip) => clip.cosKey)
  if (clipPrep === 'NORMALIZED') {
    // ★ 串行而不是并发：6 路 ffmpeg 同时抢 CPU 会把更吃时间的编码阶段拖慢，
    //   而这里每一步都要占满一个核。打底阶段占启动阶段的前四成（5%→15%），
    //   余量留给驱动自己的阶段（它最高会报到 29%）。
    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index]!
      sourceCosKeys[index] = await prepClipLocally(task.merchantId, task.id, clip, output)
      phase({ ratio: 0.4 * ((index + 1) / clips.length), label: `素材本地打底 ${index + 1}/${clips.length}` })
    }
  }
  const sourceClips = await Promise.all(clips.map(async (clip, index) => ({
    shotId: clip.shotId,
    assetId: clip.assetId,
    sourceUrl: await signedObjectUrl(sourceCosKeys[index]!, 6 * 3600),
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
    options: effectiveChatcut,
    output,
    // ★ 启动阶段本身就是分钟级（建项目 → 探素材 → 逐镜头 TTS → 上传全部字节 → 排轨），
    //   不报阶段的话这整段时间进度都停在 tick() 写的 5%，就是用户看到的「一直卡在 5%」
    onPhase: phase,
  })
  await storeChatCutState(task.id, result.state, result.status, fence)
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

/**
 * 写入 ChatCut 阶段快照（进度 + chatcutJob）。
 *
 * ★★ 这里**绝不能**写 FAILED 终态。历史缺陷正是它：本函数先把 `status` 写成 `'FAILED'`，
 *    紧随其后的 `failRender()` 看到 `task.status === 'FAILED'` 就直接早退 ——
 *    `unfreeze` 从未执行 ⇒ 任务显示失败、积分却永久冻结，连 errorCode / finishAt 都没人写，
 *    运维在库里看不到任何线索。**失败终态只由 `failRender` 一家负责**（它同时释放预留）。
 *
 * ★ 状态条件 `IN ('QUEUED','RUNNING')` 与可选的 fence 条件共同防止「迟到轮询复活终态」：
 *    上游早已成功或已退款的任务，一个晚到的轮询结果不能把它改回 RUNNING（实测能改回去，
 *    之后还会继续下载上传，甚至对已退款任务再走一次结算）。
 */
export async function storeChatCutState(
  taskId: bigint,
  chatcutJob: ChatCutJobState,
  status: 'RUNNING' | 'SUCCESS' | 'FAILED',
  fence?: RenderFence,
): Promise<void> {
  if (status === 'FAILED') return
  const task = await prisma.renderTask.findUnique({ where: { id: taskId }, select: { paramsJson: true } })
  if (!task) return
  const params = (task.paramsJson ?? {}) as Record<string, unknown>
  const updated = await prisma.renderTask.updateMany({
    where: {
      id: taskId,
      status: { in: ['QUEUED', 'RUNNING'] },
      ...(fence ? { leaseOwner: fence.owner, leaseVersion: fence.version } : {}),
    },
    data: {
      // 外部任务已受理后，本地固定为 RUNNING，避免下一轮 Worker 重复提交。
      status: 'RUNNING',
      progress: chatCutProgress(chatcutJob),
      paramsJson: { ...params, chatcutJob } as never,
    },
  })
  if (updated.count === 0) {
    console.warn(
      `[render-worker] task ${taskId} 阶段快照未写入（任务已进入终态或执行权已转移），本次结果被忽略`,
    )
  }
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
async function escalatePollFailure(
  taskId: bigint,
  state: ChatCutJobState,
  error: Error,
  fence?: RenderFence,
): Promise<void> {
  const errors = (state.pollErrors ?? 0) + 1
  console.warn(`[render-worker] ChatCut 任务 ${taskId} 查询失败（第 ${errors}/${MAX_POLL_ERRORS} 次）:`, error.message)
  if (errors < MAX_POLL_ERRORS) {
    await storeChatCutState(taskId, { ...state, pollErrors: errors }, 'RUNNING', fence)
    return
  }
  const finalState = await failRender(
    prisma,
    taskId,
    'CHATCUT_POLL_FAILED',
    `连续 ${errors} 次查询云端任务状态失败：${error.message}`,
    fence,
  )
  console.warn(`[render-worker] ChatCut 任务 ${taskId} 轮询持续失败，已终止（结果 ${finalState}）`)
}

async function pollChatCutTasks(): Promise<void> {
  if (!chatCutConfigured()) return
  const now = Date.now()
  // 独立节流：与「当前有没有新任务」解耦（原因见 tick() 里的说明）
  if (now - lastChatCutPollAt < CHATCUT_POLL_INTERVAL_MS) return
  lastChatCutPollAt = now

  // ★ 排序改为「租约到期时间升序」而不是固定取最老 5 条：
  //   原来的 take:5 + createdAt 排序下，前 5 条只要长期不结束，后面的任务永远轮不到，
  //   远端早就出片也没人下载结算，最后只能被超时 sweeper 退款。
  //   租约为 NULL（从未被推进/刚被重置）在 ASC 下排最前，正好优先处理。
  const tasks = await prisma.renderTask.findMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] }, grade: 'AI' },
    orderBy: [{ leaseExpireAt: 'asc' }, { createdAt: 'asc' }],
    take: 20,
  })
  for (const task of tasks) {
    const params = (task.paramsJson ?? {}) as { chatcutJob?: ChatCutJobState }
    const state = params.chatcutJob
    // 没有状态 = 还没启动过（或旧格式的历史任务），交给 processTask 去启动
    if (!state?.projectId) continue
    // ★ 认领：同一时刻只允许一个执行者推进同一个远端任务。
    //   原实现是裸读-改：两个 worker 会同时对同一任务提交导出、互相覆盖阶段与 renderId，
    //   甚至把一个已经结算成功的任务改回 RUNNING。
    const fence = await claimTask(task.id, { onlyQueued: false })
    if (!fence) continue // 别人正持有（租约未过期），本轮跳过不是错误
    try {
      const result = await pollChatCutRender(state)
      // 查询成功即清零失败计数（只有「连续」失败才有意义）
      await storeChatCutState(task.id, { ...result.state, pollErrors: 0 }, result.status, fence)
      for (const notice of result.state.notices ?? []) {
        if (!state.notices?.includes(notice)) console.warn(`[render-worker] ChatCut 任务 ${task.id} 提示：${notice}`)
      }
      if (result.status === 'FAILED') {
        await failRender(prisma, task.id, 'CHATCUT_FAILED', result.errorMessage || 'ChatCut 处理失败', fence)
      } else if (result.status === 'SUCCESS') {
        try {
          await finishChatCutTask(task, result.resultUrl, fence)
        } catch (e) {
          if (e instanceof FenceLostError) throw e
          if (e instanceof ExternalResultInvalidError) {
            // 上游报成功但产物不可用：立即退款 + 终态，不让用户为坏片付费，
            // 也不把任务留在 RUNNING 等 30 分钟 sweeper 兜底
            const state2 = await failRender(
              prisma,
              task.id,
              'EXTERNAL_RESULT_INVALID',
              `成片校验未通过：${e.detail}`,
              fence,
            )
            console.warn(`[render-worker] ChatCut 任务 ${task.id} 成片无效，已退款（结果 ${state2}）：${e.detail}`)
          } else {
            throw e
          }
        }
      }
    } catch (error) {
      if (error instanceof FenceLostError) {
        // 失权不是失败：任务已归别人推进，这里绝不能把它写成 FAILED 或计入失败次数
        console.warn(`[render-worker] ChatCut 任务 ${task.id} 执行权已转移，本轮结果被忽略：${error.message}`)
      } else {
        // 网络抖动 / 查询失败：保持 RUNNING，下一轮重试；**连续**失败超上限则明确终止（见 escalatePollFailure）
        await escalatePollFailure(task.id, state, error as Error, fence).catch((e) =>
          console.warn(`[render-worker] ChatCut 任务 ${task.id} 失败计数写入异常:`, (e as Error).message),
        )
      }
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
  fence?: RenderFence,
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
    }, fence))
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
