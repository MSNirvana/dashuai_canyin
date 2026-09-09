// 后台管理路由（/admin/api/v1，单角色全权限）
// 范围：管理员登录 / TTS 供应商 / 仪表盘 / 商家 / 套餐 / 账务与调账 / AI 配置 / 镜头库 / 系统配置 / 合成任务
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { ok, fail } from '../lib/result.js'
import { adminAuth } from '../middleware/admin-auth.js'
import * as adminSvc from '../services/admin.service.js'
import * as adminExtra from '../services/admin-extra.service.js'
import * as adminAi from '../services/admin-ai.service.js'
import * as ttsSvc from '../services/tts-provider.service.js'
import * as premium from '../render/premium.js'
import { invalidate } from '../lib/settings.js'
import type { Prisma } from '@prisma/client'

const router = Router()

// ──────────────────────── 鉴权（无需登录） ────────────────────────

const loginInput = z.object({ username: z.string().min(1), password: z.string().min(1) })

router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = loginInput.parse(req.body)
    const r = await adminSvc.adminLogin(prisma, username, password)
    ok(res, r)
  } catch (e) {
    if (e instanceof adminSvc.AdminLoginFailedError) return fail(res, 4001, e.message, 401)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    return fail(res, 500, '登录失败', 500)
  }
})

// 其余全部需要管理员鉴权（router.use 自动对后面所有生效）
router.use(adminAuth)

// 鉴权后暴露的「当前管理员」
router.get('/auth/me', (req, res) => {
  ok(res, { adminId: req.adminId?.toString(), username: req.adminUsername })
})

// ──────────────────────── 仪表盘 ────────────────────────
router.get('/dashboard', async (_req, res) => {
  try {
    ok(res, await adminExtra.getDashboardOverview(prisma))
  } catch {
    fail(res, 500, '查询失败', 500)
  }
})

// ──────────────────────── 商家管理 ────────────────────────
const merchantListQ = z.object({
  phone: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
router.get('/merchants', async (req, res) => {
  try {
    const q = merchantListQ.parse(req.query)
    ok(res, await adminExtra.listMerchants(prisma, q))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '查询失败', 500)
  }
})
router.get('/merchants/:id', async (req, res) => {
  try {
    ok(res, await adminExtra.getMerchantDetail(prisma, BigInt(req.params.id)))
  } catch (e) {
    if (e instanceof adminExtra.AdminNotFoundError) return fail(res, 4049, e.message, 404)
    fail(res, 500, '查询失败', 500)
  }
})
router.post('/merchants/:id/status', async (req, res) => {
  try {
    const { status } = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }).parse(req.body)
    ok(res, await adminExtra.setMerchantStatus(prisma, BigInt(req.params.id), status))
  } catch (e) {
    if (e instanceof adminExtra.AdminNotFoundError) return fail(res, 4049, e.message, 404)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '操作失败', 500)
  }
})

