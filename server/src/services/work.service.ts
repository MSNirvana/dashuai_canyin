// 首页「优秀作品」服务
// 作品是运营内容：与商家数据解耦，支持分类筛选 / 分页 / 排序 / 上下架
// 核心是 recipeJson（同款配方）——「生成同款」把它预填进创作流
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PrismaClient, Prisma } from '@prisma/client'
import { uploadFile } from '../lib/cos.js'
import { contentTypeForKey, localStorageRoot, removeLocalFile } from '../lib/local-storage.js'
import { detectVideoType, readFileHead } from '../lib/media-type.js'
import { ensureVideoCoverKey, generateVideoCover } from '../lib/thumbnail.js'
import { detectImageType } from './profile.service.js'

export class WorkNotFoundError extends Error {
  constructor() {
    super('作品不存在或已下架')
    this.name = 'WorkNotFoundError'
  }
}

/** 同一条成片已经入过库：避免两个标签页/重复点击生成多条重复草稿 */
export class WorkAlreadyImportedError extends Error {
  constructor(title?: string) {
    super(title ? `该成片已入库（草稿「${title}」），请勿重复导入` : '该成片已入库，请勿重复导入')
    this.name = 'WorkAlreadyImportedError'
  }
}

/** 封面抽帧失败（无视频 / ffmpeg 不可用 / 视频读不到） */
export class WorkCoverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkCoverError'
  }
}

/** 后台本地上传作品视频/封面时的可读错误（不是运行时故障，是「这个文件不能用」） */
export class WorkUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkUploadError'
  }
}

/**
 * 作品对象键前缀。
 *
 * ★ 新增这个前缀要同步**四处**，漏一处就是一类静默失效：
 *   1) lib/local-storage.ts 的 ALLOWED_PREFIXES —— 漏了本地模式落盘直接报错；
 *   2) gc-orphan-objects.ts 的默认**扫描前缀** PREFIXES —— 漏了它下面的对象永远扫不到；
 *   3) gc-orphan-objects.ts 的**删除白名单** DELETABLE_PREFIXES —— 漏了扫得到但删不掉；
 *   4) gc-orphan-objects.ts 的 collectReferencedKeys()（excellentWork 两列，已就位）
 *      —— 漏了会在保留期（默认 24h）后把在用的作品视频当孤儿删掉。
 *   另外 works.ts 的签名守卫（isSignableWorkKey）也按前缀放行，同样要跟着改。
 */
export const WORK_KEY_PREFIX = 'works/'

/**
 * 单个作品视频上限，100MB。与教学视频同值 —— 两者都是「运营出片」的量级。
 *
 * ⚠ 三处必须一起改，漏掉 nginx 那处的话本地开发（vite 直连 3000，不过 nginx）
 *   永远测不出问题，上线才 413：
 *     1) 本常量（服务端权威校验）
 *     2) apps/admin/src/pages/Works.tsx 的上传前预校验文案
 *     3) deploy/nginx/dashuai-admin.conf 的 `/admin/api/v1/` location 里 client_max_body_size
 */
export const MAX_WORK_VIDEO_BYTES = 100 * 1024 * 1024

/** 作品封面上限。与轮播图 / 教学封面同值，都是「运营出图」的量级 */
export const MAX_WORK_COVER_BYTES = 5 * 1024 * 1024

/**
 * 作品对象键的前缀白名单（签名守卫用）。
 *
 * 为什么要有这道守卫：`getSharedPlayUrlByKey` 本身**不校验前缀**（它是给平台共享资源用的），
 * 而作品的 coverKey / videoKey 是后台可以手工填的文本框。没有守卫的话，谁把那两列填成
 * `uploads/2/xxx.mp4`，任何登录商户请求这条作品的详情都会**拿到商户 2 私有文件的签名地址**
 * —— 越权读，且日志里看不出异常。
 *
 * `renders/` 必须一起放行：存量作品（从成片入库那条路）落的就是 `renders/{merchantId}/…`。
 * 注意 `renders/` 也是商户渲染产物所在，但那条路径下**只有本商户**能读（creations 路由有归属校验），
 * 而优秀作品是运营从成片里主动挑出来公开给所有商户看的 —— 放行是刻意的产品语义。
 */
