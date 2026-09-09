// 合成服务：把分镜已上传素材按序硬切拼接为 9:16 成片
// 三档产品档位（grade）：BASIC=纯粗剪 / AI=全自动（配音+字幕+节奏）/ PREMIUM=人工精剪（不进 FFmpeg 队列）
// 计费（v5）：时长(秒) × point_per_sec × 档位系数 ×（RECOLOR 再乘 recolor_ratio）
// 扣豆两阶段：freeze（提交时预留）→ consume（合成成功结算）；失败/unfreeze 退款由 worker / sweeper 负责
// 演示环境（FFMPEG_WORKER≠true，无 ffmpeg）下，BASIC/AI 任务会在同一事务内模拟「成功」完成，打通最小闭环；
// PREMIUM 任务无论何种环境都进入人工队列（MANUAL_PENDING），由管理后台剪辑工作台交付
// 真实环境（FFMPEG_WORKER=true）：submitRender 仅 freeze 预留 + 建 QUEUED 任务，
//   由 render/worker.ts 拉取执行 FFmpeg，成功 consume 结算、失败 unfreeze 全额释放
import { randomUUID } from 'crypto'
import type { PrismaClient, Prisma } from '@prisma/client'
import { freeze, consume, unfreeze, availableOf, type Db } from '../bean/bean.service.js'
import { getCreation, CreationNotFoundError } from './creation.service.js'
import { requireSubscription } from './subscription.service.js'
import { getNumber } from '../lib/settings.js'
import { claimBusinessRequest, completeBusinessRequest, failBusinessRequest } from '../domain/request.js'

// 计费点数（后台可配置化见 docs/05，此处为默认值）
export const RENDER_BEAN_FULL = 30n
export const RENDER_BEAN_RECOLOR = 10n

export type RenderMode = 'FULL' | 'RECOLOR'

/** 产品档位：BASIC 粗剪 / AI 全自动 / PREMIUM 人工精剪 */
export type RenderGrade = 'BASIC' | 'AI' | 'PREMIUM'

export function parseGrade(v: unknown): RenderGrade {
  return v === 'BASIC' || v === 'PREMIUM' ? v : 'AI'
}

/** 档位计费系数的兜底默认值（实际以后台 render.grade_ratio_* 配置为准） */
export const GRADE_RATIO_DEFAULT: Record<RenderGrade, number> = {
  BASIC: 1,
  AI: 1.5,
  PREMIUM: 3,
}

export class RenderNoAssetError extends Error {
  constructor() {
    super('请先为至少一个分镜上传素材')
    this.name = 'RenderNoAssetError'
  }
}
export class RenderAlreadyRunningError extends Error {
  constructor() {
    super('已有合成任务进行中')
    this.name = 'RenderAlreadyRunningError'
  }
}
export class RenderDurationUnknownError extends Error {
  constructor() {
    super('素材缺少时长信息，无法计价，请重新上传素材')
    this.name = 'RenderDurationUnknownError'
  }
}

export interface ColorGrade {
  brightness: number // -100 ~ 100，默认 0
  contrast: number
  saturation: number
  sharpen: number
}

export const DEFAULT_COLOR: ColorGrade = { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }

export interface RenderClip {
  shotId: string
  assetId: string
  cosKey: string
  coverKey: string | null
  trimStartMs: number
  trimEndMs: number | null
  /** 素材自身时长（上传确认时上报）；未设置 trim 时作为计费时长依据（与 FFmpeg 未裁剪=用全片的行为一致） */
  durationMs: number | null
  /** 该分镜的口播文案（Shot.line），AI 合成用于配音与字幕 */
  line: string | null
}

export interface SubmitRenderInput {
  mode: RenderMode
  color?: ColorGrade
  requestId?: string
  /** 是否启用 AI 合成（AI 配音 + 字幕 + 智能节奏）；默认 true（旧客户端兼容字段） */
  aiMode?: boolean
  /** 产品档位；未传时按 aiMode 推导（false→BASIC，true/缺省→AI） */
  grade?: RenderGrade
}

