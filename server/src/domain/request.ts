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

/** Atomically claim a business request. A requestId can only represent one payload per tenant/operation. */
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
