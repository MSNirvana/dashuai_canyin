// 合成路由：提交合成 / 列表 / 详情
import { createRouter } from '../lib/async-router.js'
import { InvalidIdParamError, idParam } from '../lib/params.js'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as renderSvc from '../services/render.service.js'
import { getCreation, CreationNotFoundError } from '../services/creation.service.js'
import { requireSubscription, SubscriptionRequiredError } from '../services/subscription.service.js'
import { getGeneratedPlayUrl } from '../services/media.service.js'
import {
  buildColorPreview,
  ColorPreviewNoopError,
  ColorPreviewBusyError,
} from '../render/preview.js'
import { BeanNotEnoughError } from '../bean/bean.service.js'
import { RequestConflictError } from '../domain/request.js'

const router = createRouter()
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
  requestId: z.string().trim().min(8).max(64).optional(),
  aiMode: z.boolean().optional(),
  chatcut: z.object({
    voiceId: z.enum(['warm-female', 'bright-female', 'gentle-male', 'magnetic-male', 'energetic-youth']).optional(),
    subtitles: z.boolean().optional(),
    subtitleStyle: z.enum(['CLEAN', 'EMPHASIS', 'SOCIAL']).optional(),
    bgm: z.enum(['NONE', 'LIGHT', 'UPBEAT', 'PREMIUM']).optional(),
    pacing: z.enum(['NATURAL', 'FAST', 'STORY']).optional(),
    transitions: z.enum(['CLEAN', 'SMOOTH', 'DYNAMIC']).optional(),
    removeSilence: z.boolean().optional(),
    normalizeAudio: z.boolean().optional(),
    note: z.string().trim().max(300).optional(),
  }).optional(),
})

router.post('/:id/render', async (req, res) => {
  try {
    const body = submitInput.parse(req.body)
    const r = await renderSvc.submitRender(prisma, req.merchantId!, idParam(req.params.id, 'id'), {
      mode: body.mode ?? 'FULL',
      grade: body.grade,
      color: body.color,
      requestId: body.requestId ?? randomUUID(),
      aiMode: body.aiMode,
      chatcut: body.chatcut,
    })
    ok(res, r)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof BeanNotEnoughError) return fail(res, 2001, 'AI豆不足，请充值', 400)
    if (e instanceof CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
    if (e instanceof renderSvc.RenderNoAssetError) return fail(res, 4003, '请先为分镜上传素材', 400)
    if (e instanceof renderSvc.RenderAlreadyRunningError) return fail(res, 4001, '已有合成任务进行中', 409)
    if (e instanceof renderSvc.RenderDurationUnknownError) return fail(res, 4009, e.message, 400)
    if (e instanceof renderSvc.RenderGradeUnavailableError) return fail(res, 4013, e.message, 409)
    if (e instanceof SubscriptionRequiredError) return fail(res, 2005, e.message, 403)
    if (e instanceof RequestConflictError) return fail(res, 2007, e.message, 409)
    return fail(res, 500, '提交合成失败', 500)
  }
})

/**
 * 整片调色预览。
 *
 * 与合成的关系：**不冻结豆、不建任务、不扣费** —— 它只是按当前调色参数把尚未调色的成片
 * 重编一版低码率预览，给用户「调完先看一眼」用。真正出片仍走 POST /:id/render（RECOLOR）。
 *
 * 为什么要订阅门槛：预览是**整片**的（用户明确要的），因此它在内容上等价于成片。
 * 不加门槛的话，「调色预览」就成了绕开扣豆拿视频的免费通道。
 *
 * ★ 限流不在这里做，而在 buildColorPreview 内部「缓存未命中 / 未复用 in-flight」之后 ——
 *   那边才知道这次请求是不是真的要花算力。路由层调用会连带把「命中缓存的重复请求」
 *   也算成一次额度，把限流变成误伤。4029 仍然由这里翻译成 HTTP 429。
 */
const previewInput = z.object({
  color: z.object({
    brightness: z.number().int().min(-100).max(100),
    contrast: z.number().int().min(-100).max(100),
    saturation: z.number().int().min(-100).max(100),
    sharpen: z.number().int().min(-100).max(100),
  }),
})

router.post('/:id/render/preview', async (req, res) => {
  try {
    const body = previewInput.parse(req.body)
    const merchantId = req.merchantId!
    const creationId = idParam(req.params.id, 'id')

    await requireSubscription(prisma, merchantId, '调色预览')
    const creation = await getCreation(prisma, merchantId, creationId) // 校验归属
    const clips = await renderSvc.buildRenderClips(prisma, merchantId, creationId, creation.storeId)

    const result = await buildColorPreview({
      merchantId,
      clips,
      color: body.color,
      output: renderSvc.RENDER_OUTPUT,
    })

    // 本地存储模式走 /api/v1/media/file 的 HMAC 链接，COS 模式走 SDK 签名
    const play = await getGeneratedPlayUrl(result.key, `${req.protocol}://${req.get('host')}/api/v1/media`)
    ok(res, { url: play.url, dev: play.dev, cached: result.cached, elapsedMs: result.elapsedMs })
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof ColorPreviewNoopError) return fail(res, 4014, e.message, 400)
    if (e instanceof ColorPreviewBusyError) return fail(res, 4029, e.message, 429)
    if (e instanceof SubscriptionRequiredError) return fail(res, 2005, e.message, 403)
    if (e instanceof CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
    if (e instanceof renderSvc.RenderNoAssetError) return fail(res, 4003, '请先为分镜上传素材', 400)
    console.error('[render] 调色预览失败:', e)
    return fail(res, 4015, '预览生成失败，请稍后重试', 500)
  }
})

router.get('/:id/renders', async (req, res) => {
  try {
    const list = await renderSvc.listRenders(prisma, req.merchantId!, idParam(req.params.id, 'id'))
    ok(res, list)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
    return fail(res, 500, '查询失败', 500)
  }
})

router.get('/:id/render/:taskId', async (req, res) => {
  try {
    const task = await renderSvc.getRender(prisma, req.merchantId!, idParam(req.params.taskId, 'taskId'))
    ok(res, task)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof renderSvc.RenderNotFoundError) return fail(res, 4047, '合成任务不存在', 404)
    return fail(res, 500, '查询失败', 500)
  }
})

export default router
