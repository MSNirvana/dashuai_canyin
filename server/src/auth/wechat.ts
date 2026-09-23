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

/** 单次调用（不含自愈）。
 *  ★ 接口名必须是 business/getuserphonenumber：曾误写成 secsvcs/verifysession，
 *    微信对该路径稳定返回 errcode 40066「invalid url」⇒ 微信一键登录**永远失败**，
 *    且这里抛的是 WxLoginFailedError、路由又没打日志，线上只看得到 502、日志一片空白。
 *    实测对照（同一 access_token、同一假 code，2026-09-23）：
 *      /wxa/secsvcs/verifysession       → 40066 invalid url
 *      /wxa/business/getuserphonenumber → 40029 invalid code（接口正确，只是 code 无效） */
async function fetchPhoneNumber(redis: Redis, code: string): Promise<VerifysessionResult> {
  const accessToken = await getWxAccessToken(redis)
  const url = `${WX_HOST}/wxa/business/getuserphonenumber?access_token=${accessToken}`
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

/**
 * getPhoneNumber 返回的 code → 真实手机号（按次付费，需已申请「手机号快速验证」）。
 *
 * ★ 为什么需要「清缓存重试」这一层：微信的 client_credential access_token 是**全局单例**，
 *   后取者会让先取者手里的那个立刻变成「invalid or not latest」（errcode 40001）。
 *   本项目把它缓存进 Redis、TTL 接近 2 小时 ⇒ 只要发生过任何一次外部获取
 *   （运维手工排查、别的系统接入同一 appid、将来新接的微信能力），
 *   应用就会**攥着已失效的 token 连续失败近 2 小时**，用户侧看到的就是「登录根本用不了」。
 *   实测（2026-09-23）：排查时手工调过一次 /cgi-bin/token，随后真机登录连续 3 次 40001。
 *
 *   这里在 40001 / 42001 上做一次「删缓存 → 重新取 → 用原 code 重试」：
 *   - token 无效是在**鉴权阶段**被拒的，微信没有消费掉这次 code，所以重试可用；
 *   - 只重试一次，再失败仍抛原错误，不掩盖真实故障。
 */
export async function verifyPhoneNumber(redis: Redis, code: string): Promise<VerifysessionResult> {
  try {
    return await fetchPhoneNumber(redis, code)
  } catch (e) {
    if (e instanceof WxApiError && (e.errcode === 40001 || e.errcode === 42001)) {
      const { appid } = getWxConfig()
      console.warn(`[wx] access_token 已失效（errcode ${e.errcode}），清缓存后重试一次`)
      await redis.del(ACCESS_TOKEN_KEY(appid))
      return await fetchPhoneNumber(redis, code)
    }
    throw e
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