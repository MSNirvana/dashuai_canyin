// 管理后台 - 商家 / 财务 / 套餐 / 调账 / 任务 / 镜头库 / 系统配置 等 CRUD
// 业务错误统一抛出 { code, httpStatus }，路由层捕获并映射
import type { PrismaClient, Prisma } from '@prisma/client'
import { adjust } from '../bean/bean.service.js'

export class AdminNotFoundError extends Error {
  constructor(readonly what: string) {
    super(`${what} 不存在`)
    this.name = 'AdminNotFoundError'
  }
}

// ──────────────────────── 商家与概览 ────────────────────────

export interface DashboardOverview {
  merchants: { total: number; active: number; todayNew: number }
  stores: number
  creations: { total: number; today: number }
  renderTasks: { total: number; today: number; running: number; failed24h: number }
  finance: {
    todayRechargeFen: number
    todayMemberFen: number
    monthRechargeFen: number
    todayBeanConsumed: string
    todayAiCostFen: number
    marginFen: number
  }
  ai: { providers: number; enabledProviders: number; downProviders: number; todayCalls: number; todayFallbackPct: number }
}

export async function getDashboardOverview(prisma: PrismaClient): Promise<DashboardOverview> {
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000)

  const [
    merchantTotal,
    merchantActive,
    merchantNewToday,
    storeTotal,
    creationTotal,
    creationToday,
    renderTotal,
    renderToday,
    renderRunning,
    renderFailed24h,
    todayRechargeAgg,
    monthRechargeAgg,
    todayMemberAgg,
    todayConsumeAgg,
    todayCostAgg,
    aiProviders,
    enabledProviders,
    downProviders,
    aiCallsToday,
    aiFallbackToday,
  ] = await Promise.all([
    prisma.merchant.count({ where: { deletedAt: null } }),
    prisma.merchant.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
    prisma.merchant.count({ where: { deletedAt: null, createdAt: { gte: startOfDay } } }),
    prisma.store.count({ where: { deletedAt: null } }),
    prisma.creation.count({ where: { deletedAt: null } }),
    prisma.creation.count({ where: { deletedAt: null, createdAt: { gte: startOfDay } } }),
    prisma.renderTask.count(),
    prisma.renderTask.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.renderTask.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } }),
    prisma.renderTask.count({ where: { status: 'FAILED', finishAt: { gte: dayAgo } } }),
    prisma.order.aggregate({
      _sum: { amountFen: true },
      where: { status: 'PAID', orderType: 'BEAN', paidAt: { gte: startOfDay } },
    }),
    prisma.order.aggregate({
      _sum: { amountFen: true },
      where: { status: 'PAID', orderType: 'BEAN', paidAt: { gte: startOfMonth } },
    }),
    prisma.order.aggregate({
      _sum: { amountFen: true },
      where: { status: 'PAID', orderType: 'MEMBER', paidAt: { gte: startOfDay } },
    }),
    // 今日消耗豆（绝对值）：beanLedger amount 为负表示消耗
    prisma.beanLedger.aggregate({
      _sum: { amount: true },
      where: { type: 'CONSUME', createdAt: { gte: startOfDay } },
    }),
    // 今日 AI 真实成本（分）
    prisma.aiCallLog.aggregate({
      _sum: { costFen: true },
      where: { status: 'SUCCESS', createdAt: { gte: startOfDay } },
    }),
    prisma.aiProvider.count(),
    prisma.aiProvider.count({ where: { enabled: true } }),
    prisma.aiProvider.count({ where: { healthStatus: 'DOWN' } }),
    prisma.aiCallLog.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.aiCallLog.count({ where: { createdAt: { gte: startOfDay }, isFallback: true } }),
  ])

  const todayFen = Number(todayRechargeAgg._sum.amountFen ?? 0) + Number(todayMemberAgg._sum.amountFen ?? 0)
  const todayAiFen = Number(todayCostAgg._sum.costFen ?? 0)
  const fallbackPct = aiCallsToday === 0 ? 0 : Math.round((aiFallbackToday / aiCallsToday) * 10000) / 100

  return {
    merchants: { total: merchantTotal, active: merchantActive, todayNew: merchantNewToday },
    stores: storeTotal,
    creations: { total: creationTotal, today: creationToday },
    renderTasks: {
      total: renderTotal,
      today: renderToday,
      running: renderRunning,
      failed24h: renderFailed24h,
    },
    finance: {
      todayRechargeFen: Number(todayRechargeAgg._sum.amountFen ?? 0),
      todayMemberFen: Number(todayMemberAgg._sum.amountFen ?? 0),
      monthRechargeFen: Number(monthRechargeAgg._sum.amountFen ?? 0),
      todayBeanConsumed: (-(todayConsumeAgg._sum.amount ?? 0n)).toString(),
      todayAiCostFen: todayAiFen,
      marginFen: todayFen - todayAiFen,
    },
    ai: {
      providers: aiProviders,
      enabledProviders,
      downProviders,
      todayCalls: aiCallsToday,
      todayFallbackPct: fallbackPct,
    },
  }
}

