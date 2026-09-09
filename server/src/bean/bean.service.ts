// AI豆账务核心
// 两阶段模型：FREEZE（预留）→ CONSUME（结算扣减）/ UNFREEZE（释放）
// 三条铁律：
//   1. 幂等 —— (request_id, type) 唯一索引，重复提交直接返回首次结果
//   2. 原子 —— 行锁 SELECT ... FOR UPDATE + 事务，绝不先读后写
//   3. 顺序 —— 赠豆优先消耗，不足部分用充值豆

import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

export type Db = PrismaClient | Prisma.TransactionClient

export type BeanBucket = 'GRANT' | 'RECHARGE'
export type LedgerType =
  | 'RECHARGE'
  | 'GRANT'
  | 'FREEZE'
  | 'CONSUME'
  | 'UNFREEZE'
  | 'EXPIRE'
  | 'REFUND'
  | 'ADJUST'

export class BeanNotEnoughError extends Error {
  readonly code = 'BEAN_NOT_ENOUGH'
  constructor(
    readonly required: bigint,
    readonly available: bigint,
  ) {
    super(`AI豆不足：需要 ${required}，可用 ${available}`)
    this.name = 'BeanNotEnoughError'
  }
}

interface AccountRow {
  id: bigint
  merchant_id: bigint
  balance: bigint
  grant_balance: bigint
  frozen: bigint
}

export function availableOf(a: { balance: bigint; grantBalance: bigint; frozen: bigint }): bigint {
  return a.balance + a.grantBalance - a.frozen
}

/** 取账户并加行锁；不存在则创建 */
async function lockAccount(tx: Db, merchantId: bigint): Promise<AccountRow> {
  await tx.$executeRaw`INSERT IGNORE INTO bean_account (merchant_id) VALUES (${merchantId})`
  const rows = await tx.$queryRaw<AccountRow[]>`
    SELECT id, merchant_id, balance, grant_balance, frozen
    FROM bean_account WHERE merchant_id = ${merchantId} FOR UPDATE`
  const row = rows[0]
  if (!row) throw new Error(`bean_account lock failed for merchant ${merchantId}`)
  return row
}

async function writeLedger(
  tx: Db,
  data: {
    merchantId: bigint
    type: LedgerType
    amount: bigint
    bucket?: BeanBucket
    balanceAfter: bigint
    grantAfter: bigint
    frozenAfter: bigint
    bizType?: string
    bizId?: string
    requestId?: string
    remark?: string
    operatorId?: bigint
  },
) {
  await tx.beanLedger.create({
    data: {
      merchantId: data.merchantId,
      type: data.type,
      bucket: data.bucket ?? 'RECHARGE',
      amount: data.amount,
      balanceAfter: data.balanceAfter,
      grantAfter: data.grantAfter,
      frozenAfter: data.frozenAfter,
      bizType: data.bizType,
      bizId: data.bizId,
      requestId: data.requestId,
      remark: data.remark,
      operatorId: data.operatorId,
    },
  })
}

async function findLedger(tx: Db, merchantId: bigint, bizType: string | undefined, requestId: string | undefined, type: LedgerType) {
  if (!requestId) return null
  return tx.beanLedger.findFirst({ where: { merchantId, bizType, requestId, type } })
}

async function findReservation(
  tx: Db,
  args: { merchantId: bigint; requestId?: string; bizType?: string; bizId?: string },
) {
  if (args.requestId && args.bizType) {
    const row = await tx.beanReservation.findUnique({
      where: {
        merchantId_bizType_requestId: {
          merchantId: args.merchantId,
          bizType: args.bizType,
          requestId: args.requestId,
        },
      },
    })
    if (row) return row
  }
  if (args.bizId && args.bizType) {
    return tx.beanReservation.findFirst({
      where: { merchantId: args.merchantId, bizType: args.bizType, bizId: args.bizId },
      orderBy: { createdAt: 'desc' },
    })
  }
  return null
}

// ────────────────────────────── 预留 / 结算 / 释放 ──────────────────────────────

export interface FreezeResult {
  duplicated: boolean
  frozen: bigint
  available: bigint
  reservationId: bigint
}

