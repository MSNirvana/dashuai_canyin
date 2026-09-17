// 赠积分到期清零调度（会员到期 job）
//
// 背景：bean.service.expireGrant() 早已实现，但**全项目零调用**——
// 结果是「订阅到期后赠送的积分永久保留」，与 docs/05 计费规则（订阅 ¥980/30天/赠 98000 积分，到期清零）不符，
// 也让续费失去意义（不续费也能一直用赠积分）。
//
// 触发口径：以 membership.grantExpireAt 为准（激活/续期时被置为该期 endAt）。
//
// 关键安全约束（务必别改坏）：
//   1. 一个商户只处理一次，避免同一 merchant 多行会员记录被重复清零；
//   2. 清零前必须确认该商户**没有**仍然有效的会员（endAt > now）。
//      因为 activateMembership 续期时会把新 endAt 写到同一行、并把旧行留在 ACTIVE 且 endAt 已过；
//      若不检查，续期用户的赠积分会在旧行到期日被误清空；
//   3. expireGrant 自身对 grant_balance <= 0 直接返回 0，天然幂等；
//   4. 状态置 EXPIRED 作为「已处理」标记（docs/01 定义的枚举就是 ACTIVE/EXPIRED）。
import type { PrismaClient } from '@prisma/client'
import { expireGrant, type Db } from '../bean/bean.service.js'

export interface GrantExpiryResult {
  /** 扫描到的候选会员记录数 */
  scanned: number
  /** 实际执行清零的商户数 */
  merchantsExpired: number
  /** 因仍有有效会员而跳过的商户数（已续期） */
  skippedStillActive: number
  /** 累计清零积分数 */
  beansCleared: bigint
}

const BATCH = 500

/**
 * 扫描并执行赠积分到期清零。幂等：重复调用不会重复清零。
 * 导出为纯函数形式（不依赖调度器），便于测试与手动触发。
 *
 * 到期口径（`grant_expire_at` 是后加字段，历史数据可能为 NULL，必须兼容）：
 *   候选 = 状态 ACTIVE 且 (grantExpireAt 已过 或 grantExpireAt 为空且 endAt 已过)
 */
export async function scanGrantExpiry(prisma: PrismaClient, now = new Date()): Promise<GrantExpiryResult> {
  const candidates = await prisma.membership.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { grantExpireAt: { not: null, lte: now } },
        // 兼容历史数据：grantExpireAt 为 NULL 时退回用 endAt 判断
        { grantExpireAt: null, endAt: { lte: now } },
      ],
    },
    select: { id: true, merchantId: true, grantExpireAt: true, endAt: true },
    orderBy: { endAt: 'asc' },
    take: BATCH,
  })

  const result: GrantExpiryResult = {
    scanned: candidates.length,
    merchantsExpired: 0,
    skippedStillActive: 0,
    beansCleared: 0n,
  }
  if (candidates.length === 0) return result

  const handled = new Set<string>()
  for (const m of candidates) {
    const key = m.merchantId.toString()
    if (handled.has(key)) continue // 同一商户只处理一次
    handled.add(key)

    // 续期保护：该商户若还有未到期的有效会员，说明已续期，赠积分顺延，不能清零
    const stillActive = await prisma.membership.findFirst({
      where: { merchantId: m.merchantId, status: 'ACTIVE', endAt: { gt: now } },
      select: { id: true },
    })
    if (stillActive) {
      result.skippedStillActive += 1
      continue
    }
    // 二次保护：万一 grantExpireAt 被单独延长到未来（与 endAt 不一致），也不能清零
    const grantExtended = await prisma.membership.findFirst({
      where: { merchantId: m.merchantId, status: 'ACTIVE', grantExpireAt: { gt: now } },
      select: { id: true },
    })
    if (grantExtended) {
      result.skippedStillActive += 1
      continue
    }

    const expiryLabel = (m.grantExpireAt ?? m.endAt).toISOString()
    try {
      const cleared = await prisma.$transaction(async (tx: Db) => {
        const r = await expireGrant(tx, {
          merchantId: m.merchantId,
          remark: `会员到期，赠积分清零（到期时间 ${expiryLabel}）`,
        })
        // 标记该商户所有已到期会员为 EXPIRED，同时作为「已处理」幂等标记
        await tx.membership.updateMany({
          where: { merchantId: m.merchantId, status: 'ACTIVE', endAt: { lte: now } },
          data: { status: 'EXPIRED' },
        })
        return r.expired
      })
      result.merchantsExpired += 1
      result.beansCleared += cleared
      if (cleared > 0n) {
        console.log(`[grant-expiry] 商户 ${m.merchantId} 会员到期，清零赠积分 ${cleared}`)
      }
    } catch (e) {
      // 单个商户失败不影响其余：事务已回滚，下次扫描会重试
      console.error(`[grant-expiry] 商户 ${m.merchantId} 清零失败:`, (e as Error).message)
    }
  }
  return result
}

// ──────────────────────── 调度器（照抄 membership-reminder 骨架） ────────────────────────

const SWEEP_INTERVAL_MS = Math.max(60_000, Number(process.env.GRANT_EXPIRY_SWEEP_MS ?? 3_600_000))
let timer: NodeJS.Timeout | undefined

let running = false
async function tick(prisma: PrismaClient): Promise<void> {
  if (running) return // 上一轮未结束则跳过本轮，避免叠加
  running = true
  try {
    const r = await scanGrantExpiry(prisma)
    if (r.merchantsExpired > 0 || r.skippedStillActive > 0) {
      console.log(
        `[grant-expiry] 扫描 ${r.scanned} 条，清零 ${r.merchantsExpired} 商户 / ${r.beansCleared} 积分，跳过续期 ${r.skippedStillActive} 商户`,
      )
    }
  } catch (e) {
    console.error('[grant-expiry] 扫描失败:', (e as Error).message)
  } finally {
    running = false
  }
}

export function startGrantExpirySweeper(prisma: PrismaClient): void {
  if (timer) return
  void tick(prisma) // 启动时先跑一轮
  timer = setInterval(() => void tick(prisma), SWEEP_INTERVAL_MS)
  timer.unref()
  console.log(`[grant-expiry] started (interval=${SWEEP_INTERVAL_MS}ms)`)
}

export function stopGrantExpirySweeper(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
