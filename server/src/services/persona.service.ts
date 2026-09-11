// 人设服务：门店级唯一记录（一门店一条），老板人设标签 + 门店活动
// 用于 AI 文案/分镜生成的上下文变量拼装；内容（菜品/创作/人设）全部跟随门店
import type { PrismaClient } from '@prisma/client'

export interface PersonaInput {
  bossTags?: string | null
  activity?: string | null
}

export interface PersonaView {
  bossTags: string | null
  activity: string | null
  updatedAt: string
}

export class PersonaStoreMismatchError extends Error {
  readonly code = 'PERSONA_STORE_MISMATCH'
  constructor(message = '门店不存在或无权访问') {
    super(message)
    this.name = 'PersonaStoreMismatchError'
  }
}

async function ensureStoreOwned(prisma: PrismaClient, merchantId: bigint, storeId: bigint) {
  const store = await prisma.store.findFirst({
    where: { id: storeId, merchantId, deletedAt: null },
    select: { id: true },
  })
  if (!store) throw new PersonaStoreMismatchError()
}

/** 读取门店人设（无则返回 null） */
export async function getPersona(
  prisma: PrismaClient,
  merchantId: bigint,
  storeId: bigint,
): Promise<PersonaView | null> {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const p = await prisma.persona.findUnique({
    where: { storeId },
    select: { bossTags: true, activity: true, updatedAt: true },
  })
  if (!p) return null
  return {
    bossTags: p.bossTags ?? null,
    activity: p.activity ?? null,
    updatedAt: p.updatedAt.toISOString(),
  }
}

/** 上传门店人设：不存在则创建，存在则更新（老板人设与活动都允许 null 清空） */
export async function upsertPersona(
  prisma: PrismaClient,
  merchantId: bigint,
  storeId: bigint,
  input: PersonaInput,
): Promise<PersonaView> {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const row = await prisma.persona.upsert({
    where: { storeId },
    create: {
      merchantId,
      storeId,
      bossTags: input.bossTags ?? null,
      activity: input.activity ?? null,
    },
    update: {
      // 显式 null 也写入：前端允许"清空"
      bossTags: input.bossTags === undefined ? undefined : input.bossTags,
      activity: input.activity === undefined ? undefined : input.activity,
    },
    select: { bossTags: true, activity: true, updatedAt: true },
  })
  return {
    bossTags: row.bossTags ?? null,
    activity: row.activity ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}
