// 创作服务：把「门店/菜品上下文」喂给 AI 网关生成文案与分镜，并持久化分镜
// 计费通过 runBilledScene 内部完成（文案 5 豆 / 分镜 10 豆），这里只负责上下文与落库
import type { PrismaClient, Shot } from '@prisma/client'
import type { AiGateway } from '../ai/gateway.js'
import { runBilledScene, ScenePendingError } from '../ai/ai.service.js'
import { BeanNotEnoughError } from '../bean/bean.service.js'
import { requireSubscription } from './subscription.service.js'

export const SCENE_COPY = 'copy_generate'
export const SCENE_STORYBOARD = 'storyboard_generate'

export class CreationNotFoundError extends Error {
  constructor() {
    super('创作不存在')
    this.name = 'CreationNotFoundError'
  }
}
export class CreationStoreMismatchError extends Error {
  constructor() {
    super('创作不属于该门店或商家')
    this.name = 'CreationStoreMismatchError'
  }
}

export class CreationDishMismatchError extends Error {
  constructor() {
    super('菜品不属于当前商家门店')
    this.name = 'CreationDishMismatchError'
  }
}

export class CreationAssetMismatchError extends Error {
  constructor() {
    super('创作中的素材不属于当前商家门店或已被删除')
    this.name = 'CreationAssetMismatchError'
  }
}

export interface CreateCreationInput {
  storeId: bigint
  dishId?: bigint
  title?: string
}

export interface CopyResult {
  text: string
  beanCharged: bigint
  balance: { balance: bigint; grantBalance: bigint; available: bigint }
  duplicated: boolean
  isFallbackTemplate: boolean
}

export interface StoryboardResult {
  shots: Shot[]
  raw?: string
  parsed: boolean
  beanCharged: bigint
  balance: { balance: bigint; grantBalance: bigint; available: bigint }
  duplicated: boolean
  isFallbackTemplate: boolean
}

export async function listCreations(
  prisma: PrismaClient,
  merchantId: bigint,
  storeId?: bigint,
) {
  return prisma.creation.findMany({
    where: { merchantId, storeId: storeId ?? undefined, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      storeId: true,
      dishId: true,
      track: true,
      complexity: true,
      copyText: true,
      status: true,
      createdAt: true,
      _count: { select: { shots: true } },
    },
  })
}

export async function createCreation(
  prisma: PrismaClient,
  merchantId: bigint,
  input: CreateCreationInput,
) {
  const store = await prisma.store.findFirst({
    where: { id: input.storeId, merchantId, deletedAt: null },
  })
  if (!store) throw new CreationStoreMismatchError()
  if (input.dishId !== undefined) {
    const dish = await prisma.dish.findFirst({
      where: { id: input.dishId, storeId: input.storeId, store: { merchantId, deletedAt: null }, deletedAt: null },
      select: { id: true },
    })
    if (!dish) throw new CreationDishMismatchError()
  }
  return prisma.creation.create({
    data: {
      merchantId,
      storeId: input.storeId,
      dishId: input.dishId,
      title: input.title,
      track: 'NORMAL',
      complexity: 'NORMAL',
    },
  })
}

export async function getCreation(prisma: PrismaClient, merchantId: bigint, creationId: bigint) {
  const c = await prisma.creation.findFirst({
    where: { id: creationId, merchantId, deletedAt: null },
    include: {
      shots: { orderBy: { seq: 'asc' } },
      dish: { select: { id: true, name: true } },
      store: { select: { id: true, name: true } },
    },
  })
  if (!c) throw new CreationNotFoundError()
  // 附加素材时长：合成页前端预估积分需要（未 trim 的分镜按素材实际时长计价）
  const assetIds = c.shots.map((s) => s.assetId).filter((v): v is bigint => v !== null)
  const assets = assetIds.length
    ? await prisma.mediaAsset.findMany({ where: { id: { in: assetIds }, merchantId, storeId: c.storeId, deletedAt: null } })
    : []
  if (assets.length !== assetIds.length) throw new CreationAssetMismatchError()
  const durMap = new Map(assets.map((a) => [a.id, a.durationMs]))
  return {
    ...c,
    shots: c.shots.map((s) => ({
      ...s,
      assetDurationMs: s.assetId ? (durMap.get(s.assetId) ?? null) : null,
    })),
  }
}

/** 拼装 AI 提示词变量：门店 + 菜品 + 商家人设 + 已生成文案 */
async function buildVariables(prisma: PrismaClient, creationId: bigint) {
  const c = await prisma.creation.findUnique({
    where: { id: creationId },
    include: {
      store: true,
      dish: true,
      merchant: { include: { persona: true } },
    },
  })
  if (!c) throw new CreationNotFoundError()
  const persona = c.merchant.persona
  return {
    storeName: c.store.name,
    category: c.store.category ?? '',
    city: c.store.city ?? '',
    dishName: c.dish?.name ?? '',
    dishIntro: c.dish?.intro ?? '',
    sellingPoints: c.dish?.sellingPoints ?? '',
    persona: persona ? `${persona.bossTags ?? ''} ${persona.activity ?? ''}`.trim() : '',
    copyText: c.copyText ?? '',
  }
}

