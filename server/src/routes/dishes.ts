// 菜品路由（需鉴权）。挂在 /stores/:storeId/dishes 下
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as dishSvc from '../services/dish.service.js'

const router = Router({ mergeParams: true })
router.use(auth)

type StoreDishParams = { storeId: string; id?: string }

const dishInput = z.object({
  name: z.string().min(1).max(128),
  intro: z.string().max(500).optional(),
  sellingPoints: z.string().max(1000).optional(),
  coverKey: z.string().max(512).optional(),
  sort: z.number().int().optional(),
})

router.get('/', async (req, res) => {
  try {
    const { storeId } = req.params as StoreDishParams
    const list = await dishSvc.listDishes(prisma, req.merchantId!, BigInt(storeId))
    ok(res, list)
  } catch (e) {
    if (e instanceof dishSvc.DishStoreMismatchError) fail(res, 2004, e.message, 400)
    else fail(res, 400, '查询失败', 400)
  }
})

router.post('/', async (req, res) => {
  try {
    const { storeId } = req.params as StoreDishParams
    const input = dishInput.parse(req.body)
    const dish = await dishSvc.createDish(prisma, req.merchantId!, BigInt(storeId), input)
    ok(res, dish)
  } catch (e) {
    if (e instanceof dishSvc.DishStoreMismatchError) fail(res, 2004, e.message, 400)
    else fail(res, 400, '创建失败', 400)
  }
})

router.put('/:id', async (req, res) => {
  try {
    const { storeId, id } = req.params as StoreDishParams
    const input = dishInput.parse(req.body)
    const dish = await dishSvc.updateDish(prisma, req.merchantId!, BigInt(storeId), BigInt(id!), input)
    if (!dish) return fail(res, 4045, '菜品不存在', 404)
    ok(res, dish)
  } catch (e) {
    if (e instanceof dishSvc.DishStoreMismatchError) fail(res, 2004, e.message, 400)
    else fail(res, 400, '更新失败', 400)
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const { storeId, id } = req.params as StoreDishParams
    const okDel = await dishSvc.deleteDish(prisma, req.merchantId!, BigInt(storeId), BigInt(id!))
    if (!okDel) return fail(res, 4045, '菜品不存在', 404)
    ok(res, { deleted: true })
  } catch (e) {
    if (e instanceof dishSvc.DishStoreMismatchError) fail(res, 2004, e.message, 400)
    else fail(res, 400, '删除失败', 400)
  }
})

export default router
