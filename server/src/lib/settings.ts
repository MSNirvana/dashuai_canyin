// 系统配置读取（带进程内缓存，后台修改时调用 invalidate()）

import type { PrismaClient } from '@prisma/client'

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { value: string; expireAt: number }>()

export function invalidate(groupKey?: string, settingKey?: string) {
  if (!groupKey) return cache.clear()
  for (const k of cache.keys()) {
    if (settingKey ? k === `${groupKey}.${settingKey}` : k.startsWith(`${groupKey}.`)) {
      cache.delete(k)
    }
  }
}

async function read(prisma: PrismaClient, groupKey: string, settingKey: string): Promise<string | null> {
  const ck = `${groupKey}.${settingKey}`
  const hit = cache.get(ck)
  if (hit && hit.expireAt > Date.now()) return hit.value

  const row = await prisma.systemSetting.findUnique({
    where: { groupKey_settingKey: { groupKey, settingKey } },
  })
  if (!row) return null
  cache.set(ck, { value: row.settingVal, expireAt: Date.now() + CACHE_TTL_MS })
  return row.settingVal
}

export async function getString(prisma: PrismaClient, group: string, key: string, fallback: string) {
  return (await read(prisma, group, key)) ?? fallback
}

export async function getNumber(prisma: PrismaClient, group: string, key: string, fallback: number) {
  const v = await read(prisma, group, key)
  if (v === null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export async function getBool(prisma: PrismaClient, group: string, key: string, fallback: boolean) {
  const v = await read(prisma, group, key)
  if (v === null) return fallback
  return v === 'true' || v === '1'
}
