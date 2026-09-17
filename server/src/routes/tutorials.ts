// 教学中心（小程序侧只读）：分类概览 + 分类下的课程列表。
// 后台 CRUD 与上传见 /admin/api/v1/tutorials（admin.ts）。
//
// ★ 故意**不鉴权**（和其它业务接口不一样，改回去之前先读完这段）。
//
// 内容上说得通：拍摄技巧 / 剪辑教程 / 运营知识 / 使用手册都是平台自有的教学素材，
// 不含任何商户数据；未登录的人看得到「怎么用」，才谈得上后面去开通。
//
// 但真正非改不可的理由是另一个 —— 这里是**全站唯一「未登录也能点进来」的数据页**，
// 一旦它按 401 处理，会撞上请求层那条自带的连锁反应：
//
//   「我的」页的登录弹窗**可以被 × 关掉**（见 pages/mine 的 onChangeAvatar 注释），
//   关掉之后四宫格仍然可点 ⇒ 未登录（或 token 过期且 refreshToken 也失效）时点进本页
//   ⇒ 首个请求拿到 401 / code 1001 ⇒ 请求层 redirectToLogin()
//   ⇒ 300ms 后 Taro.switchTab('/pages/mine/index')
//   ⇒ 这一下正好落在**还没落定的 navigateTo** 上，把它打断。
//      微信侧报的错就是 `navigateTo:fail timeout`：文案像「目标页加载超时」，
//      实际是导航被另一个跳转顶掉了 —— 请求层里那段注释写的就是同一件事。
//   表现给人看就是：点「拍摄技巧」→ 空白页 / 弹回「我的」，控制台一行 MiniProgramError。
//
// 把读接口放开之后，这条链路根本不会被触发。
import { createRouter } from '../lib/async-router.js'
import { z } from 'zod'
import { prisma } from '../db.js'
import { ok, fail } from '../lib/result.js'
import { tutorialCategoryEnum } from '../lib/tutorial-categories.js'
import * as tutorialSvc from '../services/tutorial.service.js'

const router = createRouter()

/** 分类概览：给「我的」页那个四宫格用（含每个分类的课程数） */
router.get('/', async (_req, res) => {
  try {
    ok(res, { categories: await tutorialSvc.listCategoryStats(prisma) })
  } catch (e) {
    console.error('[tutorials] 查询分类概览失败:', e)
    return fail(res, 500, '查询失败', 500)
  }
})

/**
 * 某个分类下的课程列表。大小写不敏感（统一 upper 后比对），
 * 但**白名单在这里是权威闸门**：不在四个码值里直接 400，不去查库。
 */
router.get('/:category', async (req, res) => {
  try {
    const raw = String(req.params.category ?? '').toUpperCase()
    const parsed = z.enum(tutorialCategoryEnum).safeParse(raw)
    if (!parsed.success) return fail(res, 400, '分类不存在', 400)

    // 本地模式下签名地址要指向**当前请求的 host**，否则真机拿到 127.0.0.1（见 works.ts 的同款做法）
    const mediaBase = `${req.protocol}://${req.get('host')}/api/v1/media`
    const items = await tutorialSvc.listByCategory(prisma, parsed.data, mediaBase)
    ok(res, { category: parsed.data, items })
  } catch (e) {
    console.error('[tutorials] 查询课程列表失败:', e)
    return fail(res, 500, '查询失败', 500)
  }
})

export default router
