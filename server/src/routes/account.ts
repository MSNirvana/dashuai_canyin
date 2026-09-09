// 账户查询路由：积分流水 / AI 调用日志 / 当前订阅 — 全部只读，不影响余额
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import { activeMembership } from '../services/order.service.js'

const router = Router()
router.use(auth)

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

/** GET /bean/ledger — 积分流水（按时间倒序） */
router.get('/bean/ledger', async (req, res) => {
  try {
    const { page, pageSize } = pageQuery.parse(req.query)
    const where = { merchantId: req.merchantId! }
    const [list, total] = await Promise.all([
      prisma.beanLedger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          type: true,
          bucket: true,
          amount: true,
          balanceAfter: true,
          grantAfter: true,
          frozenAfter: true,
          bizType: true,
          bizId: true,
          remark: true,
          createdAt: true,
        },
      }),
      prisma.beanLedger.count({ where }),
    ])
    ok(res, {
      list: list.map((r) => ({
        ...r,
        id: r.id.toString(),
        amount: r.amount.toString(),
        balanceAfter: r.balanceAfter.toString(),
        grantAfter: r.grantAfter.toString(),
        frozenAfter: r.frozenAfter.toString(),
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    })
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    return fail(res, 500, '查询失败', 500)
  }
})

/** GET /bean/ai-logs — AI 调用日志（仅当前商家自己的调用） */
router.get('/bean/ai-logs', async (req, res) => {
  try {
    const { page, pageSize } = pageQuery.parse(req.query)
    const where = { merchantId: req.merchantId! }
    const [list, total] = await Promise.all([
      prisma.aiCallLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          sceneCode: true,
          requestId: true,
          isFallback: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          costFen: true,
          beanCharged: true,
          beanBucket: true,
          latencyMs: true,
          status: true,
          errorCode: true,
          errorMsg: true,
          createdAt: true,
        },
      }),
      prisma.aiCallLog.count({ where }),
    ])
    ok(res, {
      list: list.map((r) => ({
        ...r,
        id: r.id.toString(),
        beanCharged: r.beanCharged.toString(),
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    })
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    return fail(res, 500, '查询失败', 500)
  }
})

/** GET /membership/current — 当前生效订阅（独立端点，不需要分页） */
router.get('/membership/current', async (req, res) => {
  try {
    const m = await activeMembership(prisma, req.merchantId!)
    ok(res, {
      active: !!m,
      planName: m?.package.name ?? null,
      planCode: m?.package.code ?? null,
      startAt: m?.startAt.toISOString() ?? null,
      endAt: m?.endAt.toISOString() ?? null,
      grantPoints: m?.grantBeans.toString() ?? '0',
      grantExpireAt: m?.grantExpireAt?.toISOString() ?? null,
      status: m?.status ?? null,
    })
  } catch {
    return fail(res, 500, '查询失败', 500)
  }
})

export default router