export async function listMerchants(
  prisma: PrismaClient,
  q: { phone?: string; status?: string; page?: number; pageSize?: number },
) {
  const page = q.page ?? 1
  const pageSize = Math.min(q.pageSize ?? 20, 100)
  const where: Prisma.MerchantWhereInput = {
    deletedAt: null,
    ...(q.phone ? { phone: { contains: q.phone } } : {}),
    ...(q.status ? { status: q.status } : {}),
  }
  const [list, total] = await Promise.all([
    prisma.merchant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        beanAccount: { select: { balance: true, grantBalance: true, totalRecharge: true, totalConsume: true } },
        memberships: {
          where: { status: 'ACTIVE', endAt: { gt: new Date() } },
          orderBy: { endAt: 'desc' },
          take: 1,
          include: { package: { select: { name: true, code: true } } },
        },
        _count: { select: { stores: true, creations: true, orders: true } },
      },
    }),
    prisma.merchant.count({ where }),
  ])
  return { list, total, page, pageSize }
}

export async function getMerchantDetail(prisma: PrismaClient, merchantId: bigint) {
  const m = await prisma.merchant.findFirst({
    where: { id: merchantId, deletedAt: null },
    include: {
      stores: { where: { deletedAt: null }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] },
      beanAccount: true,
      ledgers: { orderBy: { createdAt: 'desc' }, take: 50 },
      orders: { orderBy: { createdAt: 'desc' }, take: 20 },
      memberships: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { package: { select: { name: true } } },
      },
      _count: { select: { stores: true, creations: true, renderTasks: true } },
    },
  })
  if (!m) throw new AdminNotFoundError('商家')
  return m
}

export async function setMerchantStatus(prisma: PrismaClient, merchantId: bigint, status: 'ACTIVE' | 'DISABLED') {
  const r = await prisma.merchant.updateMany({
    where: { id: merchantId, deletedAt: null },
    data: { status },
  })
  if (r.count === 0) throw new AdminNotFoundError('商家')
  return { merchantId: merchantId.toString(), status }
}

// ──────────────────────── 套餐配置 ────────────────────────

export async function listAllBeanPackages(prisma: PrismaClient) {
  return prisma.beanPackage.findMany({ orderBy: [{ enabled: 'desc' }, { sort: 'asc' }] })
}

export async function upsertBeanPackage(
  prisma: PrismaClient,
  id: bigint | undefined,
  input: {
    name: string
    beans: bigint
    bonusBeans?: bigint
    priceFen: number
    memberPriceFen: number
    tag?: string | null
    sort?: number
    enabled?: boolean
  },
) {
  if (id) {
    const r = await prisma.beanPackage.update({
      where: { id },
      data: {
        name: input.name,
        beans: input.beans,
        bonusBeans: input.bonusBeans ?? 0n,
        priceFen: input.priceFen,
        memberPriceFen: input.memberPriceFen,
        tag: input.tag,
        sort: input.sort ?? 0,
        enabled: input.enabled ?? true,
      },
    })
    return r
  }
  return prisma.beanPackage.create({
    data: {
      name: input.name,
      beans: input.beans,
      bonusBeans: input.bonusBeans ?? 0n,
      priceFen: input.priceFen,
      memberPriceFen: input.memberPriceFen,
      tag: input.tag,
      sort: input.sort ?? 0,
      enabled: input.enabled ?? true,
    },
  })
}