const SIGNABLE_WORK_PREFIXES = [WORK_KEY_PREFIX, 'renders/']

/** 这条作品的某个键是否允许签名成播放地址 */
export function isSignableWorkKey(key: string | null | undefined): key is string {
  return !!key && SIGNABLE_WORK_PREFIXES.some((p) => key.startsWith(p))
}

/** 同款配方：与 creation 的 track / complexity 取值对齐 */
export interface WorkRecipe {
  /** 文案款式，对应 CopyTrack；存量 INTRO / QUALITY 仅用于兼容旧配方 */
  track?: 'TRAFFIC' | 'INTRO' | 'QUALITY' | 'RECOMMEND'
  /** 镜头复杂度：SIMPLE 简单 / COMPLEX 复杂 / FINE 精细 */
  complexity?: 'SIMPLE' | 'COMPLEX' | 'FINE'
  /** 预填的创作标题建议 */
  titleHint?: string
  /** 推荐配音音色（TTS provider 的 voiceId） */
  voiceId?: string
  /** 分镜骨架：一键生成失败时的兜底，也用于向用户展示这条作品的镜头结构 */
  shotSkeleton?: Array<{
    shotType?: string
    shotSize?: string
    durationSuggest?: number
    line?: string
    visualReq?: string
  }>
  /** 运营备注：给用户看的「这条作品为什么好」 */
  notes?: string
}

export interface WorkListQuery {
  category?: string
  page?: number
  pageSize?: number
}

const LIST_SELECT = {
  id: true,
  title: true,
  category: true,
  subCategory: true,
  tags: true,
  coverKey: true,
  videoKey: true,
  durationMs: true,
  sort: true,
  viewCount: true,
  cloneCount: true,
  publishedAt: true,
} satisfies Prisma.ExcellentWorkSelect

