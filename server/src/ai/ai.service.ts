// AI 场景编排：把「AI 网关调用」和「积分账务」串起来
// 计费时序：预冻结（标价 × buffer）→ 调用 → 成功按实际成本结算 / 失败全额解冻
// 铁律：AI 失败或超时一律不扣积分，返回兜底模板
//
// ★ 两条与「重放 / 崩溃」相关的硬约束（两条都是靠加列修出来的静默故障）：
//   1. 结算与释放的金额一律取**首次冻结时的预留快照**（bean_reservation.reserved），
//      绝不在重放时重新读 `ai_scene.bean_price` —— 价格是运营随时可改的，
//      拿新价去结旧预留会出现「超扣」「少退」以及只报 `unfreeze exceeds business reservation`
//      的持续失败（预留永久冻结）。
//   2. 业务请求带租约（lease_version + lease_expire_at）。进程在「freeze 已提交、
//      结算尚未执行」之间退出时，该 requestId 的 PENDING 预留既不会被重放推进、
//      也不属于渲染 sweeper 的管辖范围 ⇒ 积分静默永久冻结。
//      租约让「无主的 PENDING」可被 ai-recovery 扫到并释放。

import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { AiGateway } from './gateway.js'
import * as bean from '../bean/bean.service.js'
import { BeanNotEnoughError, type BeanBucket } from '../bean/bean.service.js'
import { getDecimal } from '../lib/settings.js'
import {
  acquireRequestLease,
  claimBusinessRequest,
  completeBusinessRequest,
  failBusinessRequest,
  renewRequestLease,
  releaseRequestLease,
} from '../domain/request.js'
import { decFromNumber, decMulCeil, type Dec } from '../lib/decimal.js'

export interface BilledSceneResult {
  text: string
  beanCharged: bigint
  bucket: BeanBucket | null
  usedFallbackChannel: boolean
  isFallbackTemplate: boolean
  balance: { balance: bigint; grantBalance: bigint; available: bigint }
  duplicated: boolean
  /**
   * 本次 AI 请求的**认领时刻**（= business_request.created_at）。
   *
   * ★ 调用方用它做「结果新旧」的单调排序键（见 creation.service.ts::generateShots）。
   *   为什么不用 `new Date()`：重放一次旧 requestId 时，若用「当前时间」当排序键，
   *   旧结果会被误判成最新的，从而覆盖掉更新的分镜。认领时刻在同一 requestId 上
   *   恒定不变、在不同 requestId 之间严格递增，正好可以区分
   *   「这是同一结果的重放」与「这是一次更新的生成」。
   */
  requestClaimedAt: Date
}

export interface BilledSceneParams {
  sceneCode: string
  merchantId: bigint
  requestId: string
  variables: Record<string, string>
  bizId?: string
}

/**
 * 积分 ← 成本 换算（纯整数，无浮点）：
 *   costFen 是「分」，beansPerYuan 是「1 元 = 多少积分」
 *   beans = ceil(costFen × beansPerYuan × costMultiplier / 100)
 *   默认 1 元 = 100 积分、乘数 4 时，beans = ceil(costFen × 4)
 *
 * 旧实现 `BigInt(Math.ceil((costFen / 100) * beansPerYuan * multiplier))` 有浮点误差：
 * IEEE754 下 7/100×100×4 = 28.000000000000004 → ceil = 29，凭空多扣 1 积分。
 * 实测成本 1~20000 分里有 1148 个取值（5.74%）被多扣 1 积分，且只会多扣不会少扣。
 */
export function beansFromCostMicroFen(costMicroFen: bigint, beansPerYuan: Dec, multiplier: Dec): bigint {
  if (costMicroFen < 0n) throw new RangeError('AI cost cannot be negative')
  if (costMicroFen === 0n) return 0n
  return decMulCeil([{ num: costMicroFen, exp: 0 }, beansPerYuan, multiplier], 100_000_000n)
}

