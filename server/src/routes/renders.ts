// 合成路由：提交合成 / 列表 / 详情
import { Router } from 'express'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as renderSvc from '../services/render.service.js'
import { BeanNotEnoughError } from '../bean/bean.service.js'
import { CreationNotFoundError } from '../services/creation.service.js'
import { SubscriptionRequiredError } from '../services/subscription.service.js'
import { RequestConflictError } from '../domain/request.js'

const router = Router()
router.use(auth)

const submitInput = z.object({
  mode: z.enum(['FULL', 'RECOLOR']).optional(),
  grade: z.enum(['BASIC', 'AI', 'PREMIUM']).optional(),
  color: z
    .object({
      brightness: z.number().int().min(-100).max(100),
      contrast: z.number().int().min(-100).max(100),
      saturation: z.number().int().min(-100).max(100),
      sharpen: z.number().int().min(-100).max(100),
    })
    .optional(),
  requestId: z.string().optional(),
  aiMode: z.boolean().optional(),
})

router.post('/:id/render', async (req, res) => {
  try {
    const body = submitInput.parse(req.body)
    const r = await renderSvc.submitRender(prisma, req.merchantId!, BigInt(req.params.id), {
      mode: body.mode ?? 'FULL',
      grade: body.grade,
      color: body.color,
      requestId: body.requestId ?? randomUUID(),
      aiMode: body.aiMode,
    })
    ok(res, r)
  } catch (e) {
    if (e instanceof BeanNotEnoughError) return fail(res, 2001, 'AI豆不足，请充值', 400)
    if (e instanceof CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
    if (e instanceof renderSvc.RenderNoAssetError) return fail(res, 4003, '请先为分镜上传素材', 400)
    if (e instanceof renderSvc.RenderAlreadyRunningError) return fail(res, 4001, '已有合成任务进行中', 409)
    if (e instanceof renderSvc.RenderDurationUnknownError) return fail(res, 4009, e.message, 400)
    if (e instanceof SubscriptionRequiredError) return fail(res, 2005, e.message, 403)
    if (e instanceof RequestConflictError) return fail(res, 2007, e.message, 409)
    return fail(res, 500, '提交合成失败', 500)
  }
})

router.get('/:id/renders', async (req, res) => {
  try {
    const list = await renderSvc.listRenders(prisma, req.merchantId!, BigInt(req.params.id))
    ok(res, list)
  } catch (e) {
    if (e instanceof CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
    return fail(res, 500, '查询失败', 500)
  }
})

router.get('/:id/render/:taskId', async (req, res) => {
  try {
    const task = await renderSvc.getRender(prisma, req.merchantId!, BigInt(req.params.taskId))
    ok(res, task)
  } catch (e) {
    if (e instanceof renderSvc.RenderNotFoundError) return fail(res, 4047, '合成任务不存在', 404)
    return fail(res, 500, '查询失败', 500)
  }
})

export default router
