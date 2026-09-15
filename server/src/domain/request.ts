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
