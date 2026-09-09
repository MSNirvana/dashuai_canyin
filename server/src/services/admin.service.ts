// 后台管理服务：管理员登录（单角色全权限）
import type { PrismaClient } from '@prisma/client'
import { verifyPassword } from '../lib/password.js'
import { signAdmin } from '../lib/jwt.js'

export class AdminLoginFailedError extends Error {
  constructor() {
    super('用户名或密码错误')
    this.name = 'AdminLoginFailedError'
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
