// 人设服务：商家唯一记录（uk_merchant），老板人设标签 + 门店活动
// 用于 AI 文案/分镜生成的上下文变量拼装
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

/** 读取商家人设（无则返回 null） */
export async function getPersona(prisma: PrismaClient, merchantId: bigint): Promise<PersonaView | null> {
  const p = await prisma.persona.findUnique({
    where: { merchantId },
    select: { bossTags: true, activity: true, updatedAt: true },
  })
  if (!p) return null
  return {
    bossTags: p.bossTags ?? null,
    activity: p.activity ?? null,
    updatedAt: p.updatedAt.toISOString(),
  }
}

/** 上传人设：不存在则创建，存在则更新（老板人设与活动都允许 null 清空） */
export async function upsertPersona(
  prisma: PrismaClient,
  merchantId: bigint,
  input: PersonaInput,
): Promise<PersonaView> {
  const row = await prisma.persona.upsert({
    where: { merchantId },
    create: {
      merchantId,
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
