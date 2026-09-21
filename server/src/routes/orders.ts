// 充值 / 会员 / 我的 路由
import { createRouter } from '../lib/async-router.js'
import { InvalidIdParamError, idParam } from '../lib/params.js'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as orderSvc from '../services/order.service.js'
import * as reconcile from '../services/pay-reconcile.service.js'
import { PackageNotFoundError, NoOpenidError, PaymentUnavailableError } from '../services/order.service.js'
import { SubscriptionRequiredError } from '../services/subscription.service.js'

const router = createRouter()
router.use(auth)

router.get('/me', async (req, res) => {
  try {
    const me = await orderSvc.getMe(prisma, req.merchantId!)
    ok(res, me)
  } catch {
    return fail(res, 500, '查询失败', 500)
  }
})

router.get('/recharge/packages', async (req, res) => {
  try {
    const list = await orderSvc.listBeanPackages(prisma)
    ok(res, list)
  } catch {
    return fail(res, 500, '查询失败', 500)
  }
})

router.get('/membership/plans', async (req, res) => {
  try {
    const list = await orderSvc.listMemberPlans(prisma)
    ok(res, list)
  } catch {
    return fail(res, 500, '查询失败', 500)
  }
})

router.get('/:orderNo([A-Za-z0-9_-]+)', async (req, res) => {
  try {
    const order = await orderSvc.getOrderForMerchant(prisma, req.merchantId!, req.params.orderNo!)
    if (!order) return fail(res, 3004, '订单不存在', 404)
    return ok(res, order)
  } catch {
    return fail(res, 500, '查询失败', 500)
  }
})

// 支付完成后**主动查单**（微信回调的兜底通道①）。
//
// 为什么前端付款成功后不能只轮询 GET /:orderNo：那只读本地库。
// 一旦回调因为 notify_url 不可达（备案被拦）而丢失，本地订单会永远停在 PENDING，
// 用户看到的就是「钱付了、积分不到账」。这里改为主动向微信查单，确认已支付就当场补发权益。
//
// 幂等与安全：复用 markOrderPaid() 的终态 CAS；金额必须与本地订单一致才结算；
// 订单归属由 merchantId 限定，别人拿不到你的单号。
router.post('/:orderNo([A-Za-z0-9_-]+)/query', async (req, res) => {
  try {
    const orderNo = req.params.orderNo!
    const r = await reconcile.queryAndSettle(prisma, orderNo, { merchantId: req.merchantId!, source: 'QUERY' })
    if (r.status === 'NOT_FOUND') return fail(res, 3004, '订单不存在', 404)
    // 查单可能已把订单改成 PAID/EXPIRED，回读一次给前端最新状态
    const order = await orderSvc.getOrderForMerchant(prisma, req.merchantId!, orderNo)
    return ok(res, { ...order, reconcile: { outcome: r.outcome, message: r.message } })
  } catch (e) {
    // 查单失败（微信超时 / 响应验签不通过）不当作「未支付」——返回 5xx 让前端继续轮询，
    // 后台对账 sweeper 也会兜住，绝不因为查不到就吞掉这笔权益。
    console.error('[orders] 查单异常:', e)
    return fail(res, 500, '查单失败，请稍后重试', 500)
  }
})

const orderInput = z.object({ packageId: z.string().min(1) })

router.post('/recharge/order', async (req, res) => {
  try {
    const { packageId } = orderInput.parse(req.body)
    const r = await orderSvc.createBeanOrder(prisma, req.merchantId!, idParam(packageId, 'packageId'))
    ok(res, r)
  } catch (e) {
    if (e instanceof PackageNotFoundError) return fail(res, 3006, '充值档位不存在或未启用', 404)
    if (e instanceof NoOpenidError) return fail(res, 3007, '账号未绑定微信，无法支付', 400)
    if (e instanceof PaymentUnavailableError) return fail(res, 3008, e.message, 503)
    // 本路由的 catch 是全捕获分支，会在全局 errorHandler 之前拦下异常，
    // 所以全局映射器里的 SubscriptionRequiredError → 2005 到不了这里，必须显式补上，
    // 否则「未订阅用户买加油包」这个正常业务分支会返回 500。
    if (e instanceof SubscriptionRequiredError) return fail(res, 2005, e.message, 403)
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[orders] 下单异常:', e)
    return fail(res, 500, '下单失败', 500)
  }
})

router.post('/membership/order', async (req, res) => {
  try {
    const { packageId } = orderInput.parse(req.body)
    const r = await orderSvc.createMemberOrder(prisma, req.merchantId!, idParam(packageId, 'packageId'))
    ok(res, r)
  } catch (e) {
    if (e instanceof PackageNotFoundError) return fail(res, 3006, '会员套餐不存在或未启用', 404)
    if (e instanceof NoOpenidError) return fail(res, 3007, '账号未绑定微信，无法支付', 400)
    if (e instanceof PaymentUnavailableError) return fail(res, 3008, e.message, 503)
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[orders] 下单异常:', e)
    return fail(res, 500, '下单失败', 500)
  }
})

export default router
