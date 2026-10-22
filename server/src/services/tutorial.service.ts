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
import {
  TUTORIAL_CATEGORY_CODES,
  MAX_CATEGORY_TITLE_LEN,
  type TutorialCategoryCode,
} from '../lib/tutorial-categories.js'
import { getString, invalidate } from '../lib/settings.js'
import { getSharedPlayUrlByKey } from './media.service.js'
import { detectImageType } from './profile.service.js'

/**
 * 对象键前缀。⚠ 必须与 lib/local-storage.ts 的 ALLOWED_PREFIXES 对齐，
 * 并且必须被 gc-orphan-objects.ts 的默认扫描前缀覆盖 —— 教学视频是**硬删**，
 * 残留对象指望 GC 兜底回收（这一点与 static/ 前缀刻意相反）。
 */
export const TUTORIAL_KEY_PREFIX = 'tutorials/'

/**
 * 教学视频**不设大小上限**（2026-10-13 按要求放开原来的 100MB）。
 *
 * 为什么保留这个常量、值写成 `Number.POSITIVE_INFINITY`，而不是把它删掉：
 *   这条上传链有好几层都要「上限」这个入参（multer 的 limits、uploadSingle 的错误文案、
 *   前端预校验、契约测试）。删掉常量就得在每处各写一次「没有上限」，反而更容易漏掉一层；
 *   留着常量 = 仍然只有一个开关。
 *
 * `Infinity` 是真的会让上限失效，不是「写一个很大的数」：
 *   busboy（multer 的底层）判据是
 *   `fileSizeLimit = typeof limits.fileSize === 'number' ? limits.fileSize : Infinity`，
 *   而掐断判据 `fileSize === fileSizeLimit` 在 Infinity 下**永不成立** ⇒ 不再掐断。
 *
 * ⚠ 放开大小之后，还有两条会**先拦住大文件**的天花板（都不是大小，改错的表现是
 *   「传一半断掉」，且与「文件太大」的现象几乎一样，极难区分）：
 *     1) nginx：deploy/nginx/dashuai-admin.conf 的 `client_max_body_size` 必须是 `0`
 *        （0 = 关闭检查；留成 110m 会在 413 处返回 nginx 自己的 HTML 错误页）。
 *        ★ 本地开发是 vite 直连 3000、不过 nginx，**永远测不出这一条**，只有上线才炸。
 *     2) Node：http server 的 `requestTimeout`（Node 18+ 默认 300 秒，是**整请求**超时）
 *        —— 见 src/index.ts，已置 0。
 *   （dashuai-api.conf 的 20m 不用动：上传走的是 admin 域名那条反代，不是小程序那条）
 *
 * ★ 封面图仍然限 5MB（见 MAX_TUTORIAL_COVER_BYTES）——本次只放开视频。
 */
export const MAX_TUTORIAL_VIDEO_BYTES = Number.POSITIVE_INFINITY

/** 封面图上限。与 public-asset 的轮播图同值，都是「运营出图」的量级 */
export const MAX_TUTORIAL_COVER_BYTES = 5 * 1024 * 1024

/**
 * 兜底文案：系统设置里没配（或配的脏了）时用这套。
 *
 * ★★ 2026-10-22 跟随改名：原来叫「拍摄技巧 / 剪辑教程 / 运营知识 / 使用手册」。
 *   这几个词（技巧/教程/知识/手册）正是把小程序往「教育服务·在线视频课程」上带的词，
 *   而 `/api/v1/tutorials` 是**免登录可读**的 —— 标题留在响应体里，改名的意义就打了折。
 *   注意只换**文案**，`code` 仍是 SHOOTING/EDITING/OPERATION/MANUAL（标识符不动）。
 * ★★ 2026-10-22 起这套只是**兜底**：运营可以在后台改分类名（存在系统设置里），
 *   读的地方一律走 getCategoryTitles()，不要直接引用这个常量。
 */
const FALLBACK_TITLES: Record<TutorialCategoryCode, string> = {
  SHOOTING: '怎么拍',
  EDITING: '怎么剪',
  OPERATION: '怎么发',
  MANUAL: '怎么用',
}

/** 分类名存在系统设置的这条记录下（groupKey.settingKey） */
export const TUTORIAL_SETTING_GROUP = 'tutorial'
export const TUTORIAL_TITLE_KEY = 'category_titles'

