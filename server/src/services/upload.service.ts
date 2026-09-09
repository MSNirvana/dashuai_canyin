// 对象存储直传：服务端只发 STS 临时密钥（限制前缀），文件不经过服务器
// 单文件最大 2GB，靠小程序端分片续传（cos-wx-sdk-v5）扛
import STS from 'qcloud-cos-sts'
import type { PrismaClient } from '@prisma/client'
import { assertUploadAllowed } from './subscription.service.js'
import { storageMode, type StorageMode } from '../lib/local-storage.js'

export interface StsCredential {
  tmpSecretId: string
  tmpSecretKey: string
  sessionToken: string
  startTime: number
  expiredTime: number
  bucket: string
  region: string
  prefix: string
  mode: StorageMode
}

export class UploadPrefixError extends Error {
  constructor() {
    super('上传路径不属于当前商家，已拒绝')
    this.name = 'UploadPrefixError'
  }
}
export class UploadStoreMismatchError extends Error {
  constructor() {
    super('门店不属于当前商家')
    this.name = 'UploadStoreMismatchError'
  }
}

function getAppId(bucket: string): string {
  const parts = bucket.split('-')
  return parts[parts.length - 1] ?? ''
}

function isCosConfigured(): boolean {
  return !!(
    process.env.COS_SECRET_ID &&
    process.env.COS_SECRET_KEY &&
    process.env.COS_BUCKET &&
    process.env.COS_REGION
  )
}

export async function getSts(merchantId: bigint): Promise<StsCredential> {
  const bucket = process.env.COS_BUCKET ?? ''
  const region = process.env.COS_REGION ?? ''
  const prefix = `uploads/${merchantId}/`
  const appId = getAppId(bucket)

  if (storageMode() === 'cos' && !isCosConfigured()) {
    throw new Error('COS 模式未配置 COS_SECRET_ID/KEY/BUCKET/REGION')
  }

  if (storageMode() === 'local') {
    const now = Math.floor(Date.now() / 1000)
    return {
      tmpSecretId: 'local-storage',
      tmpSecretKey: 'local-storage',
      sessionToken: 'local-storage',
      startTime: now,
      expiredTime: now + 1800,
      bucket: '',
      region: '',
      prefix,
      mode: 'local',
    }
  }

  // 兼容未显式设置 STORAGE_MODE 的旧开发环境；默认 storageMode() 已是 local，正常不会走到这里。
  if (!isCosConfigured()) {
    const now = Math.floor(Date.now() / 1000)
    return {
      tmpSecretId: 'dev-insecure',
      tmpSecretKey: 'dev-insecure',
      sessionToken: 'dev-insecure',
      startTime: now,
      expiredTime: now + 1800,
      bucket,
      region,
      prefix,
      mode: 'local',
    }
  }

  const policy = {
    version: '2.0',
    statement: [
      {
        action: [
          'name/cos:PostObject',
          'name/cos:PutObject',
          'name/cos:InitiateMultipartUpload',
          'name/cos:ListMultipartUploads',
          'name/cos:ListParts',
          'name/cos:UploadPart',
          'name/cos:CompleteMultipartUpload',
          'name/cos:AbortMultipartUpload',
        ],
        effect: 'allow',
        principal: { qcs: ['*'] },
        resource: [`qcs::cos:${region}:uid/${appId}:${bucket}/${prefix}*`],
      },
    ],
  }

  const data = (await new Promise<Record<string, unknown>>((resolve, reject) => {
    STS.getCredential(
      {
        secretId: process.env.COS_SECRET_ID,
        secretKey: process.env.COS_SECRET_KEY,
        durationSeconds: 1800,
        bucket,
        region,
        allowPrefix: `${prefix}*`,
        policy,
      },
      (err: Error | null, d: unknown) => (err ? reject(err) : resolve(d as Record<string, unknown>)),
    )
  })) as {
    credentials: { tmpSecretId: string; tmpSecretKey: string; sessionToken: string }
    startTime: number
    expiredTime: number
  }

  return {
    tmpSecretId: data.credentials.tmpSecretId,
    tmpSecretKey: data.credentials.tmpSecretKey,
    sessionToken: data.credentials.sessionToken,
    startTime: data.startTime,
    expiredTime: data.expiredTime,
    bucket,
    region,
    prefix,
    mode: 'cos',
  }
}

export interface ConfirmUploadInput {
  cosKey: string
  storeId: bigint
  type: 'VIDEO' | 'IMAGE'
  sizeBytes: number
  width?: number
  height?: number
  durationMs?: number
}

export async function confirmUpload(prisma: PrismaClient, merchantId: bigint, input: ConfirmUploadInput) {
  // 越权防护：cosKey 必须落在当前商家前缀下，否则拒绝落库
  if (!input.cosKey.startsWith(`uploads/${merchantId}/`)) throw new UploadPrefixError()
  const store = await prisma.store.findFirst({
    where: { id: input.storeId, merchantId, deletedAt: null },
  })
  if (!store) throw new UploadStoreMismatchError()

  // v5：上传永远免费，但受空间配额限制（未订阅 1GB / 订阅 5GB），超限直接拒绝
  await assertUploadAllowed(prisma, merchantId, BigInt(input.sizeBytes))

  return prisma.mediaAsset.create({
    data: {
      merchantId,
      storeId: input.storeId,
      ownerType: 'CREATION',
      ownerId: null,
      type: input.type,
      cosKey: input.cosKey,
      bucket: process.env.COS_BUCKET ?? '',
      region: process.env.COS_REGION ?? '',
      sizeBytes: input.sizeBytes,
      durationMs: input.durationMs,
      width: input.width,
      height: input.height,
      status: 'READY',
    },
  })
}
