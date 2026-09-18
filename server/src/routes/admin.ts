// 后台管理路由（/admin/api/v1，单角色全权限）
// 范围：管理员登录 / TTS 供应商 / 仪表盘 / 商家 / 套餐 / 账务与调账 / AI 配置 / 镜头库 / 系统配置 / 合成任务
import { createRouter } from '../lib/async-router.js'
import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { join } from 'node:path'
import { InvalidIdParamError, idParam, optionalIdParam } from '../lib/params.js'
import { z } from 'zod'
import { prisma, redis } from '../db.js'
import { ok, fail } from '../lib/result.js'
import { adminAuth } from '../middleware/admin-auth.js'
import {
  ADMIN_LOGIN_GLOBAL_POLICY,
  ADMIN_LOGIN_POLICY,
  adminGlobalKey,
  adminUserKey,
  checkLoginAllowed,
  clearLoginFailures,
  recordLoginFailure,
} from '../lib/login-throttle.js'
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
import * as premiumDeliverSvc from '../services/premium-delivery.service.js'
import { invalidate } from '../lib/settings.js'
import { UnsafeOutboundUrlError } from '../lib/outbound-url.js'
import type { Prisma } from '@prisma/client'

const router = createRouter()

// ──────────────────────── 鉴权（无需登录） ────────────────────────

const loginInput = z.object({ username: z.string().min(1), password: z.string().min(1) })

router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = loginInput.parse(req.body)
    /**
     * ★ 先查锁，再比密码 —— 顺序不能反。
     *   反过来的话，被锁的请求仍然会去查库、跑一次 bcrypt 比对（那是登录路径上最贵的一步），
     *   限速就从「挡住爆破」退化成「只少发一次 token」：攻击者照样能用 CPU 把你拖住。
     */
    const checks = [
      { key: adminUserKey(username), policy: ADMIN_LOGIN_POLICY },
      { key: adminGlobalKey(), policy: ADMIN_LOGIN_GLOBAL_POLICY },
    ]
    const verdict = await checkLoginAllowed(redis, checks)
    if (!verdict.allowed) {
      // 429：语义就是「稍后重试」；文案给出还要等多久，否则用户只会不停再点
      return fail(res, 4029, `登录失败次数过多，请 ${Math.ceil(verdict.retryAfterSec / 60)} 分钟后再试`, 429)
    }
    try {
      const r = await adminSvc.adminLogin(prisma, username, password)
      await clearLoginFailures(redis, username)
      return ok(res, r)
    } catch (e) {
      if (!(e instanceof adminSvc.AdminLoginFailedError)) throw e
      const locked = await recordLoginFailure(redis, checks)
      return fail(
        res,
        4001,
        locked
          ? `登录失败次数过多，请 ${Math.ceil(ADMIN_LOGIN_POLICY.windowSec / 60)} 分钟后再试`
          : e.message,
        locked ? 429 : 401,
      )
    }
  } catch (e) {
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
  /**
   * 幂等键，**必填**。
   *
   * ★ 为什么定成必填而不是选填：调账是「改钱」的动作，而它唯一的重复防线就是这个键。
   *   选填的话，忘了传的调用方会退回「每次生成新键」的老路 —— 而那正是这个 bug 的成因，
   *   表现为双击一次按钮、或请求超时重试一次，余额就被改了两遍，且两条 ADJUST 流水
   *   看起来都完全正常（不同 requestId ⇒ 唯一索引不拦）。
   *   宁可让忘了传的调用方当场吃一个 400 并看清要传什么，也不要让它悄悄地把钱改错。
   *
   * 语义：同一个 requestId 重复提交只落一次账，第二次返回**首次**的余额快照
   * （响应里的 `duplicated=true`）。所以「重试」是安全的：
   * 客户端只要在**同一次调账意图**里复用同一个 id，就不会重复扣加。
   */
  requestId: z.string().min(8).max(64),
})
router.post('/bean/adjust', async (req, res) => {
  try {
    const input = adjustInput.parse(req.body)
    const r = await adminExtra.adminAdjustBeans(prisma, BigInt(req.adminId!), {
      merchantId: BigInt(input.merchantId as string | number),
      amount: BigInt(input.amount as string | number),
      bucket: input.bucket,
      remark: input.remark,
      requestId: input.requestId,
    })
    ok(res, {
      balanceAfter: r.balanceAfter.toString(),
      grantAfter: r.grantAfter.toString(),
      // 如实告知这是重放：后台据此提示「本次没有重复扣加」，而不是让运营以为又调了一次
      duplicated: r.duplicated,
    })
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误（requestId 为必填幂等键，长度 8~64）', 400)
    return fail(res, 400, (e as Error).message, 400)
  }
})

