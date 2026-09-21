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

/**
 * 菜品稿可选的文案款式。
 * ★ 流量款**不在其中** —— 它已从「四款文案」拆成独立功能（话题稿 `mode='TOPIC'`），
 *   只走 `copy_traffic` 那份不喂门店/菜品的模板。放进这个枚举，后台手填或旧客户端传
 *   `track='TRAFFIC'` 就会创建出一条「菜品稿却挂着流量款」的创作，而它生成时会用话题模板
 *   —— 文案里既没门店也没菜品，且不报错。旧客户端若传 TRAFFIC 会拿到 400 而不是静默变味。
 */
const DISH_TRACKS = ['INTRO', 'QUALITY', 'RECOMMEND'] as const

const createInput = z.object({
  /**
   * 菜品稿必填、话题稿**必须不传**（传了 service 会抛 TopicCreationStoreForbiddenError）。
   * 这里放宽成 optional 是因为两态的必填性不同，交给 service 一处判定，
   * 免得同一条规则在 schema 与 service 里各写一半、日后只改一处。
   */
  storeId: z.string().min(1).optional(),
  dishId: z.string().optional(),
  /** 内容模式；不传 = 菜品稿（保持既有客户端行为不变） */
  mode: z.enum(['DISH', 'TOPIC']).optional(),
  /**
   * ⚠ 这里**没有** `topicCity`，是 2026-09-21 刻意移除的，不要再加回来。
   *
   * 话题稿的地域钩子改成从**宿主门店档案**直接取（用户原话：「同城落点不需要，
   * 直接获取店铺位置就行了，没有填写位置就不要这个信息」）⇒ 界面上那个输入框已经删掉。
   * 于是它既不该是入参，也不该被静默接受 —— 留一个「传了会生效」的口子，
   * 等于允许前端把地域钩子改成用户没填过的值，而文案里出现的地点没人能追溯。
   *
   * ★ 被剥离（不是报 400）：`z.object` 默认 strip，旧小程序包多传的 `topicCity` 会被丢掉。
   *   这是刻意的向后兼容 —— 那个字段是可选的地域钩子，为它把整次创建打失败会让
   *   旧包用户**完全用不了话题稿**；而丢掉它恰好等于新语义（位置由门店档案决定）。
   */
  title: requiredText(255).optional(),
  track: z.enum(DISH_TRACKS).optional(),
  complexity: z.enum(['SIMPLE', 'COMPLEX', 'FINE']).optional(),
  // 同款作品的分镜骨架（来自 excellent_work.recipe_json）：有值时在创建的同时**落成初始分镜**，
  // 前端随即跳过 AI 分镜那一步（省一次真实扣费），用户不满意再点「重新生成」整批换成 AI 版。
  // 上限 20 与后台「分镜骨架」那个录入框的上限一致；字段长度与 shotPatch 同口径。
  shotSkeleton: z
    .array(
      z.object({
        shotType: z.string().max(64).optional(),
        shotSize: z.string().max(16).optional(),
        durationSuggest: z.number().int().min(0).max(600).optional(),
        line: z.string().max(2000).optional(),
        visualReq: z.string().max(2000).optional(),
      }),
    )
    .max(20)
    .optional(),
})

const creationPatch = z.object({
  title: requiredText(255).optional(),
  // 口播文案会作为 {{copyText}} 喂给分镜提示词，纯空白值同样要 trim
  copyText: optionalText(20000),
  // 同 createInput：菜品稿三款；流量款属话题稿，不在枚举里（传了会 400）
  track: z.enum(DISH_TRACKS).optional(),
  complexity: z.enum(['SIMPLE', 'COMPLEX', 'FINE']).optional(),
  // ⚠ 同上：`topicCity` 也**不在**这个 patch 里（2026-09-21 移除）。
  //   地域钩子只在创建时从门店档案取一次快照，之后不接受任何来源的改动 ——
  //   否则「重新生成时结果不可复现」这件事会从一个入口漏回来。
  //   旧包传上来会被 strip 掉，不报错（旧包里那是个选填项，没人为它把编辑请求打失败）。
})

