// 门店服务：**一个账号只有一家门店**（2026-09-24 起产品收敛，切换门店功能下线）
import type { PrismaClient } from '@prisma/client'

/**
 * 每个商户可拥有的门店上限，**写死 1**。
 * ★ 原来读 system_setting(store.max_per_merchant)，默认 10。那一项从未进过 seed、
 *   后台也没有配置入口 —— 留着只会让人以为上限可调，而实际上永远只会读到 fallback。
 *   现在单店是产品硬约束，直接写成常量，别再套一层「看似可配」的壳。
 */
const MAX_STORES_PER_MERCHANT = 1

export class StoreLimitError extends Error {
  readonly code = 'STORE_LIMIT'
  constructor(readonly limit: number = MAX_STORES_PER_MERCHANT) {
    super(limit === 1 ? '一个账号只能创建一家门店' : `门店数量已达上限（${limit}）`)
    this.name = 'StoreLimitError'
  }
}

export class StoreDefaultDeleteError extends Error {
  readonly code = 'STORE_DEFAULT_DELETE'
  constructor(message = '门店不可删除') {
    super(message)
    this.name = 'StoreDefaultDeleteError'
  }
}

export interface StoreInput {
  name: string
  category?: string
  province?: string
  city?: string
  district?: string
  address?: string
  coverKey?: string | null
  /** 门店介绍，最多 500 字，门店详情页统一展示 */
  intro?: string | null
  /** 门店视频对象键（可选）：仅作门店展示，不进创作素材池 */
  videoKey?: string | null
  /**
   * 是否设为默认门店。
   * ★ 2026-09-24 单店模型下**路由层已不再接受本字段**（见 routes/stores.ts）：
   *   一个账号只有一家门店，它必然是默认门店，没有「设/取消默认」这回事。
   *   服务层仍如实处理三态（true = 设为默认并原子取消其它默认；false = 取消默认；
   *   不传 = 不动），是留给仍直连服务层的脚本 / 后台的——多门店若恢复，把路由那行加回来即可。
   */
  isDefault?: boolean
}

export async function listStores(prisma: PrismaClient, merchantId: bigint) {
  return prisma.store.findMany({
    where: { merchantId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      name: true,
      category: true,
      province: true,
      city: true,
      district: true,
      address: true,
      coverKey: true,
      intro: true,
      videoKey: true,
      isDefault: true,
      createdAt: true,
      // 软删的菜品不该计入：Dish.deletedAt 非空即已删除，不过滤会多算
      _count: { select: { dishes: { where: { deletedAt: null } } } },
    },
  })
}

export async function getStore(prisma: PrismaClient, merchantId: bigint, storeId: bigint) {
  return prisma.store.findFirst({
    where: { id: storeId, merchantId, deletedAt: null },
    // 门店详情页要展示「菜品 N 道」。原实现没有返回 _count，
    // 而小程序端写的是 `detail._count?.dishes ?? 0` → 该行永远显示 0 道。
    // 列表接口 listStores 一直是有 _count 的，只有详情漏了。
    include: {
      _count: { select: { dishes: { where: { deletedAt: null } } } },
    },
  })
}

export async function createStore(prisma: PrismaClient, merchantId: bigint, input: StoreInput) {
  // ★ 单店模型：已经有门店的账号不能再建。这是产品硬约束（一个账号一家门店），
  //   不是「可配置的上限」—— 存量多门店的账号也同样建不了第二家（多余的那些仍留在库里，
  //   小程序永远只用默认门店，见 listStores 的排序）。
  const count = await prisma.store.count({ where: { merchantId, deletedAt: null } })
  if (count >= MAX_STORES_PER_MERCHANT) throw new StoreLimitError()

  // 能走到这里说明这是账号的**第一家（也是唯一一家）门店** ⇒ 必然是默认门店。
  // 旧实现里「非首店尊重 isDefault 开关 / 非默认分支」在多门店下线后已成死代码，一并删掉；
  // 前端也不再传 isDefault（编辑页的「设为默认门店」开关已随多门店一起移除）。
  return prisma.store.create({
    data: {
      merchantId,
      name: input.name,
      category: input.category,
      province: input.province,
      city: input.city,
      district: input.district,
      address: input.address,
      intro: input.intro ?? null,
      isDefault: true,
    },
  })
}