export interface RenderTaskView {
  id: string
  creationId: string
  status: string
  progress: number
  mode: RenderMode
  grade: RenderGrade
  aiMode: boolean
  color: ColorGrade
  clips: RenderClip[]
  beanCharged: string
  cacheHit: boolean
  resultKey: string | null
  previewKey: string | null
  resultSize: string | null
  durationMs: number | null
  errorCode: string | null
  errorMsg: string | null
  createdAt: string
  finishAt: string | null
  assignedAt: string | null
  deadlineAt: string | null
}

function toView(row: {
  id: bigint
  creationId: bigint
  status: string
  progress: number
  grade?: string | null
  paramsJson: unknown
  beanCharged: bigint
  cacheHit: boolean
  resultKey: string | null
  previewKey: string | null
  resultSize: bigint | null
  durationMs: number | null
  errorCode: string | null
  errorMsg: string | null
  createdAt: Date
  finishAt: Date | null
  assignedAt?: Date | null
  deadlineAt?: Date | null
}): RenderTaskView {
  const p = (row.paramsJson ?? {}) as { mode?: RenderMode; aiMode?: boolean; color?: ColorGrade; clips?: RenderClip[] }
  return {
    id: row.id.toString(),
    creationId: row.creationId.toString(),
    status: row.status,
    progress: row.progress,
    mode: p.mode ?? 'FULL',
    grade: parseGrade(row.grade),
    aiMode: p.aiMode ?? true,
    color: p.color ?? DEFAULT_COLOR,
    clips: p.clips ?? [],
    beanCharged: row.beanCharged.toString(),
    cacheHit: row.cacheHit,
    resultKey: row.resultKey,
    previewKey: row.previewKey,
    resultSize: row.resultSize?.toString() ?? null,
    durationMs: row.durationMs,
    errorCode: row.errorCode,
    errorMsg: row.errorMsg,
    createdAt: row.createdAt.toISOString(),
    finishAt: row.finishAt?.toISOString() ?? null,
    assignedAt: row.assignedAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
  }
}

/** 是否启用真实 FFmpeg worker（true=真实合成；false=演示环境模拟成功） */
function simulateWorkerEnabled(): boolean {
  return process.env.FFMPEG_WORKER === 'true'
}

export async function getRender(prisma: PrismaClient, merchantId: bigint, taskId: bigint): Promise<RenderTaskView> {
  const row = await prisma.renderTask.findFirst({
    where: { id: taskId, merchantId },
  })
  if (!row) throw new RenderNotFoundError()
  return toView(row)
}

export class RenderNotFoundError extends Error {
  constructor() {
    super('合成任务不存在')
    this.name = 'RenderNotFoundError'
  }
}