/** 小程序侧列表：只看 enabled，按 sort 升序、新作品靠前 */
export async function listWorks(prisma: PrismaClient, q: WorkListQuery) {
  const page = Math.max(1, q.page ?? 1)
  const pageSize = Math.min(50, Math.max(1, q.pageSize ?? 6))
  const where: Prisma.ExcellentWorkWhereInput = {
    enabled: true,
    deletedAt: null,
    ...(q.category ? { category: q.category } : {}),
  }
  const [total, items] = await Promise.all([
    prisma.excellentWork.count({ where }),
    prisma.excellentWork.findMany({
      where,
      orderBy: [{ sort: 'asc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: LIST_SELECT,
    }),
  ])
  return { page, pageSize, total, hasMore: page * pageSize < total, items }
}

/** 分类 + 每类作品数：前端分类横滑不再写死 */
export async function listCategories(prisma: PrismaClient) {
  const rows = await prisma.excellentWork.groupBy({
    by: ['category'],
    where: { enabled: true, deletedAt: null },
    _count: { _all: true },
  })
  return rows
    .map((r) => ({ category: r.category, count: r._count._all }))
    .sort((a, b) => b.count - a.count)
}

export async function getWork(prisma: PrismaClient, id: bigint) {
  const work = await prisma.excellentWork.findFirst({
    where: { id, enabled: true, deletedAt: null },
    select: { ...LIST_SELECT, recipeJson: true, sourceType: true },
  })
  if (!work) throw new WorkNotFoundError()
  return work
}

/** 播放/查看计数：失败不影响主流程，前端不等待 */
export async function bumpViewCount(prisma: PrismaClient, id: bigint) {
  await prisma.excellentWork.updateMany({
    where: { id, deletedAt: null },
    data: { viewCount: { increment: 1 } },
  })
}

/** 「生成同款」计数 */
export async function bumpCloneCount(prisma: PrismaClient, id: bigint) {
  await prisma.excellentWork.updateMany({
    where: { id, deletedAt: null },
    data: { cloneCount: { increment: 1 } },
  })
}

// ──────────────────────── 后台管理 ────────────────────────

export interface WorkAdminInput {
  title: string
  category: string
  subCategory?: string | null
  tags?: string[] | null
  coverKey?: string | null
  videoKey?: string | null
  durationMs?: number | null
  recipeJson?: WorkRecipe
  sort?: number
  enabled?: boolean
  sourceType?: 'MANUAL' | 'RENDER'
  sourceTaskId?: bigint | null
}

export async function listAdminWorks(
  prisma: PrismaClient,
  q: { category?: string; enabled?: boolean; page?: number; pageSize?: number },
) {
  const page = Math.max(1, q.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20))
  const where: Prisma.ExcellentWorkWhereInput = {
    deletedAt: null,
    ...(q.category ? { category: q.category } : {}),
    ...(q.enabled === undefined ? {} : { enabled: q.enabled }),
  }
  const [total, items] = await Promise.all([
    prisma.excellentWork.count({ where }),
    prisma.excellentWork.findMany({
      where,
      orderBy: [{ sort: 'asc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { ...LIST_SELECT, enabled: true, sourceType: true, sourceTaskId: true, recipeJson: true },
    }),
  ])
  return { page, pageSize, total, items }
}

export async function createWork(prisma: PrismaClient, input: WorkAdminInput) {
  return prisma.excellentWork.create({
    data: {
      title: input.title,
      category: input.category,
      subCategory: input.subCategory ?? null,
      tags: (input.tags ?? null) as Prisma.InputJsonValue,
      coverKey: input.coverKey ?? null,
      videoKey: input.videoKey ?? null,
      durationMs: input.durationMs ?? null,
      recipeJson: (input.recipeJson ?? {}) as Prisma.InputJsonValue,
      sort: input.sort ?? 0,
      enabled: input.enabled ?? true,
      sourceType: input.sourceType ?? 'MANUAL',
      sourceTaskId: input.sourceTaskId ?? null,
      publishedAt: input.enabled === false ? null : new Date(),
    },
  })
}

export async function updateWork(prisma: PrismaClient, id: bigint, input: Partial<WorkAdminInput>) {
  const exist = await prisma.excellentWork.findFirst({ where: { id, deletedAt: null }, select: { id: true } })
  if (!exist) return null
  return prisma.excellentWork.update({
    where: { id },
    data: {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.subCategory === undefined ? {} : { subCategory: input.subCategory }),
      ...(input.tags === undefined ? {} : { tags: (input.tags ?? null) as Prisma.InputJsonValue }),
      ...(input.coverKey === undefined ? {} : { coverKey: input.coverKey }),
      ...(input.videoKey === undefined ? {} : { videoKey: input.videoKey }),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      ...(input.recipeJson === undefined ? {} : { recipeJson: input.recipeJson as Prisma.InputJsonValue }),
      ...(input.sort === undefined ? {} : { sort: input.sort }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled, publishedAt: input.enabled ? new Date() : null }),
      ...(input.sourceType === undefined ? {} : { sourceType: input.sourceType }),
      ...(input.sourceTaskId === undefined ? {} : { sourceTaskId: input.sourceTaskId }),
    },
  })
}

export async function deleteWork(prisma: PrismaClient, id: bigint) {
  const exist = await prisma.excellentWork.findFirst({ where: { id, deletedAt: null }, select: { id: true } })
  if (!exist) return false
  await prisma.excellentWork.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } })
  return true
}

/**
 * 可入库的成片：状态成功、有 resultKey，且**尚未入库过**。
 * 专供后台「从成片入库」挑选，避免运营手抄任务 ID，也避免同一条成片重复生成草稿。
 */
