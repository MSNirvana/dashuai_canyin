// 首页「优秀作品」：小程序侧只读接口（列表 / 分类 / 详情）+ 两个计数接口。
// 后台 CRUD 见 /admin/api/v1/works
//
// ★ 故意**不鉴权**（与 tutorials.ts 一起，是全站仅有的两个；改回去之前先读完这段）。
//
// ① 内容上说得通：这里读的是运营从成片里主动挑出来、**就是要给所有商户看**的作品。
//    service 层每个查询都带 `enabled: true, deletedAt: null`（见 work.service.ts），
//    整条线上没有任何商户维度的字段 —— 未登录的人看不到别人的数据，
//    因为这里本来就不存在「别人的数据」。
//
// ② 非改不可的理由和 tutorials.ts 那一套一样，而这里**更前置**：
//    首页 pages/home 是 tab 页，未登录也进得来，而它在 useDidShow 里就会拉这两个接口。
//    只要它们按 401 处理，请求层就走 redirectToLogin()（见 apps/mini/src/services/request.ts）：
//    300ms 后 switchTab 到「我的」—— 未登录用户**一打开小程序就被从首页弹走**，
//    连首页那句口号都留不住。真机日志里那两条
//    `GET /api/v1/works?page=1&pageSize=6 401`、`GET /api/v1/works/categories 401`
//    就是这条链路的起点。
//
// ③ 两个计数 POST 必须和三个 GET **一起**公开，不能只放 GET：
//    详情页拿到视频后立刻调 markWorkView，首页卡片与详情页的「生成同款」调 markWorkClone。
//    留着它们走 401，用户「点一次播放 / 点一次同款」就会被上面那条链路弹走 ——
//    症状从「一进首页就跳走」变成「一点就跳走」，更难查。
//    取舍：计数因此可被未登录请求刷。但这两个接口只做 viewCount/cloneCount + 1，
//    没有入参、不写别的表，而且**登录用户本来也能无限制地刷**（无去重、无限流），
//    放宽到匿名不新增实质风险；运营看的是相对热度，不是绝对真值。
//
// ④ 公开的前提是下面 signWorkUrl 那道**前缀守卫**还在 —— 见它的注释。
//    那条才是这个文件上的安全边界，与鉴权无关，**别顺手删掉**。
import { createRouter } from '../lib/async-router.js'
import { InvalidIdParamError, idParam } from '../lib/params.js'
import { z } from 'zod'
import { prisma } from '../db.js'
import { ok, fail } from '../lib/result.js'
import * as workSvc from '../services/work.service.js'
import { getSharedPlayUrlByKey } from '../services/media.service.js'

const router = createRouter()

/**
 * 把作品的对象键签成临时播放地址。
 *
 * ★ 为什么不直接 `getSharedPlayUrlByKey`：它**不校验前缀**（本来就是给平台共享资源用的），
 *   而作品的 coverKey / videoKey 在后台是**可以手工填的自由文本框**。
 *   少了这道守卫，谁把那两列填成 `uploads/2/xxx.mp4`，任何请求这条作品详情的人
 *   都会拿到商户 2 私有文件的签名地址 —— 越权读，且日志里看不出异常。
 *   本路由已改成免登录（见文件头），这道守卫因此**比原来更要紧**。
 *   前缀白名单见 work.service.ts::isSignableWorkKey（只放行 `works/` 与 `renders/`，
 *   **不含 `uploads/`**；含 `renders/` 是因为存量作品在那里）。
 *
 * 失败返回 null 而不是抛：封面签不出来只是裂一张图，不该让整个列表 500。
 */
async function signWorkUrl(key: string | null | undefined, baseUrl: string): Promise<string | null> {
  if (!workSvc.isSignableWorkKey(key)) return null
  try {
    return (await getSharedPlayUrlByKey(key, baseUrl)).url
  } catch {
    return null
  }
}

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
        coverUrl: await signWorkUrl(w.coverKey, mediaBase),
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
    const work = await workSvc.getWork(prisma, idParam(req.params.id, 'id'))
    const mediaBase = `${req.protocol}://${req.get('host')}/api/v1/media`
    const [coverUrl, videoUrl] = await Promise.all([
      signWorkUrl(work.coverKey, mediaBase),
      signWorkUrl(work.videoKey, mediaBase),
    ])
    ok(res, {
      ...work,
      coverUrl,
      videoUrl,
    })
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof workSvc.WorkNotFoundError) return fail(res, 4048, e.message, 404)
    console.error('[works] 查询作品详情失败:', e)
    return fail(res, 500, '查询失败', 500)
  }
})

/** 打开详情即计一次浏览；前端不等待结果 */
router.post('/:id/view', async (req, res) => {
  try {
    await workSvc.bumpViewCount(prisma, idParam(req.params.id, 'id'))
    ok(res, { counted: true })
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    console.error('[works] 浏览量自增失败:', e)
    fail(res, 500, '计数失败', 500)
  }
})

/** 点「生成同款」时调用，用于统计哪条作品最带货 */
router.post('/:id/clone', async (req, res) => {
  try {
    await workSvc.bumpCloneCount(prisma, idParam(req.params.id, 'id'))
    ok(res, { counted: true })
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    console.error('[works] 同款计数失败:', e)
    fail(res, 500, '计数失败', 500)
  }
})

export default router
