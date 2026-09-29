// 认证路由：微信一键 / 短信发送 / 手机号登录 / 刷新
import { createRouter } from '../lib/async-router.js'
import { z } from 'zod'
import { prisma, redis } from '../db.js'
import { loginByPhone, loginByWechat, refresh, devLogin, WxLoginFailedError } from '../auth/auth.service.js'
import { DemoExpiredError } from '../lib/demo-account.js'
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
  } catch (e) {
    // ★ 演示账号到期必须**先于** 1002 判：它的 message 是「演示账号已到期，请联系管理员」，
    //   不是「验证码错误」。并进 1002 的话用户会以为是验证码的问题，反复重发短信 ——
    //   而短信发得出去、码也没错，只是这个号已经不能再登录了。
    if (e instanceof DemoExpiredError) {
      fail(res, 1006, e.message, 403)
      return
    }
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
    // ★ 演示账号到期必须排在微信错误之前：微信这一步（code2session / verifysession）是好的，
    //   报「微信登录失败」会把排查方向整个带偏。
    if (e instanceof DemoExpiredError) {
      fail(res, 1006, e.message, 403)
      return
    }
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
  } catch (e) {
    // ★ 演示账号窗口已关：refresh 一定失败（见 auth.service.ts::refresh 的说明）。
    //   回 1006 而不是 1001，是为了让客户端能把用户送去正确的提示，而不是
    //   「登录已过期 → 重新登录 → 又被拒」地转圈。
    if (e instanceof DemoExpiredError) {
      fail(res, 1006, e.message, 401)
      return
    }
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
    // ★ 开发登录同样要过演示闸门：本地联调时最容易忘了「这个号是演示号」，
    //   在这里放过它，线上就会表现为「本地能登、线上不能登」的诡异差异。
    if (e instanceof DemoExpiredError) {
      fail(res, 1006, e.message, 403)
      return
    }
    fail(res, 1000, (e as Error).message || 'dev login failed', 400)
  }
})

export default router
