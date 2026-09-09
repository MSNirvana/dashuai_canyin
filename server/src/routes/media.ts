// 素材播放路由：返回私有桶临时签名 URL（有效期 1 小时），供小程序 <video> 播放
import { Router } from 'express'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as mediaSvc from '../services/media.service.js'
import { contentTypeForKey, isLocalStorage, localPathForKey, verifyLocalMediaToken } from '../lib/local-storage.js'

const router = Router()

// 本地开发播放：URL 自带短期 HMAC 令牌，供小程序 video/downloadFile 直接访问。
// 放在 auth 之前，避免小程序二次请求视频时还要附带 Bearer 头。
router.get('/file', (req, res) => {
  if (!isLocalStorage()) return fail(res, 4040, '接口不存在', 404)
  const key = String(req.query.key ?? '')
  const expires = String(req.query.expires ?? '')
  const token = String(req.query.token ?? '')
  try {
    const path = localPathForKey(key)
    if (!verifyLocalMediaToken(key, expires, token)) return fail(res, 1001, '播放链接已过期', 401)
    return res.sendFile(path, { headers: { 'Content-Type': contentTypeForKey(key), 'Cache-Control': 'private, max-age=300' } }, (err) => {
      if (err && !res.headersSent) fail(res, 3002, '素材不存在或未就绪', 404)
    })
  } catch {
    return fail(res, 3005, '素材路径无权限', 403)
  }
})

router.use(auth)

router.get('/:assetId/play-url', async (req, res) => {
  try {
    const r = await mediaSvc.getPlayUrl(
      prisma,
      req.merchantId!,
      BigInt(req.params.assetId),
      `${req.protocol}://${req.get('host')}${req.baseUrl}`,
    )
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
    const r = await mediaSvc.getPlayUrlByKey(
      req.merchantId!,
      key,
      `${req.protocol}://${req.get('host')}${req.baseUrl}`,
    )
    ok(res, r)
  } catch (e) {
    if (e instanceof mediaSvc.MediaKeyPrefixError) return fail(res, 3005, '素材路径无权限', 403)
    return fail(res, 500, '获取播放地址失败', 500)
  }
})

export default router
