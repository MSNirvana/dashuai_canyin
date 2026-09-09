// 素材播放地址：私有桶需服务端签发临时 URL（有效期 1 小时）才能在小程序 <video> 播放
// 开发期无 COS 配置时返回 url=null，前端按演示态处理
import type { PrismaClient } from '@prisma/client'
import COS from 'cos-nodejs-sdk-v5'
import { createLocalMediaToken, isLocalStorage } from '../lib/local-storage.js'

export class MediaNotFoundError extends Error {
  constructor() {
    super('素材不存在')
    this.name = 'MediaNotFoundError'
  }
}

let cosClient: COS | null = null
function client(): COS | null {
  if (cosClient) return cosClient
  if (process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY) {
    cosClient = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY })
  }
  return cosClient
}

export interface PlayUrl {
  url: string | null
  dev: boolean
}

export class MediaKeyPrefixError extends Error {
  constructor() {
    super('素材路径不属于当前商家，已拒绝')
    this.name = 'MediaKeyPrefixError'
  }
}

export async function getPlayUrl(
  prisma: PrismaClient,
  merchantId: bigint,
  assetId: bigint,
  baseUrl?: string,
): Promise<PlayUrl> {
  const asset = await prisma.mediaAsset.findFirst({ where: { id: assetId, merchantId, deletedAt: null } })
  if (!asset) throw new MediaNotFoundError()
  return signKey(asset.cosKey, asset.bucket, asset.region, baseUrl)
}

/** 按 key 签播放地址（用于合成产物等无 media_asset 行的文件），须落在当前商家前缀下 */
export async function getPlayUrlByKey(merchantId: bigint, key: string, baseUrl?: string): Promise<PlayUrl> {
  if (!key.startsWith(`uploads/${merchantId}/`) && !key.startsWith(`renders/${merchantId}/`)) {
    throw new MediaKeyPrefixError()
  }
  const bucket = process.env.COS_BUCKET ?? ''
  const region = process.env.COS_REGION ?? ''
  return signKey(key, bucket, region, baseUrl)
}

/**
 * 签发共享资源播放地址（镜头库示范视频等全商家共享、仅后台管理员可写入的资源）。
 * 与 getPlayUrlByKey 的区别：不校验商家前缀——key 来源是后台配置而非商家上传，可信。
 */
export async function getSharedPlayUrlByKey(key: string, baseUrl?: string): Promise<PlayUrl> {
  const bucket = process.env.COS_BUCKET ?? ''
  const region = process.env.COS_REGION ?? ''
  return signKey(key, bucket, region, baseUrl)
}

async function signKey(key: string, bucket: string, region: string, baseUrl?: string): Promise<PlayUrl> {
  if (isLocalStorage()) {
    const localBaseUrl = baseUrl
      ?? process.env.LOCAL_MEDIA_BASE_URL?.replace(/\/$/, '')
      ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}/api/v1/media`
    const { expires, token } = createLocalMediaToken(key)
    return {
      url: `${localBaseUrl}/file?key=${encodeURIComponent(key)}&expires=${expires}&token=${token}`,
      dev: true,
    }
  }
  const c = client()
  if (!c) return { url: null, dev: true }
  const url = await new Promise<string>((resolve, reject) => {
    c.getObjectUrl(
      { Bucket: bucket, Region: region, Key: key, Sign: true, Expires: 3600 },
      (err: Error | null, data: { Url?: string }) => {
        if (err) return reject(err)
        resolve(data?.Url ?? '')
      },
    )
  })
  return { url: url || null, dev: false }
}
