// JWT 鉴权中间件：解析 access token，注入 merchantId / merchantPhone
import type { NextFunction, Request, Response } from 'express'
import { verifyToken, type AccessTokenPayload } from '../lib/jwt.js'
import { DemoExpiredError, demoDeadlinePassed } from '../lib/demo-account.js'
import { fail } from '../lib/result.js'
import { prisma } from '../db.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      merchantId?: bigint
      merchantPhone?: string
    }
  }
}

export async function auth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers['authorization']
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    fail(res, 1001, '未登录', 401)
    return
  }
  try {
    const p = verifyToken<AccessTokenPayload>(header.slice(7))
    if (p.typ !== 'access') throw new Error('access token required')
    /**
     * ★★ 演示账号的绝对截止（`dst`）在这里判死 —— 这是「24h 后自动退出」真正生效的地方。
     *
     * 为什么不用等 refresh：refresh 会失败（见 auth.service.ts::refresh），但用户要等到
     * access 过期（2h）才触发刷新，最坏会多活 2 小时。带 `dst` 后到点即死，零延迟。
     *
     * ★ 必须抛**具名**错误并单独捕获：落进下面那个 `catch` 会变成 1001「登录已过期，请重新登录」，
     *   而演示账号重新登录一定失败 ⇒ 用户会陷在「登了就被踢」的死循环里，看不到真正的原因。
     * ★ 判据走纯函数 `demoDeadlinePassed`（demo-account.ts），别在这里重写一遍比较。
     */
    if (demoDeadlinePassed(p.dst)) throw new DemoExpiredError()
    const merchant = await prisma.merchant.findUnique({ where: { id: BigInt(p.mid) }, select: { status: true } })
    if (!merchant || merchant.status !== 'ACTIVE') throw new Error('merchant unavailable')
    req.merchantId = BigInt(p.mid)
    req.merchantPhone = p.phone
    next()
  } catch (e) {
    if (e instanceof DemoExpiredError) {
      fail(res, 1006, e.message, 401)
      return
    }
    fail(res, 1001, '登录已过期，请重新登录', 401)
  }
}