export async function removeBeanPackage(prisma: PrismaClient, id: bigint) {
  const r = await prisma.beanPackage.deleteMany({ where: { id } })
  if (r.count === 0) throw new AdminNotFoundError('加油包')
  return { id: id.toString(), removed: true }
}

export async function listAllMemberPackages(prisma: PrismaClient) {
  return prisma.memberPackage.findMany({ orderBy: [{ enabled: 'desc' }, { sort: 'asc' }] })
}

export async function upsertMemberPackage(
  prisma: PrismaClient,
  id: bigint | undefined,
  input: {
    code: string
    name: string
    durationDays: number
    priceFen: number
    grantBeans: bigint
    rightsJson?: Prisma.InputJsonValue
    tag?: string | null
    sort?: number
    enabled?: boolean
  },
) {
  if (id) {
    return prisma.memberPackage.update({
      where: { id },
      data: {
        code: input.code,
        name: input.name,
        durationDays: input.durationDays,
        priceFen: input.priceFen,
        grantBeans: input.grantBeans,
        rightsJson: input.rightsJson,
        tag: input.tag,
        sort: input.sort ?? 0,
        enabled: input.enabled ?? true,
      },
    })
  }
  return prisma.memberPackage.create({
    data: {
      code: input.code,
      name: input.name,
      durationDays: input.durationDays,
      priceFen: input.priceFen,
      grantBeans: input.grantBeans,
      rightsJson: input.rightsJson,
      tag: input.tag,
      sort: input.sort ?? 0,
      enabled: input.enabled ?? true,
    },
  })
}

export async function removeMemberPackage(prisma: PrismaClient, id: bigint) {
  const r = await prisma.memberPackage.deleteMany({ where: { id } })
  if (r.count === 0) throw new AdminNotFoundError('会员套餐')
  return { id: id.toString(), removed: true }
}

// ──────────────────────── 流水查询 / 调账 ────────────────────────

export async function adminListBeanLedger(
  prisma: PrismaClient,
  q: { merchantId?: bigint; type?: string; page?: number; pageSize?: number },
) {
  const page = q.page ?? 1
  const pageSize = Math.min(q.pageSize ?? 20, 100)
  const where: Prisma.BeanLedgerWhereInput = {
    ...(q.merchantId ? { merchantId: q.merchantId } : {}),
    ...(q.type ? { type: q.type } : {}),
  }
  const [list, total] = await Promise.all([
    prisma.beanLedger.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { merchant: { select: { id: true, phone: true, nickname: true } } },
    }),
    prisma.beanLedger.count({ where }),
  ])
  return { list, total, page, pageSize }
}

/** 手动调账：GRANT/RECHARGE 加，ADJUST 减；由 admin 触发 */
export async function adminAdjustBeans(
  prisma: PrismaClient,
  operatorId: bigint,
  input: {
    merchantId: bigint
    /** 正数补，负数扣 */
    amount: bigint
    bucket: 'RECHARGE' | 'GRANT'
    remark: string
  },
) {
  if (input.amount === 0n) throw new Error('amount 不能为 0')
  if (!input.remark.trim()) throw new Error('请填写调账原因')
  const result = await prisma.$transaction((tx) =>
    adjust(tx, {
      operatorId,
      merchantId: input.merchantId,
      amount: input.amount,
      bucket: input.bucket,
      remark: input.remark,
    }),
  )
  return result
}

// ──────────────────────── 合成任务 ────────────────────────

