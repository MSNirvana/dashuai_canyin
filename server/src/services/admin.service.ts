// 后台管理服务：管理员登录（单角色全权限）
import type { PrismaClient } from '@prisma/client'
import { hashPassword, verifyPassword } from '../lib/password.js'
import { signAdmin } from '../lib/jwt.js'

export class AdminLoginFailedError extends Error {
  constructor() {
    super('用户名或密码错误')
    this.name = 'AdminLoginFailedError'
  }
}

export class OldPasswordMismatchError extends Error {
  constructor() {
    // 与登录失败同一个措辞口径：**不区分**「账号不存在」与「密码错误」，
    // 避免给摸索接口的人一个可用的账号名探测器。这里调用方已通过 adminAuth，
    // 账号必然存在，措辞只剩告知作用 —— 但保持一致没有坏处。
    super('原密码不正确')
    this.name = 'OldPasswordMismatchError'
  }
}

export async function adminLogin(
  prisma: PrismaClient,
  username: string,
  password: string,
): Promise<{ token: string; admin: { id: string; username: string; displayName: string | null } }> {
  const u = await prisma.adminUser.findUnique({ where: { username } })
  if (!u || u.status !== 'ACTIVE' || !verifyPassword(password, u.passwordHash)) {
    throw new AdminLoginFailedError()
  }
  await prisma.adminUser.update({ where: { id: u.id }, data: { lastLoginAt: new Date() } })
  return {
    token: signAdmin(u.username, u.id),
    admin: { id: u.id.toString(), username: u.username, displayName: u.displayName },
  }
}

/**
 * 管理员修改自己的密码。
 *
 * ★ 已签发的 JWT **不会**因此失效（无状态，2h 自然过期）。这是刻意接受的取舍：
 *   给 AdminUser 加 `passwordChangedAt` 并在 adminAuth 里比对，需要一次 schema 迁移
 *   （走 db-baseline 部署链），而本后台只有一个全权限账号、token 有效期仅 2h ——
 *   收益配不上迁移成本。前端在改成功后**立即登出**，把「当前会话继续有效」这个窗口
 *   收敛到「操作者自己的下一个动作」。
 *
 * ★ 旧密码验证**没有**接登录限速：能打到这个接口的前提是已持有效 token，
 *   而拿到 token 本身已经等价于拿到后台。若未来要做「token 泄露后的纵深防御」，
 *   在这里复用 login-throttle 的 adminUserKey 即可。
 */
export async function adminChangePassword(
  prisma: PrismaClient,
  adminId: bigint,
  input: { oldPassword: string; newPassword: string },
): Promise<void> {
  const u = await prisma.adminUser.findUnique({ where: { id: adminId } })
  if (!u || u.status !== 'ACTIVE') throw new AdminLoginFailedError()
  if (!verifyPassword(input.oldPassword, u.passwordHash)) throw new OldPasswordMismatchError()
  if (input.newPassword === input.oldPassword) throw new Error('新密码不能与原密码相同')
  await prisma.adminUser.update({
    where: { id: u.id },
    data: { passwordHash: hashPassword(input.newPassword) },
  })
}
