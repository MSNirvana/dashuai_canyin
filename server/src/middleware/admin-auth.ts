// 后台管理员鉴权中间件：校验 admin token（typ='admin'）
import type { NextFunction, Request, Response } from 'express'
import { verifyToken, type AdminTokenPayload } from '../lib/jwt.js'
import { fail } from '../lib/result.js'
import { prisma } from '../db.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminId?: bigint
      adminUsername?: string
    }
  }
}

/**
 * ★ 除了验签，还必须**回查账号当前状态**。
 *
 * JWT 是无状态的：签发那一刻的信息被烤进 token 里，之后到过期为止都与库无关。
 * 所以只验签时，「把某个管理员停用 / 删号」对**已经签发出去的 token 完全没有效果** ——
 * 一个刚被停用的账号最长还能继续用满整个 token 有效期（默认约 2 小时），
 * 而这几条路由里包含积分调账、AI 供应商密钥、套餐价格这类动作。
 * 「禁用」是个安全动作，它必须当场生效，不能等到 token 自然过期。
 *
 * 与商户侧 `middleware/auth.ts` 用的是同一套判据（那边同样回查
 * `merchant.status !== 'ACTIVE'` 就拒），两边不要把口径走岔。
 *
 * 代价：每个后台请求多一次主键查询。后台流量很小，这个代价可以忽略；
 * 反过来如果为了省这一查加个 30s 缓存，就等于把「禁用即时生效」又打回去了。
 */
export async function adminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers['authorization']
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    fail(res, 1001, '未登录', 401)
    return
  }
  try {
    const p = verifyToken<AdminTokenPayload>(header.slice(7))
    if (p.typ !== 'admin') throw new Error('not an admin token')
    const id = BigInt(p.aid)
    const admin = await prisma.adminUser.findUnique({
      where: { id },
      // 只取需要的列：passwordHash 绝不该离开数据库
      select: { id: true, username: true, status: true },
    })
    // ★ 账号已被删除 / 已停用 ⇒ 一律按「登录失效」处理，并且**不带任何细节**返回。
    //   区分「不存在」与「已停用」等于告诉攻击者哪个账号名是真的。
    if (!admin || admin.status !== 'ACTIVE') throw new Error('admin unavailable')
    req.adminId = admin.id
    // 用库里的用户名而不是 token 里的：改名之后 token 里的旧名不该继续被信任
    req.adminUsername = admin.username
    next()
  } catch {
    fail(res, 1001, '登录已过期或无权访问', 401)
  }
}
