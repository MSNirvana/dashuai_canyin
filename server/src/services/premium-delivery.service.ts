// 精品（PREMIUM）人工剪辑 · 交付素材上传
//
// ── 为什么必须有一条上传通道 ────────────────────────────────────────────────
// 交付接口 `POST /render/tasks/:id/deliver` 收的是**对象键**（resultKey），
// 而后台此前**根本没有上传端点** —— 剪辑师只能在别处（COS 控制台 / 本地脚本）把成片
// 传上去，再把键抄进弹窗（旧界面默认值就是手拼的 `renders/{merchantId}/{taskId}.mp4`）。
// 这件事看着只是「麻烦」，实际会稳定地产生三类脏数据：
//   · 键抄错一位 ⇒ 交付成功、用户端**永远播不出来**（库里看着一切正常）；
//   · 文件名随手起 ⇒ 扩展名与真实容器不符 ⇒ Content-Type 错 ⇒ 端上静默不播；
//   · 覆盖同名键 ⇒ CDN / 微信按 URL 缓存，换了成片用户**还看旧的**，且不报错。
// 所以这里按「文件字节进、对象键出」，与「教学中心」那条通道同构。
//
// ── 键前缀为什么必须是 `renders/{merchantId}/` ──────────────────────────────
// 用户端拿成片地址走 `GET /media/play-url?key=…` ⇒ `media.service.ts::getPlayUrlByKey()`，
// 它的闸门**只放行 `uploads/{merchantId}/` 与 `renders/{merchantId}/`**。
// 换言之前缀不只是命名习惯，它同时是**越权闸门**：换个前缀（比如平台级的 `works/`）
// 交付能成功、但用户端必然 403。反过来，`renders/` 也意味着本文件写出的对象
// **必须在 GC 的扫描范围内**（它是硬交付，残留对象靠 GC 兜底回收）——
// 这与 `static/` 那条「不在扫描前缀里才保命」的规矩正好相反，别搞混。
//
// ── 为什么键里一定要带随机段 ────────────────────────────────────────────────
// 交付是可能返工的（剪辑师发现瑕疵要重传）。若沿用 `renders/{m}/{taskId}.mp4` 覆盖上传，
// 用户端/微信拿到的是**同一条 URL**，会继续播缓存里的旧成片 —— 与轮播图那条
// 「每次上传必须换新键」是同一个坑。代价是每次返工留一个无主旧对象，由 GC 在保留期后回收
// （旧行被 update 成新键后，它就不再是已引用键了）。
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { removeLocalFile } from '../lib/local-storage.js'
import { uploadFile } from '../lib/cos.js'
import { detectVideoType, readFileHead } from '../lib/media-type.js'
import { ensureVideoCoverKey } from '../lib/thumbnail.js'
import { probeDurationMs } from '../render/ffmpeg.js'
import { detectImageType } from './profile.service.js'

/**
 * 成片上限，100MB。
 *
 * ⚠ 这个数字有三处要对齐，漏掉 nginx 那处的话本地开发（vite 直连 3000，不过 nginx）
 *   永远测不出问题，上线才 413：
 *     1) 本常量（服务端权威校验）
 *     2) apps/admin 的上传前预校验文案（`components/UploadField.tsx` 的 maxMb）
 *     3) deploy/nginx/dashuai-admin.conf 的 `client_max_body_size`（现为 110m，够用）
 *   与教学视频同值是有意的：两条通道共用同一个 nginx location，上限天然绑在一起。
 */
export const MAX_DELIVER_VIDEO_BYTES = 100 * 1024 * 1024

/** 封面图上限。与轮播图/教学封面同值，都是「运营出图」的量级 */
export const MAX_DELIVER_COVER_BYTES = 5 * 1024 * 1024

/** 可交付（= 允许为它上传素材）的任务状态。SUCCESS 不在内：已交付的任务重传没有意义 */
const DELIVERABLE_STATUSES = ['MANUAL_PENDING', 'MANUAL_DOING'] as const

export class DeliverAssetError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400,
    /** 业务码，对齐 premium.PremiumTaskStateError 的形状（路由直接透传给前端） */
    readonly code = 4010,
  ) {
    super(message)
    this.name = 'DeliverAssetError'
  }
}

export interface UploadedVideo {
  /** 对象键，直接作为交付接口的 resultKey */
  key: string
  sizeBytes: number
  /** ffprobe 探测到的时长；探测失败为 null（不是错误，用户可以手填） */
  durationMs: number | null
  /** 抽帧得到的封面键；抽帧失败为 null */
  coverKey: string | null
}

