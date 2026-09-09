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

/** 发送验证码；dev 环境下打印到日志 */
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
  await prisma.smsCode.create({
    data: {
      phone,
      codeHash: hash(code),
      scene: 'LOGIN',
      ip,
      expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
    },
  })

  // dev 输出；生产替换为腾讯云 / 阿里云 SMS SDK
  console.log(`[SMS dev] phone=${phone} code=${code} expires=${TTL_MINUTES}min`)
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