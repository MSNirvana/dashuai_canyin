// 后台管理路由（/admin/api/v1，单角色全权限）
// 范围：管理员登录 / TTS 供应商 / 仪表盘 / 商家 / 套餐 / 账务与调账 / AI 配置 / 镜头库 / 系统配置 / 合成任务
import { createRouter } from '../lib/async-router.js'
import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { join } from 'node:path'
import { InvalidIdParamError, idParam, optionalIdParam } from '../lib/params.js'
import { z } from 'zod'
import { prisma } from '../db.js'
import { ok, fail } from '../lib/result.js'
import { adminAuth } from '../middleware/admin-auth.js'
import { localStorageRoot, removeLocalFile } from '../lib/local-storage.js'
import { tutorialCategoryEnum } from '../lib/tutorial-categories.js'
import * as adminSvc from '../services/admin.service.js'
import * as adminExtra from '../services/admin-extra.service.js'
import * as adminAi from '../services/admin-ai.service.js'
import * as workSvc from '../services/work.service.js'
import * as publicAssetSvc from '../services/public-asset.service.js'
import * as tutorialSvc from '../services/tutorial.service.js'
import { getSharedPlayUrlByKey } from '../services/media.service.js'
import * as ttsSvc from '../services/tts-provider.service.js'
import { PackageNotFoundError } from '../services/order.service.js'
import * as payReconcile from '../services/pay-reconcile.service.js'
import * as premium from '../render/premium.js'
import { invalidate } from '../lib/settings.js'
import type { Prisma } from '@prisma/client'

const router = createRouter()

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
    ok(res, await adminExtra.getMerchantDetail(prisma, idParam(req.params.id, 'id')))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof adminExtra.AdminNotFoundError) return fail(res, 4049, e.message, 404)
    fail(res, 500, '查询失败', 500)
  }
})
router.post('/merchants/:id/status', async (req, res) => {
  try {
    const { status } = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }).parse(req.body)
    ok(res, await adminExtra.setMerchantStatus(prisma, idParam(req.params.id, 'id'), status))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof adminExtra.AdminNotFoundError) return fail(res, 4049, e.message, 404)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '操作失败', 500)
  }
})

// 后台手动开通 / 续期会员（备案未过、支付未开放期间，用户线下付款后的兜底通道）。
// 走的是与微信支付回调**完全相同**的结算链：赠积分进会员桶、随会员到期清零、重复调用＝续期顺延。
const openMembershipInput = z.object({ remark: z.string().max(200).optional() })
router.post('/merchants/:id/membership', async (req, res) => {
  try {
    const input = openMembershipInput.parse(req.body ?? {})
    ok(
      res,
      await adminExtra.adminOpenMembership(prisma, BigInt(req.adminId!), {
        merchantId: idParam(req.params.id, 'id'),
        remark: input.remark,
      }),
    )
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof adminExtra.AdminNotFoundError) return fail(res, 4049, e.message, 404)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    if (e instanceof PackageNotFoundError) return fail(res, 4003, e.message, 400)
    fail(res, 500, (e as Error).message || '开通失败', 500)
  }
})

