// 门店服务：多门店模型的核心。创建受 system_setting(store.max_per_merchant) 限制
import type { PrismaClient } from '@prisma/client'
import { getNumber } from '../lib/settings.js'

export class StoreLimitError extends Error {
  readonly code = 'STORE_LIMIT'
  constructor(readonly limit: number) {
    super(`门店数量已达上限（${limit}）`)
    this.name = 'StoreLimitError'
  }
}

export class StoreDefaultDeleteError extends Error {
  readonly code = 'STORE_DEFAULT_DELETE'
  constructor() {
    super('默认门店不可删除，请先将其它门店设为默认')
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
  const max = await getNumber(prisma, 'store', 'max_per_merchant', 10)
  const count = await prisma.store.count({ where: { merchantId, deletedAt: null } })
  if (count >= max) throw new StoreLimitError(Number(max))

  const isFirst = count === 0
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
      isDefault: isFirst, // 首店自动为默认
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
  if (store.isDefault) throw new StoreDefaultDeleteError()

  const remaining = await prisma.store.count({ where: { merchantId, deletedAt: null } })
  if (remaining <= 1) throw new StoreDefaultDeleteError()

  await prisma.store.update({ where: { id: storeId }, data: { deletedAt: new Date() } })
  return true
}
