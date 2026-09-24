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

/** 新用户发注册赠积分（一次性）。
 *
 * ★ 两个要点：
 *  1. 走 `source: 'REGISTER'` → 进**注册赠积分桶**，永久有效，不随会员到期被清零。
 *     以前它和会员赠积分同进一个池子，会员到期时会被一起清掉。
 *  2. 发放与 `registerGrantGranted` 标记放进**同一个事务**。原实现是先发积分、再更新标记，
 *     两步之间进程挂掉就会在下次登录重复发放（30 积分虽小，但重复发就是账不平）。
 *     带上 bizId 后 `grant()` 自身也按 (bizType, requestId, GRANT) 幂等，双保险。
 */
async function grantRegisterBeanIfNeeded(prisma: PrismaClient, merchantId: bigint): Promise<void> {
  const m = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!m || m.registerGrantGranted) return
  const amount = BigInt(await getNumber(prisma, 'bean', 'register_grant_points', 30))
  await prisma.$transaction(async (tx) => {
    if (amount > 0n) {
      await bean.grant(tx, {
        merchantId,
        amount,
        source: 'REGISTER',
        bizId: merchantId.toString(),
        remark: '注册赠积分',
      })
    }
    await tx.merchant.update({
      where: { id: merchantId },
      data: { registerGrantGranted: true, lastLoginAt: new Date() },
    })
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

/**
 * 该 openid 已经属于**另一个**商户。
 *
 * `merchant.wechat_openid` 上是唯一索引（同一微信先后用两个手机号登过就会撞），
 * 硬写会抛 Prisma 的 P2002 —— 日志里只有一串索引名，排不出「这个微信已经绑过别的号」。
 * 单独抛一个能自证的错误，调用方与日志都能直接说清原因。
 *
 * ⚠ 本错误**只出现在服务端**：orders 路由会吞掉绑定失败（见那里的说明），
 *   所以 message 里的手机号不会回给客户端。真要回给用户时必须先脱敏。
 */
export class OpenidBoundToAnotherAccountError extends Error {
  readonly otherPhone: string
  constructor(otherPhone: string) {
    super(`该微信已绑定到另一个账号（手机号 ${otherPhone}）`)
    this.name = 'OpenidBoundToAnotherAccountError'
    this.otherPhone = otherPhone
  }
}

/**
 * 把「已解析出的微信身份」绑定到指定商户。**纯 DB、不联网** ⇒ 可以离线做契约测试
 * （`code2Session` 要真微信，所以把网络那半边单独拆出去，见下面那个函数）。
 *
 * ★ 为什么按 merchantId 而不是按手机号绑：调用方已经用 JWT 证明了「我是这个商户」，
 *   按 id 写库不会因为手机号匹配错而把 openid 挂到别的账号上。
 * ★ 幂等：openid 没变就**不写库** —— 每次支付前都会调一次，不该产生无意义的 UPDATE。
 */
export async function bindWechatIdentity(
  prisma: PrismaClient,
  merchantId: bigint,
  openid: string,
  unionid?: string,
): Promise<void> {
  const cur = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { wechatOpenid: true, wechatUnionid: true },
  })
  if (!cur) throw new Error(`merchant not found: ${merchantId}`)
  if (cur.wechatOpenid === openid) return

  // ★ 先查冲突再写：见 OpenidBoundToAnotherAccountError 的说明。
  const other = await prisma.merchant.findUnique({
    where: { wechatOpenid: openid },
    select: { id: true, phone: true },
  })
  if (other && other.id !== merchantId) throw new OpenidBoundToAnotherAccountError(other.phone)

  await prisma.merchant.update({
    where: { id: merchantId },
    data: { wechatOpenid: openid, wechatUnionid: unionid ?? cur.wechatUnionid },
  })
}

/**
 * `wx.login()` 的 code → openid → 绑定到当前商户。需要微信网络（`code2Session`）。
 *
 * ★★ 这是「手机号验证码登录的账号支付不了」这个缺陷的修法。
 *
 * 病根：短信登录路径 `loginByPhone()` **根本不取 openid**（它调 `upsertMerchantByPhone(prisma, phone)`，
 *   第三个参数为空），只有 `loginByWechat()` 会写 `merchant.wechatOpenid`。
 *   而微信 JSAPI 支付**必须**带付款人 `openid` ⇒ 这类账号一下单就抛 `NoOpenidError`（码 3007
 *   「账号未绑定微信，无法支付」）。
 *
 * 修法**不是**「引导用户改去用一键登录」——那要求用户换登录方式，存量账号也得重登。
 * 而是在**需要 openid 的那一刻（下单前）按需补绑**：
 *   · 对「已登录、token 还没过期」的存量账号**立刻生效**，不必重新登录；
 *   · 对「以后新注册的短信用户」一劳永逸；
 *   · 一键登录的用户走这里时 openid 不变 ⇒ 幂等不写库，零行为变化。
 *
 * ⚠ 调用方必须**吞掉失败**（见 routes/orders.ts）：账号本来就有 openid 时（一键登录用户），
 *   即使这次 code 换不出来也照样能支付 —— 不能让补绑失败把正常支付路径挡住。
 */
export async function bindWechatOpenidByLoginCode(
  prisma: PrismaClient,
  merchantId: bigint,
  wxLoginCode: string,
): Promise<string> {
  const s = await code2Session(wxLoginCode)
  await bindWechatIdentity(prisma, merchantId, s.openid, s.unionid)
  return s.openid
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
 * 默认门店创建 + 注册赠积分 + 签发 token 流程，便于在微信开发者工具里联调。
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