export async function adminListRenderTasks(
  prisma: PrismaClient,
  q: { merchantId?: bigint; status?: string; grade?: 'BASIC' | 'AI' | 'PREMIUM'; page?: number; pageSize?: number },
) {
  const page = q.page ?? 1
  const pageSize = Math.min(q.pageSize ?? 20, 100)
  const where: Prisma.RenderTaskWhereInput = {
    ...(q.merchantId ? { merchantId: q.merchantId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.grade ? { grade: q.grade } : {}),
  }
  const [list, total] = await Promise.all([
    prisma.renderTask.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { merchant: { select: { phone: true, nickname: true } } },
    }),
    prisma.renderTask.count({ where }),
  ])
  return { list, total, page, pageSize }
}

// ──────────────────────── 镜头库 ────────────────────────

export async function adminListShotLibrary(prisma: PrismaClient) {
  return prisma.shotLibrary.findMany({
    orderBy: [{ category: 'asc' }, { sort: 'asc' }, { id: 'asc' }],
  })
}

export async function adminUpsertShotLibrary(
  prisma: PrismaClient,
  id: bigint | undefined,
  input: {
    code: string
    name: string
    category: string
    tips?: string | null
    source?: string
    demoVideoKey?: string | null
    demoCoverKey?: string | null
    sort?: number
    enabled?: boolean
  },
) {
  if (id) {
    return prisma.shotLibrary.update({
      where: { id },
      data: {
        code: input.code,
        name: input.name,
        category: input.category,
        tips: input.tips,
        source: input.source ?? 'MANUAL',
        demoVideoKey: input.demoVideoKey,
        demoCoverKey: input.demoCoverKey,
        sort: input.sort ?? 0,
        enabled: input.enabled ?? true,
      },
    })
  }
  return prisma.shotLibrary.create({
    data: {
      code: input.code,
      name: input.name,
      category: input.category,
      tips: input.tips,
      source: input.source ?? 'MANUAL',
      demoVideoKey: input.demoVideoKey,
      demoCoverKey: input.demoCoverKey,
      sort: input.sort ?? 0,
      enabled: input.enabled ?? true,
    },
  })
}

export async function adminRemoveShotLibrary(prisma: PrismaClient, id: bigint) {
  const r = await prisma.shotLibrary.deleteMany({ where: { id } })
  if (r.count === 0) throw new AdminNotFoundError('镜头库条目')
  return { id: id.toString(), removed: true }
}

// ──────────────────────── 系统配置 ────────────────────────

export async function adminListSystemSettings(prisma: PrismaClient) {
  return prisma.systemSetting.findMany({
    orderBy: [{ groupKey: 'asc' }, { sort: 'asc' }, { settingKey: 'asc' }],
  })
}

export async function adminUpsertSystemSetting(
  prisma: PrismaClient,
  id: bigint | undefined,
  input: {
    groupKey: string
    settingKey: string
    settingVal: string
    valueType: 'STRING' | 'INT' | 'BOOL' | 'JSON' | 'DECIMAL'
    displayName: string
    description?: string | null
    sort?: number
    isPublic?: boolean
  },
) {
  if (id) {
    return prisma.systemSetting.update({
      where: { id },
      data: {
        groupKey: input.groupKey,
        settingKey: input.settingKey,
        settingVal: input.settingVal,
        valueType: input.valueType,
        displayName: input.displayName,
        description: input.description,
        sort: input.sort ?? 0,
        isPublic: input.isPublic ?? false,
      },
    })
  }
  return prisma.systemSetting.create({
    data: {
      groupKey: input.groupKey,
      settingKey: input.settingKey,
      settingVal: input.settingVal,
      valueType: input.valueType,
      displayName: input.displayName,
      description: input.description,
      sort: input.sort ?? 0,
      isPublic: input.isPublic ?? false,
    },
  })
}

export async function adminRemoveSystemSetting(prisma: PrismaClient, id: bigint) {
  const r = await prisma.systemSetting.deleteMany({ where: { id } })
  if (r.count === 0) throw new AdminNotFoundError('配置项')
  return { id: id.toString(), removed: true }
}
