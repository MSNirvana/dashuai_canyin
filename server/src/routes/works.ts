// 首页「优秀作品」：小程序侧只读接口（列表 / 分类 / 详情 / 计数）
// 后台 CRUD 见 /admin/api/v1/works
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as workSvc from '../services/work.service.js'
import { getSharedPlayUrlByKey } from '../services/media.service.js'

const router = Router()
router.use(auth)

const listQuery = z.object({
  category: z.string().max(32).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(6),
})

router.get('/', async (req, res) => {
  try {
    const q = listQuery.parse(req.query)
    const r = await workSvc.listWorks(prisma, q)
    // 封面在私有桶里，列表直接回签名地址，避免小程序为每张封面再发一次请求
    const mediaBase = `${req.protocol}://${req.get('host')}/api/v1/media`
    const items = await Promise.all(
      r.items.map(async (w) => ({
        ...w,
        coverUrl: w.coverKey ? (await getSharedPlayUrlByKey(w.coverKey, mediaBase)).url : null,
      })),
    )
    ok(res, { ...r, items })
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[works] 查询作品列表失败:', e)
    return fail(res, 500, '查询失败', 500)
  }
})

/** 分类 + 数量：首页分类横滑的数据源，避免前端写死分类 */
router.get('/categories', async (_req, res) => {
  try {
    ok(res, await workSvc.listCategories(prisma))
  } catch (e) {
    console.error('[works] 查询分类失败:', e)
    fail(res, 500, '查询失败', 500)
  }
})

router.get('/:id', async (req, res) => {
  try {
    const work = await workSvc.getWork(prisma, BigInt(req.params.id))
    const mediaBase = `${req.protocol}://${req.get('host')}/api/v1/media`
    const [cover, video] = await Promise.all([
      work.coverKey ? getSharedPlayUrlByKey(work.coverKey, mediaBase) : Promise.resolve(null),
      work.videoKey ? getSharedPlayUrlByKey(work.videoKey, mediaBase) : Promise.resolve(null),
    ])
    ok(res, {
      ...work,
      coverUrl: cover?.url ?? null,
      videoUrl: video?.url ?? null,
    })
  } catch (e) {
    if (e instanceof workSvc.WorkNotFoundError) return fail(res, 4048, e.message, 404)
    console.error('[works] 查询作品详情失败:', e)
    return fail(res, 500, '查询失败', 500)
  }
})

/** 打开详情即计一次浏览；前端不等待结果 */
router.post('/:id/view', async (req, res) => {
  try {
    await workSvc.bumpViewCount(prisma, BigInt(req.params.id))
    ok(res, { counted: true })
  } catch (e) {
    console.error('[works] 浏览量自增失败:', e)
    fail(res, 500, '计数失败', 500)
  }
})

/** 点「生成同款」时调用，用于统计哪条作品最带货 */
router.post('/:id/clone', async (req, res) => {
  try {
    await workSvc.bumpCloneCount(prisma, BigInt(req.params.id))
    ok(res, { counted: true })
  } catch (e) {
    console.error('[works] 同款计数失败:', e)
    fail(res, 500, '计数失败', 500)
  }
})

export default router
