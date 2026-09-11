// 人设路由：GET 读、PUT 写（一门店一条）——挂载于 /stores/:storeId/persona
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as personaSvc from '../services/persona.service.js'

const router = Router()
router.use(auth)

const personaInput = z.object({
  bossTags: z.string().max(500).nullable().optional(),
  activity: z.string().max(1000).nullable().optional(),
})

router.get('/', async (req, res) => {
  try {
    const { storeId } = req.params as { storeId: string }
    const p = await personaSvc.getPersona(prisma, req.merchantId!, BigInt(storeId))
    ok(res, p ?? { bossTags: null, activity: null, updatedAt: null })
  } catch (e) {
    if (e instanceof personaSvc.PersonaStoreMismatchError) return fail(res, 2004, e.message, 400)
    return fail(res, 500, '查询失败', 500)
  }
})

router.put('/', async (req, res) => {
  try {
    const { storeId } = req.params as { storeId: string }
    const input = personaInput.parse(req.body ?? {})
    const r = await personaSvc.upsertPersona(prisma, req.merchantId!, BigInt(storeId), input)
    ok(res, r)
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    if (e instanceof personaSvc.PersonaStoreMismatchError) return fail(res, 2004, e.message, 400)
    return fail(res, 500, '保存失败', 500)
  }
})

export default router
