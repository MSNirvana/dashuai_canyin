// 教学中心：平台级教学视频（后台管理员上传，小程序「我的 → 学习中心」展示）。
//
// ── 为什么不复用 upload.service.ts ─────────────────────────────────────────
// 那一套是**商家级**的：STS policy 把前缀锁死在 `uploads/{merchantId}/`，还要传 storeId
// 校验门店归属、过商家的存储配额。教学视频是平台级内容，没有商家上下文（admin 路由只有
// req.adminId），三点全都不适用。所以这里另开一条窄通道，与 public-asset.service.ts
// 走轮播图的路子同构 —— 区别只有一个：轮播图存**公开直链**，视频存**对象键**、
// 播放地址每次现签。理由见 signTutorialUrl 的注释。
//
// ── 三类静默失效 ─────────────────────────────────────────────────────────
//   ① 键前缀 `tutorials/` 没进 lib/local-storage.ts 的 ALLOWED_PREFIXES ⇒ 本地模式落盘与播放双双报错；
//   ② tutorial_video 的两列没进 gc-orphan-objects.ts::collectReferencedKeys() ⇒ 24h 后在用视频被删；
//   ③ 扩展名不按**魔数**判定 ⇒ 落到 contentTypeForKey 的 video/mp4 兜底，
//      webm/mov 的 Content-Type 全错，端上按 mp4 解复用必然不播。
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import {
  contentTypeForKey,
  localStorageRoot,
  removeLocalFile,
} from '../lib/local-storage.js'
import { deleteObject, uploadFile } from '../lib/cos.js'
import { detectVideoType, readFileHead } from '../lib/media-type.js'
import { generateVideoCover } from '../lib/thumbnail.js'
import { TUTORIAL_CATEGORY_CODES, type TutorialCategoryCode } from '../lib/tutorial-categories.js'
import { getSharedPlayUrlByKey } from './media.service.js'
import { detectImageType } from './profile.service.js'

/**
 * 对象键前缀。⚠ 必须与 lib/local-storage.ts 的 ALLOWED_PREFIXES 对齐，
 * 并且必须被 gc-orphan-objects.ts 的默认扫描前缀覆盖 —— 教学视频是**硬删**，
 * 残留对象指望 GC 兜底回收（这一点与 static/ 前缀刻意相反）。
 */
export const TUTORIAL_KEY_PREFIX = 'tutorials/'

/**
 * 单个视频上限，100MB。
 *
 * ⚠ 这个数字有三处必须一起改，漏掉 nginx 那处的话本地开发（vite 直连 3000，不过 nginx）
 *   永远测不出问题，上线才 413：
 *     1) 本常量（服务端权威校验）
 *     2) apps/admin/src/pages/Tutorials.tsx 的上传前预校验文案
 *     3) deploy/nginx/dashuai-admin.conf 的 `/admin/api/v1/` location 里 client_max_body_size
 *   （dashuai-api.conf 的 20m 不用动：上传走的是 admin 域名那条反代，不是小程序那条）
 */
export const MAX_TUTORIAL_VIDEO_BYTES = 100 * 1024 * 1024

/** 封面图上限。与 public-asset 的轮播图同值，都是「运营出图」的量级 */
export const MAX_TUTORIAL_COVER_BYTES = 5 * 1024 * 1024

/** 客户端的兜底文案：正常情况下客户端用自己的本地文案（离线也要能渲染），这里只在它没传时才用 */
const FALLBACK_TITLES: Record<TutorialCategoryCode, string> = {
  SHOOTING: '拍摄技巧',
  EDITING: '剪辑教程',
  OPERATION: '运营知识',
  MANUAL: '使用手册',
}

export interface TutorialListItem {
  id: string
  category: string
  title: string
  durationMs: number | null
  /** 现签播放地址（本地模式与私有桶都只有 1h） */
  videoUrl: string | null
  coverUrl: string | null
}

export interface TutorialCategoryStat {
  code: TutorialCategoryCode
  title: string
  count: number
}

export interface VideoUploadResult {
  videoKey: string
  contentType: string
  sizeBytes: number
  /**
   * 服务端抽帧得到的封面键（可能为 null）。
   *
   * 为什么服务端抽帧而不是让运营再传一张：上传时 multer 已经把文件落在本地磁盘上，
   * 抽一帧几乎没有额外成本；让运营自己截图 → 压缩 → 再上传是三道多余操作。
   * 抽帧失败**不算失败**（某些编码本机 ffmpeg 抽不出来），返回 null 即可 ——
   * 小程序 <Video> 不传 poster 时会自己显示首帧，不是白屏。
   */
  coverKey: string | null
}

export class TutorialUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TutorialUploadError'
  }
}