/**
 * 四个分类的**当前名称**（自定义值 + 兜底合并后的完整结果）。
 *
 * ★ 为什么返回「完整四份」而不是「只返回改过的」：调用方到处都要 `titles[code]`，
 *   让他自己兜底就等于把兜底逻辑复制到三处，迟早漂移。
 * ★ 脏值（手改库、JSON 写坏、值类型不对）一律**退回兜底并继续**，绝不抛错 ——
 *   这个接口是免登录的首页/我的页数据源，一个坏配置不该把整页打成 500。
 */
export async function getCategoryTitles(prisma: PrismaClient): Promise<Record<TutorialCategoryCode, string>> {
  const merged: Record<TutorialCategoryCode, string> = { ...FALLBACK_TITLES }
  const raw = await getString(prisma, TUTORIAL_SETTING_GROUP, TUTORIAL_TITLE_KEY, '')
  if (!raw) return merged
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return merged
    for (const code of TUTORIAL_CATEGORY_CODES) {
      const v = (parsed as Record<string, unknown>)[code]
      if (typeof v === 'string' && v.trim()) merged[code] = v.trim().slice(0, MAX_CATEGORY_TITLE_LEN)
    }
  } catch {
    console.warn('[tutorials] 分类名称是脏 JSON，已退回兜底文案:', raw.slice(0, 120))
  }
  return merged
}

/**
 * 保存分类名（后台用）。只写**改过的键**（与兜底相同的就不写），
 * 这样以后调整兜底文案时，没被运营动过的分类会自动跟着变。
 *
 * ⚠ 禁词校验不在这里做：放在路由层（admin.ts），因为那是「请求参数合法性」的一部分，
 *   而本函数是纯数据写入。两处都要改的时候，判据在 routes/admin.ts 的
 *   `findBannedTitleWord` 调用点。
 */
export async function saveCategoryTitles(
  prisma: PrismaClient,
  input: Partial<Record<TutorialCategoryCode, string>>,
): Promise<Record<TutorialCategoryCode, string>> {
  const current = await getCategoryTitles(prisma)
  const next: Record<string, string> = {}
  for (const code of TUTORIAL_CATEGORY_CODES) {
    const v = (input[code] ?? current[code]).trim()
    // 与兜底一致的键不落库 —— 少一条记录就少一个「以后改兜底却改不动」的坑
    if (v && v !== FALLBACK_TITLES[code]) next[code] = v
  }
  const payload = Object.keys(next).length ? JSON.stringify(next) : ''
  await prisma.systemSetting.upsert({
    where: { groupKey_settingKey: { groupKey: TUTORIAL_SETTING_GROUP, settingKey: TUTORIAL_TITLE_KEY } },
    create: {
      groupKey: TUTORIAL_SETTING_GROUP,
      settingKey: TUTORIAL_TITLE_KEY,
      settingVal: payload,
      // displayName 是**必填**（后台「系统设置」列表要有个名字），别按可选字段写
      displayName: '参考视频 · 分类名称',
      description:
        '四个分类的名称（JSON，形如 {"SHOOTING":"怎么拍"}）。与代码兜底一致的键不落库；' +
        '名称里不许出现课程/教程/教学/学习/技巧/知识/手册。一般不用手改这里，去「参考视频」页顶部改。',
      valueType: 'JSON',
    },
    update: { settingVal: payload },
  })
  // 本进程缓存必须立刻失效，否则后台改完、小程序 60s 内还看到旧名字
  invalidate(TUTORIAL_SETTING_GROUP, TUTORIAL_TITLE_KEY)
  return getCategoryTitles(prisma)
}

