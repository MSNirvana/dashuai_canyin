// 统一响应信封：前端 request.ts 依赖 { code:0, message, data, traceId }
import type { Response } from 'express'
import { randomUUID } from 'node:crypto'

export interface ApiEnvelope<T = unknown> {
  code: number
  message: string
  data?: T
  traceId: string
}

export function traceId(): string {
  return randomUUID()
}

/** 成功响应 */
export function ok<T>(res: Response, data: T, message = 'ok'): void {
  const t = (res.locals.traceId as string) || traceId()
  res.json({ code: 0, message, data, traceId: t } satisfies ApiEnvelope<T>)
}

/** 失败响应（code 为业务码，httpStatus 为 HTTP 状态） */
export function fail(
  res: Response,
  code: number,
  message: string,
  httpStatus = 400,
): void {
  const t = (res.locals.traceId as string) || traceId()
  res.status(httpStatus).json({ code, message, traceId: t } satisfies ApiEnvelope)
}
