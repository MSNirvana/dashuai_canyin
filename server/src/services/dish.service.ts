import type { PrismaClient } from '@prisma/client'

export class DishStoreMismatchError extends Error {
  readonly code = 'DISH_STORE_MISMATCH'
  constructor(message = '菜品不属于该门店') { super(message); this.name = 'DishStoreMismatchError' }
}

export interface DishMediaInput { type: 'IMAGE' | 'VIDEO'; cosKey: string; coverKey?: string; sort?: number }
export interface DishInput {
  name: string; intro?: string; sellingPoints?: string; coverKey?: string; videoKey?: string; sort?: number; media?: DishMediaInput[]
}

export async function ensureStoreOwned(prisma: PrismaClient, merchantId: bigint, storeId: bigint) {
  const store = await prisma.store.findFirst({ where: { id: storeId, merchantId, deletedAt: null }, select: { id: true } })
  if (!store) throw new DishStoreMismatchError('门店不存在或无权访问')
}

async function validateMedia(prisma: PrismaClient, merchantId: bigint, storeId: bigint, media: DishMediaInput[]) {
  if (media.filter((m) => m.type === 'IMAGE').length > 3 || media.filter((m) => m.type === 'VIDEO').length > 3) throw new DishStoreMismatchError('图片和视频分别最多上传 3 个')
  const keys = [...new Set(media.map((m) => m.cosKey))]
  if (!keys.length) return
  const assets = await prisma.mediaAsset.findMany({ where: { merchantId, storeId, cosKey: { in: keys }, status: 'READY', deletedAt: null }, select: { cosKey: true, type: true } })
  if (assets.length !== keys.length) throw new DishStoreMismatchError('存在无效或不属于当前门店的媒体')
  for (const item of media) if (!assets.some((a) => a.cosKey === item.cosKey && a.type === item.type)) throw new DishStoreMismatchError('媒体类型或归属无效')
}

function normalizeDish(d: any) {
  const media = d.media?.length ? d.media : [
    ...(d.coverKey ? [{ type: 'IMAGE', cosKey: d.coverKey, coverKey: null, sort: 0 }] : []),
    ...(d.videoKey ? [{ type: 'VIDEO', cosKey: d.videoKey, coverKey: null, sort: 0 }] : []),
  ]
  return { ...d, id: String(d.id), media: media.map((m: any) => ({ ...m, id: m.id ? String(m.id) : undefined })) }
}

export async function listDishes(prisma: PrismaClient, merchantId: bigint, storeId: bigint) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const rows = await prisma.dish.findMany({ where: { storeId, deletedAt: null }, orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }], include: { media: { orderBy: [{ type: 'asc' }, { sort: 'asc' }] } } })
  return rows.map(normalizeDish)
}

export async function getDish(prisma: PrismaClient, merchantId: bigint, storeId: bigint, dishId: bigint) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const row = await prisma.dish.findFirst({ where: { id: dishId, storeId, deletedAt: null }, include: { media: { orderBy: [{ type: 'asc' }, { sort: 'asc' }] } } })
  return row ? normalizeDish(row) : null
}

async function replaceMedia(prisma: PrismaClient, dishId: bigint, media: DishMediaInput[]) {
  await prisma.dishMedia.deleteMany({ where: { dishId } })
  if (media.length) await prisma.dishMedia.createMany({ data: media.map((m, i) => ({ dishId, type: m.type, cosKey: m.cosKey, coverKey: m.coverKey, sort: m.sort ?? i })) })
}

export async function createDish(prisma: PrismaClient, merchantId: bigint, storeId: bigint, input: DishInput) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const media = input.media ?? []
  await validateMedia(prisma, merchantId, storeId, media)
  const images = media.filter((m) => m.type === 'IMAGE').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const videos = media.filter((m) => m.type === 'VIDEO').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const dish = await prisma.dish.create({ data: { storeId, name: input.name, intro: input.intro, sellingPoints: input.sellingPoints, coverKey: images[0]?.cosKey ?? input.coverKey, videoKey: videos[0]?.cosKey ?? input.videoKey, sort: input.sort ?? 0 } })
  await replaceMedia(prisma, dish.id, media)
  return normalizeDish({ ...dish, media })
}

export async function updateDish(prisma: PrismaClient, merchantId: bigint, storeId: bigint, dishId: bigint, input: DishInput) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const existing = await prisma.dish.findFirst({ where: { id: dishId, storeId, deletedAt: null } })
  if (!existing) return null
  const media = input.media ?? []
  await validateMedia(prisma, merchantId, storeId, media)
  const images = media.filter((m) => m.type === 'IMAGE').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const videos = media.filter((m) => m.type === 'VIDEO').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const dish = await prisma.dish.update({ where: { id: dishId }, data: { name: input.name, intro: input.intro, sellingPoints: input.sellingPoints, coverKey: images[0]?.cosKey ?? input.coverKey ?? null, videoKey: videos[0]?.cosKey ?? input.videoKey ?? null, sort: input.sort ?? existing.sort } })
  await replaceMedia(prisma, dishId, media)
  return normalizeDish({ ...dish, media })
}

export async function deleteDish(prisma: PrismaClient, merchantId: bigint, storeId: bigint, dishId: bigint) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const dish = await prisma.dish.findFirst({ where: { id: dishId, storeId, deletedAt: null } })
  if (!dish) return false
  await prisma.dish.update({ where: { id: dishId }, data: { deletedAt: new Date() } })
  return true
}