export async function listRenders(prisma: PrismaClient, merchantId: bigint, creationId: bigint): Promise<RenderTaskView[]> {
  const rows = await prisma.renderTask.findMany({
    where: { merchantId, creationId },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map(toView)
}

/**
 * 单分镜有效时长（ms）：
 * - 设置了 trim（end > start）：用 trim 区间（与 FFmpeg 裁剪行为一致）
 * - 未设置 trim：用素材自身时长减去 trimStart（与 FFmpeg「未裁剪=全片」行为一致）
 * - 两者都缺：返回 null（无法计价，调用方应拒绝提交）
 */
export function clipDurationMs(clip: RenderClip): number | null {
  if (clip.trimEndMs && clip.trimEndMs > clip.trimStartMs) {
    return clip.trimEndMs - clip.trimStartMs
  }
  if (clip.durationMs && clip.durationMs > clip.trimStartMs) {
    return clip.durationMs - clip.trimStartMs
  }
  return null
}

/** 提交合成：校验 → 组装 clips → 创建任务 → 两阶段扣豆 → (演示)模拟完成 */
export async function submitRender(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
  input: SubmitRenderInput,
): Promise<{ task: RenderTaskView; duplicated: boolean }> {
  const reqId = input.requestId ?? randomUUID()

  // v5：订阅是使用合成出片的硬前提（在冻结积分之前拦截）
  await requireSubscription(prisma, merchantId, '合成出片')

  const creation = await getCreation(prisma, merchantId, creationId) // 校验归属

  // 拉取带素材的分镜（按顺序）。Shot 未建 asset 关系，单独查 media_asset
  const shots = await prisma.shot.findMany({
    where: { creationId, assetId: { not: null } },
    orderBy: { seq: 'asc' },
  })
  if (shots.length === 0) throw new RenderNoAssetError()

  const assetIds = shots.map((s) => s.assetId!)
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: assetIds }, merchantId, storeId: creation.storeId, deletedAt: null },
  })
  if (assets.length !== assetIds.length) throw new Error('创作中的素材不属于当前商家门店或已被删除')
  const assetMap = new Map(assets.map((a) => [a.id, a]))

  const clips: RenderClip[] = shots
    .map((s) => {
      const a = s.assetId ? assetMap.get(s.assetId) : undefined
      if (!a) return null
      return {
        shotId: s.id.toString(),
        assetId: s.assetId!.toString(),
        cosKey: a.cosKey,
        coverKey: a.coverKey,
        trimStartMs: s.trimStartMs,
        trimEndMs: s.trimEndMs,
        durationMs: a.durationMs ?? null,
        line: s.line,
      } satisfies RenderClip
    })
    .filter((c): c is RenderClip => c !== null)
  if (clips.length === 0) throw new RenderNoAssetError()

  const mode: RenderMode = input.mode === 'RECOLOR' ? 'RECOLOR' : 'FULL'
  const color = input.color ?? DEFAULT_COLOR
  // 档位：新客户端传 grade；旧客户端只传 aiMode → 推导（false→BASIC，其余→AI）
  const grade: RenderGrade = input.grade ?? (input.aiMode === false ? 'BASIC' : 'AI')
  const aiMode = grade !== 'BASIC' // BASIC 纯粗剪；AI/PREMIUM 含配音字幕管线（PREMIUM 由人工执行）

  // 计费时长 = 各分镜有效时长之和；任一分镜时长未知则拒绝（无法正确计价会少扣豆）
  let totalMs = 0
  for (const cl of clips) {
    const dur = clipDurationMs(cl)
    if (dur === null) throw new RenderDurationUnknownError()
    totalMs += dur
  }

  const requestPayload = { creationId: creationId.toString(), mode, color, grade, aiMode, clips }
  // 创建任务 + 并发拦截 + 业务请求占用 + freeze 放在同一事务并对创作行加锁：
  // 防止两个并发请求同时通过「无进行中任务」检查、创建出两个任务双重扣豆
  const pointPerSec = await getNumber(prisma, 'render', 'point_per_sec', 1)
  // 档位系数（后台 render.grade_ratio_basic/ai/premium 可配）
  const gradeRatio = await getNumber(prisma, 'render', `grade_ratio_${grade.toLowerCase()}`, GRADE_RATIO_DEFAULT[grade])
  // RECOLOR 复用归一化缓存（省掉源解码+缩放），按折扣系数计价，默认 5 折（后台 render.recolor_ratio 可配）
  const recolorRatio = mode === 'RECOLOR' ? await getNumber(prisma, 'render', 'recolor_ratio', 0.5) : 1
  const totalSec = totalMs / 1000
  const amount = BigInt(Math.max(1, Math.ceil(totalSec * pointPerSec * gradeRatio * recolorRatio)))

  // PREMIUM：SLA 截止时间（超时由 sweeper 自动退款）
  const premiumSlaHours = grade === 'PREMIUM' ? await getNumber(prisma, 'render', 'premium_sla_hours', 48) : 0
  const deadlineAt = grade === 'PREMIUM' ? new Date(Date.now() + premiumSlaHours * 3600_000) : null

  const txResult = await prisma.$transaction(async (tx: Db) => {
    const claim = await claimBusinessRequest(tx, {
      merchantId,
      operation: 'RENDER',
      requestId: reqId,
      payload: requestPayload,
      resourceType: 'CREATION',
      resourceId: creationId,
    })
    if (!claim.created) {
      const prior = await tx.renderTask.findFirst({ where: { merchantId, requestId: reqId } })
      if (prior) return { task: prior, duplicated: true }
      throw new RenderAlreadyRunningError()
    }
    // 锁创作行，序列化同一创作的并发提交（MySQL InnoDB 行锁）
    await tx.$queryRaw`SELECT id FROM creation WHERE id = ${creationId} FOR UPDATE`
    // PREMIUM 任务在人工队列里不算「机器合成进行中」，但同样不允许重复提交
    const running = await tx.renderTask.findFirst({
      where: { creationId, status: { in: ['QUEUED', 'RUNNING', 'MANUAL_PENDING', 'MANUAL_DOING'] } },
    })
    if (running) throw new RenderAlreadyRunningError()
    const task = await tx.renderTask.create({
      data: {
        merchantId,
        creationId,
        status: 'PENDING_RESERVATION',
        grade,
        beanCharged: amount, // 计划扣豆额：演示模式立即结算，真实模式由 worker / 人工交付结算
        deadlineAt,
        paramsJson: { mode, aiMode, color, output: { width: 1080, height: 1920, fps: 30 }, clips } as unknown as Prisma.InputJsonValue,
        requestId: reqId,
      },
    })
    const fr = await freeze(tx, {
      merchantId,
      requestId: reqId,
      amount,
      bizType: 'RENDER',
      bizId: task.id.toString(),
      remark: `${mode === 'RECOLOR' ? '重调色合成' : '合成成片'}(${grade}) 预留 ${amount} 豆`,
    })
    const status = grade === 'PREMIUM' ? 'MANUAL_PENDING' : 'QUEUED'
    const updated = await tx.renderTask.update({
      where: { id: task.id },
      data: { status, reservationId: fr.reservationId },
    })
    await tx.businessRequest.updateMany({
      where: { merchantId, operation: 'RENDER', requestId: reqId },
      data: { resourceId: task.id, resultRef: task.id.toString() },
    })
    return { task: updated, duplicated: false }
  })
  const task = txResult.task
  // 演示环境保留同步完成；任务创建与预留已原子完成，结算再以终态 CAS 收口。
  if (!txResult.duplicated && simulateWorkerEnabled() === false && grade !== 'PREMIUM') {
    await prisma.$transaction(async (tx: Db) => {
      await consume(tx, {
        merchantId,
        requestId: reqId,
        amount,
        bizType: 'RENDER',
        bizId: task.id.toString(),
        remark: `${mode === 'RECOLOR' ? '重调色合成' : '合成成片'} 消耗 ${amount} 豆`,
      })
      await tx.renderTask.updateMany({
        where: { id: task.id, status: 'QUEUED' },
        data: {
          status: 'SUCCESS', progress: 100, beanCharged: amount, cacheHit: mode === 'RECOLOR',
          resultKey: clips[0]?.cosKey ?? null, previewKey: clips[0]?.coverKey ?? null,
          durationMs: totalMs || null, finishAt: new Date(), costMs: Math.max(1, Math.round(totalMs / 1000) || 1),
        },
      })
      await completeBusinessRequest(tx, merchantId, 'RENDER', reqId, task.id.toString())
    })
  }
  const view = await getRender(prisma, merchantId, task.id)
  return { task: view, duplicated: txResult.duplicated }
}