// ────────────────────────────── 租约与结算（供本模块与 ai-recovery 共用） ──────────────────────────────

/** 本进程的租约标识。同一个进程内所有 AI 请求共用，但每个请求各有独立的 leaseVersion。 */
const LEASE_OWNER = `${process.pid}-${randomUUID().slice(0, 8)}`

/**
 * 租约时长。必须 ≥「单场景最坏一次调用耗时」，否则一次正常的慢调用会被恢复扫描误判成无主请求
 * 并提前退款（然后调用方回来结算时才发现预留已经没了）。
 * 实测单次 45~90s、`timeout_ms=90000`，多候选还要串行重试，故默认 15 分钟。
 */
export function aiLeaseTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(60_000, Number(env.AI_LEASE_TTL_MS ?? 15 * 60 * 1000))
}

export interface AiChargeParams {
  merchantId: bigint
  sceneCode: string
  operation: string
  requestId: string
  bizType: string
  bizId: string | null
  /** 场景中文名，只用于流水备注 */
  sceneName: string
  costFen: number
  costMicroFen?: bigint
  usedFallback: boolean
  /**
   * ★ 冻结快照 = 本次预留的未结余量（`bean_reservation.reserved - consumed - released`）。
   * 所有加减都以它为界；**不要**在这里重新读 `ai_scene.bean_price`。
   */
  cap: bigint
}

export interface AiChargeResult {
  charged: bigint
  bucket: BeanBucket | null
  absorbed: bigint
}

/** 仅在金额 > 0 时释放：unfreeze 对 amount<=0 会抛错，而 cap 为 0 是合法场景（零成本调用）。 */
async function unfreezeIfPositive(
  tx: Parameters<typeof bean.unfreeze>[0],
  args: { merchantId: bigint; requestId: string; amount: bigint; bizType: string; bizId?: string; remark: string },
): Promise<void> {
  if (args.amount <= 0n) return
  await bean.unfreeze(tx, args)
}

/**
 * 按成本结算一次 AI 调用，并与业务请求完成状态同事务提交。
 *
 * 导出给 ai-recovery 复用：崩溃恢复时「上游其实已经成功、日志已落库、只差结算」的情况下，
 * 必须走**同一条**结算路径，不能另写一套 —— 否则会出现两套口径的扣费。
 */
export async function settleAiCharge(
  prisma: PrismaClient,
  p: AiChargeParams,
): Promise<AiChargeResult> {
  const [beansPerYuan, multiplier] = await Promise.all([
    getDecimal(prisma, 'bean', 'points_per_yuan', 100),
    getDecimal(prisma, 'bean', 'cost_multiplier', 4),
  ])
  // 固定价场景（图像）直接用报价，不走 token 换算 —— 见 AiChargeParams.fixedBeans 的说明。
  // Legacy logs predate cost_micro_fen and contain only costFen.
  const costMicroFen = p.costMicroFen && p.costMicroFen > 0n
    ? p.costMicroFen
    : BigInt(p.costFen) * 1_000_000n
  const wantCharge = beansFromCostMicroFen(costMicroFen, beansPerYuan, multiplier)
  const charged = wantCharge
  const absorbed = 0n

  return prisma.$transaction(async (tx) => {
    let cr: { charged: bigint; bucket: BeanBucket | null }
    if (charged > 0n) {
      if (charged > p.cap) {
        await bean.increaseReservation(tx, {
          merchantId: p.merchantId, requestId: p.requestId, bizType: p.bizType,
          bizId: p.bizId ?? undefined, amount: charged - p.cap,
          remark: '实际成本高于初始预留，补充冻结差额',
        })
      }
      const consumed = await bean.consume(tx, {
        merchantId: p.merchantId,
        requestId: p.requestId,
        amount: charged,
        bizType: p.bizType,
        bizId: p.bizId ?? undefined,
        remark: p.usedFallback ? `${p.sceneName}（备用通道）` : p.sceneName,
      })
      cr = { charged: consumed.charged, bucket: consumed.bucket }
      await unfreezeIfPositive(tx, {
        merchantId: p.merchantId,
        requestId: p.requestId,
        amount: p.cap > charged ? p.cap - charged : 0n,
        bizType: p.bizType,
        bizId: p.bizId ?? undefined,
        remark: '结算后差额释放',
      })
    } else {
      await unfreezeIfPositive(tx, {
        merchantId: p.merchantId,
        requestId: p.requestId,
        amount: p.cap,
        bizType: p.bizType,
        bizId: p.bizId ?? undefined,
        remark: '零成本调用，全额释放',
      })
      cr = { charged: 0n, bucket: null }
    }
    await tx.aiCallLog.updateMany({
      where: { merchantId: p.merchantId, sceneCode: p.sceneCode, requestId: p.requestId },
      data: { beanCharged: cr.charged, absorbedBeans: absorbed, beanBucket: cr.bucket },
    })
    await completeBusinessRequest(tx, p.merchantId, p.operation, p.requestId, p.requestId)
    return { charged: cr.charged, bucket: cr.bucket, absorbed }
  })
}