export interface UploadedCover {
  key: string
  sizeBytes: number
}

/**
 * 上传前的任务守卫。
 *
 * ★ 这一步是**安全边界**而不是体验优化：对象键里的 `{merchantId}` 完全来自这条任务的归属，
 *   它是唯一的「这段视频属于谁」的凭据。没有这道校验，就等于开了一个
 *   「用一个不存在的任务 id 往任意商户目录写文件」的口子。
 *   同时顺手挡掉「给已交付/已失败的任务传素材」——那会留下永远不可能被引用的孤儿对象。
 */
async function assertDeliverableTask(prisma: PrismaClient, taskId: bigint) {
  const task = await prisma.renderTask.findUnique({
    where: { id: taskId },
    select: { id: true, merchantId: true, grade: true, status: true },
  })
  if (!task) throw new DeliverAssetError('任务不存在', 404, 4047)
  if (task.grade !== 'PREMIUM') throw new DeliverAssetError('该任务不是精品生成任务', 400, 4011)
  if (!DELIVERABLE_STATUSES.includes(task.status as (typeof DELIVERABLE_STATUSES)[number])) {
    throw new DeliverAssetError(`任务状态 ${task.status} 不可上传交付素材`)
  }
  return task
}

/** 20260918 —— 按天分段，方便在 COS 控制台按时间人工排查/清理 */
function dateSegment(): string {
  const d = new Date()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}${m}${day}`
}

function shortId(): string {
  return randomUUID().replaceAll('-', '')
}

/**
 * 保存剪辑师选中的成片。`tempPath` 是 multer 的中转文件路径。
 *
 * **无论成败都会清掉它** —— multer 全落在 `storage/.incoming/`，不清会一直堆积
 * （本项目头像上传踩过这个坑）。所以本函数内部一律走 try/finally，
 * 调用方不需要也不应该再删一次。
 *
 * 时长与封面都是 **best-effort**：ffprobe/ffmpeg 缺失或抽不出来都不该让上传失败
 * —— 成片本身已经安全落在对象存储里了，为了两个可选项把整个交付卡住是更差的选择。
 * 时长失败用户可以在弹窗里手填；封面失败小程序 `<Video>` 会自己显示首帧，不是白屏。
 */
export async function saveDeliverVideo(
  prisma: PrismaClient,
  taskId: bigint,
  tempPath: string,
): Promise<UploadedVideo> {
  try {
    const task = await assertDeliverableTask(prisma, taskId)

    // 只读文件头判类型：成片可能上百 MB，为判 16 个字节把整个文件读进内存，
    // 并发几个人交付就足以打爆进程。
    const head = await readFileHead(tempPath, 32)
    const type = head ? detectVideoType(head) : null
    if (!type) throw new DeliverAssetError('只支持 MP4 / MOV / WebM / AVI 视频')

    const key = `renders/${task.merchantId.toString()}/${taskId.toString()}-${dateSegment()}-${shortId()}${type.ext}`
    const sizeBytes = await uploadFile(tempPath, key, type.contentType)

    const durationMs = await probeDurationMs(tempPath).catch(() => null)
    const cover = await ensureVideoCoverKey(key).catch(() => ({ ok: false as const, reason: '' }))

    return {
      key,
      sizeBytes,
      durationMs,
      coverKey: cover.ok ? cover.coverKey : null,
    }
  } finally {
    await removeLocalFile(tempPath)
  }
}

/** 保存剪辑师单独上传的封面（不想用首帧时用） */
export async function saveDeliverCover(
  prisma: PrismaClient,
  taskId: bigint,
  tempPath: string,
): Promise<UploadedCover> {
  try {
    const task = await assertDeliverableTask(prisma, taskId)

    const head = await readFileHead(tempPath, 16)
    const type = head ? detectImageType(head) : null
    if (!type) throw new DeliverAssetError('封面只支持 JPG / PNG / WebP / GIF 图片')

    // 与成片同前缀：`previewKey` 将来若要在端上展示，同样要过 getPlayUrlByKey 的
    // 商户前缀闸门（放在 platform 级前缀下会签不出来）。covers/ 子目录只是为了好认。
    const key = `renders/${task.merchantId.toString()}/covers/${taskId.toString()}-${dateSegment()}-${shortId()}${type.ext}`
    const sizeBytes = await uploadFile(tempPath, key, type.contentType)
    return { key, sizeBytes }
  } finally {
    await removeLocalFile(tempPath)
  }
}