/** 真实环境 worker 收尾调用：结算扣豆 + 写产物（freeze 已在 submit 阶段完成） */
export async function completeRender(
  tx: Db,
  merchantId: bigint,
  taskId: bigint,
  result: {
    resultKey: string
    previewKey?: string | null
    resultSize?: bigint
    durationMs?: number | null
    /** 是否命中中间产物缓存（重调色复用归一化产物，对应 10 豆计费） */
    cacheHit?: boolean
  },
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM render_task WHERE id = ${taskId} FOR UPDATE`
  const task = await tx.renderTask.findUnique({ where: { id: taskId } })
  if (!task) return
  if (task.status === 'SUCCESS') return
  if (!['RUNNING', 'MANUAL_DOING', 'MANUAL_PENDING', 'QUEUED'].includes(task.status)) return
  const amount = task.beanCharged > 0n ? task.beanCharged : RENDER_BEAN_FULL
  await consume(tx, {
    merchantId,
    requestId: task.requestId ?? taskId.toString(),
    amount,
    bizType: 'RENDER',
    bizId: taskId.toString(),
  })
  const updated = await tx.renderTask.updateMany({
    where: { id: taskId, status: { in: ['RUNNING', 'MANUAL_DOING', 'MANUAL_PENDING', 'QUEUED'] } },
    data: {
      status: 'SUCCESS',
      progress: 100,
      beanCharged: amount,
      cacheHit: result.cacheHit ?? false,
      resultKey: result.resultKey,
      previewKey: result.previewKey ?? null,
      resultSize: result.resultSize,
      durationMs: result.durationMs,
      finishAt: new Date(),
    },
  })
  if (updated.count > 0 && task.requestId) {
    await completeBusinessRequest(tx, merchantId, 'RENDER', task.requestId, taskId.toString())
  }
}

/** 失败终态：先释放本任务预留；释放失败则显式进入待结算，避免假称已退款。 */
export async function failRender(
  prisma: PrismaClient,
  taskId: bigint,
  errorCode: string,
  errorMsg: string,
): Promise<'FAILED' | 'SUCCESS' | 'SETTLEMENT_PENDING'> {
  try {
    return await prisma.$transaction(async (tx: Db) => {
      await tx.$queryRaw`SELECT id FROM render_task WHERE id = ${taskId} FOR UPDATE`
      const task = await tx.renderTask.findUnique({ where: { id: taskId } })
      if (!task) return 'FAILED'
      if (task.status === 'SUCCESS') return 'SUCCESS'
      if (task.status === 'FAILED') return 'FAILED'
      const active = ['PENDING_RESERVATION', 'QUEUED', 'RUNNING', 'MANUAL_PENDING', 'MANUAL_DOING', 'SETTLEMENT_PENDING']
      if (!active.includes(task.status)) return 'FAILED'
      if (task.beanCharged > 0n) {
        await unfreeze(tx, {
          merchantId: task.merchantId,
          requestId: task.requestId ?? task.id.toString(),
          amount: task.beanCharged,
          bizType: 'RENDER',
          bizId: task.id.toString(),
          remark: '合成失败，释放本任务预留积分',
        })
      }
      await tx.renderTask.updateMany({
        where: { id: task.id, status: { in: active } },
        data: {
          status: 'FAILED',
          errorCode,
          errorMsg: errorMsg.slice(0, 500),
          finishAt: new Date(),
        },
      })
      if (task.requestId) {
        await failBusinessRequest(tx, task.merchantId, 'RENDER', task.requestId, errorCode, errorMsg)
      }
      return 'FAILED'
    })
  } catch (e) {
    await prisma.renderTask.updateMany({
      where: {
        id: taskId,
        status: { in: ['PENDING_RESERVATION', 'QUEUED', 'RUNNING', 'MANUAL_PENDING', 'MANUAL_DOING', 'SETTLEMENT_PENDING'] },
      },
      data: {
        status: 'SETTLEMENT_PENDING',
        errorCode: 'REFUND_PENDING',
        errorMsg: `积分释放失败：${(e as Error).message}`.slice(0, 500),
      },
    })
    return 'SETTLEMENT_PENDING'
  }
}

/** 当前可用豆（供前端预估展示） */
export async function getAvailable(prisma: PrismaClient, merchantId: bigint) {
  const acc = await prisma.beanAccount.upsert({
    where: { merchantId },
    create: { merchantId },
    update: {},
  })
  return availableOf(acc)
}