// ──────────────────────── 套餐配置 ────────────────────────
router.get('/bean-packages', async (_req, res) => {
  try {
    ok(res, await adminExtra.listAllBeanPackages(prisma))
  } catch {
    fail(res, 500, '查询失败', 500)
  }
})
const beanPackageInput = z.object({
  name: z.string().min(1).max(128),
  beans: z.union([z.string(), z.number()]),
  bonusBeans: z.union([z.string(), z.number()]).optional(),
  priceFen: z.number().int().min(1),
  memberPriceFen: z.number().int().min(1),
  tag: z.string().max(32).nullable().optional(),
  sort: z.number().int().optional(),
  enabled: z.boolean().optional(),
})
router.post('/bean-packages', async (req, res) => {
  try {
    const input = beanPackageInput.parse(req.body)
    ok(
      res,
      await adminExtra.upsertBeanPackage(prisma, undefined, {
        ...input,
        beans: BigInt(input.beans as string | number),
        bonusBeans:
          input.bonusBeans !== undefined ? BigInt(input.bonusBeans as string | number) : undefined,
      }),
    )
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '创建失败', 500)
  }
})
router.put('/bean-packages/:id', async (req, res) => {
  try {
    const input = beanPackageInput.parse(req.body)
    ok(
      res,
      await adminExtra.upsertBeanPackage(prisma, BigInt(req.params.id), {
        ...input,
        beans: BigInt(input.beans as string | number),
        bonusBeans:
          input.bonusBeans !== undefined ? BigInt(input.bonusBeans as string | number) : undefined,
      }),
    )
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/bean-packages/:id', async (req, res) => {
  try {
    ok(res, await adminExtra.removeBeanPackage(prisma, BigInt(req.params.id)))
  } catch (e) {
    if (e instanceof adminExtra.AdminNotFoundError) return fail(res, 4049, e.message, 404)
    fail(res, 500, '删除失败', 500)
  }
})

router.get('/member-packages', async (_req, res) => {
  try {
    ok(res, await adminExtra.listAllMemberPackages(prisma))
  } catch {
    fail(res, 500, '查询失败', 500)
  }
})
const memberPackageInput = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(128),
  durationDays: z.number().int().min(1),
  priceFen: z.number().int().min(1),
  grantBeans: z.union([z.string(), z.number()]),
  rightsJson: z.unknown().optional(),
  tag: z.string().max(32).nullable().optional(),
  sort: z.number().int().optional(),
  enabled: z.boolean().optional(),
})
router.post('/member-packages', async (req, res) => {
  try {
    const input = memberPackageInput.parse(req.body)
    ok(
      res,
      await adminExtra.upsertMemberPackage(prisma, undefined, {
        ...input,
        rightsJson: input.rightsJson as Prisma.InputJsonValue | undefined,
        grantBeans: BigInt(input.grantBeans as string | number),
      }),
    )
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '创建失败', 500)
  }
})
router.put('/member-packages/:id', async (req, res) => {
  try {
    const input = memberPackageInput.parse(req.body)
    ok(
      res,
      await adminExtra.upsertMemberPackage(prisma, BigInt(req.params.id), {
        ...input,
        rightsJson: input.rightsJson as Prisma.InputJsonValue | undefined,
        grantBeans: BigInt(input.grantBeans as string | number),
      }),
    )
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/member-packages/:id', async (req, res) => {
  try {
    ok(res, await adminExtra.removeMemberPackage(prisma, BigInt(req.params.id)))
  } catch (e) {
    if (e instanceof adminExtra.AdminNotFoundError) return fail(res, 4049, e.message, 404)
    fail(res, 500, '删除失败', 500)
  }
})

// ──────────────────────── 流水查询 / 调账 ────────────────────────
const ledgerQ = z.object({
  merchantId: z.coerce.bigint().optional(),
  type: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
router.get('/bean/ledger', async (req, res) => {
  try {
    const q = ledgerQ.parse(req.query)
    ok(res, await adminExtra.adminListBeanLedger(prisma, q))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '查询失败', 500)
  }
})
const adjustInput = z.object({
  merchantId: z.union([z.string(), z.number()]),
  amount: z.union([z.string(), z.number()]),
  bucket: z.enum(['RECHARGE', 'GRANT']),
  remark: z.string().min(1).max(255),
})
router.post('/bean/adjust', async (req, res) => {
  try {
    const input = adjustInput.parse(req.body)
    const r = await adminExtra.adminAdjustBeans(prisma, BigInt(req.adminId!), {
      merchantId: BigInt(input.merchantId as string | number),
      amount: BigInt(input.amount as string | number),
      bucket: input.bucket,
      remark: input.remark,
    })
    ok(res, {
      balanceAfter: r.balanceAfter.toString(),
      grantAfter: r.grantAfter.toString(),
    })
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    return fail(res, 400, (e as Error).message, 400)
  }
})

// ──────────────────────── 合成任务管理 ────────────────────────
const renderQ = z.object({
  merchantId: z.coerce.bigint().optional(),
  status: z.string().optional(),
  grade: z.enum(['BASIC', 'AI', 'PREMIUM']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
router.get('/render/tasks', async (req, res) => {
  try {
    const q = renderQ.parse(req.query)
    ok(res, await adminExtra.adminListRenderTasks(prisma, q))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '查询失败', 500)
  }
})

// ──────────────────────── 精品生成 · 剪辑工作台 ────────────────────────
const deliverInput = z.object({
  resultKey: z.string().min(1).max(512),
  previewKey: z.string().max(512).optional(),
  resultSize: z.coerce.bigint().optional(),
  durationMs: z.coerce.number().int().min(0).optional(),
})
router.post('/render/tasks/:id/claim', async (req, res) => {
  try {
    ok(res, await premium.claimPremiumTask(prisma, BigInt(req.params.id)))
  } catch (e) {
    if (e instanceof premium.PremiumTaskStateError) return fail(res, e.code, e.message, e.httpStatus)
    fail(res, 500, '接单失败', 500)
  }
})
router.post('/render/tasks/:id/deliver', async (req, res) => {
  try {
    const input = deliverInput.parse(req.body)
    ok(res, await premium.deliverPremiumTask(prisma, BigInt(req.params.id), input))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    if (e instanceof premium.PremiumTaskStateError) return fail(res, e.code, e.message, e.httpStatus)
    fail(res, 500, '交付失败', 500)
  }
})
router.post('/render/tasks/:id/fail', async (req, res) => {
  try {
    const reason = String(req.body?.reason ?? '人工标记失败')
    ok(res, await premium.failPremiumTask(prisma, BigInt(req.params.id), reason))
  } catch (e) {
    if (e instanceof premium.PremiumTaskStateError) return fail(res, e.code, e.message, e.httpStatus)
    fail(res, 500, '操作失败', 500)
  }
})
router.get('/render/tasks/:id/materials', async (req, res) => {
  try {
    ok(res, await premium.premiumMaterials(prisma, BigInt(req.params.id)))
  } catch (e) {
    if (e instanceof premium.PremiumTaskStateError) return fail(res, e.code, e.message, e.httpStatus)
    fail(res, 500, '查询失败', 500)
  }
})

// ──────────────────────── AI 通道 / 模型 / 场景 / 日志 ────────────────────────
router.get('/ai/providers', async (_req, res) => {
  try {
    ok(res, await adminAi.listAiProviders(prisma))
  } catch {
    fail(res, 500, '查询失败', 500)
  }
})

const providerInput = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  providerType: z.string().min(1).max(32),
  protocol: z.enum(['OPENAI_COMPATIBLE', 'ANTHROPIC_NATIVE']).optional(),
  baseUrl: z.string().min(1).max(512),
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  monthlyBudgetFen: z.number().int().nullable().optional(),
})
router.post('/ai/providers', async (req, res) => {
  try {
    const input = providerInput.parse(req.body)
    ok(res, await adminAi.upsertAiProvider(prisma, undefined, input))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '创建失败', 500)
  }
})
router.put('/ai/providers/:id', async (req, res) => {
  try {
    const input = providerInput.parse(req.body)
    ok(res, await adminAi.upsertAiProvider(prisma, BigInt(req.params.id), input))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.post('/ai/providers/:id/enable', async (req, res) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body)
    ok(res, await adminAi.setAiProviderEnabled(prisma, BigInt(req.params.id), enabled))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '操作失败', 500)
  }
})
router.delete('/ai/providers/:id', async (req, res) => {
  try {
    ok(res, await adminAi.removeAiProvider(prisma, BigInt(req.params.id)))
  } catch {
    fail(res, 500, '删除失败', 500)
  }
})
const testInput = z.object({ modelCode: z.string().min(1) })
router.post('/ai/providers/:id/test', async (req, res) => {
  try {
    const { modelCode } = testInput.parse(req.body)
    ok(res, await adminAi.testAiProvider(prisma, BigInt(req.params.id), modelCode))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    if (e instanceof adminAi.AdminAiNotFoundError) return fail(res, 4049, e.message, 404)
    fail(res, 500, '测试失败', 500)
  }
})
router.post('/ai/providers/test-all', async (_req, res) => {
  try {
    const providers = await prisma.aiProvider.findMany({
      where: { enabled: true },
      include: { models: { where: { enabled: true }, take: 1, orderBy: { modelCode: 'asc' } } },
    })
    const results = await Promise.all(
      providers.map(async (p) => {
        const m = p.models[0]
        if (!m) return { providerId: p.id.toString(), code: p.code, ok: false, errorMsg: '无可用模型' }
        const r = await adminAi.testAiProvider(prisma, p.id, m.modelCode)
        return { providerId: p.id.toString(), code: p.code, ...r }
      }),
    )
    ok(res, results)
  } catch {
    fail(res, 500, '批量测试失败', 500)
  }
})