export async function listImportableTasks(prisma: PrismaClient, limit = 30) {
  const imported = await prisma.excellentWork.findMany({
    where: { sourceTaskId: { not: null }, deletedAt: null },
    select: { sourceTaskId: true },
  })
  const importedIds = imported
    .map((r) => r.sourceTaskId)
    .filter((v): v is bigint => v !== null)

  const tasks = await prisma.renderTask.findMany({
    where: {
      status: 'SUCCESS',
      resultKey: { not: null },
      ...(importedIds.length ? { id: { notIn: importedIds } } : {}),
    },
    orderBy: { id: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
    select: {
      id: true,
      resultKey: true,
      durationMs: true,
      grade: true,
      createdAt: true,
      creation: { select: { id: true, title: true, store: { select: { name: true, category: true } } } },
      merchant: { select: { phone: true, nickname: true } },
    },
  })

  // BigInt 不能直接 JSON.stringify，统一转字符串
  return tasks.map((t) => ({
    id: String(t.id),
    resultKey: t.resultKey,
    durationMs: t.durationMs,
    grade: t.grade,
    createdAt: t.createdAt,
    title: t.creation?.title ?? null,
    storeName: t.creation?.store?.name ?? null,
    storeCategory: t.creation?.store?.category ?? null,
    merchantPhone: t.merchant?.phone ?? null,
    merchantNickname: t.merchant?.nickname ?? null,
  }))
}

/**
 * 从商家成功成片入库：把 render_task 的成片复制成一条作品草稿（默认不上架）。
 * 素材仍是同一对象键，运营在后台补齐封面 / 分类 / 配方后再上架。
 */
export async function createWorkFromRenderTask(prisma: PrismaClient, taskId: bigint) {
  // 幂等保护：软删过的作品不拦，允许重新入库
  const dup = await prisma.excellentWork.findFirst({
    where: { sourceTaskId: taskId, deletedAt: null },
    select: { title: true },
  })
  if (dup) throw new WorkAlreadyImportedError(dup.title)

  const task = await prisma.renderTask.findFirst({
    where: { id: taskId, status: 'SUCCESS', resultKey: { not: null } },
    select: {
      id: true,
      resultKey: true,
      durationMs: true,
      grade: true,
      creation: { select: { title: true, store: { select: { name: true, category: true } } } },
    },
  })
  if (!task || !task.resultKey) throw new WorkNotFoundError()

  const title = task.creation?.title || `${task.creation?.store?.name ?? '未命名门店'}的成片`
  // 入库时顺手抽一帧当封面：小程序首页卡片需要真图，否则只能显示「封面待补」占位。
  // best-effort，失败不影响入库本身（运营仍可在后台点「抽封面」重试或手填 coverKey）。
  const cover = await ensureVideoCoverKey(task.resultKey).catch(() => ({ ok: false as const, reason: '' }))
  if (!cover.ok) console.warn('[works] 入库自动抽帧失败:', cover.reason)

  return prisma.excellentWork.create({
    data: {
      title,
      category: task.creation?.store?.category || '餐饮',
      tags: ['成片入库'] as Prisma.InputJsonValue,
      coverKey: cover.ok ? cover.coverKey : null,
      videoKey: task.resultKey,
      durationMs: task.durationMs ?? null,
      // 配方留空，由运营补齐；不自动上架，避免未审核内容直接出现在首页
      recipeJson: {} as Prisma.InputJsonValue,
      enabled: false,
      sourceType: 'RENDER',
      sourceTaskId: task.id,
    },
  })
}

/**
 * 按已有 videoKey 重新抽一帧封面（运营觉得首帧不好看，或作品是在自动抽帧上线前入库的）。
 * 没有视频、抽帧失败都会抛 WorkCoverError，由路由转成可读提示。
 */
export async function regenerateWorkCover(prisma: PrismaClient, id: bigint) {
  const work = await prisma.excellentWork.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, videoKey: true },
  })
  if (!work) throw new WorkNotFoundError()
  if (!work.videoKey) throw new WorkCoverError('这条作品还没有视频，先填视频 Key 或从成片入库')

  const cover = await ensureVideoCoverKey(work.videoKey, { atSeconds: 1 })
  if (!cover.ok) throw new WorkCoverError(cover.reason)

  return prisma.excellentWork.update({ where: { id }, data: { coverKey: cover.coverKey } })
}

