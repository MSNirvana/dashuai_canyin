// JWT 鉴权中间件：解析 access token，注入 merchantId / merchantPhone
import type { NextFunction, Request, Response } from 'express'
import { verifyToken, type AccessTokenPayload } from '../lib/jwt.js'
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
    const merchant = await prisma.merchant.findUnique({ where: { id: BigInt(p.mid) }, select: { status: true } })
    if (!merchant || merchant.status !== 'ACTIVE') throw new Error('merchant unavailable')
    req.merchantId = BigInt(p.mid)
    req.merchantPhone = p.phone
    next()
  } catch {
    fail(res, 1001, '登录已过期，请重新登录', 401)
  }
}
