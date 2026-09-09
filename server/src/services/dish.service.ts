// 菜品服务：归属门店，写操作均校验门店归属商家
import type { PrismaClient } from '@prisma/client'

export class DishStoreMismatchError extends Error {
  readonly code = 'DISH_STORE_MISMATCH'
  constructor() {
    super('菜品不属于该门店')
    this.name = 'DishStoreMismatchError'
  }
}

export interface DishInput {
  name: string
  intro?: string
  sellingPoints?: string
  coverKey?: string
  videoKey?: string
  sort?: number
}

export async function ensureStoreOwned(prisma: PrismaClient, merchantId: bigint, storeId: bigint) {
  const store = await prisma.store.findFirst({
    where: { id: storeId, merchantId, deletedAt: null },
    select: { id: true },
  })
  if (!store) throw new DishStoreMismatchError()
}

export async function listDishes(prisma: PrismaClient, merchantId: bigint, storeId: bigint) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  return prisma.dish.findMany({
    where: { storeId, deletedAt: null },
    orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      intro: true,
      sellingPoints: true,
      coverKey: true,
      videoKey: true,
      sort: true,
      createdAt: true,
    },
  })
}

export async function getDish(prisma: PrismaClient, merchantId: bigint, storeId: bigint, dishId: bigint) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  return prisma.dish.findFirst({ where: { id: dishId, storeId, deletedAt: null } })
}

export async function createDish(
  prisma: PrismaClient,
  merchantId: bigint,
  storeId: bigint,
  input: DishInput,
) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  return prisma.dish.create({
    data: {
      storeId,
      name: input.name,
      intro: input.intro,
      sellingPoints: input.sellingPoints,
      coverKey: input.coverKey,
      videoKey: input.videoKey,
      sort: input.sort ?? 0,
    },
  })
}

export async function updateDish(
  prisma: PrismaClient,
  merchantId: bigint,
  storeId: bigint,
  dishId: bigint,
  input: DishInput,
) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const dish = await prisma.dish.findFirst({ where: { id: dishId, storeId, deletedAt: null } })
  if (!dish) return null
  return prisma.dish.update({
    where: { id: dishId },
    data: {
      name: input.name,
      intro: input.intro,
      sellingPoints: input.sellingPoints,
      coverKey: input.coverKey,
      videoKey: input.videoKey,
      sort: input.sort ?? dish.sort,
    },
  })
}

export async function deleteDish(prisma: PrismaClient, merchantId: bigint, storeId: bigint, dishId: bigint) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const dish = await prisma.dish.findFirst({ where: { id: dishId, storeId, deletedAt: null } })
  if (!dish) return false
  await prisma.dish.update({ where: { id: dishId }, data: { deletedAt: new Date() } })
  return true
}