/** 预留额度。幂等：同一 (requestId, FREEZE) 只执行一次 */
export async function freeze(
  tx: Db,
  args: { merchantId: bigint; requestId?: string; amount: bigint; bizType?: string; bizId?: string; remark?: string },
): Promise<FreezeResult> {
  if (args.amount <= 0n) throw new Error('freeze amount must be positive')

  const acc = await lockAccount(tx, args.merchantId)
  const bizType = args.bizType ?? 'UNKNOWN'
  const existing = await findReservation(tx, {
    merchantId: args.merchantId,
    requestId: args.requestId,
    bizType,
    bizId: args.bizId,
  })
  if (existing) {
    return {
      duplicated: true,
      frozen: acc.frozen,
      available: acc.balance + acc.grant_balance - acc.frozen,
      reservationId: existing.id,
    }
  }
  const dup = await findLedger(tx, args.merchantId, bizType, args.requestId, 'FREEZE')
  if (dup) {
    throw new Error('FREEZE 流水已存在但缺少积分预留记录')
  }
  const available = acc.balance + acc.grant_balance - acc.frozen
  if (available < args.amount) {
    throw new BeanNotEnoughError(args.amount, available)
  }

  const frozenAfter = acc.frozen + args.amount
  const reservation = await tx.beanReservation.create({
    data: {
      merchantId: args.merchantId,
      bizType,
      bizId: args.bizId ?? `${args.requestId ?? 'anonymous'}:${Date.now()}`,
      requestId: args.requestId ?? `anonymous:${Date.now()}`,
      reserved: args.amount,
    },
  })
  await tx.beanAccount.update({
    where: { merchantId: args.merchantId },
    data: { frozen: frozenAfter, version: { increment: 1 } },
  })
  try {
    await writeLedger(tx, {
      merchantId: args.merchantId,
      type: 'FREEZE',
      amount: args.amount,
      balanceAfter: acc.balance,
      grantAfter: acc.grant_balance,
      frozenAfter,
      bizType,
      bizId: args.bizId,
      requestId: args.requestId,
      remark: args.remark ?? `预留 ${args.amount} 豆`,
    })
  } catch (e) {
    // reservation/account/ledger are one transaction; any error rolls all changes back.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw e
    }
    throw e
  }

  return { duplicated: false, frozen: frozenAfter, available: available - args.amount, reservationId: reservation.id }
}

export interface ConsumeResult {
  duplicated: boolean
  charged: bigint
  bucket: BeanBucket
  balanceAfter: bigint
  grantAfter: bigint
}

/** 结算扣减：赠豆优先，不足部分用充值豆。幂等：同一 (requestId, CONSUME) 只执行一次 */
export async function consume(
  tx: Db,
  args: { merchantId: bigint; requestId?: string; amount: bigint; bizType?: string; bizId?: string; remark?: string },
): Promise<ConsumeResult> {
  if (args.amount <= 0n) throw new Error('consume amount must be positive')

  const dup = await findLedger(tx, args.merchantId, args.bizType, args.requestId, 'CONSUME')
  if (dup) {
    return {
      duplicated: true,
      charged: BigInt(-dup.amount),
      bucket: dup.bucket === 'GRANT' ? 'GRANT' : 'RECHARGE',
      balanceAfter: BigInt(dup.balanceAfter),
      grantAfter: BigInt(dup.grantAfter),
    }
  }

  const acc = await lockAccount(tx, args.merchantId)
  const reservation = await findReservation(tx, {
    merchantId: args.merchantId,
    requestId: args.requestId,
    bizType: args.bizType,
    bizId: args.bizId,
  })
  if (!reservation) throw new Error('consume 找不到对应积分预留')
  const remaining = reservation.reserved - reservation.consumed - reservation.released
  if (remaining < args.amount) throw new Error('consume exceeds business reservation')
  if (acc.frozen < args.amount) throw new Error(`consume(${args.amount}) exceeds frozen(${acc.frozen})，请先 freeze`)

  const grantUsed: bigint = acc.grant_balance < args.amount ? acc.grant_balance : args.amount
  const rechargeUsed: bigint = args.amount - grantUsed
  if (acc.balance < rechargeUsed) throw new BeanNotEnoughError(args.amount, acc.balance + acc.grant_balance - acc.frozen)
  const bucket: BeanBucket = grantUsed > 0n && rechargeUsed === 0n ? 'GRANT' : 'RECHARGE'
  const grantAfter = acc.grant_balance - grantUsed
  const balanceAfter = acc.balance - rechargeUsed
  const frozenAfter = acc.frozen - args.amount

  await tx.beanAccount.update({
    where: { merchantId: args.merchantId },
    data: {
      balance: balanceAfter,
      grantBalance: grantAfter,
      frozen: frozenAfter,
      totalConsume: { increment: args.amount },
      version: { increment: 1 },
    },
  })
  const consumedAfter = reservation.consumed + args.amount
  await tx.beanReservation.update({
    where: { id: reservation.id },
    data: {
      consumed: consumedAfter,
      status: consumedAfter + reservation.released >= reservation.reserved ? 'CONSUMED' : 'ACTIVE',
    },
  })
  await writeLedger(tx, {
    merchantId: args.merchantId,
    type: 'CONSUME',
    amount: -args.amount,
    bucket,
    balanceAfter,
    grantAfter,
    frozenAfter,
    bizType: args.bizType,
    bizId: args.bizId,
    requestId: args.requestId,
    remark: args.remark ?? `消耗 ${args.amount} 豆`,
  })

  return { duplicated: false, charged: args.amount, bucket, balanceAfter, grantAfter }
}