export async function generateCopy(
  prisma: PrismaClient,
  gateway: AiGateway,
  merchantId: bigint,
  creationId: bigint,
  requestId: string,
): Promise<CopyResult> {
  // v5：订阅是使用文案生成的硬前提（在扣积分之前拦截，避免白冻结）
  await requireSubscription(prisma, merchantId, '文案生成')
  await getCreation(prisma, merchantId, creationId) // 校验归属
  const vars = await buildVariables(prisma, creationId)
  const r = await runBilledScene(prisma, gateway, {
    sceneCode: SCENE_COPY,
    merchantId,
    requestId,
    variables: vars,
    bizId: String(creationId),
  })
  if (!r.isFallbackTemplate && r.text) {
    await prisma.creation.update({ where: { id: creationId }, data: { copyText: r.text } })
  }
  return {
    text: r.text,
    beanCharged: r.beanCharged,
    balance: r.balance,
    duplicated: r.duplicated,
    isFallbackTemplate: r.isFallbackTemplate,
  }
}

/** 从 AI 返回的散文中尽量抠出 JSON 数组/对象 */
function extractJson(text: string): string {
  const arrS = text.indexOf('[')
  const arrE = text.lastIndexOf(']')
  if (arrS >= 0 && arrE > arrS) return text.slice(arrS, arrE + 1)
  const objS = text.indexOf('{')
  const objE = text.lastIndexOf('}')
  if (objS >= 0 && objE > objS) return text.slice(objS, objE + 1)
  return text
}

export async function generateShots(
  prisma: PrismaClient,
  gateway: AiGateway,
  merchantId: bigint,
  creationId: bigint,
  requestId: string,
): Promise<StoryboardResult> {
  // v5：订阅是使用分镜生成的硬前提
  await requireSubscription(prisma, merchantId, '分镜生成')
  await getCreation(prisma, merchantId, creationId)
  const vars = await buildVariables(prisma, creationId)
  const r = await runBilledScene(prisma, gateway, {
    sceneCode: SCENE_STORYBOARD,
    merchantId,
    requestId,
    variables: vars,
    bizId: String(creationId),
  })

  let parsed = false
  let shots: Shot[] = []
  let raw: string | undefined
  if (r.text) {
    raw = r.text
    try {
      const parsedBody = JSON.parse(extractJson(r.text))
      const arr: unknown[] = Array.isArray(parsedBody)
        ? parsedBody
        : Array.isArray((parsedBody as { shots?: unknown[] }).shots)
          ? (parsedBody as { shots: unknown[] }).shots
          : []
      await prisma.$transaction(async (tx) => {
        await tx.shot.deleteMany({ where: { creationId } })
        let seq = 0
        for (const item of arr) {
          seq++
          const it = item as Record<string, unknown>
          await tx.shot.create({
            data: {
              creationId,
              seq,
              shotType: (it.shotType as string) ?? null,
              durationSuggest:
                typeof it.durationSuggest === 'number' ? it.durationSuggest : null,
              line: (it.line as string) ?? null,
              visualReq: (it.visualReq as string) ?? null,
              status: 'PENDING',
            },
          })
        }
      })
      parsed = true
      shots = await prisma.shot.findMany({ where: { creationId }, orderBy: { seq: 'asc' } })
    } catch {
      parsed = false
    }
  }
  return {
    shots,
    raw,
    parsed,
    beanCharged: r.beanCharged,
    balance: r.balance,
    duplicated: r.duplicated,
    isFallbackTemplate: r.isFallbackTemplate,
  }
}

export async function updateShotAsset(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
  shotId: bigint,
  input: { assetId?: bigint; trimStartMs?: number; trimEndMs?: number },
) {
  const creation = await getCreation(prisma, merchantId, creationId)
  // 越权防护：shot 必须属于当前 creation（否则可改到他人创作的分镜）
  if (input.assetId !== undefined) {
    const asset = await prisma.mediaAsset.findFirst({ where: { id: input.assetId, merchantId, storeId: creation.storeId, deletedAt: null } })
    if (!asset) throw new Error('素材不属于当前商家门店')
  }
  const upd = await prisma.shot.updateMany({
    where: { id: shotId, creationId },
    data: {
      assetId: input.assetId,
      trimStartMs: input.trimStartMs ?? 0,
      trimEndMs: input.trimEndMs,
    },
  })
  if (upd.count === 0) throw new Error('分镜不存在')
  const shot = await prisma.shot.findUnique({ where: { id: shotId } })
  if (!shot) throw new Error('分镜不存在')
  return shot
}
