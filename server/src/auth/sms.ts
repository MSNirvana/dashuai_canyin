// 短信验证码服务
// 真实生产请替换为腾讯云 / 阿里云短信；当前为 dev 实现，验证码在日志输出

import type { PrismaClient } from '@prisma/client'
import { createHash, randomInt } from 'node:crypto'
import { smsProviderMode, readTencentSmsConfig, sendSmsViaTencent } from './sms-provider.js'

const TTL_MINUTES = 5
const MAX_ATTEMPTS = 5
const RESEND_COOLDOWN_SEC = 60

export class SmsSendTooFrequentError extends Error {
  readonly code = 'SMS_TOO_FREQUENT'
  constructor(readonly cooldownSec: number) {
    super(`sms send too frequent, cooldown ${cooldownSec}s`)
    this.name = 'SmsSendTooFrequentError'
  }
}

export class SmsCodeInvalidError extends Error {
  readonly code = 'SMS_INVALID'
  constructor() {
    super('sms code invalid or expired')
    this.name = 'SmsCodeInvalidError'
  }
}

export class SmsDailyLimitError extends Error {
  readonly code = 'SMS_DAILY_LIMIT'
  constructor(readonly limit: number) {
    super(`daily sms limit ${limit} reached`)
    this.name = 'SmsDailyLimitError'
  }
}

const DAILY_LIMIT_PER_PHONE = 10
const DAILY_LIMIT_PER_IP = 50

function hash(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

function genCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** 手机号脱敏：138****0001。保留前 3 后 4，够定位问题但不泄露完整号码。 */
function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '***'
}

export class SmsProviderNotConfiguredError extends Error {
  readonly code = 'SMS_PROVIDER_NOT_CONFIGURED'
  constructor(message = '短信服务未配置，请联系管理员') {
    super(message)
    this.name = 'SmsProviderNotConfiguredError'
  }
}

/**
 * “没有可用的发送通道”时抛的错。
 *
 * ★ 为什么要抽成一个函数：这个错误有**两条**抛出路径 ——
 *   `SMS_PROVIDER` 未选（mode === 'none'）、以及**选了但配置不齐**（线上就是这种：
 *   `SMS_PROVIDER=tencent` 而密钥还没填）。两条路径的**用户可见行为必须一致**，
 *   否则会出现“本地测的时候提示很清楚，线上反而只有一句‘未配置’”这种最难查的差异。
 *   （实测踩过：2026-09-18 只改了 mode==='none' 那条，而线上恰好走的是另一条。）
 *
 * 测试期最常见的困惑是“测试者用了一个没进白名单的号”（码本来就发不出去），
 *   而默认文案会把他引向“等运维修通道”，白等一场。
 *   所以只在**后门开着**时补一句；后门关着时（正式运营）用户看到的仍是原话。
 */
function smsUnavailableError(): SmsProviderNotConfiguredError {
  return new SmsProviderNotConfiguredError(
    smsTestCodeConfig()
      ? '测试期仅名单内的测试号码可登录，请联系管理员加入名单'
      : undefined,
  )
}

