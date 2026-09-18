import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

export type RequestDb = PrismaClient | Prisma.TransactionClient

/** Stable JSON representation used for detecting requestId payload reuse. */
export function canonicalize(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`
}

export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}

export class RequestConflictError extends Error {
  readonly code = 'REQUEST_PAYLOAD_CONFLICT'
  constructor() {
    super('requestId 已被用于不同的业务参数')
    this.name = 'RequestConflictError'
  }
}

export interface ClaimInput {
  merchantId: bigint
  operation: string
  requestId: string
  payload: unknown
  resourceType?: string
  resourceId?: bigint
}

/** Atomically claim a business request. A requestId can only represent one payload per tenant/operation.
 *
 * ★ 调用方必须让事务跑在 READ COMMITTED 下（见下面 P2002 分支的说明）。
 *   用 MySQL 默认的 REPEATABLE READ 会在「并发同 requestId」时静默出错。
 */
export async function claimBusinessRequest(db: RequestDb, input: ClaimInput) {
  const hash = payloadHash(input.payload)
  const where = {
    merchantId_operation_requestId: {
      merchantId: input.merchantId,
      operation: input.operation,
      requestId: input.requestId,
    },
  } as const
  const existing = await db.businessRequest.findUnique({ where })
  if (existing) {
    if (existing.payloadHash !== hash) throw new RequestConflictError()
    return { created: false, row: existing, hash }
  }
  try {
    const row = await db.businessRequest.create({
      data: {
        merchantId: input.merchantId,
        operation: input.operation,
        requestId: input.requestId,
        payloadHash: hash,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      },
    })
    return { created: true, row, hash }
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e
    // 输家在这里必须能读到赢家刚提交的那一行。
    //
    // 反面教材（原实现）：REPEATABLE READ 下事务内第一条一致读（上面的 findUnique）就把快照定死，
    // 赢家是在我们读完之后才提交的，于是**同事务里再 findUnique 依然返回 null** → 走 `throw e`
    // 把 P2002 重新抛出去 → 上层映射成 500。
    // 实测（8 并发同 requestId）：1 个 200 + 7 个 500「提交合成失败」，数据虽正确但客户端看到的是失败。
    //
    // 因此这里依赖调用方使用 READ COMMITTED（每条语句取新快照）。当前调用方：
    //   - services/render.service.ts :: submitRender
    //   - ai/ai.service.ts            :: runScene
    // 新增调用方时请一并设置 isolationLevel，否则并发重放会退化成 5xx。
    const row = await db.businessRequest.findUnique({ where })
    if (!row) throw e
    if (row.payloadHash !== hash) throw new RequestConflictError()
    return { created: false, row, hash }
  }
}

export async function completeBusinessRequest(
  db: RequestDb,
  merchantId: bigint,
  operation: string,
  requestId: string,
  resultRef?: string,
) {
  await db.businessRequest.updateMany({
    where: { merchantId, operation, requestId },
    data: { status: 'COMPLETED', resultRef, errorCode: null, errorMsg: null },
  })
}

export async function failBusinessRequest(
  db: RequestDb,
  merchantId: bigint,
  operation: string,
  requestId: string,
  errorCode: string,
  errorMsg: string,
) {
  await db.businessRequest.updateMany({
    where: { merchantId, operation, requestId },
    data: { status: 'FAILED', errorCode, errorMsg: errorMsg.slice(0, 500) },
  })
}

// ────────────────────────────── 请求租约（与 render_task 同一套语义） ──────────────────────────────
//
// 为什么 AI 路径也需要租约：
//   claimBusinessRequest + bean.freeze 是原子的，所以「进程在 freeze 前退出」没问题。
//   但「进程在 freeze 已提交、结算尚未执行」之间退出就会留下一个死结：
//     · 该 requestId 的重放看到 PENDING 且没有 AiCallLog → 抛 ScenePendingError，
//       既不能继续推进，也不会释放预留（调用方只能换 requestId 重试，而旧预留永远冻结）；
//     · 渲染 sweeper 只管 render_task，不认 business_request。
//   结果是积分静默永久冻结，且库里看起来完全正常。租约让「无主的 PENDING」变得可识别、可回收。

/**
 * 抢占/接管请求租约。
 *
 * `onlyIfExpired=false`：无条件抢占（仅用于**刚刚创建**的那一行，此时不存在竞争者）。
 * `onlyIfExpired=true` ：只在租约为空或已过期时接管 —— 这是恢复扫描用的形态。
 *
 * 实现是「先读 id/version，再按 version 做条件更新」的 CAS：两个进程同时读到 version=0，
 * 只有先提交的那条 update 命中（count=1），另一条 count=0 → 拿不到租约。
 * 因此调用方**必须**按返回值判断，绝不能假定自己一定拿到了。
 */
export async function acquireRequestLease(
  db: RequestDb,
  args: {
    merchantId: bigint
    operation: string
    requestId: string
    owner: string
    ttlMs: number
    now?: Date
    onlyIfExpired?: boolean
  },
): Promise<{ acquired: boolean; version: number | null }> {
  const now = args.now ?? new Date()
  const where: Prisma.BusinessRequestWhereInput = {
    merchantId: args.merchantId,
    operation: args.operation,
    requestId: args.requestId,
    status: 'PENDING',
  }
  if (args.onlyIfExpired) {
    where.OR = [{ leaseExpireAt: null }, { leaseExpireAt: { lt: now } }]
  }
  const row = await db.businessRequest.findFirst({ where, select: { id: true, leaseVersion: true } })
  if (!row) return { acquired: false, version: null }
  const upd = await db.businessRequest.updateMany({
    where: { id: row.id, leaseVersion: row.leaseVersion },
    data: {
      leaseOwner: args.owner,
      leaseExpireAt: new Date(now.getTime() + args.ttlMs),
      leaseVersion: { increment: 1 },
    },
  })
  if (upd.count === 0) return { acquired: false, version: null }
  return { acquired: true, version: row.leaseVersion + 1 }
}

/** 续租。只有仍持有同一 version 的执行者能续；返回 false 表示已失权，必须立即停止后续副作用。 */
export async function renewRequestLease(
  db: RequestDb,
  args: { merchantId: bigint; operation: string; requestId: string; owner: string; version: number; ttlMs: number; now?: Date },
): Promise<boolean> {
  const now = args.now ?? new Date()
  const upd = await db.businessRequest.updateMany({
    where: {
      merchantId: args.merchantId,
      operation: args.operation,
      requestId: args.requestId,
      status: 'PENDING',
      leaseOwner: args.owner,
      leaseVersion: args.version,
    },
    data: { leaseExpireAt: new Date(now.getTime() + args.ttlMs) },
  })
  return upd.count === 1
}

/** 释放租约（正常结束时清空，便于区分「已完成」与「无主残留」） */
export async function releaseRequestLease(
  db: RequestDb,
  args: { merchantId: bigint; operation: string; requestId: string; owner: string; version: number },
): Promise<void> {
  await db.businessRequest.updateMany({
    where: {
      merchantId: args.merchantId,
      operation: args.operation,
      requestId: args.requestId,
      leaseOwner: args.owner,
      leaseVersion: args.version,
    },
    data: { leaseOwner: null, leaseExpireAt: null },
  })
}
