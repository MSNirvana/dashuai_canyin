// 菜品路由（需鉴权）。挂在 /stores/:storeId/dishes 下
import { createRouter } from '../lib/async-router.js'
import { InvalidIdParamError, idParam } from '../lib/params.js'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import { requiredText, optionalText } from '../lib/validators.js'
import * as dishSvc from '../services/dish.service.js'

const router = createRouter({ mergeParams: true })
router.use(auth)

type StoreDishParams = { storeId: string; id?: string }

// 菜名/简介/卖点都会喂给 AI 提示词变量（dishName / dishIntro / sellingPoints），
// 纯空白值会让提示词里出现空段，所以必须 trim 后再判空（`.min(1)` 数的是长度，"   " 能过）
//
// ★ 本对象**有守护**：字段增删要同步 scripts/verify-input-trim.ts 的 GUARDED 清单
//   （那里按「字段名 + 必须走 validators 工厂函数」逐条断言 dishes.ts 的声明）。
const dishInput = z.object({
  name: requiredText(128),
  intro: optionalText(500),
  sellingPoints: optionalText(1000),
  coverKey: z.string().max(512).optional(),
  videoKey: z.string().max(512).optional(),
  // 菜单资产类型。**可选**：不传时由服务端沿用库里的类型（新建默认 SINGLE），
  // 见 dish.service.ts::updateDish 的注释 —— 默认成 SINGLE 会把套餐静默降级成单菜。
  kind: z.enum(['SINGLE', 'COMBO']).optional(),
  // 价格单位是**分**（与 member_package.price_fen 同口径）。上限 100 万元 = 100000000 分，
  // 与 dish.service.ts 的 MAX_PRICE_FEN 一致；比大小（原价 > 套餐价）这类业务规则放服务端，
  // 这里只拦住「不是非负整数」这种形态问题。
  priceFen: z.number().int().min(0).max(100000000).optional(),
  // ★ 允许 null，而且 null 与「不传」是**两件事**：
  //   null = 用户把划线价删掉了（显式清空）；不传 = 没提这件事（沿用库里的）。
  //   少了 null 这个出口，原价一旦填过就再也删不掉。
  originalPriceFen: z.number().int().min(0).max(100000000).nullable().optional(),
  // dishId 收字符串、在 handler 里过 idParam 转 bigint：`BigInt('abc')` 会抛 SyntaxError，
  // 而裸解析在 async handler 里没人接管（见 lib/params.ts 的说明）。
  comboItems: z
    .array(z.object({ dishId: z.string().min(1).max(19), quantity: z.number().int().min(1).max(99).optional(), sort: z.number().int().min(0).optional() }))
    .max(30)
    .optional(),
  media: z.array(z.object({ type: z.enum(['IMAGE', 'VIDEO']), cosKey: z.string().min(1).max(512), coverKey: z.string().max(512).optional(), sort: z.number().int().min(0).optional() })).max(6).optional(),
  sort: z.number().int().optional(),
})

/**
 * 把请求体里的 comboItems 收敛成服务层要的 bigint 形态。
 * ★ 缺省值不在这里补：`?? []` 会把「没传 comboItems」与「传了空数组」混成同一件事，
 *   而这两者对套餐的含义完全不同（前者是「沿用/不动」，后者是「清空」）——
 *   是否必填由服务层的 normalizeCombo 按 kind 判定。
 */
function parseComboItems(input: { comboItems?: Array<{ dishId: string; quantity?: number; sort?: number }> }) {
  if (input.comboItems === undefined) return undefined
  return input.comboItems.map((it) => ({ dishId: idParam(it.dishId, 'dishId'), quantity: it.quantity, sort: it.sort }))
}

router.get('/', async (req, res) => {
  try {
    const { storeId } = req.params as StoreDishParams
    const list = await dishSvc.listDishes(prisma, req.merchantId!, idParam(storeId, 'storeId'))
    ok(res, list)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof dishSvc.DishStoreMismatchError) return fail(res, 2004, e.message, 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[dishes] 查询异常:', e)
    return fail(res, 500, '查询失败', 500)
  }
})

router.get('/:id', async (req, res) => {
  try {
    const { storeId, id } = req.params as StoreDishParams
    const dish = await dishSvc.getDish(prisma, req.merchantId!, idParam(storeId, 'storeId'), idParam(id, 'id'))
    if (!dish) return fail(res, 4045, '菜品不存在', 404)
    ok(res, dish)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof dishSvc.DishStoreMismatchError) return fail(res, 2004, e.message, 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[dishes] 查询异常:', e)
    return fail(res, 500, '查询失败', 500)
  }
})

router.post('/', async (req, res) => {
  try {
    const { storeId } = req.params as StoreDishParams
    const input = dishInput.parse(req.body)
    const dish = await dishSvc.createDish(prisma, req.merchantId!, idParam(storeId, 'storeId'), { ...input, comboItems: parseComboItems(input) })
    ok(res, dish)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof dishSvc.DishStoreMismatchError) return fail(res, 2004, e.message, 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[dishes] 创建异常:', e)
    return fail(res, 500, '创建失败', 500)
  }
})

router.put('/:id', async (req, res) => {
  try {
    const { storeId, id } = req.params as StoreDishParams
    const input = dishInput.parse(req.body)
    const dish = await dishSvc.updateDish(prisma, req.merchantId!, idParam(storeId, 'storeId'), idParam(id, 'id'), { ...input, comboItems: parseComboItems(input) })
    if (!dish) return fail(res, 4045, '菜品不存在', 404)
    ok(res, dish)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof dishSvc.DishStoreMismatchError) return fail(res, 2004, e.message, 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[dishes] 更新异常:', e)
    return fail(res, 500, '更新失败', 500)
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const { storeId, id } = req.params as StoreDishParams
    const okDel = await dishSvc.deleteDish(prisma, req.merchantId!, idParam(storeId, 'storeId'), idParam(id, 'id'))
    if (!okDel) return fail(res, 4045, '菜品不存在', 404)
    ok(res, { deleted: true })
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof dishSvc.DishStoreMismatchError) return fail(res, 2004, e.message, 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[dishes] 删除异常:', e)
    return fail(res, 500, '删除失败', 500)
  }
})

export default router