/** 释放预留（失败退款）。幂等：同一 (requestId, UNFREEZE) 只执行一次 */
export async function unfreeze(
  tx: Db,
  args: { merchantId: bigint; requestId?: string; amount: bigint; bizType?: string; bizId?: string; remark?: string },
): Promise<{ duplicated: boolean; frozenAfter: bigint }> {
  if (args.amount <= 0n) throw new Error('unfreeze amount must be positive')
  const dup = await findLedger(tx, args.merchantId, args.bizType, args.requestId, 'UNFREEZE')
  if (dup) return { duplicated: true, frozenAfter: BigInt(dup.frozenAfter) }

  const acc = await lockAccount(tx, args.merchantId)
  const reservation = await findReservation(tx, {
    merchantId: args.merchantId,
    requestId: args.requestId,
    bizType: args.bizType,
    bizId: args.bizId,
  })
  if (!reservation) throw new Error('unfreeze 找不到对应积分预留')
  const remainingScoped = reservation.reserved - reservation.consumed - reservation.released
  if (remainingScoped < args.amount) throw new Error('unfreeze exceeds business reservation')
  if (acc.frozen < args.amount) throw new Error('unfreeze exceeds account frozen amount')
  const release = args.amount
  const frozenAfter = acc.frozen - release

  await tx.beanAccount.update({
    where: { merchantId: args.merchantId },
    data: { frozen: frozenAfter, version: { increment: 1 } },
  })
  const releasedAfter = reservation.released + release
  await tx.beanReservation.update({
    where: { id: reservation.id },
    data: {
      released: releasedAfter,
      status: releasedAfter + reservation.consumed >= reservation.reserved ? 'RELEASED' : 'ACTIVE',
    },
  })
  await writeLedger(tx, {
    merchantId: args.merchantId,
    type: 'UNFREEZE',
    amount: -release,
    balanceAfter: acc.balance,
    grantAfter: acc.grant_balance,
    frozenAfter,
    bizType: args.bizType,
    bizId: args.bizId,
    requestId: args.requestId,
    remark: args.remark ?? `释放 ${release} 豆`,
  })

  return { duplicated: false, frozenAfter }
}

// ────────────────────────────── 入账 / 赠送 / 过期 ──────────────────────────────

