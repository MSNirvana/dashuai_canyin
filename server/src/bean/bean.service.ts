// 积分账务核心
// 两阶段模型：FREEZE（预留）→ CONSUME（结算扣减）/ UNFREEZE（释放）
// 三条铁律：
//   1. 幂等 —— (request_id, type) 唯一索引，重复提交直接返回首次结果
//   2. 原子 —— 行锁 SELECT ... FOR UPDATE + 事务，绝不先读后写
//   3. 顺序 —— 赠积分优先消耗，不足部分用充值积分

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
    super(`积分不足：需要 ${required}，可用 ${available}`)
    this.name = 'BeanNotEnoughError'
  }
}

interface AccountRow {
  id: bigint
  merchant_id: bigint
  balance: bigint
  grant_balance: bigint
  grant_register_balance: bigint
  frozen: bigint
}

export function availableOf(a: {
  balance: bigint
  grantBalance: bigint
  /** 注册赠积分桶；老调用点可能没带这个字段，按 0 处理保持向后兼容 */
  grantRegisterBalance?: bigint
  frozen: bigint
}): bigint {
  return a.balance + a.grantBalance + (a.grantRegisterBalance ?? 0n) - a.frozen
}

/** 取账户并加行锁；不存在则创建 */
async function lockAccount(tx: Db, merchantId: bigint): Promise<AccountRow> {
  await tx.$executeRaw`INSERT IGNORE INTO bean_account (merchant_id) VALUES (${merchantId})`
  const rows = await tx.$queryRaw<AccountRow[]>`
    SELECT id, merchant_id, balance, grant_balance, grant_register_balance, frozen
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
    /** 本行 amount 中来自赠积分桶的绝对数量（>=0）；见 schema.prisma 的说明 */
    grantAmount?: bigint
    /** 上一项中来自「注册赠积分」桶的部分（会员赠积分用量 = grantAmount - grantRegisterAmount） */
    grantRegisterAmount?: bigint
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
  // 防御：grantAmount 是「绝对数量」，负数说明调用方语义写错（例如直接传了带符号的 amount）
  const grantAmount = data.grantAmount ?? 0n
  const grantRegisterAmount = data.grantRegisterAmount ?? 0n
  if (grantAmount < 0n) throw new Error(`writeLedger grantAmount 必须为非负数，收到 ${grantAmount}`)
  if (grantRegisterAmount < 0n) throw new Error(`writeLedger grantRegisterAmount 必须为非负数，收到 ${grantRegisterAmount}`)
  if (grantRegisterAmount > grantAmount) {
    throw new Error(`writeLedger grantRegisterAmount(${grantRegisterAmount}) 不能超过 grantAmount(${grantAmount})`)
  }
  if (grantAmount > (data.amount < 0n ? -data.amount : data.amount)) {
    throw new Error(`writeLedger grantAmount(${grantAmount}) 超过 amount(${data.amount}) 的绝对值`)
  }
  await tx.beanLedger.create({
    data: {
      merchantId: data.merchantId,
      type: data.type,
      bucket: data.bucket ?? 'RECHARGE',
      amount: data.amount,
      grantAmount,
      grantRegisterAmount,
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

/**
 * 查找预留。
 * 关键约束：只要带了 requestId，就必须按 (merchantId, bizType, requestId) 精确匹配。
 * 不能再用 bizId 兜底——否则同一创作「重新生成文案/分镜」时会命中上一次的预留，
 * 导致第二次不再冻结、结算时又拿旧预留去扣（consume/unfreeze exceeds business reservation）。
 * bizId 兜底仅用于没有 requestId 的历史/匿名流程。
 */
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
    return null
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
      available: acc.balance + acc.grant_balance + acc.grant_register_balance - acc.frozen,
      reservationId: existing.id,
    }
  }
  const dup = await findLedger(tx, args.merchantId, bizType, args.requestId, 'FREEZE')
  if (dup) {
    throw new Error('FREEZE 流水已存在但缺少积分预留记录')
  }
  const available = acc.balance + acc.grant_balance + acc.grant_register_balance - acc.frozen
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
      remark: args.remark ?? `预留 ${args.amount} 积分`,
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
  /** 本次消耗中来自赠积分桶的绝对数量（会员赠积分 + 注册赠积分；0 表示全部来自充值积分） */
  grantUsed: bigint
  /** 上一项中来自「注册赠积分」桶的部分 */
  grantRegisterUsed: bigint
  balanceAfter: bigint
  /** 剩余赠积分总量（会员桶 + 注册桶） */
  grantAfter: bigint
}

/** 结算扣减：赠积分优先，不足部分用充值积分。幂等：同一 (requestId, CONSUME) 只执行一次 */
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
      grantUsed: dup.grantAmount,
      grantRegisterUsed: dup.grantRegisterAmount,
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

  // 消耗顺序（对用户有利：先用会作废的，再用永久的，最后动充值积分）：
  //   会员赠积分 grant_balance（会员到期会清零）→ 注册赠积分 grant_register_balance（永久）→ 充值积分 balance
  const min = (a: bigint, b: bigint) => (a < b ? a : b)
  const membershipUsed: bigint = min(acc.grant_balance, args.amount)
  const afterMembership: bigint = args.amount - membershipUsed
  const registerUsed: bigint = min(acc.grant_register_balance, afterMembership)
  const rechargeUsed: bigint = afterMembership - registerUsed
  const grantUsed: bigint = membershipUsed + registerUsed
  const available = acc.balance + acc.grant_balance + acc.grant_register_balance - acc.frozen
  if (acc.balance < rechargeUsed) throw new BeanNotEnoughError(args.amount, available)
  // 主桶只标「是否含充值积分」，保持既有 GRANT/RECHARGE 二值语义（前端 Tag 颜色依赖它）
  const bucket: BeanBucket = grantUsed > 0n && rechargeUsed === 0n ? 'GRANT' : 'RECHARGE'
  const grantAfter = acc.grant_balance - membershipUsed
  const grantRegisterAfter = acc.grant_register_balance - registerUsed
  const balanceAfter = acc.balance - rechargeUsed
  const frozenAfter = acc.frozen - args.amount

  await tx.beanAccount.update({
    where: { merchantId: args.merchantId },
    data: {
      balance: balanceAfter,
      grantBalance: grantAfter,
      grantRegisterBalance: grantRegisterAfter,
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
    // ★ P2-1：bucket 只能标一个主桶，混合消费时必须把赠积分用量单独留痕，
    //   否则「这次消耗里有多少赠积分」永久丢失（用户账单 + 赠积分统计都会失真）。
    grantAmount: grantUsed,
    // 赠积分内部再分来源，这样「会员赠积分被吃掉了多少」可审计（= grantAmount - grantRegisterAmount）
    grantRegisterAmount: registerUsed,
    balanceAfter,
    grantAfter: grantAfter + grantRegisterAfter,
    frozenAfter,
    bizType: args.bizType,
    bizId: args.bizId,
    requestId: args.requestId,
    remark: args.remark ?? `消耗 ${args.amount} 积分`,
  })

  return {
    duplicated: false,
    charged: args.amount,
    bucket,
    grantUsed,
    grantRegisterUsed: registerUsed,
    balanceAfter,
    grantAfter: grantAfter + grantRegisterAfter,
  }
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
    grantAfter: acc.grant_balance + acc.grant_register_balance,
    frozenAfter,
    bizType: args.bizType,
    bizId: args.bizId,
    requestId: args.requestId,
    remark: args.remark ?? `释放 ${release} 积分`,
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
    grantAfter: acc.grant_balance + acc.grant_register_balance,
    frozenAfter: acc.frozen,
    bizType: 'ORDER',
    bizId: args.bizId,
    requestId: args.bizId ? `order:${args.bizId}` : undefined,
    remark: args.remark ?? `充值 ${args.amount} 积分`,
  })
  return { balanceAfter }
}

/** 赠积分来源：决定进哪个桶，也就决定了会不会随会员到期被清零 */
export type GrantSource = 'MEMBERSHIP' | 'REGISTER'

export interface GrantResult {
  duplicated: boolean
  /** 剩余赠积分总量（会员桶 + 注册桶） */
  grantAfter: bigint
  membershipAfter: bigint
  registerAfter: bigint
}

/**
 * 发放赠积分，按来源记入**不同的桶**：
 *   - MEMBERSHIP：会员周期赠积分，随会员到期清零（grant-expiry 调度）
 *   - REGISTER  ：注册赠积分，拉新奖励，永久有效，**不参与到期清零**
 *
 * 幂等：同一 (bizType, requestId, GRANT) 只发一次。注册赠积分尤其依赖这个 ——
 * 首登并发（同一用户两个端同时登录）时不能重复发放。
 */
export async function grant(
  tx: Db,
  args: { merchantId: bigint; amount: bigint; bizId?: string; remark?: string; source?: GrantSource },
): Promise<GrantResult> {
  const source: GrantSource = args.source ?? 'MEMBERSHIP'
  const isRegister = source === 'REGISTER'
  const bizType = isRegister ? 'REGISTER' : 'MEMBERSHIP'
  const requestId = args.bizId ? `${isRegister ? 'register' : 'membership'}:${args.bizId}` : undefined

  const dup = await findLedger(tx, args.merchantId, bizType, requestId, 'GRANT')
  if (dup) {
    const cur = await lockAccount(tx, args.merchantId)
    return {
      duplicated: true,
      grantAfter: cur.grant_balance + cur.grant_register_balance,
      membershipAfter: cur.grant_balance,
      registerAfter: cur.grant_register_balance,
    }
  }

  const acc = await lockAccount(tx, args.merchantId)
  const membershipAfter = isRegister ? acc.grant_balance : acc.grant_balance + args.amount
  const registerAfter = isRegister ? acc.grant_register_balance + args.amount : acc.grant_register_balance
  await tx.beanAccount.update({
    where: { merchantId: args.merchantId },
    data: {
      grantBalance: membershipAfter,
      grantRegisterBalance: registerAfter,
      totalGrant: { increment: args.amount },
      version: { increment: 1 },
    },
  })
  await writeLedger(tx, {
    merchantId: args.merchantId,
    type: 'GRANT',
    amount: args.amount,
    bucket: 'GRANT',
    grantAmount: args.amount,
    grantRegisterAmount: isRegister ? args.amount : 0n,
    balanceAfter: acc.balance,
    grantAfter: membershipAfter + registerAfter,
    frozenAfter: acc.frozen,
    bizType,
    bizId: args.bizId,
    requestId,
    remark: args.remark ?? (isRegister ? `注册赠送 ${args.amount} 积分` : `会员赠送 ${args.amount} 积分`),
  })
  return { duplicated: false, grantAfter: membershipAfter + registerAfter, membershipAfter, registerAfter }
}

/**
 * 会员赠积分到期清零（会员到期定时任务调用）。
 *
 * ★ 只清**会员桶**（grant_balance）。注册赠积分在 grant_register_balance，原样保留 ——
 *   拉新时承诺「送 30 积分试用」，不该在 30 天后随会员一起作废。
 *   原实现清空整个赠积分池，会把注册赠积分一起清掉（靠分桶才可能修对：消耗是池化的，
 *   没有批次概念，所以「账上还剩多少注册赠积分」无法从历史流水反推）。
 */
export async function expireGrant(tx: Db, args: { merchantId: bigint; remark?: string }) {
  const acc = await lockAccount(tx, args.merchantId)
  if (acc.grant_balance <= 0n) return { expired: 0n, preserved: acc.grant_register_balance }
  const expired = acc.grant_balance
  await tx.beanAccount.update({
    where: { merchantId: args.merchantId },
    data: { grantBalance: 0n, version: { increment: 1 } },
  })
  await writeLedger(tx, {
    merchantId: args.merchantId,
    type: 'EXPIRE',
    amount: -expired,
    bucket: 'GRANT',
    grantAmount: expired,
    grantRegisterAmount: 0n, // 清的是会员赠积分，不含注册赠积分
    balanceAfter: acc.balance,
    grantAfter: acc.grant_register_balance, // 剩余赠积分 = 注册桶（未被清）
    frozenAfter: acc.frozen,
    bizType: 'MEMBER_EXPIRE',
    remark: args.remark ?? `会员赠积分到期清零 ${expired}`,
  })
  return { expired, preserved: acc.grant_register_balance }
}

/** 后台手动调账（必填 remark 与 operatorId，全留痕） */
export async function adjust(
  tx: Db,
  args: { merchantId: bigint; amount: bigint; bucket?: BeanBucket; operatorId: bigint; remark: string },
) {
  if (!args.remark) throw new Error('adjust requires remark')
  const acc = await lockAccount(tx, args.merchantId)
  const bucket = args.bucket ?? 'RECHARGE'
  // 后台调账的「赠积分」一律进**会员桶**（会随会员到期清零）；注册桶只由注册路径写入。
  // 这样运营手动补的赠积分不会变成永久余额，口径与「赠送」按钮的语义一致。
  const balanceAfter = bucket === 'RECHARGE' ? acc.balance + args.amount : acc.balance
  const membershipAfter = bucket === 'GRANT' ? acc.grant_balance + args.amount : acc.grant_balance
  if (balanceAfter < 0n || membershipAfter < 0n) throw new Error('adjust would make balance negative')
  const grantAfter = membershipAfter + acc.grant_register_balance

  await tx.beanAccount.update({
    where: { merchantId: args.merchantId },
    data: { balance: balanceAfter, grantBalance: membershipAfter, version: { increment: 1 } },
  })
  await writeLedger(tx, {
    merchantId: args.merchantId,
    type: 'ADJUST',
    amount: args.amount,
    bucket,
    grantAmount: bucket === 'GRANT' ? (args.amount < 0n ? -args.amount : args.amount) : 0n,
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
  const grantMembershipBalance = acc.grantBalance
  const grantRegisterBalance = acc.grantRegisterBalance
  return {
    balance: acc.balance,
    // 对外仍以「赠积分总量」表达（会员桶 + 注册桶）。
    // 若这里只给会员桶，而 available 含两桶，客户端会出现「赠积分 0 / 可用 30」这种自相矛盾的界面。
    grantBalance: grantMembershipBalance + grantRegisterBalance,
    /** 会员桶（会随会员到期清零） */
    grantMembershipBalance,
    /** 注册桶（永久有效） */
    grantRegisterBalance,
    frozen: acc.frozen,
    available: availableOf(acc),
  }
}