export async function runBilledScene(
  prisma: PrismaClient,
  gateway: AiGateway,
  params: BilledSceneParams,
): Promise<BilledSceneResult> {
  const scene = await prisma.aiScene.findUnique({ where: { code: params.sceneCode } })
  if (!scene || !scene.enabled) throw new Error(`scene ${params.sceneCode} not available`)

  // 冻结额 = 场景「单次上限」（财务安全网）。实际按成本×系数结算，恒不超过该上限
  const price = scene.beanPrice
  const bizType = `AI_${params.sceneCode}`
  const operation = params.sceneCode === 'copy_generate'
    ? 'AI_COPY'
    : params.sceneCode === 'storyboard_generate'
      ? 'AI_STORYBOARD'
      : `AI_${params.sceneCode.toUpperCase()}`
  const bizId = params.bizId ?? null
  const ttlMs = aiLeaseTtlMs()

  const balanceAfter = async () => bean.getBalance(prisma, params.merchantId)

  /**
   * ★ 计价快照：结算/释放的金额上限永远取自**预留行本身**，而不是当前场景标价。
   *   首次调用时预留刚刚按 `price` 冻结，所以两者相等；重放时若运营改过价，
   *   只有这里读出来的旧值才与预留对得上（否则 unfreeze 直接抛错 → 预留永久冻结）。
   */
  const reservedCap = async (): Promise<bigint> => {
    const remaining = await bean.reservationRemaining(prisma, {
      merchantId: params.merchantId,
      requestId: params.requestId,
      bizType,
      bizId: bizId ?? undefined,
    })
    return remaining ?? price
  }

  const chargeArgs = (
    o: { costFen: number; costMicroFen?: bigint; usedFallback: boolean; cap: bigint },
  ): AiChargeParams => ({
    merchantId: params.merchantId,
    sceneCode: params.sceneCode,
    operation,
    requestId: params.requestId,
    bizType,
    bizId,
    sceneName: scene.name,
    ...o,
  })

  // 请求占用与积分预留必须原子完成，进程退出时不会留下无预留的 PENDING 请求。
  // ★ isolationLevel 必须显式设为 READ COMMITTED：REPEATABLE READ 下并发同 requestId 时，
  //   claimBusinessRequest 命中 P2002 后的同事务重读会因旧快照返回 null 并重抛 P2002 → 5xx。
  const claim = await prisma.$transaction(async (tx) => {
    const result = await claimBusinessRequest(tx, {
      merchantId: params.merchantId,
      operation,
      requestId: params.requestId,
      payload: { sceneCode: params.sceneCode, variables: params.variables, bizId },
      resourceType: 'CREATION',
      resourceId: params.bizId ? BigInt(params.bizId) : undefined,
    })
    if (result.created) {
      await bean.freeze(tx, {
        merchantId: params.merchantId,
        requestId: params.requestId,
        amount: price,
        bizType,
        bizId: bizId ?? undefined,
        remark: `${scene.name} 预留`,
      })
    }
    return result
  }, { isolationLevel: 'ReadCommitted' })

  // 本次请求的「认领时刻」——所有返回路径都带上它，供调用方做结果新旧判定
  const claimedAt = claim.row.createdAt

  // 已有相同业务请求时先返回结果或报告进行中，不能再次创建冻结。
  if (!claim.created) {
    const cap = await reservedCap()
    const log = await prisma.aiCallLog.findFirst({ where: { merchantId: params.merchantId, sceneCode: params.sceneCode, requestId: params.requestId } })
    if (log) {
      const settled = claim.row.status === 'COMPLETED'
        ? {
            charged: log.beanCharged ?? 0n,
            bucket: log.beanBucket === 'GRANT' ? 'GRANT' as const : log.beanBucket === 'RECHARGE' ? 'RECHARGE' as const : null,
          }
        : await settleAiCharge(prisma, chargeArgs({
            costFen: log.costFen,
            usedFallback: log.isFallback,
            cap,
            // ★ 重放图像场景时必须**照样按固定价**结。这条路径是「首次调用成功、
            //   日志已落库、进程在结算前退出」的恢复点：此时 log.costFen=0（出图没有 token 用量），
            //   若这里不补固定价，重放会把预留**全额释放**——用户拿走了封面却一分没扣。
            //   金额取 `cap`（当初冻结的那个数）而不是当前 scene.beanPrice：
            //   运营可能中途改过价，而预留是按旧价冻的，用新价结算会「超扣」。
            costMicroFen: log.costMicroFen,
          }))
      const b = await balanceAfter()
      return {
        text: log.responseSnapshot ?? '',
        beanCharged: settled.charged,
        bucket: settled.bucket,
        usedFallbackChannel: log.isFallback ?? false,
        isFallbackTemplate: false,
        balance: { balance: b.balance, grantBalance: b.grantBalance, available: b.available },
        duplicated: true,
        requestClaimedAt: claimedAt,
      }
    }
    if (claim.row.status === 'FAILED') {
      const b = await balanceAfter()
      return {
        text: renderFallback(scene.fallbackTemplate, params.variables),
        beanCharged: 0n,
        bucket: null,
        usedFallbackChannel: false,
        isFallbackTemplate: true,
        balance: { balance: b.balance, grantBalance: b.grantBalance, available: b.available },
        duplicated: true,
        requestClaimedAt: claimedAt,
      }
    }
    // PENDING 且没有调用日志：上一轮执行者要么还在跑，要么已经崩了。
    // 崩掉的那种由 ai-recovery 按租约过期回收（这里只负责如实报告「进行中」）。
    throw new ScenePendingError()
  }

  // ★ 租约：刚创建的行无条件认领（此时不存在竞争者）。
  //   这一步故意放在 claim 事务**之外**：万一在 claim 与这里之间进程退出，
  //   business_request 的 lease_expire_at 会是 NULL —— 恢复扫描把 NULL 视为「无主」，
  //   于是它仍然能被回收，不会漏。
  const lease = await acquireRequestLease(prisma, {
    merchantId: params.merchantId,
    operation,
    requestId: params.requestId,
    owner: LEASE_OWNER,
    ttlMs,
  })

  // 2) 调用 AI 网关（含故障转移与熔断）
  //    调用前把租约时钟重新起算：占用时长应当从「真正开始调用」算，而不是从认领算。
  await renewRequestLease(prisma, {
    merchantId: params.merchantId,
    operation,
    requestId: params.requestId,
    owner: LEASE_OWNER,
    version: lease.version ?? 0,
    ttlMs,
  })
  const r = await gateway.runScene({
    sceneCode: params.sceneCode,
    variables: params.variables,
    merchantId: params.merchantId,
    requestId: params.requestId,
  })

  const cap = await reservedCap()

  /**
   * 落地前的失权校验：如果这次调用耗时超过了租约（极端慢 + 恢复扫描已介入），
   * 预留可能已被恢复任务释放。此时**不能**再结算 —— 否则就是「已退款又扣费」。
   * 续租失败（行已不是 PENDING / 已不归我们）即视为失权。
   */
  const fenceOk = lease.version !== null && await renewRequestLease(prisma, {
    merchantId: params.merchantId,
    operation,
    requestId: params.requestId,
    owner: LEASE_OWNER,
    version: lease.version,
    ttlMs,
  })
  if (!fenceOk) {
    console.warn(
      `[ai-billing] requestId=${params.requestId} 结算前已失去租约（调用耗时超过 ${ttlMs}ms？），` +
        `预留已由恢复任务处理，本次不再结算`,
    )
    const b = await balanceAfter()
    return {
      text: renderFallback(scene.fallbackTemplate, params.variables),
      beanCharged: 0n,
      bucket: null,
      usedFallbackChannel: false,
      isFallbackTemplate: true,
      balance: { balance: b.balance, grantBalance: b.grantBalance, available: b.available },
      duplicated: true,
      requestClaimedAt: claimedAt,
    }
  }

  // 3) 失败 / 超时：全额解冻，返回兜底模板，不扣积分
  if (!r.ok) {
    await prisma.$transaction(async (tx) => {
      await unfreezeIfPositive(tx, {
        merchantId: params.merchantId,
        requestId: params.requestId,
        amount: cap,
        bizType,
        bizId: bizId ?? undefined,
        remark: 'AI 调用失败，全额释放',
      })
      await failBusinessRequest(tx, params.merchantId, operation, params.requestId, 'AI_FAILED', r.message)
    })
    await releaseRequestLease(prisma, {
      merchantId: params.merchantId,
      operation,
      requestId: params.requestId,
      owner: LEASE_OWNER,
      version: lease.version ?? 0,
    })
    const b = await balanceAfter()
    return {
      text: renderFallback(scene.fallbackTemplate, params.variables),
      beanCharged: 0n,
      bucket: null,
      usedFallbackChannel: false,
      isFallbackTemplate: true,
      balance: { balance: b.balance, grantBalance: b.grantBalance, available: b.available },
      duplicated: false,
      requestClaimedAt: claimedAt,
    }
  }

  // 4) 成功：按实际成本结算，并与业务请求完成状态同事务提交。
  const res = await settleAiCharge(prisma, chargeArgs({
    costFen: r.costFen,
    costMicroFen: r.costMicroFen,
    usedFallback: r.usedFallback,
    cap,
  }))
  await releaseRequestLease(prisma, {
    merchantId: params.merchantId,
    operation,
    requestId: params.requestId,
    owner: LEASE_OWNER,
    version: lease.version ?? 0,
  })

  const b = await balanceAfter()
  return {
    text: r.text,
    beanCharged: res.charged,
    bucket: res.bucket,
    usedFallbackChannel: r.usedFallback,
    isFallbackTemplate: false,
    balance: { balance: b.balance, grantBalance: b.grantBalance, available: b.available },
    duplicated: false,
    requestClaimedAt: claimedAt,
  }
}

function renderFallback(tpl: string | null, vars: Record<string, string>): string {
  if (!tpl) return ''
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '')
}

export { BeanNotEnoughError }

/**
 * 幂等未完成信号：同一 requestId 已冻结但无完成记录（进行中或先前失败已释放）。
 * 调用方应改用「新的 requestId」重试，不要把它当成成功返回。
 */
export class ScenePendingError extends Error {
  readonly code = 'SCENE_PENDING'
  constructor(message = 'request in progress or previously failed; retry with a new requestId') {
    super(message)
    this.name = 'ScenePendingError'
  }
}
