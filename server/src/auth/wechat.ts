// 微信小程序服务端 API 封装
// 主要能力：
//   1. code2session —— wx.login() 拿 openid / unionid
//   2. verifysession —— getPhoneNumber 拿真实手机号（按次付费）
//   3. access_token 缓存（7200s）

import type { Redis } from 'ioredis'
import type { PrismaClient } from '@prisma/client'

const WX_HOST = 'https://api.weixin.qq.com'
const ACCESS_TOKEN_KEY = (appid: string) => `wx:access_token:${appid}`

export class WxApiError extends Error {
  constructor(
    message: string,
    readonly errcode: number,
  ) {
    super(`WeChat API error ${errcode}: ${message}`)
    this.name = 'WxApiError'
  }
}

export interface Code2SessionResult {
  openid: string
  unionid?: string
  sessionKey: string
}

export interface VerifysessionResult {
  phoneNumber: string
  purePhoneNumber: string
  countryCode: string
}

interface WxConfig {
  appid: string
  secret: string
}

export function getWxConfig(): WxConfig {
  const appid = process.env.WX_APPID
  const secret = process.env.WX_SECRET
  if (!appid || !secret) throw new Error('WX_APPID / WX_SECRET missing in env')
  return { appid, secret }
}

async function postJson<T>(url: string, body: Record<string, unknown>, timeoutMs = 8000): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new Error(`WeChat HTTP request failed: ${(e as Error).message}`)
  }
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`WeChat non-JSON response: ${text.slice(0, 200)}`)
  }
  if (json.errcode && json.errcode !== 0) {
    throw new WxApiError(json.errmsg ?? 'unknown', json.errcode)
  }
  return json as T
}

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new Error(`WeChat HTTP request failed: ${(e as Error).message}`)
  }
  const json = (await res.json()) as any
  if (json.errcode && json.errcode !== 0) {
    throw new WxApiError(json.errmsg ?? 'unknown', json.errcode)
  }
  return json as T
}

/** wx.login() → openid / session_key / unionid */
export async function code2Session(code: string): Promise<Code2SessionResult> {
  const { appid, secret } = getWxConfig()
  const url = `${WX_HOST}/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`
  const r = await getJson<{
    openid?: string
    session_key?: string
    unionid?: string
    errcode?: number
    errmsg?: string
  }>(url)
  if (!r.openid || !r.session_key) {
    throw new WxApiError(r.errmsg ?? 'invalid code2session response', r.errcode ?? -1)
  }
  return {
    openid: r.openid,
    unionid: r.unionid,
    sessionKey: r.session_key,
  }
}

/** client_credential access_token，缓存到 Redis，7200s 提前 300s 刷新 */
export async function getWxAccessToken(redis: Redis): Promise<string> {
  const { appid, secret } = getWxConfig()
  const cached = await redis.get(ACCESS_TOKEN_KEY(appid))
  if (cached) return cached
  const url = `${WX_HOST}/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`
  const r = await getJson<{ access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }>(url)
  if (!r.access_token) throw new WxApiError(r.errmsg ?? 'no access_token', r.errcode ?? -1)
  const ttl = Math.max((r.expires_in ?? 7200) - 300, 60)
  await redis.set(ACCESS_TOKEN_KEY(appid), r.access_token, 'EX', ttl)
  return r.access_token
}

/** getPhoneNumber 返回的 code → 真实手机号（按次付费，需已申请「手机号快速验证」） */
export async function verifyPhoneNumber(redis: Redis, code: string): Promise<VerifysessionResult> {
  const accessToken = await getWxAccessToken(redis)
  const url = `${WX_HOST}/wxa/secsvcs/verifysession?access_token=${accessToken}`
  const r = await postJson<{
    errcode?: number
    errmsg?: string
    phone_info?: { phoneNumber: string; purePhoneNumber: string; countryCode: string }
  }>(url, { code })
  if (!r.phone_info?.phoneNumber) {
    throw new WxApiError(r.errmsg ?? 'no phone_info', r.errcode ?? -1)
  }
  return {
    phoneNumber: r.phone_info.phoneNumber,
    purePhoneNumber: r.phone_info.purePhoneNumber,
    countryCode: r.phone_info.countryCode,
  }
}

/** 解析 openid / unionid 仅用于审计，不依赖此做权限决策 */
export async function auditMerchantWx(
  _prisma: PrismaClient,
  _merchantId: bigint,
  _openid: string,
  _unionid?: string,
): Promise<void> {
  // 保留：后续做风控/解封/审计日志
}