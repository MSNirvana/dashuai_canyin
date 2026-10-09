// 登录业务编排
//   微信一键：code2session 拿 openid + verifysession 拿手机号，按手机号匹配账号
//   短信兜底：短信码校验通过即登录（同号码关联已有账号）

import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'
import { code2Session, verifyPhoneNumber } from './wechat.js'
import { verifyCode, SmsCodeInvalidError } from './sms.js'
import { signAccess, signRefresh, verifyToken } from '../lib/jwt.js'
import { demoLoginCode, demoSessionDeadline, DemoLoginThrottledError, loadDemoPolicy } from '../lib/demo-account.js'
import {
  checkLoginAllowed,
  clearDemoLoginFailures,
  merchantDemoLoginKey,
  MERCHANT_DEMO_LOGIN_POLICY,
  recordLoginFailure,
} from '../lib/login-throttle.js'
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
  await grantRegisterBeanIfNeeded(prisma, merchant.id)

  return buildLoginResult(prisma, merchant)
}

/**
 * 手机号验证码登录（兜底通道）。
 *
 * ★★ 演示账号的**固定登录码**在这里分流 —— 这是「不需要点『获取验证码』」能成立的唯一地方。
 *
 * 判据全部来自 `demoLoginCode()`（**与 `sendCode()` 用的是同一个函数**，两边不会打架）：
 *   · 该号不在 `demo.config.phones` 里，或没配 `login_code` ⇒ 返回 null ⇒
 *     走**原封不动**的短信验证码流程（普通账号零行为变化，连一次 Redis 都不多花）；
 *   · 否则用那枚固定码比对，**不查 `smsCode` 表**。
 *
 * ★★ 为什么不能复用短信码那条路（只把码值换成固定的）：`smsCode` 是**一次性**的，
 *   第一次登录就把记录消费掉了，第二次又得去点「获取验证码」—— 正是要避免的事。
 *   演示码是**可重复使用的共享码**，所以它根本不进那张表。
 *
 * ★★ 为什么必须在这里限速：6 位固定码可重复使用，不限速就是穷举必中。
 *   短信码那条路不需要 —— `verifyCode()` 自带「同记录错 5 次作废」+ 5 分钟 TTL。
 * ★ 顺序是「先查限速、再比对码值」：已被锁住的请求不该再去比对（同后台登录的口径）。
 */
