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
//   3. ★ 上述检查**必须在事务内、在拿到商户级锁之后**重新做一遍（见下面循环里的说明）：
//      在事务外判断等于「先看后做」，续费只要插在中间，就会把刚到账的赠积分清掉；
//   4. expireGrant 自身对 grant_balance <= 0 直接返回 0，天然幂等；且只清未被在途预留占用的部分；
//   5. 状态置 EXPIRED 作为「已处理」标记（docs/01 定义的枚举就是 ACTIVE/EXPIRED）。
import type { PrismaClient } from '@prisma/client'
import { expireGrant, lockMerchantAccount, type Db } from '../bean/bean.service.js'

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

    const expiryLabel = (m.grantExpireAt ?? m.endAt).toISOString()
    try {
      // ★★ 所有判断都必须在**拿到商户级锁之后、在事务内**重新做一遍。
      //
      //   反面教材（原实现）：候选扫出来 → 在事务外问「这个商户还有有效会员吗」→
      //   回答「没有了」→ 进事务清零。而「问答」与「进事务」之间是一段真空期，
      //   用户恰好在这段时间完成续费并拿到新一期赠积分 ⇒ 清零事务照旧执行，
      //   把**刚到账的 98000 积分**抹掉。用户付了钱、页面显示续费成功、积分却没了。
      //
      //   锁与 activateMembership 是同一把（bean_account 行锁），因此续费与清零
      //   只能有一个先跑完；后到的那个看到的是对方已提交的结果，判断自然正确。
      const outcome = await prisma.$transaction(async (tx: Db) => {
        await lockMerchantAccount(tx, m.merchantId)

        // 续期保护：锁内重新确认该商户没有有效会员，赠积分才轮得到清零
        const stillActive = await tx.membership.findFirst({
          where: { merchantId: m.merchantId, status: 'ACTIVE', endAt: { gt: now } },
          select: { id: true },
        })
        if (stillActive) return 'SKIPPED' as const
        // 二次保护：万一 grantExpireAt 被单独延长到未来（与 endAt 不一致），也不能清零
        const grantExtended = await tx.membership.findFirst({
          where: { merchantId: m.merchantId, status: 'ACTIVE', grantExpireAt: { gt: now } },
          select: { id: true },
        })
        if (grantExtended) return 'SKIPPED' as const

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
      }, { isolationLevel: 'ReadCommitted' })
      // ↑ READ COMMITTED：锁内那两次「还有有效会员吗」的复查必须是**当前**数据。
      //   REPEATABLE READ 下若事务里先出现别的非锁定 SELECT，读视图会被提前定死，
      //   锁内复查就会拿到续费之前的旧快照 —— 等于没有复查。

      if (outcome === 'SKIPPED') {
        result.skippedStillActive += 1
        continue
      }
      result.merchantsExpired += 1
      result.beansCleared += outcome
      if (outcome > 0n) {
        console.log(`[grant-expiry] 商户 ${m.merchantId} 会员到期，清零赠积分 ${outcome}`)
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
