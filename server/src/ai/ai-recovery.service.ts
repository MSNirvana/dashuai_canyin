// AI 业务请求的「无主占位」恢复调度
//
// 背景（为什么必须有这个东西）：
//   runBilledScene 把「业务请求占用 + 积分预留」放在同一个事务里提交，所以
//   「进程在 freeze 之前退出」是安全的 —— 什么都没留下。
//   但进程若在 **freeze 已提交、结算尚未执行** 之间退出（部署重启、OOM、被 kill -9），
//   就会留下一个死结：
//     · 该 requestId 的重放看到 PENDING 且没有 AiCallLog → 抛 ScenePendingError，
//       调用方只能换新的 requestId 重试，而**旧预留永远冻结**；
//     · 渲染侧的 stuck sweeper / orphan 回收只管 render_task，不认 business_request。
//   结果是「用户被冻结了一笔积分，界面上完全看不出，库里也一切正常」。
//
// 判据（怎么认出「无主」）：business_request.lease_expire_at
//   · NULL         → 无主（renewRequestLease 从未跑过：认领后立刻崩溃，或租约正常释放后留痕被清）
//   · < now        → 租约已过期（持有者已崩溃或挂起超过租约时长）
//   两者都还要叠加一段宽限期（createdAt 足够旧），否则刚提交、租约尚未写入的那几毫秒
//   会被误判成无主，导致「正在跑的请求被人抢先退款」。
//
// 处理方式（两条分支，都要保证「预留一定被结清」）：
//   ① 上游其实已经成功（ai_call_log 有 responseSnapshot，只差结算）→ 走**同一条**结算路径
//      settleAiCharge，按日志里的 costFen 扣费，绝不重复调用上游；
//   ② 上游没有结果 → 全额释放预留 + 请求置 FAILED（errorCode=AI_LEASE_EXPIRED）。
//
// 抢占用 acquireRequestLease 的 CAS（version 自增）：多个进程/多个 sweeper 同时扫到同一条，
// 只有一个能拿到，另一个自动跳过。恢复动作本身也带 fencing —— 拿到租约才动手。
//
// 用法：由 index.ts 常驻启动；也可 `npm run ai-recovery:verify` 在测试里手动跑一轮。
import type { PrismaClient } from '@prisma/client'
import { unfreeze, type Db } from '../bean/bean.service.js'
import { acquireRequestLease, failBusinessRequest, releaseRequestLease } from '../domain/request.js'
import { settleAiCharge, aiLeaseTtlMs } from './ai.service.js'

const SWEEP_INTERVAL_MS = Math.max(60_000, Number(process.env.AI_RECOVERY_SWEEP_MS ?? 300_000))
/**
 * 宽限期：只有「创建超过这么久、租约还是空的/过期的」才允许被回收。
 * 目的是让「认领事务已提交、租约写入还没执行」的那几毫秒不被误判。
 */
const GRACE_MS = Math.max(30_000, Number(process.env.AI_RECOVERY_GRACE_MS ?? 120_000))
const BATCH = 50
/** AI 业务的 operation 前缀（AI_COPY / AI_STORYBOARD / AI_<SCENE>） */
const AI_OPERATION_PREFIX = 'AI_'
/** 预留 bizType 前缀，与 ai.service 的 `AI_${sceneCode}` 一致 */
const AI_BIZ_PREFIX = 'AI_'

export interface AiRecoveryResult {
  /** 扫到的无主候选数 */
  scanned: number
  /** 抢到租约并完成处理的条数 */
  recovered: number
  /** 已按日志完成结算的条数 */
  settled: number
  /** 全额释放预留的条数 */
  released: number
  /** 释放/结算的积分数 */
  beansFreed: bigint
}

/**
 * 扫描并回收无主的 AI 业务请求。幂等：重复调用不会再动已处理的请求
 * （处理完状态就是 COMPLETED / FAILED，不再进候选集）。
 */
