// 认证路由：微信一键 / 短信发送 / 手机号登录 / 刷新
import { createRouter } from '../lib/async-router.js'
import { z } from 'zod'
import { prisma, redis } from '../db.js'
import { loginByPhone, loginByWechat, refresh, devLogin, WxLoginFailedError } from '../auth/auth.service.js'
import { sendCode, SmsSendTooFrequentError, SmsDailyLimitError, SmsProviderNotConfiguredError } from '../auth/sms.js'
import { SmsSendFailedError } from '../auth/sms-provider.js'
import { ok, fail } from '../lib/result.js'

const router = createRouter()

const phoneSchema = z.string().regex(/^1\d{10}$/, 'invalid phone')

router.post('/sms/send', async (req, res) => {
  try {
    const phone = phoneSchema.parse(req.body?.phone)
    const { cooldownSec } = await sendCode(prisma, phone, req.ip)
    ok(res, { cooldownSec })
  } catch (e) {
    if (e instanceof SmsSendTooFrequentError || e instanceof SmsDailyLimitError) {
      fail(res, 1003, e.message, 429)
      return
    }
    if (e instanceof SmsProviderNotConfiguredError) {
      fail(res, 1004, e.message, 503)
      return
    }
    if (e instanceof SmsSendFailedError) {
      // e.reason 含腾讯云内部错误码与账号状态，只进服务端日志，不回给客户端。
      // 这条日志是排查「用户说收不到短信」的第一现场 —— 余额不足 / 签名模板未过审 / 限频都在这里现形。
      console.error(`[SMS] 发送失败：${e.reason}`)
      fail(res, 1005, '短信发送失败，请稍后重试', 502)
      return
    }
    fail(res, 1003, '发送失败', 400)
  }
})

router.post('/login', async (req, res) => {
  try {
    const phone = phoneSchema.parse(req.body?.phone)
    const code = z.string().length(6).parse(req.body?.code)
    const result = await loginByPhone(prisma, phone, code)
    ok(res, result)
  } catch {
    fail(res, 1002, '验证码错误或已过期', 400)
  }
})

router.post('/wechat-login', async (req, res) => {
  try {
    const phoneCode = z.string().min(1).parse(req.body?.phoneCode)
    const wxLoginCode = z.string().min(1).parse(req.body?.wxLoginCode)
    const result = await loginByWechat(prisma, redis, { phoneCode, wxLoginCode })
    ok(res, result)
  } catch (e) {
    if (e instanceof WxLoginFailedError) {
      // ★ 必须落服务端日志。这段错误原先只回客户端、不进日志 ⇒ 线上只剩一个 502，
      //   排查微信一键登录时会完全失去第一现场（2026-09-23 实测：err.log 一片空白，
      //   最后只能手工复现微信接口，才挖到 secsvcs/verifysession 的 40066 invalid url）。
      console.error(`[auth] 微信一键登录失败：${e.message}`)
      fail(res, 5001, `微信登录失败：${e.message}`, 502)
    } else {
      console.error(`[auth] 微信一键登录异常：${(e as Error).message}`)
      fail(res, 5001, '微信登录失败', 500)
    }
  }
})

router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = z.string().min(1).parse(req.body?.refreshToken)
    const result = await refresh(prisma, refreshToken)
    ok(res, result)
  } catch {
    fail(res, 1001, '刷新失败，请重新登录', 401)
  }
})

/** 开发登录旁路开关（仅用于本地联调，生产返回 false） */
router.get('/dev-mode', (_req, res) => {
  ok(res, { enabled: process.env.DEV_LOGIN === 'true' })
})

/** 开发登录：仅 DEV_LOGIN=true 时可用，直接按手机号创建/找回账号，不走真实微信/短信 */
router.post('/dev-login', async (req, res) => {
  if (process.env.DEV_LOGIN !== 'true') {
    fail(res, 1000, 'dev login disabled', 403)
    return
  }
  try {
    const phone = phoneSchema.parse(req.body?.phone)
    const result = await devLogin(prisma, phone)
    ok(res, result)
  } catch (e) {
    fail(res, 1000, (e as Error).message || 'dev login failed', 400)
  }
})

export default router
