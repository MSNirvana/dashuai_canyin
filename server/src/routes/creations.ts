// 创作路由：CRUD + 文案生成 + 分镜生成 + 分镜绑定素材
import { Router } from 'express'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as creationSvc from '../services/creation.service.js'
import { aiGateway } from '../ai/gateway-instance.js'
import { BeanNotEnoughError } from '../bean/bean.service.js'
import { ScenePendingError } from '../ai/ai.service.js'
import { SubscriptionRequiredError } from '../services/subscription.service.js'
import { RequestConflictError } from '../domain/request.js'

const router = Router()
router.use(auth)

const createInput = z.object({
  storeId: z.string().min(1),
  dishId: z.string().optional(),
  title: z.string().max(255).optional(),
})

const shotPatch = z.object({
  assetId: z.string().optional(),
  trimStartMs: z.number().int().min(0).optional(),
  trimEndMs: z.number().int().min(0).optional(),
})

router.get('/', async (req, res) => {
  const storeId = req.query.storeId ? BigInt(req.query.storeId as string) : undefined
  const list = await creationSvc.listCreations(prisma, req.merchantId!, storeId)
  ok(res, list)
})

router.post('/', async (req, res) => {
  try {
    const input = createInput.parse(req.body)
    const c = await creationSvc.createCreation(prisma, req.merchantId!, {
      storeId: BigInt(input.storeId),
      dishId: input.dishId ? BigInt(input.dishId) : undefined,
      title: input.title,
    })
    ok(res, c)
  } catch (e) {
    if (e instanceof creationSvc.CreationStoreMismatchError || e instanceof creationSvc.CreationDishMismatchError) fail(res, 2004, e.message, 400)
    else fail(res, 400, '创建失败', 400)
  }
})

router.get('/:id', async (req, res) => {
  try {
    const c = await creationSvc.getCreation(prisma, req.merchantId!, BigInt(req.params.id))
    ok(res, c)
  } catch (e) {
    if (e instanceof creationSvc.CreationNotFoundError) fail(res, 4046, '创作不存在', 404)
    else fail(res, 400, '查询失败', 400)
  }
})

router.post('/:id/copy', async (req, res) => {
  try {
    const r = await creationSvc.generateCopy(
      prisma,
      aiGateway,
      req.merchantId!,
      BigInt(req.params.id),
      String(req.body?.requestId ?? randomUUID()),
    )
    ok(res, r)
  } catch (e) {
    handleAiErr(e, res)
  }
})

router.post('/:id/storyboard', async (req, res) => {
  try {
    const r = await creationSvc.generateShots(
      prisma,
      aiGateway,
      req.merchantId!,
      BigInt(req.params.id),
      String(req.body?.requestId ?? randomUUID()),
    )
    ok(res, r)
  } catch (e) {
    handleAiErr(e, res)
  }
})

router.put('/:id/shots/:shotId', async (req, res) => {
  try {
    const input = shotPatch.parse(req.body)
    const s = await creationSvc.updateShotAsset(
      prisma,
      req.merchantId!,
      BigInt(req.params.id),
      BigInt(req.params.shotId),
      {
        assetId: input.assetId ? BigInt(input.assetId) : undefined,
        trimStartMs: input.trimStartMs,
        trimEndMs: input.trimEndMs,
      },
    )
    ok(res, s)
  } catch (e) {
    if (e instanceof creationSvc.CreationNotFoundError) fail(res, 4046, '创作不存在', 404)
    else fail(res, 400, '更新分镜失败', 400)
  }
})

function handleAiErr(e: unknown, res: import('express').Response) {
  // 真实异常必须落日志：既有 bug 是 catch 吞掉后 500 无任何排查线索
  if (!(e instanceof BeanNotEnoughError) && !(e instanceof creationSvc.CreationNotFoundError) && !(e instanceof ScenePendingError) && !(e instanceof SubscriptionRequiredError) && !(e instanceof RequestConflictError)) {
    console.error('[creations] AI 调用异常:', e)
  }
  if (e instanceof BeanNotEnoughError) return fail(res, 2001, 'AI豆不足，请充值', 400)
  if (e instanceof creationSvc.CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
  if (e instanceof SubscriptionRequiredError) return fail(res, 2005, e.message, 403)
  if (e instanceof RequestConflictError) return fail(res, 2007, e.message, 409)
  if (e instanceof ScenePendingError) return fail(res, 2006, '任务进行中或上次失败，请换 requestId 重试', 409)
  return fail(res, 500, '生成失败', 500)
}

export default router