export async function loginByPhone(
  prisma: PrismaClient,
  redis: Redis,
  phone: string,
  code: string,
): Promise<LoginResult> {
  const demoCode = demoLoginCode(await loadDemoPolicy(prisma), phone)

  if (demoCode) {
    const checks = [{ key: merchantDemoLoginKey(phone), policy: MERCHANT_DEMO_LOGIN_POLICY }]
    const verdict = await checkLoginAllowed(redis, checks)
    if (!verdict.allowed) throw new DemoLoginThrottledError(verdict.retryAfterSec)
    if (code !== demoCode) {
      await recordLoginFailure(redis, checks)
      throw new SmsCodeInvalidError()
    }
    // 成功即清零。否则「错 9 次 + 对 1 次 + 再错 1 次」会立刻被锁 —— 计数必须跟着成功归零。
    await clearDemoLoginFailures(redis, phone)
  } else {
    await verifyCode(prisma, phone, code)
  }

  const merchant = await upsertMerchantByPhone(prisma, phone)
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
/**
 * 写 `merchant.wechat_openid` 之前先查冲突，**别把裸 P2002 冒到 500**。
 *
 * 数据库层有唯一索引兜底（`merchant_wechat_openid_key`），但 P2002 的 message 里
 * 只有索引名，排不出「被谁占了」—— 用户看到的是一个没有信息量的 500，我们也定位不了。
 * 这里提前查一次，抛带**占用者手机号**的专用错误，日志能自证、用户也能照着操作。
 *
 * ★ 所有写 openid 的路径都要过这里（本文件 3 处 + 下单补绑 1 处）。
 *   实际事故：2026-10-09 15:58，同一微信尝试登录另一个手机号的账号，
 *   `upsertMerchantByPhone` 的 create/update 分支没有预检 ⇒ 连续两次裸 P2002 500。
 *
 * `selfId` 用于「更新自己」的场景 —— 自己占着自己的 openid 不算冲突。
 */
async function assertOpenidAvailable(prisma: PrismaClient, openid: string, selfId?: bigint): Promise<void> {
  const other = await prisma.merchant.findUnique({
    where: { wechatOpenid: openid },
    select: { id: true, phone: true },
  })
  if (other && other.id !== selfId) throw new OpenidBoundToAnotherAccountError(other.phone)
}

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

  // ★ 先查冲突再写：见 assertOpenidAvailable 的说明。
  await assertOpenidAvailable(prisma, openid, merchantId)

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
 *
 * ★★★ 2026-10-09 语义升级（本函数原名 `bindWechatOpenidByLoginCode`）：
 *   上面那条「调用方必须吞掉失败」的补丁，实际只是把问题**掩盖成静默回退** ——
 *   一旦该 openid 已属于**另一个账号**（唯一索引 `merchant_wechat_openid_key` 拒绝绑定），
 *   下单就退回用 `merchant.wechat_openid` 里的**旧 openid**，而那个未必是当前付款人，
 *   微信于是在调起支付时弹「下单账号与支付账号不一致」，用户完全无从下手。
 *   实际发生：2026-10-09 16:36，账号 10（15210343436）连续两笔 ¥980 全部卡死。
 *
 *   ⇒ 现在**取 openid 与绑定彻底拆开**：
 *       · 用 code 换 openid  = **必须**（它决定 payer.openid，微信的硬要求）
 *       · 把它写进账号       = **顺带**（失败只记日志，付款照走）
 *     于是「微信登录的账号」与「大帅餐饮登录的账号」是不是同一个，**不再影响能否付款**。
 */
export async function resolvePayerOpenid(
  prisma: PrismaClient,
  merchantId: bigint,
  wxLoginCode?: string,
): Promise<string | undefined> {
  if (!wxLoginCode) return undefined

  let session: { openid: string; unionid?: string }
  try {
    session = await code2Session(wxLoginCode)
  } catch (e) {
    // 换不出来（网络异常 / code 已失效或已被用过）⇒ 回退账号已存 openid，行为同改动前。
    console.warn('[pay] wx.login 的 code 换 openid 失败（回退账号已存 openid）:', (e as Error).message)
    return undefined
  }

  // ★★ 绑定只是「顺手做的事」，**失败绝不影响付款** —— 这一行是本次事故的修法。
  try {
    await bindWechatIdentity(prisma, merchantId, session.openid, session.unionid)
  } catch (e) {
    console.warn('[pay] 顺带绑定 openid 未成功（不影响本次支付）:', (e as Error).message)
  }

  // ★ 无论绑定成败，都返回**本次付款人**的 openid。
  return session.openid
}

/**
 * 刷新 token。
 *
 * ★ 演示账号在这里**不可能**被续命：`buildLoginResult` 会过 `demoSessionDeadline`，
 *   而截止时刻是「激活时刻 + 窗口」算出来的**绝对时间**，跟刷新几次无关 ——
 *   窗口一过这里直接抛 `DemoExpiredError`（路由层映射成 1006）。
 *   这正是「24h 后自动退出」能成立的原因：access 2h / refresh 30d 的滑动续期
 *   本身是永不过期的，只有绝对截止能把它掐断。
 */
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
 * 注册赠积分 + 签发 token 流程，便于在微信开发者工具里联调。
 */
export async function devLogin(prisma: PrismaClient, phone: string): Promise<LoginResult> {
  if (process.env.NODE_ENV === 'production' || process.env.DEV_LOGIN !== 'true') throw new Error('dev login disabled')
  if (!/^1\d{10}$/.test(phone)) throw new Error('invalid phone')

  const merchant = await upsertMerchantByPhone(prisma, phone, `dev_openid_${phone}`)
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
    // 两个旧分支（原先没 openid / 换了微信）本就是同一段 update，合并；
    // 只在真要改绑时才预检冲突（openid 没变时维持幂等、不写库）。
    if (openid && existing.wechatOpenid !== openid) {
      await assertOpenidAvailable(prisma, openid, existing.id)
      await prisma.merchant.update({
        where: { id: existing.id },
        data: { wechatOpenid: openid, wechatUnionid: unionid ?? existing.wechatUnionid },
      })
    }
    return existing
  }

  // ★ 新建同样要预检：该 openid 已属于另一个手机号的账号时，直接 create 会撞唯一索引
  //   抛裸 P2002（冒成 500，日志里只有索引名）。实际事故见 assertOpenidAvailable 的注释。
  if (openid) await assertOpenidAvailable(prisma, openid)
  return prisma.merchant.create({
    data: {
      phone,
      wechatOpenid: openid,
      wechatUnionid: unionid,
    },
  })
}

async function buildLoginResult(prisma: PrismaClient, merchant: { id: bigint; phone: string; nickname: string | null; avatarUrl: string | null }): Promise<LoginResult> {
  /**
   * ★★ 演示账号闸门必须在**签发任何 token 之前**。
   *
   * 这里是**唯一**出口（登录 / 微信一键 / 刷新 / 开发登录四条路径全走它），所以放在这一处
   * 就等于四条路径一起接线 —— 分散到各路由去判，必然漏掉一条（最可能漏的是 `/auth/refresh`，
   * 而它恰好是泄漏点：refresh 每次都换发新 refresh，漏了它演示窗口就形同虚设）。
   *
   * 顺序也重要：先判过期、后签 token。反过来的话窗口已关时会发出一个 `dst` 早已过期的 token，
   * 用户看到的是「刚登录就被踢」，而不是「演示已结束，请联系管理员」。
   */
  const demoDst = await demoSessionDeadline(prisma, merchant.phone)

  const isNew = (await prisma.store.count({ where: { merchantId: merchant.id } })) === 1
  const m = await prisma.membership.findFirst({
    where: { merchantId: merchant.id, status: 'ACTIVE', endAt: { gt: new Date() } },
    orderBy: { endAt: 'desc' },
  })
  const ba = await bean.getBalance(prisma, merchant.id)
  return {
    token: signAccess({ mid: String(merchant.id), phone: merchant.phone, ...(demoDst ? { dst: demoDst } : {}) }),
    refreshToken: signRefresh(merchant.id, demoDst),
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
