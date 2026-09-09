// 登录业务编排
//   微信一键：code2session 拿 openid + verifysession 拿手机号，按手机号匹配账号
//   短信兜底：短信码校验通过即登录（同号码关联已有账号）

import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'
import { code2Session, verifyPhoneNumber } from './wechat.js'
import { verifyCode } from './sms.js'
import { signAccess, signRefresh, verifyToken } from '../lib/jwt.js'
import * as bean from '../bean/bean.service.js'
import { getNumber } from '../lib/settings.js'

export interface LoginResult {
  token: string
  refreshToken: string
  merchant: { id: string; phone: string; nickname: string | null; avatarUrl: string | null; isNew: boolean }
  member: { isMember: boolean; endAt: Date | null }
  bean: { balance: string; grantBalance: string; available: string; frozen: string }
}

export class WxLoginFailedError extends Error {
  readonly code = 'WX_LOGIN_FAILED'
  constructor(message: string) {
    super(`wx login failed: ${message}`)
    this.name = 'WxLoginFailedError'
  }
}

/** 创建默认门店（首次登录的商家） */
async function ensureDefaultStore(prisma: PrismaClient, merchantId: bigint): Promise<void> {
  const exists = await prisma.store.findFirst({ where: { merchantId, isDefault: true } })
  if (exists) return
  await prisma.store.create({
    data: { merchantId, name: '默认门店', isDefault: true },
  })
}

/** 新用户发注册赠豆（一次性） */
async function grantRegisterBeanIfNeeded(prisma: PrismaClient, merchantId: bigint): Promise<void> {
  const m = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!m || m.registerGrantGranted) return
  const amount = BigInt(await getNumber(prisma, 'bean', 'register_grant_points', 30))
  if (amount > 0n) {
    await prisma.$transaction((tx) => bean.grant(tx, { merchantId, amount, remark: '注册赠豆' }))
  }
  await prisma.merchant.update({
    where: { id: merchantId },
    data: { registerGrantGranted: true, lastLoginAt: new Date() },
  })
}

/** 微信一键登录：手机号匹配账号 */
export async function loginByWechat(
  prisma: PrismaClient,
  redis: Redis,
  params: { phoneCode: string; wxLoginCode: string },
): Promise<LoginResult> {
  // 1) wx.login 的 code → openid / unionid（用于账号关联与审计）
  let openid: string
  let unionid: string | undefined
  try {
    const s = await code2Session(params.wxLoginCode)
    openid = s.openid
    unionid = s.unionid
  } catch (e) {
    throw new WxLoginFailedError(`code2session: ${(e as Error).message}`)
  }

  // 2) getPhoneNumber 的 code → 真实手机号
  let phone: string
  try {
    const r = await verifyPhoneNumber(redis, params.phoneCode)
    phone = r.phoneNumber
  } catch (e) {
    throw new WxLoginFailedError(`verifysession: ${(e as Error).message}`)
  }

  if (!/^1\d{10}$/.test(phone)) throw new WxLoginFailedError(`invalid phone: ${phone}`)

  // 3) 按手机号匹配或创建账号；首次登录绑定 openid
  const merchant = await upsertMerchantByPhone(prisma, phone, openid, unionid)
  await ensureDefaultStore(prisma, merchant.id)
  await grantRegisterBeanIfNeeded(prisma, merchant.id)

  return buildLoginResult(prisma, merchant)
}

/** 手机号验证码登录（兜底通道） */
export async function loginByPhone(prisma: PrismaClient, phone: string, code: string): Promise<LoginResult> {
  await verifyCode(prisma, phone, code)

  const merchant = await upsertMerchantByPhone(prisma, phone)
  await ensureDefaultStore(prisma, merchant.id)
  await grantRegisterBeanIfNeeded(prisma, merchant.id)
  await prisma.merchant.update({ where: { id: merchant.id }, data: { lastLoginAt: new Date() } })

  return buildLoginResult(prisma, merchant)
}

/** 刷新 token */
export async function refresh(prisma: PrismaClient, refreshToken: string): Promise<LoginResult> {
  const payload = verifyToken<{ mid: string; typ: string }>(refreshToken)
  if (payload.typ !== 'refresh') throw new Error('invalid refresh token')
  const id = BigInt(payload.mid)
  const merchant = await prisma.merchant.findUnique({ where: { id } })
  if (!merchant || merchant.status !== 'ACTIVE') throw new Error('merchant not available')
  return buildLoginResult(prisma, merchant)
}

/**
 * 开发登录旁路：仅在 DEV_LOGIN=true 时可用（默认关闭，生产绝不暴露）。
 * 不依赖真实微信 / 短信，直接按手机号创建或找回账号，走与正式登录一致的
 * 默认门店创建 + 注册赠豆 + 签发 token 流程，便于在微信开发者工具里联调。
 */
export async function devLogin(prisma: PrismaClient, phone: string): Promise<LoginResult> {
  if (process.env.NODE_ENV === 'production' || process.env.DEV_LOGIN !== 'true') throw new Error('dev login disabled')
  if (!/^1\d{10}$/.test(phone)) throw new Error('invalid phone')

  const merchant = await upsertMerchantByPhone(prisma, phone, `dev_openid_${phone}`)
  await ensureDefaultStore(prisma, merchant.id)
  await grantRegisterBeanIfNeeded(prisma, merchant.id)
  await prisma.merchant.update({ where: { id: merchant.id }, data: { lastLoginAt: new Date() } })
  return buildLoginResult(prisma, merchant)
}

async function upsertMerchantByPhone(
  prisma: PrismaClient,
  phone: string,
  openid?: string,
  unionid?: string,
) {
  const existing = await prisma.merchant.findUnique({ where: { phone } })
  if (existing) {
    if (existing.status !== 'ACTIVE') throw new Error('merchant not available')
    if (openid && !existing.wechatOpenid) {
      await prisma.merchant.update({
        where: { id: existing.id },
        data: { wechatOpenid: openid, wechatUnionid: unionid ?? existing.wechatUnionid },
      })
    } else if (openid && existing.wechatOpenid !== openid) {
      // 同一手机号下换了微信账号（如换设备/重装），更新绑定
      await prisma.merchant.update({
        where: { id: existing.id },
        data: { wechatOpenid: openid, wechatUnionid: unionid ?? existing.wechatUnionid },
      })
    }
    return existing
  }

  return prisma.merchant.create({
    data: {
      phone,
      wechatOpenid: openid,
      wechatUnionid: unionid,
    },
  })
}

async function buildLoginResult(prisma: PrismaClient, merchant: { id: bigint; phone: string; nickname: string | null; avatarUrl: string | null }): Promise<LoginResult> {
  const isNew = (await prisma.store.count({ where: { merchantId: merchant.id } })) === 1
  const m = await prisma.membership.findFirst({
    where: { merchantId: merchant.id, status: 'ACTIVE', endAt: { gt: new Date() } },
    orderBy: { endAt: 'desc' },
  })
  const ba = await bean.getBalance(prisma, merchant.id)
  return {
    token: signAccess({ mid: String(merchant.id), phone: merchant.phone }),
    refreshToken: signRefresh(merchant.id),
    merchant: {
      id: String(merchant.id),
      phone: merchant.phone,
      nickname: merchant.nickname,
      avatarUrl: merchant.avatarUrl,
      isNew,
    },
    member: { isMember: !!m, endAt: m?.endAt ?? null },
    bean: {
      balance: ba.balance.toString(),
      grantBalance: ba.grantBalance.toString(),
      available: ba.available.toString(),
      frozen: ba.frozen.toString(),
    },
  }
}