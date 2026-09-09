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
  contact?: string
  coverKey?: string | null
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
      contact: true,
      coverKey: true,
      isDefault: true,
      createdAt: true,
      _count: { select: { dishes: true } },
    },
  })
}

export async function getStore(prisma: PrismaClient, merchantId: bigint, storeId: bigint) {
  return prisma.store.findFirst({
    where: { id: storeId, merchantId, deletedAt: null },
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
      contact: input.contact,
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

  if (input.coverKey !== undefined && input.coverKey !== null) {
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        merchantId,
        storeId,
        cosKey: input.coverKey,
        type: 'IMAGE',
        status: 'READY',
        deletedAt: null,
      },
      select: { id: true },
    })
    if (!asset) throw new StoreCoverError()
  }

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
      contact: input.contact,
      ...(input.coverKey !== undefined ? { coverKey: input.coverKey } : {}),
    },
  })
}

export class StoreCoverError extends Error {
  constructor() {
    super('门店图片无效或不属于当前门店')
    this.name = 'StoreCoverError'
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
