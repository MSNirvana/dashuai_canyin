// 运营公开图（首页轮播等）：存一张图 → 换回一条**长期匿名可读**的直链。
//
// ── 为什么不能复用 upload.service.ts 那套 ────────────────────────────────────
// 那套是**商家级**的：STS policy 把前缀锁死在 `uploads/{merchantId}/`，同时要求传
// `storeId` 校验门店归属、还要过商家的存储配额。而后台运营图根本没有商家上下文
// （admin 路由挂的是 adminAuth，只给 req.adminId），三点统统套不上。
//
// ── 为什么必须是「对象级 ACL: public-read + CDN 直链」──────────────────────
// 这张图的最终消费者是小程序首页的 `<Image src={s.image}>` —— 页面里写死的一个字符串，
// 小程序**不签名、也不认对象键**。于是三种候选地址只有一种能用：
//   · 签名 URL（media.service.ts 那套，1 小时过期）⇒ 用户下次打开就是裂图；
//   · 对象键 ⇒ 小程序不知道去哪取；
//   · 公开直链 ⇒ 唯一可行。
// 桶是私有桶（含商家私密素材），所以只对**单个对象**设 ACL，绝不整桶放开 ——
// 与首页那批展示图的做法完全一致（见 apps/mini/scripts/upload-static-assets.mjs 顶部注释）。
//
// ── 前缀为什么是 static/ ───────────────────────────────────────────────────
//   · 沿用桶里既有的「公开展示图」区（static/mini/… 已在用）；
//   · ★ 它是**唯一不会落库**的一类对象（存在 system_setting 的 JSON 里），所以指望
//     「登记进 GC 的已引用键集合」来保命是行不通的；真正保命的是 gc-orphan-objects.ts
//     的默认扫描前缀与删除前白名单里**都没有 `static/`**。
//     **把本功能挪到 uploads/ 前缀下会立刻踩雷**（那边会被 GC 扫到，而这张图不落库）。
import { randomUUID } from 'node:crypto'
import { createLocalMediaToken, isLocalStorage } from '../lib/local-storage.js'
import { publicObjectUrl, uploadPublicObject } from '../lib/cos.js'

/**
 * 单张图上限。
 * ⚠ 三处必须一起改：本常量（服务端权威校验）、apps/admin 的预校验文案、
 *   deploy/nginx/dashuai-admin.conf 的 client_max_body_size。漏掉 nginx 那处的话
 *   本地开发（vite 直连 3000，不过 nginx）永远测不出问题，上线才 413。
 */
export const MAX_PUBLIC_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * 对象键前缀。⚠ 必须与 lib/local-storage.ts 的 ALLOWED_PREFIXES 对齐
 * （好在两个前缀都落在已放行的 `static/` 下，加新的运营图只需在这里登记）。
 */
const CAROUSEL_KEY_PREFIX = 'static/admin/carousel'
const SLOGAN_BANNER_KEY_PREFIX = 'static/admin/slogan-banner'

/** 本地模式的令牌有效期，见 publicUrl() 的说明 */
const LOCAL_MEDIA_TTL_SECONDS = 10 * 365 * 24 * 3600

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedImageError'
  }
}

export interface PublicImage {
  /** 对象键（落库的是 url，key 只用于排查与将来清理） */
  key: string
  url: string
}

interface ImageKind {
  ext: string
  contentType: string
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 按**文件内容**判断图片类型（魔数嗅探）。
 *
 * ★ 为什么不信 `Content-Type`、也不信文件名后缀：
 *   Content-Type 是客户端自己填的，文件名同样完全可控。而类型判断在这里有两个
 *   真实后果 —— 非图片文件会被当成图片存进公网可读的桶；扩展名错了会让下游
 *   Content-Type 跟着错（本项目已踩过：webp/gif 漏配会落到 video/mp4，
 *   部分端直接不渲染，见 lib/local-storage.ts::contentTypeForKey 的注释）。
 *   一次嗅探同时解决「拒掉非图片」「扩展名正确」「Content-Type 正确」三件事。
 */
function sniffImage(buffer: Buffer): ImageKind | null {
  // JPEG：SOI + 首个段标记
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: '.jpg', contentType: 'image/jpeg' }
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ext: '.png', contentType: 'image/png' }
  }
  // WebP：RIFF 容器，第 8-12 字节是 'WEBP'
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { ext: '.webp', contentType: 'image/webp' }
  }
  const head = buffer.subarray(0, 6).toString('latin1')
  if (head === 'GIF87a' || head === 'GIF89a') {
    return { ext: '.gif', contentType: 'image/gif' }
  }
  return null
}

/** 20260917 —— 按天分目录，方便在 COS 控制台按时间人工清理 */
function dateSegment(): string {
  const d = new Date()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}${m}${day}`
}

function publicUrl(key: string): string {
  if (!isLocalStorage()) return publicObjectUrl(key)
  // 本地模式没有「永久公开」这个能力：/api/v1/media/file 靠 HMAC 令牌放行且令牌带过期时间。
  // 而轮播图存的是一条**写进配置、之后长期使用**的地址，所以这里签一个超长有效期。
  // 不给本地模式单独做「static/ 目录静态托管」的旁路：本地库本来就是一次性的开发数据
  // （换机器或重跑 db push 都得重传），而旁路会让本地与生产的地址形态不一致，
  // 反而掩盖真实问题。
  const base = (
    process.env.LOCAL_MEDIA_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}/api/v1/media`
  ).replace(/\/$/, '')
  const { expires, token } = createLocalMediaToken(key, LOCAL_MEDIA_TTL_SECONDS)
  return `${base}/file?key=${encodeURIComponent(key)}&expires=${expires}&token=${token}`
}

/**
 * 保存一张运营公开图，返回可直接写进配置的公开直链。
 *
 * 校验与建键只此一处：轮播图、首页口号图都走它，避免第二个调用方自己抄一遍
 * 「大小 / 魔数 / 建键」而漏掉其中一条（漏掉魔数那条就等于开了一个「任意文件
 * 存进公网可读桶」的口子）。
 *
 * 键里带随机段（而不是用 slideId 之类的稳定名）是**故意的**：小程序与微信都会按 URL
 * 缓存图片，若用固定键覆盖上传，运营换了图、用户那边**还显示旧图**，且没有任何报错。
 * 代价是每次换图都会留下一个无主旧对象，需要人工清理（static/ 前缀不在 GC 扫描范围内）。
 */
async function savePublicImage(prefix: string, buffer: Buffer): Promise<PublicImage> {
  if (buffer.length === 0) throw new UnsupportedImageError('图片内容为空')
  if (buffer.length > MAX_PUBLIC_IMAGE_BYTES) {
    throw new UnsupportedImageError(`图片不能超过 ${MAX_PUBLIC_IMAGE_BYTES / 1024 / 1024}MB`)
  }
  const kind = sniffImage(buffer)
  if (!kind) throw new UnsupportedImageError('只支持 jpg / png / webp / gif 图片')

  const key = `${prefix}/${dateSegment()}/${randomUUID().replaceAll('-', '')}${kind.ext}`
  await uploadPublicObject(key, buffer, kind.contentType)
  return { key, url: publicUrl(key) }
}

/** 后台「首页轮播图」用 */
export function saveCarouselImage(buffer: Buffer): Promise<PublicImage> {
  return savePublicImage(CAROUSEL_KEY_PREFIX, buffer)
}

/** 后台「首页口号图」用 */
export function saveSloganBannerImage(buffer: Buffer): Promise<PublicImage> {
  return savePublicImage(SLOGAN_BANNER_KEY_PREFIX, buffer)
}
