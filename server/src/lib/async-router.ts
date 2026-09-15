// 异步路由包装器。
//
// 背景（这次审读实测确认的一个 P0）：Express 4 **不会**接管 async handler 抛出的
// Promise rejection——既不回响应、也不交给错误中间件，最终变成 unhandledRejection。
// 而 Node 15+ 对未处理的 rejection 默认直接退出进程。结果是一条
// `GET /api/v1/stores/abc` 就能让整个后端挂掉（stores.ts 里的 BigInt 解析）。
//
// 处理方式：所有路由统一用 createRouter() 创建，它在注册时把每个 handler 包一层，
// 把同步异常与 Promise rejection 都转交给 next()，从而进入 lib/errors.ts 的 errorHandler，
// 返回正常的 400/500 响应，进程不受影响。
//
// 注意：必须是「注册时包装」，不能靠 patch Router.prototype——因为 index.ts 里路由模块
// 是静态 import，在任何语句执行前就已完成注册。
import { Router, type RequestHandler, type RouterOptions } from 'express'

/* Express 中间件签名无法用严格类型描述，这里统一用宽签名 */
type NextFn = (err?: unknown) => void

/** 包装单个 handler；非函数原样透传（use 的第一个参数可能是路径字符串） */
function wrapOne(h: unknown): unknown {
  if (typeof h !== 'function') return h
  const fn = h as unknown as (
    this: unknown,
    req: unknown,
    res: unknown,
    next: NextFn,
  ) => unknown
  // Express 错误中间件是 4 参 (err, req, res, next)，签名不同，必须原样透传
  if (fn.length >= 4) return h
  return function wrapped(this: unknown, req: unknown, res: unknown, next: NextFn): void {
    try {
      const ret = fn.call(this, req, res, next) as { then?: unknown } | undefined
      if (ret && typeof ret.then === 'function') {
        ;(ret as Promise<unknown>).then(undefined, next)
      }
    } catch (e) {
      next(e)
    }
  }
}

function wrapArgs(args: unknown[]): unknown[] {
  return args.map((a) => (Array.isArray(a) ? a.map(wrapOne) : wrapOne(a)))
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'] as const

/**
 * 与 express 的 Router() 用法完全一致，但注册的 handler 会被自动包装，
 * 保证 async 异常流入全局错误处理器而不是打死进程。
 */
export function createRouter(options?: RouterOptions): Router {
  const router = Router(options as RouterOptions)
  const target = router as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>
  for (const m of METHODS) {
    const orig = target[m]
    if (!orig) continue
    const bound = orig.bind(router)
    target[m] = (...args: unknown[]) => bound(...wrapArgs(args))
  }
  return router
}

/** 给单条路由用（挂载在别处、不走 createRouter 时的兜底） */
export const asyncHandler = (h: RequestHandler): RequestHandler => wrapOne(h) as RequestHandler
