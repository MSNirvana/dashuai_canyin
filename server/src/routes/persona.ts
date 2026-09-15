// 人设路由：GET 读、PUT 写（一门店一条）——挂载于 /stores/:storeId/persona
// mergeParams: true 必须开：否则读不到父级挂载路径上的 :storeId（req.params.storeId 为 undefined）
import { createRouter } from '../lib/async-router.js'
import { InvalidIdParamError, idParam } from '../lib/params.js'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as personaSvc from '../services/persona.service.js'

const router = createRouter({ mergeParams: true })
router.use(auth)

const personaInput = z.object({
  bossTags: z.string().max(500).nullable().optional(),
  activity: z.string().max(1000).nullable().optional(),
})

router.get('/', async (req, res) => {
  try {
    const { storeId } = req.params as { storeId: string }
    const p = await personaSvc.getPersona(prisma, req.merchantId!, idParam(storeId, 'storeId'))
    ok(res, p ?? { bossTags: null, activity: null, updatedAt: null })
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof personaSvc.PersonaStoreMismatchError) return fail(res, 2004, e.message, 400)
    // 真实异常必须落日志：否则 500 无任何排查线索
    console.error('[persona] 读取失败:', e)
    return fail(res, 500, '查询失败', 500)
  }
})

router.put('/', async (req, res) => {
  try {
    const { storeId } = req.params as { storeId: string }
    const input = personaInput.parse(req.body ?? {})
    const r = await personaSvc.upsertPersona(prisma, req.merchantId!, idParam(storeId, 'storeId'), input)
    ok(res, r)
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof personaSvc.PersonaStoreMismatchError) return fail(res, 2004, e.message, 400)
    console.error('[persona] 保存失败:', e)
    return fail(res, 500, '保存失败', 500)
  }
})

export default router
