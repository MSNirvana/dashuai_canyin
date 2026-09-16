// 创作路由：CRUD + 文案生成 + 分镜生成 + 分镜绑定素材
import { createRouter } from '../lib/async-router.js'
import { InvalidIdParamError, idParam, optionalIdParam } from '../lib/params.js'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import { requiredText, optionalText } from '../lib/validators.js'
import * as creationSvc from '../services/creation.service.js'
import { aiGateway } from '../ai/gateway-instance.js'
import { BeanNotEnoughError } from '../bean/bean.service.js'
import { ScenePendingError } from '../ai/ai.service.js'
import { SubscriptionRequiredError } from '../services/subscription.service.js'
import { RequestConflictError } from '../domain/request.js'

const router = createRouter()
router.use(auth)

/** 媒体文件访问前缀（本地存储签名 URL 与 COS 签名 URL 都以它为基准拼接） */
function mediaBaseUrl(req: import('express').Request): string {
  return `${req.protocol}://${req.get('host')}/api/v1/media`
}

const createInput = z.object({
  storeId: z.string().min(1),
  dishId: z.string().optional(),
  title: requiredText(255).optional(),
  track: z.enum(['TRAFFIC', 'INTRO', 'QUALITY', 'RECOMMEND']).optional(),
  complexity: z.enum(['SIMPLE', 'COMPLEX', 'FINE']).optional(),
})

const creationPatch = z.object({
  title: requiredText(255).optional(),
  // 口播文案会作为 {{copyText}} 喂给分镜提示词，纯空白值同样要 trim
  copyText: optionalText(20000),
  track: z.enum(['TRAFFIC', 'INTRO', 'QUALITY', 'RECOMMEND']).optional(),
  complexity: z.enum(['SIMPLE', 'COMPLEX', 'FINE']).optional(),
})

const shotPatch = z.object({
  assetId: z.string().optional(),
  trimStartMs: z.number().int().min(0).optional(),
  trimEndMs: z.number().int().min(0).optional(),
  // 分镜脚本编辑（不涉及素材）
  shotType: z.string().max(64).nullable().optional(),
  shotSize: z.string().max(16).nullable().optional(),
  durationSuggest: z.number().int().min(0).max(600).nullable().optional(),
  line: z.string().max(2000).nullable().optional(),
  visualReq: z.string().max(2000).nullable().optional(),
})

router.get('/', async (req, res) => {
  try {
    const storeId = optionalIdParam(req.query.storeId, 'storeId')
    const list = await creationSvc.listCreations(prisma, req.merchantId!, storeId)
    ok(res, list)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    console.error('[creations] 列表查询异常:', e)
    fail(res, 500, '查询失败', 500)
  }
})

router.post('/', async (req, res) => {
  try {
    const input = createInput.parse(req.body)
    const c = await creationSvc.createCreation(prisma, req.merchantId!, {
      storeId: idParam(input.storeId, 'storeId'),
      dishId: optionalIdParam(input.dishId, 'dishId'),
      title: input.title,
      track: input.track,
      complexity: input.complexity,
    })
    ok(res, c)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof creationSvc.CreationStoreMismatchError || e instanceof creationSvc.CreationDishMismatchError) return fail(res, 2004, e.message, 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[creations] 创建异常:', e)
    return fail(res, 500, '创建失败', 500)
  }
})

/** 保存编辑：标题 / 文案正文 / 款式 / 复杂度（编辑不扣积分） */
router.patch('/:id', async (req, res) => {
  try {
    const input = creationPatch.parse(req.body)
    const c = await creationSvc.updateCreation(prisma, req.merchantId!, idParam(req.params.id, 'id'), input)
    ok(res, c)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof creationSvc.CreationNotFoundError) fail(res, 4046, '创作不存在', 404)
    else if (e instanceof z.ZodError) fail(res, 400, '参数错误', 400)
    else fail(res, 400, '保存失败', 400)
  }
})