// ──────────────────────── 合成任务管理 ────────────────────────
const renderQ = z.object({
  merchantId: z.coerce.bigint().optional(),
  status: z.string().optional(),
  /**
   * 多状态筛选（逗号分隔）。
   *
   * 为什么另开一个参数而不是让 `status` 接受数组：「精品接单」页默认要的是
   * **待接单 + 剪辑中**这一个语义集合（「手上还有活吗」），而不是两个独立的筛选值。
   * 让 `status` 同时接受字符串与数组，会把一个 z.string 悄悄变成联合类型，
   * 而调用方（旧页面）传的仍是字符串 —— 这种「看着兼容、类型其实变了」的改动
   * 最容易在下一次编辑时踩空。
   */
  statuses: z.string().max(240).optional(),
  grade: z.enum(['BASIC', 'AI', 'PREMIUM']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
router.get('/render/tasks', async (req, res) => {
  try {
    const q = renderQ.parse(req.query)
    // ★ 拆出 statuses 再展开：zod 的 `.optional()` 在展开后仍带 `| undefined`，
    //   而 service 的入参是 `string[] | undefined` —— 直接 `...q` 会让
    //   「已解析成数组」这件事在类型上丢掉（运行时没问题，但类型检查会挡下）。
    const { statuses, ...rest } = q
    ok(
      res,
      await adminExtra.adminListRenderTasks(prisma, {
        ...rest,
        ...(statuses
          ? { statuses: statuses.split(',').map((s) => s.trim()).filter(Boolean) }
          : {}),
      }),
    )
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    fail(res, 500, '查询失败', 500)
  }
})

// ──────────────────────── 精品生成 · 剪辑工作台 ────────────────────────
const deliverInput = z.object({
  resultKey: z.string().min(1).max(512),
  previewKey: z.string().max(512).nullable().optional(),
  resultSize: z.coerce.bigint().optional(),
  durationMs: z.coerce.number().int().min(0).optional(),
})

/**
 * 交付素材上传（multipart，字段名固定 `file`，另带 `kind=video|cover`）。
 *
 * 存在的理由：交付接口收的是**对象键**，而后台此前没有上传端点 ⇒ 剪辑师只能在别处把
 * 成片传上去再把键抄进来。抄错一位的表现是「交付成功、用户端永远播不出来」，
 * 库里完全看不出问题。这里改成「选文件 → 回填键」，并把时长/封面一起带出来。
 *
 * ⚠ multer 实例自己一个（limits 必须绑本功能的常量），但**错误翻译复用下面的
 *   `uploadSingle()` 工厂**（本函数用到的它在文件更下面定义 —— 函数声明会提升，
 *   此处调用是安全的）。这一块是本项目第三个上传点了，各抄一份的代价已经显现过：
 *   「文件不能超过 XMB」这类文案漏改一处，表现就是运营看着一个错误的数字去压缩文件。
 */
const deliverUpload = multer({
  dest: join(localStorageRoot(), '.incoming'),
  limits: { fileSize: premiumDeliverSvc.MAX_DELIVER_VIDEO_BYTES },
})

/** 错误翻译走共享工厂（定义在本文件更下面 —— 函数声明会提升，此处求值安全） */
const deliverUploadSingle = uploadSingle(deliverUpload, premiumDeliverSvc.MAX_DELIVER_VIDEO_BYTES)

router.post('/render/tasks/:id/deliver/upload', deliverUploadSingle, async (req, res) => {
  const file = req.file
  if (!file) return fail(res, 3001, '缺少上传文件', 400)
  try {
    const kind = z
      .enum(['video', 'cover'])
      .parse(req.query.kind ?? (req.body as { kind?: string })?.kind)
    const id = idParam(req.params.id, 'id')

    if (kind === 'cover') {
      if (file.size > premiumDeliverSvc.MAX_DELIVER_COVER_BYTES) {
        const maxMb = Math.round(premiumDeliverSvc.MAX_DELIVER_COVER_BYTES / 1024 / 1024)
        return fail(res, 400, `封面不能超过 ${maxMb}MB`, 400)
      }
      return ok(res, await premiumDeliverSvc.saveDeliverCover(prisma, id, file.path))
    }
    return ok(res, await premiumDeliverSvc.saveDeliverVideo(prisma, id, file.path))
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误：kind 必须是 video 或 cover', 400)
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof premiumDeliverSvc.DeliverAssetError) return fail(res, e.code, e.message, e.httpStatus)
    console.error('[admin] 交付素材上传失败:', e)
    return fail(res, 500, '上传失败', 500)
  } finally {
    // ★ 兜底清理。service 内部也会清（正常路径），但「kind 不合法」「编号不合法」
    //   「封面超限」这三个分支在进 service 之前就 return 了，走不到那里。
    //   multer 全部落在 storage/.incoming/，漏一个就是一次永久占盘。
    await removeLocalFile(file.path)
  }
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
    if (e instanceof UnsafeOutboundUrlError) return fail(res, 400, e.message, 400)
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
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
    if (e instanceof UnsafeOutboundUrlError) return fail(res, 400, e.message, 400)
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
    if (e instanceof adminExtra.ShotLibraryKeyError) return fail(res, 400, e.message, 400)
    fail(res, 500, '创建失败', 500)
  }
})
router.put('/shot-library/:id', async (req, res) => {
  try {
    ok(res, await adminExtra.adminUpsertShotLibrary(prisma, idParam(req.params.id, 'id'), shotLibInput.parse(req.body)))
  } catch (e) {
    if (e instanceof InvalidIdParamError) return fail(res, 4000, '参数不合法', 400)
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    if (e instanceof adminExtra.ShotLibraryKeyError) return fail(res, 400, e.message, 400)
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

// ──────────────────────── 平台级素材上传（作品 / 教学视频） ────────────────────────
//
// 这两条上传通道是一条：平台级内容没有商家上下文（admin 路由只有 req.adminId），
// 所以都不带 storeId、不锁商户前缀、不过商家的存储配额；也都要求
// **服务端先收流、再按文件头判类型**（客户端声明的 Content-Type 与文件名都不可信）。
// 差别只有键前缀（works/ 与 tutorials/）和大小上限，所以公共件只留一份 ——
// 这层原本写在「教学中心」那一段里，第二个调用方（作品）出现时就该提出来，
// 否则「上传失败」的错误文案与 multer 的错误映射会被抄成两份、然后各改各的。
//
// 为什么不收 raw body（像轮播图那样）而收 multipart：这两类是**视频**，100MB 级。
// raw 会把整段字节读进内存再交给业务层；multer 直接落盘中转，之后的
// ffmpeg 抽帧与流式上传都能按文件路径处理，内存占用与文件大小无关。
// 轮播图 ≤5MB，raw 反而更简单（少一层表单解析）—— 两条路按体积分。

/**
 * 包一层，把 multer 的错误转成可读的业务码。
 * 不拦的话 multer 走 `next(err)` 一路落到全局 errorHandler，变成「服务器内部错误 500」
 * —— 运营看到 500 完全不知道是自己的文件太大。
 * ⚠ 注意 client_max_body_size：nginx 先于本层拒绝时返回的是 413 页面，
 *   与本函数无关（deploy/nginx/dashuai-admin.conf 已同步放开到 110m）。
 */
function uploadSingle(upload: multer.Multer, maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return next()
      const tooLarge = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
      const maxMb = Math.round(maxBytes / 1024 / 1024)
      fail(res, 400, tooLarge ? `文件不能超过 ${maxMb}MB` : '文件上传失败，请重试', 400)
    })
  }
}

const workUpload = multer({
  dest: join(localStorageRoot(), '.incoming'),
  // 单文件上限，与 MAX_WORK_VIDEO_BYTES 同一个数字（超限的文件根本不落盘）
  limits: { fileSize: workSvc.MAX_WORK_VIDEO_BYTES },
})

/**
 * 作品视频 / 封面上传（multipart，字段名固定 `file`，另有 `kind=video|cover`）。
 * 返回**对象键**而不是可播放地址：键写进 excellent_work 那两列，地址每次读时现签
 * （私有桶，固定键覆盖上传还会让微信/CDN 继续显示旧图，见 work.service 的建键说明）。
 *
 * 视频上传成功时会顺手抽一帧当封面（抽帧失败**不阻断**，回 coverKey: null，
 * 运营仍可在列表上点「重抽封面」补 —— 不该因为封面把整个上传退掉）。
 */
router.post('/works/upload', uploadSingle(workUpload, workSvc.MAX_WORK_VIDEO_BYTES), async (req, res) => {
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
      // 封面上限比 multer 的 100MB 严得多，所以在拿到文件之后再单独判一次
      if (file.size > workSvc.MAX_WORK_COVER_BYTES) {
        await removeLocalFile(file.path)
        const maxMb = Math.round(workSvc.MAX_WORK_COVER_BYTES / 1024 / 1024)
        return fail(res, 400, `封面不能超过 ${maxMb}MB`, 400)
      }
      return ok(res, await workSvc.saveWorkCover(file.path))
    }
    ok(res, await workSvc.saveWorkVideo(file.path))
  } catch (e) {
    if (e instanceof workSvc.WorkUploadError) return fail(res, 400, e.message, 400)
    console.error('[admin] 作品素材上传失败:', e)
    fail(res, 500, '上传失败', 500)
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
router.post('/tutorials/upload', uploadSingle(tutorialUpload, tutorialSvc.MAX_TUTORIAL_VIDEO_BYTES), async (req, res) => {
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
