// 业务错误 → HTTP 业务码 映射
// 前端 request.ts 的 ERROR_TEXT 对应这里的 code
import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { InvalidIdParamError } from './params.js'
import { BeanNotEnoughError } from '../bean/bean.service.js'
import { ScenePendingError } from '../ai/ai.service.js'
import { WxApiError } from '../auth/wechat.js'
import { SmsCodeInvalidError, SmsDailyLimitError, SmsSendTooFrequentError, SmsProviderNotConfiguredError } from '../auth/sms.js'
import { SmsSendFailedError } from '../auth/sms-provider.js'
import { StoreLimitError, StoreDefaultDeleteError } from '../services/store.service.js'
import { DishStoreMismatchError } from '../services/dish.service.js'
import {
  CreationNotFoundError,
  ShotNotFoundError,
  CreationStoreMismatchError,
  CreationDishMismatchError,
  CreationAssetMismatchError,
} from '../services/creation.service.js'
import {
  RenderNoAssetError,
  RenderAlreadyRunningError,
  RenderDurationUnknownError,
  RenderGradeUnavailableError,
} from '../services/render.service.js'
import { SubscriptionRequiredError, StorageQuotaExceededError } from '../services/subscription.service.js'
import {
  PublishMaterialUnavailableError,
  PublishMaterialNotReadyError,
  PublishCoverFailedError,
} from '../services/publish-material.service.js'
import { RemoteImageError } from '../services/remote-asset.service.js'
import { fail } from './result.js'
import { RequestConflictError } from '../domain/request.js'
import { InvalidObjectKeyError } from './object-key.js'

export interface MappedError {
  code: number
  message: string
  httpStatus: number
  /** 未归类的异常：原始信息只进日志，不返回给客户端 */
  unexpected?: boolean
}

function mapError(e: unknown): MappedError {
  // 参数类错误优先：路径/查询/请求体参数非法、zod 校验失败都应返回 400，而不是 500
  if (e instanceof InvalidIdParamError) return { code: 4000, message: '参数不合法', httpStatus: 400 }
  if (e instanceof ZodError) return { code: 4000, message: '参数错误', httpStatus: 400 }
  // 非法对象键（含 `..` 等穿越段）属于入参问题，返回 400 而不是 500
  if (e instanceof InvalidObjectKeyError) return { code: 4000, message: e.message, httpStatus: 400 }
  if (e instanceof BeanNotEnoughError) return { code: 2001, message: '积分不足', httpStatus: 400 }
  if (e instanceof ScenePendingError) return { code: 2002, message: '请求进行中或已失败，请使用新的 requestId 重试', httpStatus: 409 }
  if (e instanceof RequestConflictError) return { code: 2007, message: e.message, httpStatus: 409 }
  if (e instanceof WxApiError) return { code: 5001, message: `微信登录失败：${e.message}`, httpStatus: 502 }
  if (e instanceof SmsSendTooFrequentError) return { code: 1003, message: `验证码发送过于频繁，请 ${e.cooldownSec}s 后再试`, httpStatus: 429 }
  if (e instanceof SmsDailyLimitError) return { code: 1003, message: `今日验证码次数已达上限（${e.limit}）`, httpStatus: 429 }
  if (e instanceof SmsCodeInvalidError) return { code: 1002, message: '验证码错误或已过期', httpStatus: 400 }
  if (e instanceof SmsProviderNotConfiguredError) return { code: 1004, message: e.message, httpStatus: 503 }
  // 通道侧发送失败（余额不足 / 签名模板未过审 / 网络异常）。
  // 刻意不回传 e.reason：它含腾讯云内部错误码与账号状态，对用户无意义，只进服务端日志。
  if (e instanceof SmsSendFailedError) return { code: 1005, message: '短信发送失败，请稍后重试', httpStatus: 502 }
  if (e instanceof StoreLimitError) return { code: 2003, message: e.message, httpStatus: 400 }
  if (e instanceof StoreDefaultDeleteError) return { code: 2003, message: e.message, httpStatus: 400 }
  if (e instanceof DishStoreMismatchError) return { code: 2004, message: e.message, httpStatus: 400 }
  if (e instanceof SubscriptionRequiredError) return { code: 2005, message: e.message, httpStatus: 403 }
  if (e instanceof StorageQuotaExceededError) return { code: 4008, message: e.message, httpStatus: 400 }
  if (e instanceof CreationNotFoundError) return { code: 4046, message: e.message, httpStatus: 404 }
  if (e instanceof ShotNotFoundError) return { code: 4047, message: e.message, httpStatus: 404 }
  if (e instanceof CreationStoreMismatchError) return { code: 2004, message: e.message, httpStatus: 400 }
  if (e instanceof CreationDishMismatchError) return { code: 2004, message: e.message, httpStatus: 400 }
  if (e instanceof CreationAssetMismatchError) return { code: 2004, message: e.message, httpStatus: 400 }
  if (e instanceof RenderGradeUnavailableError) return { code: 4013, message: e.message, httpStatus: 409 }
  if (e instanceof RenderNoAssetError) return { code: 4003, message: e.message, httpStatus: 400 }
  if (e instanceof RenderAlreadyRunningError) return { code: 4001, message: e.message, httpStatus: 409 }
  if (e instanceof RenderDurationUnknownError) return { code: 4009, message: e.message, httpStatus: 400 }
  // ── 发布素材（标题/文案/封面）──
  // 2012：功能未开通（场景没建/停用）—— 部署配置问题，不是用户操作问题，故 503 而非 400
  if (e instanceof PublishMaterialUnavailableError) return { code: 2012, message: e.message, httpStatus: 503 }
  // 2013：前置条件没满足（还没生成过标题与文案就想单独重出封面）
  if (e instanceof PublishMaterialNotReadyError) return { code: 2013, message: e.message, httpStatus: 400 }
  // 2014：出图这次没成功。message 由服务层收敛过（不含图床地址/curl 原文），可以直接回给用户
  if (e instanceof PublishCoverFailedError) return { code: 2014, message: e.message, httpStatus: 502 }
  // ★ RemoteImageError 的 message 里**带图床域名与 curl 原文**（第三方内部信息），
  //   正常路径已在 publish-material.service 里被收成 PublishCoverFailedError，
  //   这里兜住漏网的那种：回一句固定文案，原文只进日志。
  if (e instanceof RemoteImageError) return { code: 2014, message: '封面生成失败，请稍后重试', httpStatus: 502 }
  return { code: 5001, message: '服务器内部错误，请稍后重试', httpStatus: 500, unexpected: true }
}

/** 全局错误处理器：必须注册在路由之后 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const m = mapError(err)
  if (m.unexpected) {
    // 未归类的异常：原始 message / 堆栈只进日志，不回给客户端（可能含 SQL、源码路径）
    const tid = (res.locals.traceId as string) || '-'
    console.error(`[error] traceId=${tid}`, err)
  }
  fail(res, m.code, m.message, m.httpStatus)
}