/**
 * 短信测试码（联调期用固定验证码登录，不必每次去服务端日志里捞）。
 *
 * ★ 这是一个**登录后门**，所以照 `devLogin()` 的同一套规矩上了**四道**闸门，缺一不可：
 *   ① `NODE_ENV !== 'production'`（生产整块失效）；
 *   ② `SMS_TEST_CODE` 必须是 **6 位数字**（留空 = 关闭）；
 *   ③ `SMS_TEST_CODE_PHONES` 必须**非空**，且该手机号在名单里；
 *   ④ 若 ① 不成立（确实在 production）：必须**再**显式声明 `SMS_TEST_CODE_ALLOW_PROD=true`。
 *
 * ★ 为什么会有闸门 ① 的“破例开关”（2026-09-18 加）：
 *   体验版要发给店外的测试者，而当时正式登录通道**两条都不通** —— 短信签名还在运营商报备
 *   （`SMS_PROVIDER` 未配 ⇒ 发码直接 1004），微信一键登录要求小程序已认证。
 *   于是“能不能登进去”变成了“能不能测试”的前提，只能在线上开一个受控的口子。
 *
 *   破例刻意做成**四件事同时成立**才生效：production ＋ 码是 6 位数字 ＋ 白名单非空 ＋
 *   `SMS_TEST_CODE_ALLOW_PROD === 'true'`。前三条堵住“任意号输固定码就登”（本设计里**表达不出无差别后门**），
 *   最后一条让“这是生产环境的登录后门”在服务器 `.env` 里**一眼可见**。
 *
 *   ⚠ 备案 / 小程序认证通过、真实短信通道打开之后，**必须**从服务器 `.env` 删掉：
 *   `SMS_TEST_CODE` / `SMS_TEST_CODE_PHONES` / `SMS_TEST_CODE_ALLOW_PROD` / `DEV_LOGIN`。
 *
 * ★ 为什么白名单是"必填"而不是"留空 = 所有号"：
 *   能用一个变量把**任意手机号**变成「输 123456 就能登」，风险太大了 ——
 *   线上只要漏配一处，代价就是全部商家账号。「无差别后门」这件事在本设计里**表达不出来**。
 *
 * ★ 测试码只替换**码值**，不豁免发送流程：`verifyCode()` 仍要求该手机号有一条
 *   未过期、未使用的记录 ⇒ 必须先点「获取验证码」，每号每日限额与 IP 限频照旧生效。
 *
 * ⚠ **白名单号在测试码启用期间收不到真实短信**（分支在调真实通道之前就 return 了）。
 *   签名过审、要把 `SMS_PROVIDER` 切成 tencent 做「真实发送」验证时，**必须换个不在
 *   白名单里的号**，否则会看到「接口 200、没有短信」而误判成通道有问题。
 *
 * 与 `smsProviderMode(env)` 同款签名：env 可注入，便于离线契约测试（`npm run sms:verify` 的 E 段）。
 */
export function smsTestCodeConfig(env: NodeJS.ProcessEnv = process.env): { code: string; phones: string[] } | null {
  // ② 码值形态
  const code = (env.SMS_TEST_CODE ?? '').trim()
  if (!/^\d{6}$/.test(code)) return null
  // ③ 白名单必须非空 —— 故意不支持“留空 = 所有号”
  const phones = (env.SMS_TEST_CODE_PHONES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!phones.length) return null
  // ① 环境：生产**默认整块失效**；要在线上启用，必须再显式声明一次。
  if (env.NODE_ENV === 'production' && env.SMS_TEST_CODE_ALLOW_PROD !== 'true') return null
  return { code, phones }
}

/** 该手机号是否走测试码；是则返回那个固定码。 */
export function smsTestCodeFor(phone: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const cfg = smsTestCodeConfig(env)
  return cfg && cfg.phones.includes(phone) ? cfg.code : null
}

