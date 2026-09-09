// 充值 / 会员 / 我的 路由
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as orderSvc from '../services/order.service.js'
import { PackageNotFoundError, NoOpenidError } from '../services/order.service.js'
import { SubscriptionRequiredError } from '../services/subscription.service.js'

const router = Router()
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

const orderInput = z.object({ packageId: z.string().min(1) })

router.post('/recharge/order', async (req, res) => {
  try {
    const { packageId } = orderInput.parse(req.body)
    const r = await orderSvc.createBeanOrder(prisma, req.merchantId!, BigInt(packageId))
    ok(res, r)
  } catch (e) {
    if (e instanceof PackageNotFoundError) return fail(res, 3006, '充值档位不存在或未启用', 404)
    if (e instanceof NoOpenidError) return fail(res, 3007, '账号未绑定微信，无法支付', 400)
    return fail(res, 500, '下单失败', 500)
  }
})

router.post('/membership/order', async (req, res) => {
  try {
    const { packageId } = orderInput.parse(req.body)
    const r = await orderSvc.createMemberOrder(prisma, req.merchantId!, BigInt(packageId))
    ok(res, r)
  } catch (e) {
    if (e instanceof PackageNotFoundError) return fail(res, 3006, '会员套餐不存在或未启用', 404)
    if (e instanceof NoOpenidError) return fail(res, 3007, '账号未绑定微信，无法支付', 400)
    return fail(res, 500, '下单失败', 500)
  }
})

export default router