export async function scanStaleAiRequests(
  prisma: PrismaClient,
  opts: { now?: Date; owner?: string; ttlMs?: number } = {},
): Promise<AiRecoveryResult> {
  const now = opts.now ?? new Date()
  const ttlMs = opts.ttlMs ?? aiLeaseTtlMs()
  const owner = opts.owner ?? `ai-recovery-${process.pid}`
  const result: AiRecoveryResult = { scanned: 0, recovered: 0, settled: 0, released: 0, beansFreed: 0n }

  const candidates = await prisma.businessRequest.findMany({
    where: {
      status: 'PENDING',
      operation: { startsWith: AI_OPERATION_PREFIX },
      createdAt: { lt: new Date(now.getTime() - GRACE_MS) },
      OR: [{ leaseExpireAt: null }, { leaseExpireAt: { lt: now } }],
    },
    select: { merchantId: true, operation: true, requestId: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })
  result.scanned = candidates.length

  for (const c of candidates) {
    // ★ 抢占：CAS 自增 leaseVersion。抢不到说明别人正在处理（或这条已经不再是 PENDING），跳过。
    const lease = await acquireRequestLease(prisma, {
      merchantId: c.merchantId,
      operation: c.operation,
      requestId: c.requestId,
      owner,
      ttlMs,
      now,
      onlyIfExpired: true,
    })
    if (!lease.acquired || lease.version === null) continue

    try {
      const freed = await recoverOne(prisma, {
        merchantId: c.merchantId,
        operation: c.operation,
        requestId: c.requestId,
        owner,
        version: lease.version,
        settled: () => {
          result.settled += 1
        },
      })
      result.recovered += 1
      result.beansFreed += freed
      if (freed > 0n) result.released += 1
    } catch (e) {
      console.error(
        `[ai-recovery] 回收失败 merchant=${c.merchantId} requestId=${c.requestId}:`,
        (e as Error).message,
      )
    }
  }
  return result
}

/** 处理单条无主请求；返回本次结清的积分数（0 表示本来就没有未结余量） */
async function recoverOne(
  prisma: PrismaClient,
  args: {
    merchantId: bigint
    operation: string
    requestId: string
    owner: string
    version: number
    settled: () => void
  },
): Promise<bigint> {
  const { merchantId, operation, requestId } = args

  // 预算行：它才是「本次预留了多少」的唯一权威（bizType 形如 AI_copy_generate）
  const reservation = await prisma.beanReservation.findFirst({
    where: { merchantId, requestId, bizType: { startsWith: AI_BIZ_PREFIX } },
    orderBy: { createdAt: 'desc' },
  })
  const remaining = reservation ? reservation.reserved - reservation.consumed - reservation.released : 0n
  const log = await prisma.aiCallLog.findFirst({
    where: { merchantId, requestId },
    orderBy: { createdAt: 'desc' },
  })

  // 分支 ①：上游已经出结果（日志里有响应快照），只是没来得及结算 → 补结算。
  //         复用 settleAiCharge 保证扣费口径与正常路径完全一致。
  if (log && log.responseSnapshot && remaining > 0n && reservation) {
    const scene = await prisma.aiScene.findUnique({ where: { code: log.sceneCode } })
    const r = await settleAiCharge(prisma, {
      merchantId,
      sceneCode: log.sceneCode,
      operation,
      requestId,
      bizType: reservation.bizType,
      bizId: reservation.bizId,
      sceneName: scene?.name ?? log.sceneCode,
      costFen: log.costFen,
      costMicroFen: log.costMicroFen,
      usedFallback: log.isFallback,
      // ★ 计价快照：用预留行的未结余量作为上限，不重读当前价格
      cap: remaining,
    })
    args.settled()
    console.warn(
      `[ai-recovery] requestId=${requestId} 无主但上游已成功，已按日志补结算 ${r.charged} 积分` +
        `（预留 ${remaining}，释放差额 ${remaining - r.charged}）`,
    )
    return remaining - r.charged
  }

  // 分支 ②：上游没有结果 → 全额释放预留 + 请求置失败。
  //         不重试上游：我们没有可续传的远端任务 id，重放也只会在同一个进程里再挂一次。
  await prisma.$transaction(async (tx: Db) => {
    if (reservation && remaining > 0n) {
      await unfreeze(tx, {
        merchantId,
        requestId,
        amount: remaining,
        bizType: reservation.bizType,
        bizId: reservation.bizId,
        remark: `AI 请求无主（租约过期），释放预留 ${remaining} 积分`,
      })
    }
    await failBusinessRequest(
      tx,
      merchantId,
      operation,
      requestId,
      'AI_LEASE_EXPIRED',
      '执行进程在结算前退出，已释放预留并终止该请求，请用新的 requestId 重试',
    )
  })
  await releaseRequestLease(prisma, { merchantId, operation, requestId, owner: args.owner, version: args.version })
  console.error(
    `[ai-recovery] requestId=${requestId} 执行进程已失联（租约过期），已释放预留 ${remaining} 积分并把请求置为 FAILED`,
  )
  return remaining
}

// ──────────────────────── 调度器（照抄 grant-expiry 骨架） ────────────────────────

let timer: NodeJS.Timeout | undefined
let running = false

async function tick(prisma: PrismaClient): Promise<void> {
  if (running) return // 上一轮未结束则跳过本轮，避免叠加
  running = true
  try {
    const r = await scanStaleAiRequests(prisma)
    if (r.scanned > 0 || r.recovered > 0) {
      console.log(
        `[ai-recovery] 扫描无主 AI 请求 ${r.scanned} 条：恢复 ${r.recovered}（补结算 ${r.settled} / 释放 ${r.released}），共结清 ${r.beansFreed} 积分`,
      )
    }
  } catch (e) {
    console.error('[ai-recovery] 扫描失败:', (e as Error).message)
  } finally {
    running = false
  }
}

export function startAiRecoverySweeper(prisma: PrismaClient): void {
  if (timer) return
  void tick(prisma) // 启动时先跑一轮：部署重启留下的无主预留应当尽快被结清
  timer = setInterval(() => void tick(prisma), SWEEP_INTERVAL_MS)
  timer.unref()
  console.log(`[ai-recovery] started (interval=${SWEEP_INTERVAL_MS}ms, grace=${GRACE_MS}ms)`)
}

export function stopAiRecoverySweeper(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