export interface TutorialListItem {
  id: string
  category: string
  title: string
  durationMs: number | null
  /** 现签播放地址（本地模式与私有桶都只有 1h）。**小程序端已不再用它播放**，留给后台预览与回退 */
  videoUrl: string | null
  coverUrl: string | null
  /** 视频号视频标识 —— 小程序端拿它调 `wx.openChannelsActivity` 跳转播放 */
  feedId: string
  /** 视频号 ID（`sph` 开头）。行上没填时已由服务端用 env 兜底；仍为 null ⇒ 客户端不给「观看」入口 */
  finderUserName: string | null
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

/**
 * 全局默认视频号 ID。
 *
 * 本项目只有一个（自己的）视频号，后台逐行填 `sph…` 是纯重复劳动；留空即用这个值。
 * ★ 走 `process.env` 直读、不进 lib/config.ts —— 与项目里其它运营侧开关同一口径，
 *   改值只需要改 `.env` 并重启，不涉及编译期常量。
 */
const DEFAULT_FINDER_USER_NAME = (process.env.TUTORIAL_FINDER_USER_NAME ?? '').trim()

/** 这一行到底能不能给用户看：**feedId 非空**才算（空串/纯空白等同没有） */
function hasPlayableVideo(row: { feedId: string | null }): boolean {
  return !!row.feedId && !!row.feedId.trim()
}

/**
 * 四个分类各自有多少条**可看的**内容（给「我的」页那个分组列表用）。
 *
 * ★★ 2026-10-21：只数**真的配了 feedId 的行**——
 *   小程序按这个数决定「这个分类露不露脸」：数为 0 ⇒ 整个分类入口隐藏，
 *   四个都为 0 ⇒ 「我的」页连分组标题一起隐藏。
 * ★★ 2026-10-22：判据从 `videoKey` 换成 `feedId`（页面已改为跳转视频号播放，
 *   上传的视频文件不再是小程序端的播放来源）。`videoKey` 在库里保留，
 *   但**不再参与任何可见性判断** —— 别再把它加回来。
 * ★ 仍然**四个分类全量返回**（count 可能是 0）：过滤交给客户端，
 *   这样同一个接口既能驱动「隐藏」也能驱动「显示」，不需要第二个 "hasAny" 字段。
 */
export async function listCategoryStats(prisma: PrismaClient): Promise<TutorialCategoryStat[]> {
  // 名称与计数**并发取**：两者互不依赖，串起来等于让首页多等一次设置表查询
  const [rows, titles] = await Promise.all([
    prisma.tutorialVideo.findMany({
      where: { enabled: true },
      select: { category: true, feedId: true },
    }),
    getCategoryTitles(prisma),
  ])
  const countOf = new Map<string, number>()
  for (const row of rows) {
    if (!hasPlayableVideo(row)) continue
    countOf.set(row.category, (countOf.get(row.category) ?? 0) + 1)
  }
  // 顺序与分类白名单一致，客户端拿到即可直接渲染
  return TUTORIAL_CATEGORY_CODES.map((code) => ({
    code,
    title: titles[code],
    count: countOf.get(code) ?? 0,
  }))
}

/** 某个分类下的内容列表（sort 升序，同 sort 新→旧） */
export async function listByCategory(
  prisma: PrismaClient,
  category: string,
  baseUrl?: string,
): Promise<TutorialListItem[]> {
  const rows = await prisma.tutorialVideo.findMany({
    // ★ 与 `listCategoryStats` **同一口径**：没配 feedId 的行不下发。
    //   两处口径必须一致，否则会出现「入口写着 3 条、点进去 4 条其中 1 条点不动」。
    where: { category, enabled: true, feedId: { not: null } },
    orderBy: [{ sort: 'asc' }, { id: 'desc' }],
    take: 200,
    select: {
      id: true,
      category: true,
      title: true,
      durationMs: true,
      videoKey: true,
      coverKey: true,
      feedId: true,
      finderUserName: true,
    },
  })
  return Promise.all(
    rows
      // 空串（手改库的脏值）在 where 里挡不住，在这里补一刀 —— 计数那边也是这么判的
      .filter(hasPlayableVideo)
      .map(async (r) => ({
        id: r.id.toString(),
        category: r.category,
        title: r.title,
        durationMs: r.durationMs,
        videoUrl: await signTutorialUrl(r.videoKey, baseUrl),
        coverUrl: await signTutorialUrl(r.coverKey, baseUrl),
        feedId: (r.feedId ?? '').trim(),
        // 行上没填就吃 env 默认值；两边都空 ⇒ 客户端会隐藏「观看」按钮（不给出点不动的入口）
        finderUserName: (r.finderUserName ?? '').trim() || DEFAULT_FINDER_USER_NAME || null,
      })),
  )
}

// ──────────────────────── 后台 CRUD ────────────────────────

export interface TutorialInput {
  category: string
  title: string
  videoKey?: string | null
  coverKey?: string | null
  /** 视频号视频标识。**这是小程序端能不能看这条的唯一判据**（空 ⇒ 不下发） */
  feedId?: string | null
  /** 视频号 ID；留空表示用 env `TUTORIAL_FINDER_USER_NAME` */
  finderUserName?: string | null
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
      feedId: true,
      finderUserName: true,
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
    // 空串归一成 null：判据是「trim 后非空」，存空串只会让两处判断各错一次
    feedId: input.feedId?.trim() || null,
    finderUserName: input.finderUserName?.trim() || null,
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