router.get('/ai/models', async (req, res) => {
  try {
    const providerId = req.query.providerId ? BigInt(req.query.providerId as string) : undefined
    ok(res, await adminAi.listAiModels(prisma, providerId))
  } catch {
    fail(res, 500, '查询失败', 500)
  }
})
const modelInput = z.object({
  providerId: z.union([z.string(), z.number()]),
  modelCode: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  capability: z.string().optional(),
  maxContextTokens: z.number().int().nullable().optional(),
  maxOutputTokens: z.number().int().nullable().optional(),
  inputPricePerMtok: z.number().int().min(0),
  outputPricePerMtok: z.number().int().min(0),
  enabled: z.boolean().optional(),
})
router.post('/ai/models', async (req, res) => {
  try {
    const input = modelInput.parse(req.body)
    ok(
      res,
      await adminAi.upsertAiModel(prisma, undefined, {
        ...input,
        providerId: BigInt(input.providerId as string | number),
      }),
    )
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '创建失败', 500)
  }
})
router.put('/ai/models/:id', async (req, res) => {
  try {
    const input = modelInput.parse(req.body)
    ok(
      res,
      await adminAi.upsertAiModel(prisma, BigInt(req.params.id), {
        ...input,
        providerId: BigInt(input.providerId as string | number),
      }),
    )
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/ai/models/:id', async (req, res) => {
  try {
    ok(res, await adminAi.removeAiModel(prisma, BigInt(req.params.id)))
  } catch {
    fail(res, 500, '删除失败', 500)
  }
})

router.get('/ai/scenes', async (_req, res) => {
  try {
    ok(res, await adminAi.listAiScenes(prisma))
  } catch {
    fail(res, 500, '查询失败', 500)
  }
})
const sceneInput = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  promptTemplate: z.string().min(1),
  fallbackTemplate: z.string().nullable().optional(),
  defaultModelId: z.union([z.string(), z.number()]),
  fallbackModelIds: z.array(z.union([z.string(), z.number()])),
  beanPrice: z.union([z.string(), z.number()]),
  timeoutMs: z.number().int().optional(),
  maxRetries: z.number().int().optional(),
  temperature: z.number().nullable().optional(),
  maxOutputTokens: z.number().int().nullable().optional(),
  enabled: z.boolean().optional(),
})
router.post('/ai/scenes', async (req, res) => {
  try {
    const input = sceneInput.parse(req.body)
    ok(
      res,
      await adminAi.upsertAiScene(prisma, undefined, {
        ...input,
        defaultModelId: BigInt(input.defaultModelId as string | number),
        fallbackModelIds: adminAi.bigintArray(input.fallbackModelIds),
        beanPrice: BigInt(input.beanPrice as string | number),
      }),
    )
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '创建失败', 500)
  }
})
router.put('/ai/scenes/:id', async (req, res) => {
  try {
    const input = sceneInput.parse(req.body)
    ok(
      res,
      await adminAi.upsertAiScene(prisma, BigInt(req.params.id), {
        ...input,
        defaultModelId: BigInt(input.defaultModelId as string | number),
        fallbackModelIds: adminAi.bigintArray(input.fallbackModelIds),
        beanPrice: BigInt(input.beanPrice as string | number),
      }),
    )
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/ai/scenes/:id', async (req, res) => {
  try {
    ok(res, await adminAi.removeAiScene(prisma, BigInt(req.params.id)))
  } catch (e) {
    if (e instanceof adminAi.AdminAiNotFoundError) return fail(res, 4049, e.message, 404)
    fail(res, 500, '删除失败', 500)
  }
})

const aiLogQ = z.object({
  providerId: z.coerce.bigint().optional(),
  merchantId: z.coerce.bigint().optional(),
  sceneCode: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
router.get('/ai/call-logs', async (req, res) => {
  try {
    const q = aiLogQ.parse(req.query)
    ok(res, await adminAi.adminListAiCallLogs(prisma, q))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '查询失败', 500)
  }
})

// ──────────────────────── 镜头库 ────────────────────────
router.get('/shot-library', async (_req, res) => {
  try {
    ok(res, await adminExtra.adminListShotLibrary(prisma))
  } catch {
    fail(res, 500, '查询失败', 500)
  }
})
const shotLibInput = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  category: z.string().min(1).max(32),
  tips: z.string().nullable().optional(),
  source: z.string().optional(),
  demoVideoKey: z.string().max(512).nullable().optional(),
  demoCoverKey: z.string().max(512).nullable().optional(),
  sort: z.number().int().optional(),
  enabled: z.boolean().optional(),
})
router.post('/shot-library', async (req, res) => {
  try {
    ok(res, await adminExtra.adminUpsertShotLibrary(prisma, undefined, shotLibInput.parse(req.body)))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '创建失败', 500)
  }
})
router.put('/shot-library/:id', async (req, res) => {
  try {
    ok(res, await adminExtra.adminUpsertShotLibrary(prisma, BigInt(req.params.id), shotLibInput.parse(req.body)))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/shot-library/:id', async (req, res) => {
  try {
    ok(res, await adminExtra.adminRemoveShotLibrary(prisma, BigInt(req.params.id)))
  } catch (e) {
    if (e instanceof adminExtra.AdminNotFoundError) return fail(res, 4049, e.message, 404)
    fail(res, 500, '删除失败', 500)
  }
})

// ──────────────────────── 系统配置 ────────────────────────
router.get('/settings', async (_req, res) => {
  try {
    ok(res, await adminExtra.adminListSystemSettings(prisma))
  } catch {
    fail(res, 500, '查询失败', 500)
  }
})
const settingInput = z.object({
  groupKey: z.string().min(1).max(64),
  settingKey: z.string().min(1).max(64),
  settingVal: z.string().min(1),
  valueType: z.enum(['STRING', 'INT', 'BOOL', 'JSON', 'DECIMAL']),
  displayName: z.string().min(1).max(128),
  description: z.string().max(500).nullable().optional(),
  sort: z.number().int().optional(),
  isPublic: z.boolean().optional(),
})
router.post('/settings', async (req, res) => {
  try {
    const r = await adminExtra.adminUpsertSystemSetting(prisma, undefined, settingInput.parse(req.body))
    invalidate()
    ok(res, r)
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '创建失败', 500)
  }
})
router.put('/settings/:id', async (req, res) => {
  try {
    const r = await adminExtra.adminUpsertSystemSetting(
      prisma,
      BigInt(req.params.id),
      settingInput.parse(req.body),
    )
    invalidate()
    ok(res, r)
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/settings/:id', async (req, res) => {
  try {
    const r = await adminExtra.adminRemoveSystemSetting(prisma, BigInt(req.params.id))
    invalidate()
    ok(res, r)
  } catch (e) {
    if (e instanceof adminExtra.AdminNotFoundError) return fail(res, 4049, e.message, 404)
    fail(res, 500, '删除失败', 500)
  }
})

// ──────────────────────── TTS 供应商（沿用上一轮实现） ────────────────────────
router.get('/tts/providers', async (_req, res) => {
  try {
    ok(res, await ttsSvc.listTtsProviders(prisma))
  } catch {
    fail(res, 500, '查询失败', 500)
  }
})
const ttsInput = z.object({
  name: z.string().min(1).optional(),
  appId: z.string().nullable().optional(),
  secretId: z.string().optional(),
  apiKey: z.string().optional(),
  voiceId: z.string().nullable().optional(),
  extra: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
})
router.put('/tts/providers/:code', async (req, res) => {
  try {
    const input = ttsInput.parse(req.body)
    ok(res, await ttsSvc.upsertTtsProvider(prisma, { code: req.params.code, ...input }))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '保存失败', 500)
  }
})
router.post('/tts/providers/:code/enable', async (req, res) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body)
    ok(res, await ttsSvc.setTtsEnabled(prisma, req.params.code, enabled))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '操作失败', 500)
  }
})
router.delete('/tts/providers/:code', async (req, res) => {
  try {
    ok(res, await ttsSvc.removeTtsProvider(prisma, req.params.code))
  } catch {
    fail(res, 500, '删除失败', 500)
  }
})

export default router
