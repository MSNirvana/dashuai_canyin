// 精品生成（PREMIUM）人工剪辑链路
// 状态机：MANUAL_PENDING（待接单）→ MANUAL_DOING（剪辑中）→ SUCCESS（交付成片）/ FAILED（失败或 SLA 超时）
// 计费铁律与机器合成一致：submitRender 只 freeze 预留；交付成功才 consume，失败/超时 unfreeze 全额释放
import type { PrismaClient } from '@prisma/client'
import { prisma } from '../db.js'
import type { Db } from '../bean/bean.service.js'
import { completeRender, failRender, type RenderClip } from '../services/render.service.js'
import { getSharedPlayUrlByKey } from '../services/media.service.js'

export class PremiumTaskStateError extends Error {
  constructor(
    message: string,
    readonly code = 4010,
    readonly httpStatus = 409,
  ) {
    super(message)
    this.name = 'PremiumTaskStateError'
  }
}

export interface PremiumMaterial {
  seq: number
  shotId: string
  line: string | null
  trimStartMs: number
  trimEndMs: number | null
  durationMs: number | null
  cosKey: string
  playUrl: string | null // 演示环境（无 COS）为 null
}

function parseClips(paramsJson: unknown): RenderClip[] {
  const p = (paramsJson ?? {}) as { clips?: RenderClip[] }
  return p.clips ?? []
}

async function getTaskOrThrow(taskId: bigint) {
  const task = await prisma.renderTask.findUnique({ where: { id: taskId } })
  if (!task) throw new PremiumTaskStateError('任务不存在', 4047, 404)
  if (task.grade !== 'PREMIUM') throw new PremiumTaskStateError('该任务不是精品生成任务', 4011, 400)
  return task
}

/** 接单：MANUAL_PENDING → MANUAL_DOING（updateMany 条件更新防并发双接） */
export async function claimPremiumTask(prisma: PrismaClient, taskId: bigint) {
  await getTaskOrThrow(taskId)
  const claimed = await prisma.renderTask.updateMany({
    where: { id: taskId, status: 'MANUAL_PENDING' },
    data: { status: 'MANUAL_DOING', assignedAt: new Date(), progress: 10 },
  })
  if (claimed.count === 0) throw new PremiumTaskStateError('任务不在待接单状态（可能已被接走）')
  return prisma.renderTask.findUnique({ where: { id: taskId } })
}

export interface DeliverInput {
  resultKey: string
  previewKey?: string | null
  resultSize?: bigint | null
  durationMs?: number | null
}

/** 交付成片：consume 结算 + 落产物（幂等：requestId rc:<taskId>） */
export async function deliverPremiumTask(prisma: PrismaClient, taskId: bigint, input: DeliverInput) {
  const task = await getTaskOrThrow(taskId)
  if (task.status !== 'MANUAL_DOING' && task.status !== 'MANUAL_PENDING') {
    if (task.status === 'SUCCESS') return task
    throw new PremiumTaskStateError(`任务状态 ${task.status} 不可交付`)
  }
  await prisma.$transaction(async (tx: Db) => {
    await completeRender(tx, task.merchantId, taskId, {
      resultKey: input.resultKey,
      previewKey: input.previewKey ?? null,
      resultSize: input.resultSize ?? undefined,
      durationMs: input.durationMs ?? null,
      cacheHit: false,
    })
  })
  return prisma.renderTask.findUnique({ where: { id: taskId } })
}

/** 人工标记失败：unfreeze 全额释放 + FAILED */
export async function failPremiumTask(prisma: PrismaClient, taskId: bigint, reason: string) {
  const task = await getTaskOrThrow(taskId)
  if (task.status === 'SUCCESS') throw new PremiumTaskStateError('任务已交付，不可标记失败')
  const state = await failRender(prisma, taskId, 'MANUAL_FAILED', reason || '人工标记失败')
  if (state === 'SETTLEMENT_PENDING') throw new PremiumTaskStateError('退款处理中，请稍后查看任务状态', 4012, 500)
  return prisma.renderTask.findUnique({ where: { id: taskId } })
}

/** 素材清单：剪辑工作台下载用（管理员可信，直接按 key 签名） */
export async function premiumMaterials(prisma: PrismaClient, taskId: bigint): Promise<PremiumMaterial[]> {
  const task = await getTaskOrThrow(taskId)
  const clips = parseClips(task.paramsJson)
  const out: PremiumMaterial[] = []
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    if (!c) continue
    const { url } = await getSharedPlayUrlByKey(c.cosKey).catch(() => ({ url: null }))
    out.push({
      seq: i + 1,
      shotId: c.shotId,
      line: c.line ?? null,
      trimStartMs: c.trimStartMs,
      trimEndMs: c.trimEndMs,
      durationMs: c.durationMs,
      cosKey: c.cosKey,
      playUrl: url,
    })
  }
  return out
}

// ──────────────────────── SLA 超时 sweeper ────────────────────────

const SWEEP_INTERVAL_MS = Math.max(60_000, Number(process.env.PREMIUM_SWEEP_MS ?? 300_000))
let sweeping = false
let sweepTimer: ReturnType<typeof setInterval> | null = null

export function startPremiumSweeper(): void {
  if (sweeping) return
  sweeping = true
  console.log(`[premium-sweeper] started (interval=${SWEEP_INTERVAL_MS}ms)`)
  sweepTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS)
}

export function stopPremiumSweeper(): void {
  sweeping = false
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
}

/** 超时未交付的精品任务：unfreeze 全额退款 + FAILED(SLA_TIMEOUT) */
async function sweep(): Promise<void> {
  if (!sweeping) return
  const overdue = await prisma.renderTask.findMany({
    where: {
      grade: 'PREMIUM',
      status: { in: ['MANUAL_PENDING', 'MANUAL_DOING'] },
      deadlineAt: { lt: new Date() },
    },
    take: 50,
  })
  for (const task of overdue) {
    try {
      const state = await failRender(prisma, task.id, 'SLA_TIMEOUT', '精品合成超过承诺时限，已自动退款')
      console.warn(`[premium-sweeper] task ${task.id} 超时，状态 ${state}`)
    } catch (e) {
      console.error(`[premium-sweeper] task ${task.id} 退款失败:`, (e as Error).message)
    }
  }
}
