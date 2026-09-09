// 素材播放路由：返回私有桶临时签名 URL（有效期 1 小时），供小程序 <video> 播放
import { Router } from 'express'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as mediaSvc from '../services/media.service.js'

const router = Router()
router.use(auth)

router.get('/:assetId/play-url', async (req, res) => {
  try {
    const r = await mediaSvc.getPlayUrl(prisma, req.merchantId!, BigInt(req.params.assetId))
    ok(res, r)
  } catch (e) {
    if (e instanceof mediaSvc.MediaNotFoundError) return fail(res, 3002, '素材不存在或未就绪', 404)
    return fail(res, 500, '获取播放地址失败', 500)
  }
})

router.get('/play-url', async (req, res) => {
  try {
    const key = String(req.query.key ?? '')
    if (!key) return fail(res, 3004, '缺少 key', 400)
    const r = await mediaSvc.getPlayUrlByKey(req.merchantId!, key)
    ok(res, r)
  } catch (e) {
    if (e instanceof mediaSvc.MediaKeyPrefixError) return fail(res, 3005, '素材路径无权限', 403)
    return fail(res, 500, '获取播放地址失败', 500)
  }
})

export default router
