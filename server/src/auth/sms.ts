// 短信验证码服务
// 真实生产请替换为腾讯云 / 阿里云短信；当前为 dev 实现，验证码在日志输出

import type { PrismaClient } from '@prisma/client'
import { createHash, randomInt } from 'node:crypto'

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
  constructor() {
    super('短信服务未配置，请联系管理员')
    this.name = 'SmsProviderNotConfiguredError'
  }
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

  const code = genCode()
  const record = await prisma.smsCode.create({
    data: {
      phone,
      codeHash: hash(code),
      scene: 'LOGIN',
      ip,
      expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
    },
  })

  const provider = process.env.SMS_PROVIDER?.trim()
  if (process.env.NODE_ENV === 'production' && !provider) {
    await prisma.smsCode.delete({ where: { id: record.id } })
    throw new SmsProviderNotConfiguredError()
  }
  if (!provider) {
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
    // 供应商适配器接入前不允许伪造发送成功；生产由此分支明确失败。
    await prisma.smsCode.delete({ where: { id: record.id } })
    throw new SmsProviderNotConfiguredError()
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