/** 充值入账（支付回调成功后调用） */
export async function recharge(
  tx: Db,
  args: { merchantId: bigint; amount: bigint; bizId?: string; remark?: string },
) {
  const acc = await lockAccount(tx, args.merchantId)
  const balanceAfter = acc.balance + args.amount
  await tx.beanAccount.update({
    where: { merchantId: args.merchantId },
    data: { balance: balanceAfter, totalRecharge: { increment: args.amount }, version: { increment: 1 } },
  })
  await writeLedger(tx, {
    merchantId: args.merchantId,
    type: 'RECHARGE',
    amount: args.amount,
    bucket: 'RECHARGE',
    balanceAfter,
    grantAfter: acc.grant_balance,
    frozenAfter: acc.frozen,
    bizType: 'ORDER',
    bizId: args.bizId,
    requestId: args.bizId ? `order:${args.bizId}` : undefined,
    remark: args.remark ?? `充值 ${args.amount} 豆`,
  })
  return { balanceAfter }
}

/** 会员周期赠豆（赠豆单独记账，到期清零） */
export async function grant(
  tx: Db,
  args: { merchantId: bigint; amount: bigint; bizId?: string; remark?: string },
) {
  const acc = await lockAccount(tx, args.merchantId)
  const grantAfter = acc.grant_balance + args.amount
  await tx.beanAccount.update({
    where: { merchantId: args.merchantId },
    data: { grantBalance: grantAfter, totalGrant: { increment: args.amount }, version: { increment: 1 } },
  })
  await writeLedger(tx, {
    merchantId: args.merchantId,
    type: 'GRANT',
    amount: args.amount,
    bucket: 'GRANT',
    balanceAfter: acc.balance,
    grantAfter,
    frozenAfter: acc.frozen,
    bizType: 'MEMBERSHIP',
    bizId: args.bizId,
    requestId: args.bizId ? `membership:${args.bizId}` : undefined,
    remark: args.remark ?? `会员赠送 ${args.amount} 豆`,
  })
  return { grantAfter }
}

/** 赠豆到期清零（会员到期定时任务调用） */
export async function expireGrant(tx: Db, args: { merchantId: bigint; remark?: string }) {
  const acc = await lockAccount(tx, args.merchantId)
  if (acc.grant_balance <= 0n) return { expired: 0n }
  await tx.beanAccount.update({
    where: { merchantId: args.merchantId },
    data: { grantBalance: 0n, version: { increment: 1 } },
  })
  await writeLedger(tx, {
    merchantId: args.merchantId,
    type: 'EXPIRE',
    amount: -acc.grant_balance,
    bucket: 'GRANT',
    balanceAfter: acc.balance,
    grantAfter: 0n,
    frozenAfter: acc.frozen,
    bizType: 'MEMBER_EXPIRE',
    remark: args.remark ?? `赠豆到期清零 ${acc.grant_balance}`,
  })
  return { expired: acc.grant_balance }
}

/** 后台手动调账（必填 remark 与 operatorId，全留痕） */
export async function adjust(
  tx: Db,
  args: { merchantId: bigint; amount: bigint; bucket?: BeanBucket; operatorId: bigint; remark: string },
) {
  if (!args.remark) throw new Error('adjust requires remark')
  const acc = await lockAccount(tx, args.merchantId)
  const bucket = args.bucket ?? 'RECHARGE'
  const balanceAfter = bucket === 'RECHARGE' ? acc.balance + args.amount : acc.balance
  const grantAfter = bucket === 'GRANT' ? acc.grant_balance + args.amount : acc.grant_balance
  if (balanceAfter < 0n || grantAfter < 0n) throw new Error('adjust would make balance negative')

  await tx.beanAccount.update({
    where: { merchantId: args.merchantId },
    data: { balance: balanceAfter, grantBalance: grantAfter, version: { increment: 1 } },
  })
  await writeLedger(tx, {
    merchantId: args.merchantId,
    type: 'ADJUST',
    amount: args.amount,
    bucket,
    balanceAfter,
    grantAfter,
    frozenAfter: acc.frozen,
    bizType: 'ADMIN',
    operatorId: args.operatorId,
    requestId: `adjust:${args.merchantId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    remark: args.remark,
  })
  return { balanceAfter, grantAfter }
}

/** 查询余额（含可用额度） */
export async function getBalance(prisma: Db, merchantId: bigint) {
  const acc = await prisma.beanAccount.upsert({
    where: { merchantId },
    create: { merchantId },
    update: {},
  })
  return {
    balance: acc.balance,
    grantBalance: acc.grantBalance,
    frozen: acc.frozen,
    available: availableOf(acc),
  }
}
