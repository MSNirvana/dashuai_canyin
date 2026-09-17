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

let running = false
let timer: ReturnType<typeof setTimeout> | null = null

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

/** 取一个 QUEUED 任务并抢占标记 RUNNING（多 worker 并发时用 updateMany 条件更新抢锁） */
async function tick(): Promise<void> {
  // PREMIUM（人工精剪）任务不进机器队列，由管理后台剪辑工作台处理
  const task = await prisma.renderTask.findFirst({
    where: { status: 'QUEUED', grade: { not: 'PREMIUM' } },
    orderBy: { createdAt: 'asc' },
  })
  if (!task) {
    await pollChatCutTasks()
    return
  }

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
  })
  await storeChatCutState(task.id, result.state, result.status)
  for (const notice of result.state.notices ?? []) {
    console.warn(`[render-worker] ChatCut 任务 ${task.id} 提示：${notice}`)
  }
  if (result.status === 'FAILED') throw new Error(result.errorMessage || 'ChatCut 启动失败')
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
      progress: chatcutJob.phase === 'RENDER' ? 60 : 30,
      paramsJson: { ...params, chatcutJob } as never,
    },
  })
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
      await storeChatCutState(task.id, result.state, result.status)
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
      // 网络抖动 / 查询失败：保持 RUNNING，下一轮重试（超时由 stuck-sweeper 兜底退款）
      console.warn(`[render-worker] ChatCut 任务 ${task.id} 查询失败:`, (error as Error).message)
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