/** 发送验证码；开发环境打印日志，生产环境未配置真实供应商时拒绝发送。 */
export async function sendCode(prisma: PrismaClient, phone: string, ip?: string): Promise<{ cooldownSec: number }> {
  const since = new Date(Date.now() - RESEND_COOLDOWN_SEC * 1000)
  const recent = await prisma.smsCode.findFirst({
    where: { phone, scene: 'LOGIN', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
  })
  if (recent) throw new SmsSendTooFrequentError(RESEND_COOLDOWN_SEC)

  const today = new Date(new Date().toISOString().slice(0, 10))
  const phoneCount = await prisma.smsCode.count({ where: { phone, createdAt: { gte: today } } })
  if (phoneCount >= DAILY_LIMIT_PER_PHONE) throw new SmsDailyLimitError(DAILY_LIMIT_PER_PHONE)
  if (ip) {
    const ipCount = await prisma.smsCode.count({ where: { ip, createdAt: { gte: today } } })
    if (ipCount >= DAILY_LIMIT_PER_IP) throw new SmsDailyLimitError(DAILY_LIMIT_PER_IP)
  }

  // 测试码模式下直接把记录里的码值设成那个固定码 ⇒ `verifyCode()` 一行都不用改：
  // 常规的「比对哈希 → 记 usedAt → 累计 attempts」全部照旧生效。
  const testCode = smsTestCodeFor(phone)
  const code = testCode ?? genCode()
  const record = await prisma.smsCode.create({
    data: {
      phone,
      codeHash: hash(code),
      scene: 'LOGIN',
      ip,
      expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
    },
  })

  if (testCode) {
    // 联调分支：不调真实通道。否则「签名没过审 / 管道没开」时整条链路一步都走不动。
    // ★ 它**排在下面那条 production 检查之前** —— 这正是白名单号码在生产环境也能发码的原因。
    const prodHint = process.env.NODE_ENV === 'production'
      ? ' ⚠ 当前是 production 环境，这是登录后门，尽快删除'
      : ''
    console.log(
      `[SMS test] phone=${maskPhone(phone)} 已使用测试码下发（SMS_TEST_CODE 生效，未调用真实通道）${prodHint}`,
    )
    return { cooldownSec: RESEND_COOLDOWN_SEC }
  }

  const mode = smsProviderMode()
  if (process.env.NODE_ENV === 'production' && mode === 'none') {
    await prisma.smsCode.delete({ where: { id: record.id } })
    // ★ 这里的文案要能自证真因。测试期最常见的情形是“测试者用了一个没进白名单的号”，
    //   而默认文案“短信服务未配置”会把他引向“等运维修短信通道”，白等一场。
    //   所以只在**测试码后门开着**时补一句；后门关着时普通用户看到的仍是原话。
    throw smsUnavailableError()
  }
  if (mode === 'none') {
    // 本地联调时把验证码打到日志，否则没有短信通道就没法登录。
    // ⚠ 只在**显式声明这是开发环境**时打印：早先只判断「非 production」，
    //   而 NODE_ENV 写错（例如 staging）的线上服务器会把验证码打进日志，
    //   任何能看到日志的人都可冒充任意手机号登录。现在多绑一个开关。
    // 手机号也做脱敏，日志被转发/截图时不泄露全量号码。
    const devLogEnabled = process.env.DEV_LOGIN === 'true' || process.env.SMS_LOG_CODE === 'true'
    if (devLogEnabled) {
      console.log(`[SMS dev] phone=${maskPhone(phone)} code=${code} expires=${TTL_MINUTES}min`)
    } else {
      console.log(`[SMS dev] phone=${maskPhone(phone)} 已生成验证码但未打印（需 DEV_LOGIN=true 或 SMS_LOG_CODE=true 才显示明文）`)
    }
  } else {
    // 选了真实通道但配置不齐：不猜、不降级成"假装发送成功"，直接明确失败。
    const cfg = readTencentSmsConfig()
    if (!cfg) {
      await prisma.smsCode.delete({ where: { id: record.id } })
      throw smsUnavailableError()
    }
    try {
      await sendSmsViaTencent(cfg, phone, code)
    } catch (e) {
      // ⚠ 发送失败必须删掉刚写入的记录。否则会留下一条「有效但用户永远收不到」的验证码：
      //   用户会一直等，而这条记录还会占用当天该号码的发送配额（DAILY_LIMIT_PER_PHONE），
      //   连续失败几次后把用户彻底挡在门外 —— 表现为「点了没反应，也没有短信」。
      await prisma.smsCode.delete({ where: { id: record.id } })
      throw e
    }
  }
  return { cooldownSec: RESEND_COOLDOWN_SEC }
}

/** 校验短信码。成功标记 usedAt。失败累计 attempts，达上限作废 */
export async function verifyCode(prisma: PrismaClient, phone: string, code: string): Promise<void> {
  const rec = await prisma.smsCode.findFirst({
    where: { phone, scene: 'LOGIN', usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  })
  if (!rec) throw new SmsCodeInvalidError()
  if (rec.attempts >= MAX_ATTEMPTS) throw new SmsCodeInvalidError()
  if (rec.codeHash !== hash(code)) {
    await prisma.smsCode.update({ where: { id: rec.id }, data: { attempts: { increment: 1 } } })
    throw new SmsCodeInvalidError()
  }
  await prisma.smsCode.update({ where: { id: rec.id }, data: { usedAt: new Date() } })
}