import jwt from 'jsonwebtoken'

const ISSUER = process.env.JWT_ISSUER ?? 'dshuaai-server'
const AUDIENCE = process.env.JWT_AUDIENCE ?? 'dshuaai-client'
function secret(): string {
  const value = process.env.JWT_SECRET
  if (!value && process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET required')
  return value ?? 'dev-only-insecure-secret'
}
export interface AccessTokenPayload {
  mid: string
  phone: string
  typ?: 'access'
  /**
   * **演示账号**的绝对截止（unix 秒）。普通账号不签发此声明。
   * ★ 判据（含「什么算过期」）唯一出处：`lib/demo-account.ts::demoDeadlinePassed`，
   *   中间件与守护都调它，别在这里另写一份比较。
   * ★ 为什么写进 token 而不是每次查库：见 demo-account.ts 顶部说明。
   */
  dst?: number
}
export interface RefreshTokenPayload { mid: string; typ: 'refresh'; dst?: number }
export interface AdminTokenPayload { aid: string; username: string; typ: 'admin' }
export function signAccess(payload: AccessTokenPayload): string {
  return jwt.sign({ ...payload, typ: 'access' }, secret(), { expiresIn: '2h', issuer: ISSUER, audience: AUDIENCE, algorithm: 'HS256' })
}
export function signAdmin(username: string, adminId: bigint | number | string): string {
  return jwt.sign({ aid: String(adminId), username, typ: 'admin' }, secret(), { expiresIn: '2h', issuer: ISSUER, audience: AUDIENCE, algorithm: 'HS256' })
}
/**
 * ★ `dst`（演示账号绝对截止）必须**同时**写进 refresh：否则「刷新」会签出一对
 *   没有截止的 token，窗口一过照样能靠 30 天的 refresh 续期 ⇒ 24h 形同虚设。
 */
export function signRefresh(merchantId: bigint | number, dst?: number): string {
  return jwt.sign({ mid: String(merchantId), typ: 'refresh', ...(dst ? { dst } : {}) }, secret(), { expiresIn: '30d', issuer: ISSUER, audience: AUDIENCE, algorithm: 'HS256' })
}
export function verifyToken<T = unknown>(token: string): T {
  const p = jwt.verify(token, secret(), { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE })
  if (typeof p === 'string' || !['access', 'refresh', 'admin'].includes(p.typ)) throw new Error('Invalid token type')
  const id: unknown = p.typ === 'admin' ? p.aid : p.mid
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) throw new Error('Invalid token subject')
  return p as T
}