const shotPatch = z.object({
  assetId: z.string().optional(),
  trimStartMs: z.number().int().min(0).optional(),
  trimEndMs: z.number().int().min(0).optional(),
  // 「暂不上传该分镜」：落库的跳过标记（与 assetId 互斥，见 creationSvc.updateShotAsset）
  skipped: z.boolean().optional(),
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
    // 归档分类用 ?archived=1 拉取。不传就是默认列表 —— 服务层会排除已归档的，
    // 所以「归档后不出现在全部/进行中/已就绪」是服务端保证的，不是前端过滤出来的。
    const archived = req.query.archived === '1' || req.query.archived === 'true'
    const list = await creationSvc.listCreations(prisma, req.merchantId!, storeId, {
      archived,
      // 列表卡片要显示「第一个已上传视频的缩略图」，封面是签名 URL ⇒ 与详情接口用同一个 base
      mediaBaseUrl: mediaBaseUrl(req),
    })
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
      storeId: input.storeId === undefined ? undefined : idParam(input.storeId, 'storeId'),
      dishId: optionalIdParam(input.dishId, 'dishId'),
      mode: input.mode,
      title: input.title,
      track: input.track,
      complexity: input.complexity,
      shotSkeleton: input.shotSkeleton,
    })
    ok(res, c)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof creationSvc.CreationStoreMismatchError || e instanceof creationSvc.CreationDishMismatchError) return fail(res, 2004, e.message, 400)
    // 话题稿的两种前置条件单列错误码：前端要区分「参数传错了」（开发期问题）
    // 与「还没建门店」（用户能自己解决，要引导到门店页）
    if (e instanceof creationSvc.TopicCreationStoreForbiddenError) return fail(res, 2002, e.message, 400)
    if (e instanceof creationSvc.TopicHostStoreMissingError) return fail(res, 2011, e.message, 400)
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

/** 归档：从「全部 / 进行中 / 已就绪」移出，只在「归档」分类可见 */
router.post('/:id/archive', async (req, res) => {
  try {
    const r = await creationSvc.archiveCreation(prisma, req.merchantId!, idParam(req.params.id, 'id'))
    ok(res, r)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof creationSvc.CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
    console.error('[creations] 归档异常:', e)
    fail(res, 500, '归档失败', 500)
  }
})

/** 恢复：把归档的创作放回默认列表 */
router.post('/:id/unarchive', async (req, res) => {
  try {
    const r = await creationSvc.unarchiveCreation(prisma, req.merchantId!, idParam(req.params.id, 'id'))
    ok(res, r)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof creationSvc.CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
    console.error('[creations] 恢复异常:', e)
    fail(res, 500, '恢复失败', 500)
  }
})

/** 删除（服务层写 deletedAt 软删）：不可恢复，前端必须先弹确认 */
router.delete('/:id', async (req, res) => {
  try {
    const r = await creationSvc.deleteCreation(prisma, req.merchantId!, idParam(req.params.id, 'id'))
    ok(res, r)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof creationSvc.CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
    console.error('[creations] 删除异常:', e)
    fail(res, 500, '删除失败', 500)
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
    const hasAsset =
      input.assetId !== undefined ||
      input.trimStartMs !== undefined ||
      input.trimEndMs !== undefined ||
      input.skipped !== undefined

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
        skipped: input.skipped,
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
  if (e instanceof BeanNotEnoughError) return fail(res, 2001, '积分不足，请充值', 400)
  if (e instanceof creationSvc.CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
  if (e instanceof SubscriptionRequiredError) return fail(res, 2005, e.message, 403)
  if (e instanceof RequestConflictError) return fail(res, 2007, e.message, 409)
  if (e instanceof ScenePendingError) return fail(res, 2006, '任务进行中或上次失败，请换 requestId 重试', 409)
  return fail(res, 500, '生成失败', 500)
}

export default router
