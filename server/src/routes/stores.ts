// 门店路由（需鉴权）。X-Store-Id 由前端在请求头携带，用于上下文切换
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as storeSvc from '../services/store.service.js'

const router = Router()
router.use(auth)

const storeInput = z.object({
  name: z.string().min(1).max(128),
  category: z.string().max(64).optional(),
  province: z.string().max(64).optional(),
  city: z.string().max(64).optional(),
  district: z.string().max(64).optional(),
  address: z.string().max(255).optional(),
  contact: z.string().max(64).optional(),
  isDefault: z.boolean().optional(),
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
    else fail(res, 400, '创建失败', 400)
  }
})

router.get('/:id', async (req, res) => {
  const store = await storeSvc.getStore(prisma, req.merchantId!, BigInt(req.params.id))
  if (!store) return fail(res, 4044, '门店不存在', 404)
  ok(res, store)
})

router.put('/:id', async (req, res) => {
  try {
    const input = storeInput.parse(req.body)
    const store = await storeSvc.updateStore(prisma, req.merchantId!, BigInt(req.params.id), input)
    if (!store) return fail(res, 4044, '门店不存在', 404)
    ok(res, store)
  } catch (e) {
    if (e instanceof storeSvc.StoreDefaultDeleteError) fail(res, 2003, e.message, 400)
    else fail(res, 400, '更新失败', 400)
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const okDel = await storeSvc.deleteStore(prisma, req.merchantId!, BigInt(req.params.id))
    if (!okDel) return fail(res, 4044, '门店不存在', 404)
    ok(res, { deleted: true })
  } catch (e) {
    if (e instanceof storeSvc.StoreDefaultDeleteError) fail(res, 2003, e.message, 400)
    else fail(res, 400, '删除失败', 400)
  }
})

export default router