// ──────────────────────── 支付补单（回调丢失的最后兜底） ────────────────────────
//
// 微信异步回调可能因 notify_url 不可达（本项目卡在备案上）、网络抖动、重试耗尽而**静默丢失**：
// 用户钱付了、微信侧 SUCCESS，本地却停在 PENDING。用户端查单 + 低频对账已能覆盖绝大多数情况，
// 这个接口是前两者都失效时的人工通道。
//
// 只读微信查单接口，再走与支付回调**完全相同**的 markOrderPaid() ⇒ 幂等，重复点不会双发权益。
const orderNoParam = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/, '订单号不合法')
router.post('/orders/:orderNo/reconcile', async (req, res) => {
  try {
    const orderNo = orderNoParam.parse(req.params.orderNo)
    const r = await payReconcile.queryAndSettle(prisma, orderNo)
    if (r.status === 'NOT_FOUND') return fail(res, 4049, '订单不存在', 404)
    ok(res, r)
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[admin] 补单异常:', e)
    fail(res, 500, (e as Error).message || '补单失败', 500)
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
      await adminExtra.upsertBeanPackage(prisma, idParam(req.params.id, 'id'), {
        ...input,
        beans: BigInt(input.beans as string | number),
        bonusBeans:
          input.bonusBeans !== undefined ? BigInt(input.bonusBeans as string | number) : undefined,
      }),
    )
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/bean-packages/:id', async (req, res) => {
  try {
    ok(res, await adminExtra.removeBeanPackage(prisma, idParam(req.params.id, 'id')))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
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
      await adminExtra.upsertMemberPackage(prisma, idParam(req.params.id, 'id'), {
        ...input,
        rightsJson: input.rightsJson as Prisma.InputJsonValue | undefined,
        grantBeans: BigInt(input.grantBeans as string | number),
      }),
    )
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/member-packages/:id', async (req, res) => {
  try {
    ok(res, await adminExtra.removeMemberPackage(prisma, idParam(req.params.id, 'id')))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
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
    ok(res, await premium.claimPremiumTask(prisma, idParam(req.params.id, 'id')))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof premium.PremiumTaskStateError) return fail(res, e.code, e.message, e.httpStatus)
    fail(res, 500, '接单失败', 500)
  }
})
router.post('/render/tasks/:id/deliver', async (req, res) => {
  try {
    const input = deliverInput.parse(req.body)
    ok(res, await premium.deliverPremiumTask(prisma, idParam(req.params.id, 'id'), input))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    if (e instanceof premium.PremiumTaskStateError) return fail(res, e.code, e.message, e.httpStatus)
    fail(res, 500, '交付失败', 500)
  }
})
router.post('/render/tasks/:id/fail', async (req, res) => {
  try {
    const reason = String(req.body?.reason ?? '人工标记失败')
    ok(res, await premium.failPremiumTask(prisma, idParam(req.params.id, 'id'), reason))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof premium.PremiumTaskStateError) return fail(res, e.code, e.message, e.httpStatus)
    fail(res, 500, '操作失败', 500)
  }
})
router.get('/render/tasks/:id/materials', async (req, res) => {
  try {
    ok(res, await premium.premiumMaterials(prisma, idParam(req.params.id, 'id')))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
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
    ok(res, await adminAi.upsertAiProvider(prisma, idParam(req.params.id, 'id'), input))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.post('/ai/providers/:id/enable', async (req, res) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body)
    ok(res, await adminAi.setAiProviderEnabled(prisma, idParam(req.params.id, 'id'), enabled))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '操作失败', 500)
  }
})
router.delete('/ai/providers/:id', async (req, res) => {
  try {
    ok(res, await adminAi.removeAiProvider(prisma, idParam(req.params.id, 'id')))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    fail(res, 500, '删除失败', 500)
  }
})
const testInput = z.object({ modelCode: z.string().min(1) })
router.post('/ai/providers/:id/test', async (req, res) => {
  try {
    const { modelCode } = testInput.parse(req.body)
    ok(res, await adminAi.testAiProvider(prisma, idParam(req.params.id, 'id'), modelCode))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
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
    const providerId = optionalIdParam(req.query.providerId, 'providerId')
    ok(res, await adminAi.listAiModels(prisma, providerId))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    console.error('[admin] 查询 AI 模型失败:', e)
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
      await adminAi.upsertAiModel(prisma, idParam(req.params.id, 'id'), {
        ...input,
        providerId: BigInt(input.providerId as string | number),
      }),
    )
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/ai/models/:id', async (req, res) => {
  try {
    ok(res, await adminAi.removeAiModel(prisma, idParam(req.params.id, 'id')))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
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
    if (e instanceof adminAi.AdminAiInvalidTemplateError) return fail(res, 400, e.message, 400)
    fail(res, 500, '创建失败', 500)
  }
})
router.put('/ai/scenes/:id', async (req, res) => {
  try {
    const input = sceneInput.parse(req.body)
    ok(
      res,
      await adminAi.upsertAiScene(prisma, idParam(req.params.id, 'id'), {
        ...input,
        defaultModelId: BigInt(input.defaultModelId as string | number),
        fallbackModelIds: adminAi.bigintArray(input.fallbackModelIds),
        beanPrice: BigInt(input.beanPrice as string | number),
      }),
    )
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    if (e instanceof adminAi.AdminAiInvalidTemplateError) return fail(res, 400, e.message, 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/ai/scenes/:id', async (req, res) => {
  try {
    ok(res, await adminAi.removeAiScene(prisma, idParam(req.params.id, 'id')))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
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
    ok(res, await adminExtra.adminUpsertShotLibrary(prisma, idParam(req.params.id, 'id'), shotLibInput.parse(req.body)))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/shot-library/:id', async (req, res) => {
  try {
    ok(res, await adminExtra.adminRemoveShotLibrary(prisma, idParam(req.params.id, 'id')))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof adminExtra.AdminNotFoundError) return fail(res, 4049, e.message, 404)
    fail(res, 500, '删除失败', 500)
  }
})

// ──────────────────────── 首页优秀作品 ────────────────────────
const workQuery = z.object({
  category: z.string().max(32).optional(),
  enabled: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
router.get('/works', async (req, res) => {
  try {
    const q = workQuery.parse(req.query)
    ok(
      res,
      await workSvc.listAdminWorks(prisma, {
        category: q.category,
        enabled: q.enabled === undefined ? undefined : q.enabled === 'true',
        page: q.page,
        pageSize: q.pageSize,
      }),
    )
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[admin] 查询优秀作品失败:', e)
    fail(res, 500, '查询失败', 500)
  }
})

const workRecipeInput = z.object({
  track: z.enum(['TRAFFIC', 'INTRO', 'QUALITY', 'RECOMMEND']).optional(),
  complexity: z.enum(['SIMPLE', 'COMPLEX', 'FINE']).optional(),
  titleHint: z.string().max(128).optional(),
  voiceId: z.string().max(128).optional(),
  shotSkeleton: z
    .array(
      z.object({
        shotType: z.string().max(32).optional(),
        shotSize: z.string().max(32).optional(),
        durationSuggest: z.number().int().min(1).max(60).optional(),
        line: z.string().max(500).optional(),
        visualReq: z.string().max(500).optional(),
      }),
    )
    .max(20)
    .optional(),
  notes: z.string().max(500).optional(),
})

const workInput = z.object({
  title: z.string().min(1).max(128),
  category: z.string().min(1).max(32),
  subCategory: z.string().max(32).nullable().optional(),
  tags: z.array(z.string().max(32)).max(10).nullable().optional(),
  coverKey: z.string().max(512).nullable().optional(),
  videoKey: z.string().max(512).nullable().optional(),
  durationMs: z.number().int().min(0).nullable().optional(),
  recipeJson: workRecipeInput.optional(),
  sort: z.number().int().optional(),
  enabled: z.boolean().optional(),
})

router.post('/works', async (req, res) => {
  try {
    ok(res, await workSvc.createWork(prisma, workInput.parse(req.body)))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[admin] 创建优秀作品失败:', e)
    fail(res, 500, '创建失败', 500)
  }
})

router.put('/works/:id', async (req, res) => {
  try {
    const r = await workSvc.updateWork(prisma, idParam(req.params.id, 'id'), workInput.partial().parse(req.body))
    if (!r) return fail(res, 4049, '作品不存在', 404)
    ok(res, r)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[admin] 更新优秀作品失败:', e)
    fail(res, 500, '更新失败', 500)
  }
})

router.delete('/works/:id', async (req, res) => {
  try {
    const okDel = await workSvc.deleteWork(prisma, idParam(req.params.id, 'id'))
    if (!okDel) return fail(res, 4049, '作品不存在', 404)
    ok(res, { deleted: true })
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    console.error('[admin] 删除优秀作品失败:', e)
    fail(res, 500, '删除失败', 500)
  }
})

/** 按 videoKey 重新抽一帧当封面（首帧不好看 / 自动抽帧上线前入库的作品） */
router.post('/works/:id/cover', async (req, res) => {
  try {
    ok(res, await workSvc.regenerateWorkCover(prisma, idParam(req.params.id, 'id')))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof workSvc.WorkNotFoundError) return fail(res, 4049, '作品不存在', 404)
    if (e instanceof workSvc.WorkCoverError) return fail(res, 4010, e.message, 400)
    console.error('[admin] 抽取作品封面失败:', e)
    fail(res, 500, '抽帧失败', 500)
  }
})

/** 可入库成片列表：给「从成片入库」弹窗做挑选用，已入库的不会再出现 */
router.get('/works/importable-tasks', async (req, res) => {
  try {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query)
    ok(res, await workSvc.listImportableTasks(prisma, limit))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[admin] 查询可入库成片失败:', e)
    fail(res, 500, '查询失败', 500)
  }
})

/** 从商家成功成片入库：生成一条未上架草稿，运营补齐分类/配方后再上架 */
router.post('/works/from-render-task', async (req, res) => {
  try {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(req.body)
    ok(res, await workSvc.createWorkFromRenderTask(prisma, BigInt(taskId)))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    if (e instanceof workSvc.WorkAlreadyImportedError) return fail(res, 4090, e.message, 409)
    if (e instanceof workSvc.WorkNotFoundError) return fail(res, 4049, '成片不存在或尚未成功', 404)
    console.error('[admin] 从成片入库失败:', e)
    fail(res, 500, '入库失败', 500)
  }
})

// ──────────────────────── 素材预览 ────────────────────────
/**
 * 把 COS 对象键签成临时地址，供运营在上架前核对封面 / 视频（与成片同一存储）。
 * 刻意不传 baseUrl：本地模式走 LOCAL_MEDIA_BASE_URL（默认 127.0.0.1:3000/api/v1/media），
 * 用请求 host 会得到后台 dev server 的地址，而 /api/v1/media/file 并不在后台侧。
 */
router.get('/media/preview', async (req, res) => {
  try {
    const { key } = z.object({ key: z.string().min(1).max(512) }).parse(req.query)
    ok(res, await getSharedPlayUrlByKey(key))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[admin] 素材预览签名失败:', e)
    fail(res, 500, '预览失败', 500)
  }
})

// ──────────────────────── 运营公开图上传 ────────────────────────
/**
 * 上传一张运营公开图（首页轮播图 / 首页口号图），返回可匿名访问的 CDN 直链。
 * 存储策略与「为什么不能复用商家那套上传」见 services/public-asset.service.ts 顶部。
 *
 * ── 为什么收 raw body 而不是 multipart ────────────────────────────────────
 * 只有一个文件、没有别的字段，multipart 纯属多余；而 raw 让字节直接以 Buffer 到手，
 * 正好用于**魔数嗅探**（图片类型必须按内容判断，不信 Content-Type 也不信文件名）。
 * 少一层表单解析就少一类「boundary 丢了 / 字段名写错 ⇒ 服务端报『缺少上传文件』」
 * 的排查成本 —— 那类故障的表现与原因之间几乎看不出关系。
 *
 * `type: () => true` 是**刻意**的：无论客户端声明什么 Content-Type，都先把原始字节交给我，
 * 再由魔数决定收不收。让 body parser 按「客户端声明的类型」决定要不要解析，
 * 等于把校验权交给客户端。
 *
 * ★ 路由从下面这张表统一注册：下面的「body 超限」错误分支也要用到同一张表 ——
 *   两处各写一份路径清单，早晚会出现「新加了上传接口、但超限时回的还是『请求内容过大』」
 *   这种只在传大图时才现形的错配。
 */
interface PublicImageRoute {
  path: string
  /** 出错时打日志用的中文名 */
  label: string
  save: (buffer: Buffer) => Promise<publicAssetSvc.PublicImage>
}

const PUBLIC_IMAGE_ROUTES: readonly PublicImageRoute[] = [
  { path: '/uploads/carousel-image', label: '轮播图', save: publicAssetSvc.saveCarouselImage },
  { path: '/uploads/slogan-banner-image', label: '口号图', save: publicAssetSvc.saveSloganBannerImage },
]

for (const route of PUBLIC_IMAGE_ROUTES) {
  router.post(
    route.path,
    express.raw({ type: () => true, limit: publicAssetSvc.MAX_PUBLIC_IMAGE_BYTES }),
    async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body)) return fail(res, 400, '缺少上传内容', 400)
        ok(res, await route.save(req.body))
      } catch (e) {
        if (e instanceof publicAssetSvc.UnsupportedImageError) return fail(res, 400, e.message, 400)
        console.error(`[admin] ${route.label}上传失败:`, e)
        fail(res, 500, '上传失败', 500)
      }
    },
  )
}