export async function updateStore(
  prisma: PrismaClient,
  merchantId: bigint,
  storeId: bigint,
  input: StoreInput & { isDefault?: boolean },
) {
  const store = await prisma.store.findFirst({ where: { id: storeId, merchantId, deletedAt: null } })
  if (!store) return null

  // 门店图片 / 视频都必须先作为素材落到本门店下，防止借用他人或其它门店的对象键
  await assertStoreMedia(prisma, merchantId, storeId, input.coverKey, 'IMAGE', () => new StoreCoverError())
  await assertStoreMedia(prisma, merchantId, storeId, input.videoKey, 'VIDEO', () => new StoreVideoError())

  // 设为默认：先把其它门店取消默认，再置当前为默认（事务保证唯一默认）
  if (input.isDefault === true && !store.isDefault) {
    await prisma.$transaction([
      prisma.store.updateMany({ where: { merchantId, isDefault: true }, data: { isDefault: false } }),
      prisma.store.update({ where: { id: storeId }, data: { isDefault: true } }),
    ])
  } else if (input.isDefault === false && store.isDefault) {
    // ★ 「取消默认」也要如实生效：原来只处理 true，用户把默认开关关掉再保存会被静默忽略，
    //   回到详情页开关还是开的（前端从 updateStore 的响应刷新，看到的仍是 true）。
    await prisma.store.update({ where: { id: storeId }, data: { isDefault: false } })
  }

  return prisma.store.update({
    where: { id: storeId },
    data: {
      name: input.name,
      category: input.category,
      province: input.province,
      city: input.city,
      district: input.district,
      address: input.address,
      ...(input.coverKey !== undefined ? { coverKey: input.coverKey } : {}),
      ...(input.intro !== undefined ? { intro: input.intro } : {}),
      ...(input.videoKey !== undefined ? { videoKey: input.videoKey } : {}),
    },
  })
}

/** 校验门店图片 / 视频的对象键确实属于本门店的已就绪素材 */
async function assertStoreMedia(
  prisma: PrismaClient,
  merchantId: bigint,
  storeId: bigint,
  cosKey: string | null | undefined,
  type: 'IMAGE' | 'VIDEO',
  error: () => Error,
) {
  if (cosKey === undefined || cosKey === null) return
  const asset = await prisma.mediaAsset.findFirst({
    where: {
      merchantId,
      storeId,
      cosKey,
      type,
      status: 'READY',
      deletedAt: null,
    },
    select: { id: true },
  })
  if (!asset) throw error()
}

export class StoreCoverError extends Error {
  constructor() {
    super('门店图片无效或不属于当前门店')
    this.name = 'StoreCoverError'
  }
}

export class StoreVideoError extends Error {
  constructor() {
    super('门店视频无效或不属于当前门店')
    this.name = 'StoreVideoError'
  }
}

export async function deleteStore(prisma: PrismaClient, merchantId: bigint, storeId: bigint) {
  const store = await prisma.store.findFirst({ where: { id: storeId, merchantId, deletedAt: null } })
  if (!store) return false
  // ★ 单店模型下账号唯一的那家门店就是默认门店 —— 删了全站就没有门店上下文了，一律拒绝。
  //   前端已无删除入口（门店详情页的「删除」按钮随多门店一起下线），这里留一道是为了
  //   挡住绕过界面直接调接口的调用方。
  if (store.isDefault) throw new StoreDefaultDeleteError()

  // 能走到这里的只有**历史遗留**的多门店数据（非默认门店）。保留这条路径是为了还能把
  // 遗留门店清出去（scripts/e2e-smoke.mjs 的历史数据清理就依赖它）；
  // 正常账号永远删不掉自己的门店，因为那家店一定是默认门店（上面已拦）。
  await prisma.store.update({ where: { id: storeId }, data: { deletedAt: new Date() } })
  return true
}
