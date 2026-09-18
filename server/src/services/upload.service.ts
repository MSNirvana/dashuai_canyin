// 对象存储直传：服务端只发 STS 临时密钥（限制前缀），文件不经过服务器
// 单文件最大 2GB，靠小程序端分片续传（cos-wx-sdk-v5）扛
import STS from 'qcloud-cos-sts'
import type { PrismaClient } from '@prisma/client'
import { assertUploadAllowed } from './subscription.service.js'
import { storageMode, type StorageMode } from '../lib/local-storage.js'
import { assertSafeObjectKey } from '../lib/object-key.js'
import { headObjectMeta } from '../lib/cos.js'

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

/** 单文件上限，与 multer 的 limits.fileSize 保持一致（2GB，靠客户端分片续传扛） */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

/** 对象不存在 / 大小异常 / 类型不符 —— 一律 400，不是 5xx */
export class UploadObjectMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadObjectMismatchError'
  }
}

/**
 * 允许的扩展名 → 声明的素材类型。
 *
 * ★ 为什么要按扩展名卡一道：`type` 是客户端说了算的（IMAGE/VIDEO），
 *   而它决定了后续管线怎么处理这个对象（抽帧/封面/合成）。一个 `.mp4` 被声明成 IMAGE，
 *   或反过来把一个 2GB 视频声明成 IMAGE 蒙过体积相关的逻辑，都会在下游以
 *   「静默不播 / 合成失败」的形式出现，而上传这一步看起来完全成功。
 *   这里只做「扩展名 ↔ 声明类型」的一致性 + 后缀白名单，避免出现可执行/脚本类后缀。
 */
const ALLOWED_EXT_BY_TYPE: Record<'VIDEO' | 'IMAGE', string[]> = {
  VIDEO: ['.mp4', '.m4v', '.mov', '.webm', '.avi'],
  IMAGE: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
}

function extOf(key: string): string {
  const i = key.lastIndexOf('.')
  return i < 0 ? '' : key.slice(i).toLowerCase()
}

function assertExtensionMatches(key: string, type: 'VIDEO' | 'IMAGE'): void {
  const ext = extOf(key)
  const allowed = ALLOWED_EXT_BY_TYPE[type]
  if (!ext || !allowed.includes(ext)) {
    throw new UploadObjectMismatchError(
      `对象键后缀 ${ext || '(无)'} 与素材类型 ${type} 不符（允许：${allowed.join('/')}）`,
    )
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
  /** 视频封面缩略图的对象键（客户端抽帧后随视频一起上报；服务端生成时由上传路由写入） */
  coverKey?: string | null
  /**
   * 素材归属：CREATION = 创作素材（默认），STORE = 门店资料（主图/门店视频），DISH = 菜品素材。
   * 门店资料不参与创作选片，避免污染素材池。
   */
  ownerType?: 'CREATION' | 'STORE' | 'DISH'
}

export async function confirmUpload(prisma: PrismaClient, merchantId: bigint, input: ConfirmUploadInput) {
  // 越权防护：先做键本身的安全校验，再做商家前缀校验。
  // 顺序不能反 —— 只做前缀匹配拦不住 `uploads/1/../../2/xxx.jpg`
  // （前缀通过，但路径解析后落到商户 2 的目录），见 lib/object-key.ts 的说明。
  assertSafeObjectKey(input.cosKey, 'cosKey')
  if (!input.cosKey.startsWith(`uploads/${merchantId}/`)) throw new UploadPrefixError()
  // 封面同样必须落在当前商家前缀下，避免借用他人对象键
  if (input.coverKey) {
    assertSafeObjectKey(input.coverKey, 'coverKey')
    if (!input.coverKey.startsWith(`uploads/${merchantId}/`)) throw new UploadPrefixError()
  }
  const store = await prisma.store.findFirst({
    where: { id: input.storeId, merchantId, deletedAt: null },
  })
  if (!store) throw new UploadStoreMismatchError()

  // ── 幂等：同一个对象键只登记一行 ──────────────────────────────────
  // 客户端 `confirmUploadWithRetry` 对 /complete 最多重试 3 次（弱网下很常见）。
  // 若第一次其实已经落库、只是响应丢了，重试就会再建一行**完全相同的素材**：
  // 配额被重复计算、素材列表出现重复项、GC 也不知道该按哪一行判引用。
  // 实测库里已经有一组（商户 1 的同 key 两行、且两行分别被 1 个和 6 个分镜引用）。
  // 所以这里先查后建：同 key 的未删除素材直接原样返回，不新建、不重复计配额。
  const existing = await prisma.mediaAsset.findFirst({
    where: { merchantId, cosKey: input.cosKey, deletedAt: null },
  })
  if (existing) {
    console.warn(`[upload] 重复确认同一对象键（幂等返回已有素材）key=${input.cosKey} asset=${existing.id}`)
    return existing
  }

  // ── 服务端核验对象真实存在与真实大小 ─────────────────────────────
  // 客户端上报的 sizeBytes 只是线索，不是证据：上报 0 就能让配额校验形同虚设，
  // 上报一个不存在的键也能把素材标成 READY。所以配额与落库一律用存储侧的真实值。
  const meta = await headObjectMeta(input.cosKey)
  if (!meta.exists) {
    throw new UploadObjectMismatchError('对象不存在或上传尚未完成，请重试上传后再次确认')
  }
  if (meta.sizeBytes <= 0) {
    throw new UploadObjectMismatchError('对象为空文件，已拒绝登记')
  }
  if (meta.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new UploadObjectMismatchError(`对象大小 ${meta.sizeBytes} 超过单文件上限 ${MAX_UPLOAD_BYTES}`)
  }
  assertExtensionMatches(input.cosKey, input.type)
  // 客户端值只用于**发现异常**（日志/排查），不参与任何计算。
  // 偏差大往往说明客户端口径错了（实测同一对象被上报过 22495870 与 5242880 两个值）。
  if (input.sizeBytes !== meta.sizeBytes) {
    console.warn(
      `[upload] 客户端上报大小 ${input.sizeBytes} 与存储实测 ${meta.sizeBytes} 不一致 key=${input.cosKey}，以存储为准`,
    )
  }

  // v5：上传永远免费，但受空间配额限制（未订阅 1GB / 订阅 5GB），超限直接拒绝
  await assertUploadAllowed(prisma, merchantId, BigInt(meta.sizeBytes))

  return prisma.mediaAsset.create({
    data: {
      merchantId,
      storeId: input.storeId,
      ownerType: input.ownerType ?? 'CREATION',
      ownerId: null,
      type: input.type,
      cosKey: input.cosKey,
      bucket: process.env.COS_BUCKET ?? '',
      region: process.env.COS_REGION ?? '',
      sizeBytes: meta.sizeBytes,
      durationMs: input.durationMs,
      width: input.width,
      height: input.height,
      coverKey: input.coverKey ?? null,
      status: 'READY',
    },
  })
}
