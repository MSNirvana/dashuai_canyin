// 镜头库公开列表：分镜头拍摄时给前端选/查看用，仅返回启用项
// 后台 CRUD 见 admin 路由（/admin/api/v1/shot-library）
import { createRouter } from '../lib/async-router.js'
import { InvalidIdParamError, idParam } from '../lib/params.js'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import { describeSharedPrefixes, isSharedAssetKey } from '../lib/shared-asset-key.js'
import * as mediaSvc from '../services/media.service.js'

const router = createRouter()
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
      where: { id: idParam(req.params.id, 'id') },
      select: { demoVideoKey: true, enabled: true },
    })
    if (!lib || !lib.enabled || !lib.demoVideoKey) return fail(res, 4048, '示范视频不存在', 404)
    /**
     * ★ 「不走商家前缀校验」≠「什么键都能签」。
     *
     * `demoVideoKey` 在后台是**自由文本框**（见 admin.ts 的 shotLibInput），
     * 而这条路由是**登录商户**就能调的读接口。少了下面这一行，谁把那列填成
     * `uploads/2/xxx.mp4`，任何登录商户都会拿到商户 2 私有文件的签名地址 ——
     * 越权读，且日志里看不出异常（签出去的是合法签名、状态码 200）。
     *
     * 白名单只放行平台共享前缀（tutorials / works / static），
     * 商户级的 uploads / renders 一律拒绝；路径安全校验也在里面（防 `../` 穿越）。
     * 存量数据不受影响：改这一行之前库里 `demo_video_key` 全为空。
     */
    if (!isSharedAssetKey(lib.demoVideoKey)) {
      console.warn(
        `[shot-library] 拒绝签名：demoVideoKey 不在平台共享前缀内（允许 ${describeSharedPrefixes()}）id=${req.params.id}`,
      )
      return fail(res, 4048, '示范视频不存在', 404)
    }
    const r = await mediaSvc.getSharedPlayUrlByKey(
      lib.demoVideoKey,
      `${req.protocol}://${req.get('host')}/api/v1/media`,
    )
    ok(res, r)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    return fail(res, 500, '获取示范视频失败', 500)
  }
})

export default router