export class TutorialNotFoundError extends Error {
  constructor(message = '教学视频不存在') {
    super(message)
    this.name = 'TutorialNotFoundError'
  }
}

// ──────────────────────── 键与类型 ────────────────────────

/** 20260917 —— 按天分目录，方便在 COS 控制台按时间人工排查/清理 */
function dateSegment(): string {
  const d = new Date()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}${m}${day}`
}

/**
 * 对象键。随机段是**故意**的：微信与 CDN 都按 URL 缓存媒体，
 * 用固定键覆盖上传的话运营换了视频、用户那边还播旧的，且没有任何报错。
 */
function tutorialKey(ext: string): string {
  return `${TUTORIAL_KEY_PREFIX}${dateSegment()}/${randomUUID().replaceAll('-', '')}${ext}`
}

/** 抽帧产物落盘位置：与 multer 的中转区同一个目录，抽完立即删 */
function tmpCoverPath(): string {
  return join(localStorageRoot(), '.incoming', `tutorial_cover_${randomUUID().replaceAll('-', '')}.jpg`)
}

// ──────────────────────── 上传 ────────────────────────

/**
 * 保存后台选中的视频文件。`tempPath` 是 multer 的中转文件路径。
 *
 * **无论成败都会清掉它** —— multer 全部落在 storage/.incoming/，不清会一直堆积
 * （这是本项目头像上传踩过的坑，见 object-key-column-uploads 技能）。
 */
export async function saveTutorialVideo(tempPath: string): Promise<VideoUploadResult> {
  const head = await readFileHead(tempPath, 32)
  const type = head ? detectVideoType(head) : null
  if (!type) {
    await removeLocalFile(tempPath)
    throw new TutorialUploadError('只支持 MP4 / MOV / WebM / AVI 视频')
  }

  const videoKey = tutorialKey(type.ext)
  let sizeBytes = 0
  try {
    sizeBytes = await uploadFile(tempPath, videoKey, type.contentType)
  } catch (e) {
    await removeLocalFile(tempPath)
    throw e
  }

  // 抽帧失败不阻断上传
  let coverKey: string | null = null
  try {
    const outKey = tutorialKey('.jpg')
    const outPath = tmpCoverPath()
    const { ok } = await generateVideoCover(tempPath, outPath)
    if (ok) {
      // 封面走同一条通道（私有对象 + 现签），所以用 uploadFile 而不是 uploadPublicObject：
      // 教学封面没有任何理由对公网匿名开放
      await uploadFile(outPath, outKey, 'image/jpeg')
      coverKey = outKey
    }
    await removeLocalFile(outPath)
  } catch (e) {
    console.warn('[tutorial] 封面抽帧失败（不阻断上传）:', (e as Error).message)
    coverKey = null
  } finally {
    await removeLocalFile(tempPath)
  }

  return { videoKey, contentType: contentTypeForKey(videoKey), sizeBytes, coverKey }
}

/** 保存后台单独上传的封面图（运营想用一张比首帧更好看的图时） */
export async function saveTutorialCover(tempPath: string): Promise<{ coverKey: string; sizeBytes: number }> {
  const head = await readFileHead(tempPath, 16)
  const type = head ? detectImageType(head) : null
  if (!type) {
    await removeLocalFile(tempPath)
    throw new TutorialUploadError('封面只支持 JPG / PNG / WebP / GIF 图片')
  }
  const key = tutorialKey(type.ext)
  try {
    return { coverKey: key, sizeBytes: await uploadFile(tempPath, key, type.contentType) }
  } finally {
    await removeLocalFile(tempPath)
  }
}

// ──────────────────────── 小程序读取 ────────────────────────

/**
 * 播放地址现签。
 *
 * 用 `getSharedPlayUrlByKey`（不校验商家前缀）而不是 `getPlayUrlByKey`：后者的闸门只认
 * `uploads/{merchantId}/`，`tutorials/` 会被直接拒掉。
 * 它本身**不做** assertSafeObjectKey，所以这里自己补一道前缀检查 ——
 * 读接口会替客户端签名，若有人手工把库里这列改成 `uploads/2/xxx`，
 * 就等于把别的商家的私有文件签给任何登录用户。失败返回 null，不让整页 500。
 *
 * `baseUrl` 必须由路由传**当前请求的 host**（见 works.ts 的同款做法）：
 * 本地模式的默认值是 `LOCAL_MEDIA_BASE_URL`（127.0.0.1:3000），真机拿着它必然播不出来。
 */
async function signTutorialUrl(key: string | null, baseUrl?: string): Promise<string | null> {
  if (!key || !key.startsWith(TUTORIAL_KEY_PREFIX)) return null
  try {
    return (await getSharedPlayUrlByKey(key, baseUrl)).url
  } catch {
    return null
  }
}

/** 四个分类各自有多少节课（给「我的」页那个四宫格用） */
export async function listCategoryStats(prisma: PrismaClient): Promise<TutorialCategoryStat[]> {
  const grouped = await prisma.tutorialVideo.groupBy({
    by: ['category'],
    where: { enabled: true },
    _count: { _all: true },
  })
  const countOf = new Map(grouped.map((g) => [g.category, g._count._all]))
  // 顺序与分类白名单一致，客户端拿到即可直接渲染
  return TUTORIAL_CATEGORY_CODES.map((code) => ({
    code,
    title: FALLBACK_TITLES[code],
    count: countOf.get(code) ?? 0,
  }))
}

/** 某个分类下的课程列表（sort 升序，同 sort 新→旧） */
export async function listByCategory(
  prisma: PrismaClient,
  category: string,
  baseUrl?: string,
): Promise<TutorialListItem[]> {
  const rows = await prisma.tutorialVideo.findMany({
    where: { category, enabled: true },
    orderBy: [{ sort: 'asc' }, { id: 'desc' }],
    // 分类页是「一次拉完 + 本地切换播放」的形态，不做分页；这里只加个防呆上限
    take: 200,
    select: { id: true, category: true, title: true, durationMs: true, videoKey: true, coverKey: true },
  })
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id.toString(),
      category: r.category,
      title: r.title,
      durationMs: r.durationMs,
      videoUrl: await signTutorialUrl(r.videoKey, baseUrl),
      coverUrl: await signTutorialUrl(r.coverKey, baseUrl),
    })),
  )
}

// ──────────────────────── 后台 CRUD ────────────────────────

export interface TutorialInput {
  category: string
  title: string
  videoKey?: string | null
  coverKey?: string | null
  durationMs?: number | null
  sort?: number
  enabled?: boolean
}

/**
 * 后台列表**不**签名：一页 20 条就是 40 次签名请求，而后台只有点「预览」时才需要地址。
 * 预览统一走已有的 `GET /admin/media/preview?key=…`。
 */
export async function adminListTutorials(
  prisma: PrismaClient,
  q: { category?: string; enabled?: boolean } = {},
) {
  return prisma.tutorialVideo.findMany({
    where: {
      ...(q.category ? { category: q.category } : {}),
      ...(q.enabled === undefined ? {} : { enabled: q.enabled }),
    },
    orderBy: [{ category: 'asc' }, { sort: 'asc' }, { id: 'desc' }],
    select: {
      id: true,
      category: true,
      title: true,
      videoKey: true,
      coverKey: true,
      durationMs: true,
      sort: true,
      enabled: true,
      createdAt: true,
      updatedAt: true,
    },
  })
}

export async function adminUpsertTutorial(prisma: PrismaClient, id: bigint | undefined, input: TutorialInput) {
  const data = {
    category: input.category,
    title: input.title,
    videoKey: input.videoKey ?? null,
    coverKey: input.coverKey ?? null,
    durationMs: input.durationMs ?? null,
    sort: input.sort ?? 0,
    enabled: input.enabled ?? true,
  }
  if (id === undefined) return prisma.tutorialVideo.create({ data })
  const updated = await prisma.tutorialVideo.updateMany({ where: { id }, data })
  if (updated.count === 0) throw new TutorialNotFoundError()
  return prisma.tutorialVideo.findUniqueOrThrow({ where: { id } })
}

/**
 * 硬删一行，并**尽力**删掉它引用的两个对象。
 *
 * 为什么硬删（表上没有 deletedAt）：这一行是这些大文件的唯一引用，软删等于留下一份
 * 永久无法回收的存储成本。删对象失败不致命 —— 打日志即可，残留对象由
 * gc-orphan-objects.ts 在保留期后回收（这正是把 tutorials/ 纳入 GC 扫描前缀的原因）。
 */
export async function adminRemoveTutorial(
  prisma: PrismaClient,
  id: bigint,
): Promise<{ removedObjects: number }> {
  const row = await prisma.tutorialVideo.findUnique({
    where: { id },
    select: { videoKey: true, coverKey: true },
  })
  if (!row) throw new TutorialNotFoundError()

  const deleted = await prisma.tutorialVideo.deleteMany({ where: { id } })
  if (deleted.count === 0) throw new TutorialNotFoundError()

  let removedObjects = 0
  for (const key of [row.videoKey, row.coverKey]) {
    if (!key || !key.startsWith(TUTORIAL_KEY_PREFIX)) continue
    try {
      await deleteObject(key)
      removedObjects++
    } catch (e) {
      console.warn('[tutorial] 删除对象失败（留给 GC 回收）:', key, (e as Error).message)
    }
  }
  return { removedObjects }
}
