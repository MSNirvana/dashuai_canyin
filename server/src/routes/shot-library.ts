// 镜头库公开列表：分镜头拍摄时给前端选/查看用，仅返回启用项
// 后台 CRUD 见 admin 路由（/admin/api/v1/shot-library）
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as mediaSvc from '../services/media.service.js'

const router = Router()
router.use(auth)

router.get('/', async (req, res) => {
  try {
    const category = z.string().optional().parse(req.query.category)
    const list = await prisma.shotLibrary.findMany({
      where: { enabled: true, ...(category ? { category } : {}) },
      orderBy: [{ category: 'asc' }, { sort: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        category: true,
        tips: true,
        demoVideoKey: true,
        demoCoverKey: true,
        sort: true,
      },
    })
    ok(res, list)
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    return fail(res, 500, '查询失败', 500)
  }
})

/** 镜头示范视频私有签名 URL（有效 1 小时）。示范视频为后台配置的共享资源，不走商家前缀校验 */
router.get('/:id/demo-play-url', async (req, res) => {
  try {
    const lib = await prisma.shotLibrary.findUnique({
      where: { id: BigInt(req.params.id) },
      select: { demoVideoKey: true, enabled: true },
    })
    if (!lib || !lib.enabled || !lib.demoVideoKey) return fail(res, 4048, '示范视频不存在', 404)
    const r = await mediaSvc.getSharedPlayUrlByKey(lib.demoVideoKey)
    ok(res, r)
  } catch {
    return fail(res, 500, '获取示范视频失败', 500)
  }
})

export default router
