import type { Request, Response } from 'express'
import { isIP } from 'node:net'
import { z } from 'zod'
import { prisma, redis } from '../db.js'
import { createRouter } from '../lib/async-router.js'
import { idParam, InvalidIdParamError } from '../lib/params.js'
import { requiredText } from '../lib/validators.js'
import { ok, fail } from '../lib/result.js'
import { WebPayProviderError } from '../lib/wxpay.js'
import { auth } from '../middleware/auth.js'
import { PackageNotFoundError, PaymentUnavailableError } from '../services/order.service.js'
import { SubscriptionRequiredError } from '../services/subscription.service.js'
import { createWebOrder, getWebCatalog, payWebOrder, WebOrderError } from '../services/web-order.service.js'

const router = createRouter()
const sceneInput = z.object({ scene: z.enum(['NATIVE', 'H5']) })
const orderInput = sceneInput.extend({ kind: z.enum(['MEMBER', 'BEAN']), packageId: requiredText(19).regex(/^\d{1,19}$/) })
const orderNoInput = requiredText(32).regex(/^[MB]W[0-9a-f]{30}$/)

/** 只信任 index 中配置的 loopback 反代；直连取 socket，忽略请求体 IP。 */
export function webPayerClientIp(req: Request): string | undefined {
  const remote = req.socket.remoteAddress
  const ip = remote === '::1' || remote?.startsWith('127.') || remote?.startsWith('::ffff:127.') ? req.ip : remote
  const normalized = ip?.replace(/^::ffff:/, '')
  return normalized && isIP(normalized) ? normalized : undefined
}

async function limitPayment(req: Request, res: Response): Promise<boolean> {
  const count = Number(await redis.eval(`
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end
return n`, 1, `web:pay:merchant:${req.merchantId}`))
  if (count <= 10) return true
  res.setHeader('Retry-After', '60')
  fail(res, 4290, '支付请求过于频繁，请稍后重试', 429)
  return false
}

function paymentFailure(res: Response, error: unknown) {
  let code = 500, status = 500, message = '支付请求失败，请稍后重试'
  if (error instanceof WebOrderError) { code = error.code; status = error.status; message = error.message }
  else if (error instanceof PaymentUnavailableError) { code = 3008; status = 503; message = error.message }
  else if (error instanceof PackageNotFoundError) { code = 3006; status = 404; message = error.message }
  else if (error instanceof SubscriptionRequiredError) { code = 2005; status = 403; message = error.message }
  else if (error instanceof z.ZodError || error instanceof InvalidIdParamError) { code = 4000; status = 400; message = '参数不合法' }
  else if (error instanceof WebPayProviderError) {
    code = 3014; status = 502; message = '微信支付暂不可用，请稍后重试'
    if (error.providerCode === 'ORDERPAID') { code = 3009; status = 409; message = '微信订单已支付，请查询订单状态' }
    if (error.providerCode === 'ORDER_CLOSED') { code = 3010; status = 409; message = '微信订单已关闭，请重新下单' }
    if (error.providerCode === 'FREQUENCY_LIMITED' || error.providerCode === 'RATELIMIT_EXCEEDED' || error.httpStatus === 429) { status = 429; message = '微信支付请求过于频繁，请稍后重试' }
    if (error.providerCode === 'NO_AUTH' || error.providerCode === 'APPID_MCHID_NOT_MATCH') { status = 503; message = '微信支付通道暂不可用' }
  } else if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
    code = 3015; status = 504; message = '微信支付请求超时，请查询订单后重试'
  }
  if (status >= 500) console.error('[web-pay] 支付请求异常:', error instanceof WebPayProviderError ? error.providerCode : error instanceof Error ? error.message : '未知异常')
  const orderNo = error instanceof Error && 'orderNo' in error ? error.orderNo : undefined
  if (typeof orderNo === 'string') {
    return res.status(status).json({ code, message, data: { orderNo }, traceId: res.locals.traceId })
  }
  return fail(res, code, message, status)
}

router.get('/catalog', async (_req, res) => {
  try { ok(res, await getWebCatalog(prisma)) }
  catch (e) { paymentFailure(res, e) }
})

router.use(auth)
router.post('/orders', async (req, res) => {
  try {
    const input = orderInput.parse(req.body)
    const packageId = idParam(input.packageId, 'packageId')
    if (!await limitPayment(req, res)) return
    ok(res, await createWebOrder(prisma, req.merchantId!, { ...input, packageId }, webPayerClientIp(req)))
  } catch (e) { paymentFailure(res, e) }
})
router.post('/orders/:orderNo/pay', async (req, res) => {
  try {
    const { scene } = sceneInput.parse(req.body)
    const orderNo = orderNoInput.parse(req.params.orderNo)
    if (!await limitPayment(req, res)) return
    ok(res, await payWebOrder(prisma, req.merchantId!, orderNo, scene, webPayerClientIp(req)))
  } catch (e) { paymentFailure(res, e) }
})

export default router