// ──────────────────────── 后台上传（本地文件 → 对象存储） ────────────────────────
//
// 为什么要这条通道：在此之前后台只能**手填对象键**（运营得先自己把视频传进 COS 再抄键），
// 而「从管理后台本地导入视频」是本模块的常规操作。与教学视频那条通道同构，
// 区别只在键前缀（见 WORK_KEY_PREFIX 的说明）。
//
// 为什么是服务端收流（multipart）而不是像商家素材那样走 STS 直传：
// 直传那套要求 storeId + 商户前缀 + 存储配额，平台级运营内容三样都不适用；
// 而**魔数嗅探必须拿到真实字节**，服务端收流正好顺手做了。

/** 20260918 —— 按天分目录，方便在 COS 控制台按时间人工排查/清理 */
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
function workKey(ext: string): string {
  return `${WORK_KEY_PREFIX}${dateSegment()}/${randomUUID().replaceAll('-', '')}${ext}`
}

/** 抽帧产物落盘位置：与 multer 的中转区同一个目录，抽完立即删 */
function tmpCoverPath(): string {
  return join(localStorageRoot(), '.incoming', `work_cover_${randomUUID().replaceAll('-', '')}.jpg`)
}

export interface WorkVideoUploadResult {
  videoKey: string
  contentType: string
  sizeBytes: number
  /**
   * 服务端抽帧得到的封面键（可能为 null）。抽帧失败**不算上传失败**
   * —— 某些编码本机 ffmpeg 抽不出来，而作品列表还有「重抽封面」按钮可补，
   * 不该因为封面把整个上传退掉（那样运营连视频都白传了）。
   */
  coverKey: string | null
}

/**
 * 保存后台选中的作品视频。`tempPath` 是 multer 的中转文件路径。
 *
 * **无论成败都会清掉它** —— multer 全部落在 storage/.incoming/，不清会一直堆积。
 */
export async function saveWorkVideo(tempPath: string): Promise<WorkVideoUploadResult> {
  const head = await readFileHead(tempPath, 32)
  const type = head ? detectVideoType(head) : null
  if (!type) {
    await removeLocalFile(tempPath)
    throw new WorkUploadError('只支持 MP4 / MOV / WebM / AVI 视频')
  }

  const videoKey = workKey(type.ext)
  let sizeBytes = 0
  try {
    sizeBytes = await uploadFile(tempPath, videoKey, type.contentType)
  } catch (e) {
    await removeLocalFile(tempPath)
    throw e
  }

  let coverKey: string | null = null
  try {
    const outKey = workKey('.jpg')
    const outPath = tmpCoverPath()
    const { ok } = await generateVideoCover(tempPath, outPath)
    if (ok) {
      // 私有对象 + 现签，与作品视频同一条通道，不走 uploadPublicObject
      await uploadFile(outPath, outKey, 'image/jpeg')
      coverKey = outKey
    }
    await removeLocalFile(outPath)
  } catch (e) {
    console.warn('[works] 封面抽帧失败（不阻断上传）:', (e as Error).message)
    coverKey = null
  } finally {
    await removeLocalFile(tempPath)
  }

  return { videoKey, contentType: contentTypeForKey(videoKey), sizeBytes, coverKey }
}

/** 保存后台单独上传的作品封面（运营想用一张比首帧更好看的图时） */
export async function saveWorkCover(tempPath: string): Promise<{ coverKey: string; sizeBytes: number }> {
  const head = await readFileHead(tempPath, 16)
  const type = head ? detectImageType(head) : null
  if (!type) {
    await removeLocalFile(tempPath)
    throw new WorkUploadError('封面只支持 JPG / PNG / WebP / GIF 图片')
  }
  const key = workKey(type.ext)
  try {
    return { coverKey: key, sizeBytes: await uploadFile(tempPath, key, type.contentType) }
  } finally {
    await removeLocalFile(tempPath)
  }
}
