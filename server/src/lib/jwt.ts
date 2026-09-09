import jwt from 'jsonwebtoken'

const ISSUER = process.env.JWT_ISSUER ?? 'dshuaai-server'
const AUDIENCE = process.env.JWT_AUDIENCE ?? 'dshuaai-client'
function secret(): string {
  const value = process.env.JWT_SECRET
  if (!value && process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET required')
  return value ?? 'dev-only-insecure-secret'
}
export interface AccessTokenPayload { mid: string; phone: string; typ?: 'access' }
export interface RefreshTokenPayload { mid: string; typ: 'refresh' }
export interface AdminTokenPayload { aid: string; username: string; typ: 'admin' }
export function signAccess(payload: AccessTokenPayload): string {
  return jwt.sign({ ...payload, typ: 'access' }, secret(), { expiresIn: '2h', issuer: ISSUER, audience: AUDIENCE, algorithm: 'HS256' })
}
export function signAdmin(username: string, adminId: bigint | number | string): string {
  return jwt.sign({ aid: String(adminId), username, typ: 'admin' }, secret(), { expiresIn: '2h', issuer: ISSUER, audience: AUDIENCE, algorithm: 'HS256' })
}
export function signRefresh(merchantId: bigint | number): string {
  return jwt.sign({ mid: String(merchantId), typ: 'refresh' }, secret(), { expiresIn: '30d', issuer: ISSUER, audience: AUDIENCE, algorithm: 'HS256' })
}
export function verifyToken<T = unknown>(token: string): T {
  const p = jwt.verify(token, secret(), { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE })
  if (typeof p === 'string' || !['access', 'refresh', 'admin'].includes(p.typ)) throw new Error('Invalid token type')
  const id: unknown = p.typ === 'admin' ? p.aid : p.mid
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) throw new Error('Invalid token subject')
  return p as T
}
