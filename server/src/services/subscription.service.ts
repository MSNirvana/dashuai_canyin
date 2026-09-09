// 订阅与配额服务（v5）
// 订阅是使用「文案生成 / 分镜生成 / 合成出片」的硬前提；上传免费但受空间配额限制。
// 规则见 docs/05 v5：订阅 ¥980/30天/赠98000积分、加油包仅订阅可买、
// 空间 未订阅1GB / 订阅5GB —— 全部参数后台可改（SystemSetting）。
import type { PrismaClient } from '@prisma/client'
import { getNumber } from '../lib/settings.js'

const GB = 1024 * 1024 * 1024
const DEFAULT_QUOTA_FREE = 1 * GB
const DEFAULT_QUOTA_SUBSCRIBED = 5 * GB

/** 未订阅却调用付费功能（路由层映射为 2005） */
export class SubscriptionRequiredError extends Error {
  readonly code = 'SUBSCRIPTION_REQUIRED'
  constructor(message = '需要订阅后才能使用该功能') {
    super(message)
    this.name = 'SubscriptionRequiredError'
  }
}

/** 上传空间不足 */
export class StorageQuotaExceededError extends Error {
  readonly code = 'STORAGE_QUOTA_EXCEEDED'
  constructor(
    readonly usedBytes: bigint,
    readonly quotaBytes: bigint,
  ) {
    super(`上传空间不足：已用 ${humanBytes(usedBytes)} / 配额 ${humanBytes(quotaBytes)}`)
    this.name = 'StorageQuotaExceededError'
  }
}

export function humanBytes(b: bigint): string {
  const n = Number(b)
  if (n >= GB) return `${(n / GB).toFixed(2)}GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  return `${Math.round(n / 1024)}KB`
}

/** 当前有效订阅（status=ACTIVE 且未过期） */
export async function activeSubscription(prisma: PrismaClient, merchantId: bigint) {
  return prisma.membership.findFirst({
    where: { merchantId, status: 'ACTIVE', endAt: { gt: new Date() } },
    orderBy: { endAt: 'desc' },
    include: { package: true },
  })
}

/** 付费功能统一入口：未订阅直接抛错，由路由层转成 2002 */
export async function requireSubscription(
  prisma: PrismaClient,
  merchantId: bigint,
  feature: string,
) {
  const sub = await activeSubscription(prisma, merchantId)
  if (!sub) throw new SubscriptionRequiredError(feature)
  return sub
}

/** 空间配额（字节）：未订阅 1GB / 订阅 5GB，后台可改 */
export async function quotaBytes(prisma: PrismaClient, subscribed: boolean): Promise<bigint> {
  const def = subscribed ? DEFAULT_QUOTA_SUBSCRIBED : DEFAULT_QUOTA_FREE
  const v = await getNumber(
    prisma,
    'storage',
    subscribed ? 'quota_subscribed_bytes' : 'quota_free_bytes',
    def,
  )
  return BigInt(Math.max(0, Math.round(v)))
}

/** 已用空间（字节）：名下所有未删除素材求和 */
export async function usedBytes(prisma: PrismaClient, merchantId: bigint): Promise<bigint> {
  const agg = await prisma.mediaAsset.aggregate({
    where: { merchantId, deletedAt: null },
    _sum: { sizeBytes: true },
  })
  return agg._sum.sizeBytes ?? 0n
}

export interface StorageView {
  usedBytes: bigint
  quotaBytes: bigint
  subscribed: boolean
}

/** 空间用量快照（前端展示进度条） */
export async function getStorage(prisma: PrismaClient, merchantId: bigint): Promise<StorageView> {
  const sub = await activeSubscription(prisma, merchantId)
  const subscribed = !!sub
  return {
    usedBytes: await usedBytes(prisma, merchantId),
    quotaBytes: await quotaBytes(prisma, subscribed),
    subscribed,
  }
}

/** 上传前校验：超配额直接拒绝（上传本身永远免费，不扣积分） */
export async function assertUploadAllowed(
  prisma: PrismaClient,
  merchantId: bigint,
  incomingBytes: bigint,
): Promise<StorageView> {
  const view = await getStorage(prisma, merchantId)
  if (view.usedBytes + incomingBytes > view.quotaBytes) {
    throw new StorageQuotaExceededError(view.usedBytes, view.quotaBytes)
  }
  return view
}