/**
 * body-parser 的超限错误（`entity.too.large`）抛在**中间件层**，会直接进全局错误处理器，
 * 被归类成「未归类异常」返回 500「服务器内部错误」。运营看到的现象是：传了张稍大的图，
 * 后台报服务器错误 —— 完全看不出是自己图片太大。
 *
 * ⚠ 必须用 `originalUrl` 区分来源：全局的 `express.json({ limit: '2mb' })` 超限时
 *   抛的是同一个 `type`，若一律回「图片不能超过 5MB」，会把一个无关的报错指向图片。
 */
router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if ((err as { type?: string }).type !== 'entity.too.large') return next(err)
  const isImageUpload = PUBLIC_IMAGE_ROUTES.some((r) => req.originalUrl.includes(r.path))
  if (isImageUpload) {
    return fail(res, 400, `图片不能超过 ${publicAssetSvc.MAX_PUBLIC_IMAGE_BYTES / 1024 / 1024}MB`, 400)
  }
  return fail(res, 400, '请求内容过大', 400)
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
      idParam(req.params.id, 'id'),
      settingInput.parse(req.body),
    )
    invalidate()
    ok(res, r)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '更新失败', 500)
  }
})
router.delete('/settings/:id', async (req, res) => {
  try {
    const r = await adminExtra.adminRemoveSystemSetting(prisma, idParam(req.params.id, 'id'))
    invalidate()
    ok(res, r)
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
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

// ──────────────────────── 教学中心（平台级教学视频） ────────────────────────
//
// 与镜头库 / 优秀作品最大的区别：视频由后台**直接上传**，不再手填对象键
// （后台此前根本没有上传端点，见 apps/admin/src/pages/HomeCarousel.tsx 顶部注释）。
// 这条上传通道是**平台级**的，刻意不复用商家那套 `/api/v1/upload/local`：
// 那条强制 storeId 必填且必须属于当前商家、强制 `uploads/{merchantId}/` 前缀、
// 还要过商家存储配额 —— 教学视频一样都不适用。
// 对象落 `tutorials/` 前缀（见 services/tutorial.service.ts）。

const tutorialUpload = multer({
  dest: join(localStorageRoot(), '.incoming'),
  // 单文件上限，与 MAX_TUTORIAL_VIDEO_BYTES 同一个数字（超限的文件根本不落盘）
  limits: { fileSize: tutorialSvc.MAX_TUTORIAL_VIDEO_BYTES },
})

/**
 * 包一层，把 multer 的错误转成可读的业务码。
 * 不拦的话 multer 走 `next(err)` 一路落到全局 errorHandler，变成「服务器内部错误 500」
 * —— 运营看到 500 完全不知道是自己的文件太大。
 * ⚠ 注意 client_max_body_size：nginx 先于本层拒绝时返回的是 413 页面，
 *   与本函数无关（deploy/nginx/dashuai-admin.conf 已同步放开到 110m）。
 */
function adminUploadSingle(req: Request, res: Response, next: NextFunction): void {
  tutorialUpload.single('file')(req, res, (err: unknown) => {
    if (!err) return next()
    const tooLarge = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
    const maxMb = Math.round(tutorialSvc.MAX_TUTORIAL_VIDEO_BYTES / 1024 / 1024)
    fail(res, 400, tooLarge ? `文件不能超过 ${maxMb}MB` : '文件上传失败，请重试', 400)
  })
}

router.get('/tutorials', async (req, res) => {
  try {
    const q = z
      .object({
        category: z.string().max(16).optional(),
        // 刻意不用 z.coerce.boolean()：它把字符串 'false' 当成 true（非空串即真）
        enabled: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query)
    ok(
      res,
      await tutorialSvc.adminListTutorials(prisma, {
        ...(q.category ? { category: q.category } : {}),
        ...(q.enabled === undefined ? {} : { enabled: q.enabled === 'true' }),
      }),
    )
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[admin] 查询教学视频失败:', e)
    fail(res, 500, '查询失败', 500)
  }
})

const tutorialInput = z.object({
  category: z.enum(tutorialCategoryEnum),
  title: z.string().min(1).max(128),
  videoKey: z.string().max(512).nullable().optional(),
  coverKey: z.string().max(512).nullable().optional(),
  durationMs: z.number().int().min(0).nullable().optional(),
  sort: z.number().int().optional(),
  enabled: z.boolean().optional(),
})

router.post('/tutorials', async (req, res) => {
  try {
    ok(res, await tutorialSvc.adminUpsertTutorial(prisma, undefined, tutorialInput.parse(req.body)))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    console.error('[admin] 创建教学视频失败:', e)
    fail(res, 500, '创建失败', 500)
  }
})

router.put('/tutorials/:id', async (req, res) => {
  try {
    ok(res, await tutorialSvc.adminUpsertTutorial(prisma, idParam(req.params.id, 'id'), tutorialInput.parse(req.body)))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    if (e instanceof tutorialSvc.TutorialNotFoundError) return fail(res, 4049, e.message, 404)
    console.error('[admin] 更新教学视频失败:', e)
    fail(res, 500, '更新失败', 500)
  }
})

/** 硬删：连存储里的视频与封面一起删（删对象失败不致命，残留由 GC 兜底） */
router.delete('/tutorials/:id', async (req, res) => {
  try {
    ok(res, await tutorialSvc.adminRemoveTutorial(prisma, idParam(req.params.id, 'id')))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof tutorialSvc.TutorialNotFoundError) return fail(res, 4049, e.message, 404)
    console.error('[admin] 删除教学视频失败:', e)
    fail(res, 500, '删除失败', 500)
  }
})

/**
 * 教学视频 / 封面上传（multipart，字段名固定为 `file`，另有 `kind=video|cover`）。
 * 返回对象键而不是可播放地址：键要存进 tutorial_video，地址每次读时现签。
 */
router.post('/tutorials/upload', adminUploadSingle, async (req, res) => {
  const file = req.file
  if (!file) return fail(res, 3001, '缺少上传文件', 400)

  // kind 从 query 或表单字段取（两种调用方式都支持）
  let kind: 'video' | 'cover'
  try {
    kind = z.enum(['video', 'cover']).parse(req.query.kind ?? (req.body as { kind?: string })?.kind)
  } catch {
    await removeLocalFile(file.path)
    return fail(res, 400, '参数错误：kind 必须是 video 或 cover', 400)
  }

  try {
    if (kind === 'cover') {
      if (file.size > tutorialSvc.MAX_TUTORIAL_COVER_BYTES) {
        await removeLocalFile(file.path)
        const maxMb = Math.round(tutorialSvc.MAX_TUTORIAL_COVER_BYTES / 1024 / 1024)
        return fail(res, 400, `封面不能超过 ${maxMb}MB`, 400)
      }
      return ok(res, await tutorialSvc.saveTutorialCover(file.path))
    }
    ok(res, await tutorialSvc.saveTutorialVideo(file.path))
  } catch (e) {
    if (e instanceof tutorialSvc.TutorialUploadError) return fail(res, 400, e.message, 400)
    console.error('[admin] 教学素材上传失败:', e)
    fail(res, 500, '上传失败', 500)
  }
})

export default router
