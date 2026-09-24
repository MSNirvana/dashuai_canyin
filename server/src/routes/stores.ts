// 门店路由（需鉴权）。X-Store-Id 由前端在请求头携带，用于上下文切换
import { createRouter } from '../lib/async-router.js'
import { InvalidIdParamError, idParam } from '../lib/params.js'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import { requiredText, optionalText, nullableText } from '../lib/validators.js'
import * as storeSvc from '../services/store.service.js'

const router = createRouter()
router.use(auth)

// 用户输入的文本一律走 validators 的工厂函数：`.trim()` 漏掉是静默失效
// （`z.string().min(1)` 会让 "   " 通过，库里存下纯空白的名称/品类/城市）
const storeInput = z.object({
  name: requiredText(128),
  category: optionalText(64),
  province: optionalText(64),
  city: optionalText(64),
  district: optionalText(64),
  address: optionalText(255),
  coverKey: z.string().max(512).nullable().optional(),
  intro: nullableText(500),
  videoKey: z.string().max(512).nullable().optional(),
  // ★ 2026-09-24 单店模型：这里**不再接受 isDefault**（zod 默认丢弃未声明字段）。
  //   一个账号只有一家门店，它必然是默认门店 —— 允许客户端把它关掉，只会做出
  //   「有门店但没有默认门店」的畸形数据。多门店时代的「设为默认」开关已从前端下线。
  //   要恢复多门店时，把这一行加回来即可。
})


router.get('/', async (req, res) => {
  const list = await storeSvc.listStores(prisma, req.merchantId!)
  ok(res, list)
})

router.post('/', async (req, res) => {
  try {
    const input = storeInput.parse(req.body)
    const store = await storeSvc.createStore(prisma, req.merchantId!, input)
    ok(res, store)
  } catch (e) {
    if (e instanceof storeSvc.StoreLimitError) fail(res, 2003, e.message, 400)
    else {
      if (!(e instanceof z.ZodError)) console.error('[stores] 创建门店失败:', e)
      fail(res, 400, '创建失败', 400)
    }
  }
})

router.get('/:id', async (req, res) => {
  const store = await storeSvc.getStore(prisma, req.merchantId!, idParam(req.params.id, 'id'))
  if (!store) return fail(res, 4044, '门店不存在', 404)
  ok(res, store)
})

router.put('/:id', async (req, res) => {
  try {
    const input = storeInput.parse(req.body)
    const store = await storeSvc.updateStore(prisma, req.merchantId!, idParam(req.params.id, 'id'), input)
    if (!store) return fail(res, 4044, '门店不存在', 404)
    ok(res, store)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof storeSvc.StoreDefaultDeleteError) fail(res, 2003, e.message, 400)
    else if (e instanceof storeSvc.StoreCoverError) fail(res, 2009, e.message, 400)
    else if (e instanceof storeSvc.StoreVideoError) fail(res, 2010, e.message, 400)
    else {
      if (!(e instanceof z.ZodError)) console.error('[stores] 更新门店失败:', e)
      fail(res, 400, '更新失败', 400)
    }
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const okDel = await storeSvc.deleteStore(prisma, req.merchantId!, idParam(req.params.id, 'id'))
    if (!okDel) return fail(res, 4044, '门店不存在', 404)
    ok(res, { deleted: true })
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof storeSvc.StoreDefaultDeleteError) fail(res, 2003, e.message, 400)
    else fail(res, 400, '删除失败', 400)
  }
})

export default router
