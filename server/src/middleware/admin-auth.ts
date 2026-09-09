// 后台管理员鉴权中间件：校验 admin token（typ='admin'）
import type { NextFunction, Request, Response } from 'express'
import { verifyToken, type AdminTokenPayload } from '../lib/jwt.js'
import { fail } from '../lib/result.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminId?: bigint
      adminUsername?: string
    }
  }
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['authorization']
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    fail(res, 1001, '未登录', 401)
    return
  }
  try {
    const p = verifyToken<AdminTokenPayload>(header.slice(7))
    if (p.typ !== 'admin') throw new Error('not an admin token')
    req.adminId = BigInt(p.aid)
    req.adminUsername = p.username
    next()
  } catch {
    fail(res, 1001, '登录已过期或无权访问', 401)
  }
}
