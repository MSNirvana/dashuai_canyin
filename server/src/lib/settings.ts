// 系统配置读取（带进程内缓存，后台修改时调用 invalidate()）

import type { PrismaClient } from '@prisma/client'
import { decFromNumber, decFromString, type Dec } from './decimal.js'

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

/**
 * 精确十进制读取：直接解析库里的原始字符串，不经过 Number()。
 * 所有「钱 / 积分」相关的配置都必须用这个，不能用 getNumber ——
 * 例：point_per_sec 配成 "0.5" 时，Number("0.5") 再参与乘法会引入二进制误差，
 * 而 Dec 走 {num:5n, exp:1} 全程整数。非法/缺失时回退到 fallback。
 */
export async function getDecimal(
  prisma: PrismaClient,
  group: string,
  key: string,
  fallback: number | string,
): Promise<Dec> {
  const v = await read(prisma, group, key)
  const parsed = v !== null ? decFromString(v) : null
  if (parsed) return parsed
  const fb = decFromNumber(typeof fallback === 'string' ? Number(fallback) : fallback)
  if (!fb) throw new Error(`settings ${group}.${key} 非法且 fallback 不可用`)
  return fb
}

export async function getBool(prisma: PrismaClient, group: string, key: string, fallback: boolean) {
  const v = await read(prisma, group, key)
  if (v === null) return fallback
  return v === 'true' || v === '1'
}
