// 业务错误 → HTTP 业务码 映射
// 前端 request.ts 的 ERROR_TEXT 对应这里的 code
import type { NextFunction, Request, Response } from 'express'
import { BeanNotEnoughError } from '../bean/bean.service.js'
import { ScenePendingError } from '../ai/ai.service.js'
import { WxApiError } from '../auth/wechat.js'
import { SmsCodeInvalidError, SmsDailyLimitError, SmsSendTooFrequentError } from '../auth/sms.js'
import { StoreLimitError, StoreDefaultDeleteError } from '../services/store.service.js'
import { DishStoreMismatchError } from '../services/dish.service.js'
import { SubscriptionRequiredError, StorageQuotaExceededError } from '../services/subscription.service.js'
import { fail } from './result.js'
import { RequestConflictError } from '../domain/request.js'

export interface MappedError {
  code: number
  message: string
  httpStatus: number
}

function mapError(e: unknown): MappedError {
  if (e instanceof BeanNotEnoughError) return { code: 2001, message: '积分不足', httpStatus: 400 }
  if (e instanceof ScenePendingError) return { code: 2002, message: '请求进行中或已失败，请使用新的 requestId 重试', httpStatus: 409 }
  if (e instanceof RequestConflictError) return { code: 2007, message: e.message, httpStatus: 409 }
  if (e instanceof WxApiError) return { code: 5001, message: `微信登录失败：${e.message}`, httpStatus: 502 }
  if (e instanceof SmsSendTooFrequentError) return { code: 1003, message: `验证码发送过于频繁，请 ${e.cooldownSec}s 后再试`, httpStatus: 429 }
  if (e instanceof SmsDailyLimitError) return { code: 1003, message: `今日验证码次数已达上限（${e.limit}）`, httpStatus: 429 }
  if (e instanceof SmsCodeInvalidError) return { code: 1002, message: '验证码错误或已过期', httpStatus: 400 }
  if (e instanceof StoreLimitError) return { code: 2003, message: e.message, httpStatus: 400 }
  if (e instanceof StoreDefaultDeleteError) return { code: 2003, message: e.message, httpStatus: 400 }
  if (e instanceof DishStoreMismatchError) return { code: 2004, message: e.message, httpStatus: 400 }
  if (e instanceof SubscriptionRequiredError) return { code: 2005, message: e.message, httpStatus: 403 }
  if (e instanceof StorageQuotaExceededError) return { code: 4008, message: e.message, httpStatus: 400 }
  const msg = e instanceof Error ? e.message : '未知错误'
  return { code: 5001, message: msg, httpStatus: 500 }
}

/** 全局错误处理器：必须注册在路由之后 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const m = mapError(err)
  fail(res, m.code, m.message, m.httpStatus)
}
