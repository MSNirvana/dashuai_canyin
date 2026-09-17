// 商户个人资料（个人主页）：读取 / 更新昵称与头像。
//
// ── 为什么头像**不走 media_asset** ──
// media_asset 是「门店级创作素材池」：storeId 必填、owner_type 只有 CREATION/STORE/DISH、
// 而且 confirmUpload 会累加存储配额。头像是**商户级**的（一个账号一张，可能连门店都还没建），
// 硬塞进去会同时污染素材列表与「上传空间」进度条。
// 所以这里只做两件事：把文件写进本商家前缀、把**对象键**存进 Merchant.avatarKey。
//
// ── 为什么库里只存键、不存 URL ──
// 展示地址两种模式都是**现签**的，且 TTL 都只有 1 小时：
//   本地 = /api/v1/media/file?key&expires&token（HMAC）｜COS = 私有桶签名 URL
// 把签名 URL 落库 ⇒ 1 小时后头像必然变红叉。所以每次读取时重新签（见 resolveAvatarUrl）。
//
// ⚠ 新增对象键列必须同步 scripts/gc-orphan-objects.ts::collectReferencedKeys()，
//   否则 GC 会在保留期（默认 24h）后把在用的头像当孤儿删掉。avatarKey 已登记。
import type { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import * as cos from '../lib/cos.js'
import { assertSafeObjectKey } from '../lib/object-key.js'
import { removeLocalFile } from '../lib/local-storage.js'
import * as mediaSvc from './media.service.js'

/** 头像体积上限：纯展示用，5MB 足够，且能挡住「拿头像当网盘」 */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024

export class AvatarKeyNotOwnedError extends Error {
  constructor() {
    super('头像路径不属于当前商家，已拒绝')
    this.name = 'AvatarKeyNotOwnedError'
  }
}

export class AvatarTooLargeError extends Error {
  constructor() {
    super(`头像不能超过 ${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)}MB`)
    this.name = 'AvatarTooLargeError'
  }
}

export class AvatarNotImageError extends Error {
  constructor() {
    super('只支持 JPG / PNG / GIF / WebP 格式的图片')
    this.name = 'AvatarNotImageError'
  }
}

export interface ProfileView {
  id: string
  phone: string
  nickname: string | null
  /** 商家自传头像的对象键（可能与 avatarUrl 同时为空） */
  avatarKey: string | null
  /**
   * **直接可用的展示地址**（本地=带令牌的 media/file，COS=签名 URL），已按
   * avatarKey > 外部 avatarUrl 的优先级解析好。
   * ⚠ 有效期 1 小时，**不要缓存/落库**，每次读资料时重新取。
   */
  avatarUrl: string | null
}

/** 头像对象键前缀：uploads/{merchantId}/avatar/ —— 与商家的上传前缀、GC 扫描前缀都对得上 */
export function avatarKeyPrefix(merchantId: bigint): string {
  return `uploads/${merchantId}/avatar/`
}

/**
 * 头像键归属性校验（越权防护）。
 *
 * 只做前缀匹配不够：`uploads/1/../../2/x.jpg` 前缀是过的，但解析后落到**别人的目录**，
 * 于是 A 商家的头像列里就存了 B 商家的键 —— 再借着「读资料时服务端替我签名」把 B 的文件读出来。
 * assertSafeObjectKey 先掐掉 `..` / 空段 / 编码分隔符，再做前缀匹配，两者缺一不可。
 */
export function assertAvatarKeyOwned(merchantId: bigint, key: string): void {
  assertSafeObjectKey(key, 'avatarKey')
  if (!key.startsWith(avatarKeyPrefix(merchantId))) throw new AvatarKeyNotOwnedError()
}

/** 允许的图片类型。**以文件头字节为准，不看文件名** —— 扩展名是客户端可控的字符串。 */
const IMAGE_SIGNATURES: { ext: string; contentType: string; matches: (b: Buffer) => boolean }[] = [
  { ext: '.jpg', contentType: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: '.png',
    contentType: 'image/png',
    matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { ext: '.gif', contentType: 'image/gif', matches: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  {
    ext: '.webp',
    contentType: 'image/webp',
    matches: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
]

/** 按文件头判定图片类型；不是受支持的图片返回 null（调用方据此拒绝，不要把未知类型存成头像） */
export function detectImageType(buf: Buffer): { ext: string; contentType: string } | null {
  // 不额外判长度：subarray 对越界范围返回空串、下标越界返回 undefined，比较自然为 false
  for (const s of IMAGE_SIGNATURES) {
    if (s.matches(buf)) return { ext: s.ext, contentType: s.contentType }
  }
  return null
}

/** 头像展示地址：优先自传对象键，其次微信侧外部链接；取不到（键非法/签名失败）时返回 null，不让读资料整体失败 */
async function resolveAvatarUrl(
  merchant: { id: bigint; avatarKey: string | null; avatarUrl: string | null },
  baseUrl?: string,
): Promise<string | null> {
  if (merchant.avatarKey) {
    try {
      const played = await mediaSvc.getPlayUrlByKey(merchant.id, merchant.avatarKey, baseUrl)
      if (played.url) return played.url
    } catch {
      // 键已被手工改坏/不属于本商家：降级到外部链接，不阻断「我的」页渲染
    }
  }
  return merchant.avatarUrl ?? null
}

async function buildView(
  merchant: { id: bigint; phone: string; nickname: string | null; avatarKey: string | null; avatarUrl: string | null },
  baseUrl?: string,
): Promise<ProfileView> {
  return {
    id: merchant.id.toString(),
    phone: merchant.phone,
    nickname: merchant.nickname,
    avatarKey: merchant.avatarKey,
    avatarUrl: await resolveAvatarUrl(merchant, baseUrl),
  }
}

export async function getProfile(
  prisma: PrismaClient,
  merchantId: bigint,
  baseUrl?: string,
): Promise<ProfileView> {
  const m = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantId },
    select: { id: true, phone: true, nickname: true, avatarKey: true, avatarUrl: true },
  })
  return buildView(m, baseUrl)
}

export interface ProfileInput {
  /** 传 `''` 或 `null` 表示清空昵称（回落到展示手机号）；不传表示不改 */
  nickname?: string | null
  /** 自传头像的对象键；不传表示不改 */
  avatarKey?: string
}

/**
 * 更新昵称 / 头像。
 *
 * 昵称在**服务层也 trim 一次**（路由的 `nullableText(20)` 已经 trim 过，这里是纵深防御）：
 * 校验里写 `.trim()` 只保护了走路由的那条路径，任何直接调服务的地方（脚本、后台、
 * 以后新加的入口）都会绕过它——而「库里存了纯空白昵称」是**静默**的。
 * 空串与纯空白统一归一成 `null`（而不是存 `""`）：读资料时的回落逻辑是 `nickname || phone`，
 * 存空串虽然也能回落，但库里会出现「有值却是空白」的行，后台列表与日志里都看不出该字段到底设置过没有。
 */
export async function updateProfile(
  prisma: PrismaClient,
  merchantId: bigint,
  input: ProfileInput,
  baseUrl?: string,
): Promise<ProfileView> {
  const data: { nickname?: string | null; avatarKey?: string } = {}
  if (input.nickname !== undefined) {
    const trimmed = input.nickname === null ? '' : input.nickname.trim()
    data.nickname = trimmed === '' ? null : trimmed
  }
  if (input.avatarKey !== undefined) {
    assertAvatarKeyOwned(merchantId, input.avatarKey)
    data.avatarKey = input.avatarKey
  }
  const m = await prisma.merchant.update({
    where: { id: merchantId },
    data,
    select: { id: true, phone: true, nickname: true, avatarKey: true, avatarUrl: true },
  })
  return buildView(m, baseUrl)
}

/** 读文件前 n 字节（判magic number）。读不到返回 null，由调用方当作「不是图片」处理 */
async function readHead(path: string, n: number): Promise<Buffer | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

/**
 * 保存客户端上传的头像文件，并把对象键写进 Merchant.avatarKey。
 *
 * 旧头像对象在**写库成功后**尽力删除：删早了会在新头像写库失败时把用户头像弄丢。
 * 删除失败不影响本次结果 —— 它只是变成孤儿对象，由 gc-orphan-objects 按保留期回收。
 */
export async function saveAvatarUpload(
  prisma: PrismaClient,
  merchantId: bigint,
  file: { path: string; size: number },
  baseUrl?: string,
): Promise<ProfileView> {
  if (file.size > AVATAR_MAX_BYTES) {
    await removeLocalFile(file.path)
    throw new AvatarTooLargeError()
  }

  // 只读文件头 16 字节：判类型不需要整块读进内存（multer 已把体积挡在前面）
  const head = await readHead(file.path, 16)
  if (!head) {
    await removeLocalFile(file.path)
    throw new AvatarNotImageError()
  }
  const type = detectImageType(head)
  if (!type) {
    await removeLocalFile(file.path)
    throw new AvatarNotImageError()
  }

  const prev = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantId },
    select: { avatarKey: true },
  })

  const key = `${avatarKeyPrefix(merchantId)}${Date.now()}_${randomUUID().replaceAll('-', '')}${type.ext}`
  try {
    await cos.uploadFile(file.path, key, type.contentType)
  } finally {
    // 中转区文件无论成败都要清掉：multer 落在 storage/.incoming/，不清会一直堆积
    await removeLocalFile(file.path)
  }

  const view = await updateProfile(prisma, merchantId, { avatarKey: key }, baseUrl)

  if (prev.avatarKey && prev.avatarKey !== key) {
    await cos.deleteObject(prev.avatarKey).catch(() => undefined)
  }
  return view
}