router.get('/:id', async (req, res) => {
  try {
    const c = await creationSvc.getCreation(
      prisma,
      req.merchantId!,
      idParam(req.params.id, 'id'),
      mediaBaseUrl(req),
    )
    ok(res, c)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof creationSvc.CreationNotFoundError) fail(res, 4046, '创作不存在', 404)
    else fail(res, 400, '查询失败', 400)
  }
})

/** 为已上传但缺封面的分镜补生成缩略图（本地存储模式用 ffmpeg 抽帧），返回生成数量 */
router.post('/:id/ensure-covers', async (req, res) => {
  try {
    const r = await creationSvc.ensureCreationCovers(prisma, req.merchantId!, idParam(req.params.id, 'id'))
    ok(res, r)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof creationSvc.CreationNotFoundError) fail(res, 4046, '创作不存在', 404)
    else fail(res, 500, '生成缩略图失败', 500)
  }
})

router.post('/:id/copy', async (req, res) => {
  try {
    const track = creationSvc.isCopyTrack(req.body?.track) ? req.body.track : undefined
    const r = await creationSvc.generateCopy(
      prisma,
      aiGateway,
      req.merchantId!,
      idParam(req.params.id, 'id'),
      String(req.body?.requestId ?? randomUUID()),
      track,
    )
    ok(res, r)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    handleAiErr(e, res)
  }
})

router.post('/:id/storyboard', async (req, res) => {
  try {
    const complexity = creationSvc.isComplexity(req.body?.complexity) ? req.body.complexity : undefined
    const r = await creationSvc.generateShots(
      prisma,
      aiGateway,
      req.merchantId!,
      idParam(req.params.id, 'id'),
      String(req.body?.requestId ?? randomUUID()),
      complexity,
    )
    ok(res, r)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    handleAiErr(e, res)
  }
})

router.put('/:id/shots/:shotId', async (req, res) => {
  try {
    const input = shotPatch.parse(req.body)
    const creationId = idParam(req.params.id, 'id')
    const shotId = idParam(req.params.shotId, 'shotId')
    // 脚本字段（景别/时长/台词/画面要求）走内容编辑
    const hasContent =
      input.shotType !== undefined ||
      input.shotSize !== undefined ||
      input.durationSuggest !== undefined ||
      input.line !== undefined ||
      input.visualReq !== undefined
    // 素材绑定字段（assetId/trim）走素材更新；两者可同时提交
    const hasAsset = input.assetId !== undefined || input.trimStartMs !== undefined || input.trimEndMs !== undefined

    let s: Awaited<ReturnType<typeof creationSvc.readShotOwned>> | null = null
    if (hasContent) {
      // 内部会先 getCreation 校验归属，越权即抛 CreationNotFoundError → 404
      s = await creationSvc.updateShotContent(prisma, req.merchantId!, creationId, shotId, {
        shotType: input.shotType,
        shotSize: input.shotSize,
        durationSuggest: input.durationSuggest,
        line: input.line,
        visualReq: input.visualReq,
      })
    }
    if (hasAsset) {
      s = await creationSvc.updateShotAsset(prisma, req.merchantId!, creationId, shotId, {
        assetId: input.assetId ? idParam(input.assetId, 'assetId') : undefined,
        trimStartMs: input.trimStartMs,
        trimEndMs: input.trimEndMs,
      })
    }
    if (!s) {
      // 既无脚本字段也无素材字段（body 为 {}）时走到这里。
      // 原实现直接 prisma.shot.findFirst({ id, creationId }) 回读，**未校验 creation 是否属于当前商户**，
      // 可越权读到他人创作的分镜台词（已实测复现）。改为带归属校验的读取。
      s = await creationSvc.readShotOwned(prisma, req.merchantId!, creationId, shotId)
    }
    ok(res, s)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof creationSvc.CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
    if (e instanceof creationSvc.ShotNotFoundError) return fail(res, 4047, '分镜不存在', 404)
    if (e instanceof creationSvc.CreationAssetMismatchError) return fail(res, 2004, e.message, 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[creations] 更新分镜异常:', e)
    return fail(res, 500, '更新分镜失败', 500)
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
