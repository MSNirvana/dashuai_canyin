// 素材直传：拉 STS 临时密钥 → cos-wx-sdk-v5 分片上传 → 后端确认落库
//
// 单文件最大 2GB，走 sliceUploadFile 分片上传（默认分片 1MB）。
//
// 关于「断点续传」到底由谁负责（原注释写的是「由 SDK 内部 TaskId 接管」，不准确）：
//   ★ 真正让续传生效的不是 TaskId，而是 SDK 写在 wx storage 里的 **UploadId 缓存**
//     （key = `cos_sdk_upload_cache`，见 node_modules/cos-wx-sdk-v5/src/session.js）。
//     缓存键 = md5(FilePath) + md5(size::mode::lastAccessedTime::lastModifiedTime::ChunkSize::Bucket::**Key**)，
//     即**对象键 Key 也是文件特征值的一部分**。
//     恢复时 SDK 会校验远端 UploadId 仍在、再用 multipartListPart 拉回已上传分片并跳过
//     （advance.js 的 seek_local_avail_upload_id → wholeMultipartListPart）。
//   ★ 前提是「用同一个 Key 重试」：Key 一变，缓存键就变，SDK 永远命中不了缓存，
//     只能从第 0 字节重传，而且每次失败都在桶里再留一个上传碎片。
//     所以下面的 sliceUploadWithRetry 用**同一个 key** 重试，这是续传能生效的关键。
//   ★ 跨「重新选一次文件」的续传做不了：chooseMedia 每次给新的临时路径、文件 mtime 也变，
//     SDK 会判定成另一个文件。这里只承诺**同一次上传内的重试续传**。
import COS from 'cos-wx-sdk-v5'
import Taro from '@tarojs/taro'
import { BASE_URL, PLATFORM, STORAGE_KEYS } from '../config'
import { http } from './request'

export interface StsCredential {
  tmpSecretId: string
  tmpSecretKey: string
  sessionToken: string
  startTime: number
  expiredTime: number
  bucket: string
  region: string
  prefix: string
  mode?: 'local' | 'cos'
}

export interface MediaAsset {
  id: string
  cosKey: string
  type: string
  sizeBytes: number
  durationMs?: number
  status: string
  coverKey?: string | null
}

function randomStr(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10)
  return s
}

/**
 * 确认落库失败（对象已上传、但后端没有登记）。
 *
 * 这类失败会在存储里留下**孤儿对象**：文件真实存在、数据库没有对应素材行，
 * 既不会出现在任何列表里，也不会被业务逻辑回收。
 * （服务端已有 GC 工具兜底：server/scripts/gc-orphan-objects.ts，会按保留期回收无主对象。）
 * 带上 cosKey 是为了让调用方能原样重试（而不是重新生成一个新 key 再传一遍）。
 */
export class UploadConfirmError extends Error {
  readonly cosKey: string
  constructor(cosKey: string, message: string) {
    super(message)
    this.name = 'UploadConfirmError'
    this.cosKey = cosKey
  }
}

/** 确认落库：网络抖动很常见，直接放弃会稳定产生孤儿对象，因此带退避重试 */
async function confirmUploadWithRetry(payload: Record<string, unknown>, cosKey: string): Promise<MediaAsset> {
  const delays = [0, 400, 1200]
  let lastErr: unknown
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]))
    try {
      return await http.post<MediaAsset>('/upload/complete', payload)
    } catch (e) {
      lastErr = e
    }
  }
  throw new UploadConfirmError(cosKey, (lastErr as Error)?.message || '素材登记失败，请重试')
}

/** 上传已被调用方取消（页面卸载等）：此时不应再走 /upload/complete 落库 */
export class UploadAbortedError extends Error {
  constructor() {
    super('上传已取消')
    this.name = 'UploadAbortedError'
  }
}

/** 可取消的上传句柄。页面卸载时调用 abort() 会立刻停止传输 */
export interface UploadTaskHandle {
  abort: () => void
}

/**
 * 分片上传的重试退避（毫秒）。第 0 项表示立即首传。
 *
 * 为什么要重试：分片上传失败（弱网、切后台被系统挂起）后，原实现直接把错误抛给调用方，
 * 用户点了「重试」就是一个**全新的 key**，于是 SDK 的 UploadId 缓存命中不了，从 0 重传。
 * 这里在内部同 key 重试，微弱的网络抖动不必让用户重来。
 */
const SLICE_RETRY_DELAYS = [0, 800, 2000]

/**
 * 分片上传，失败后**用同一个 key** 重试。
 *
 * 同一个 key 是续传的前提（见文件头说明）：SDK 的 UploadId 缓存键包含 Key，
 * 且它**只在上传成功时才清除 UploadId**（advance.js 里 removeUploadId 仅出现在成功分支），
 * 因此重试时能命中缓存，配合 multipartListPart 跳过已上传分片，只补传剩余部分。
 *
 * 必须直接抛错、不得重试的情况：
 *   - 用户主动取消（abort 或页面卸载）—— 和用户意志对抗没有意义
 * 因此用 `cancel.byUser`（由外部 abort 句柄置位）与 `isCancelled` 双重判断。
 */
async function sliceUploadWithRetry(
  cos: COS,
  params: { Bucket: string; Region: string; Key: string; FilePath: string },
  /** 由调用方持有：abort 句柄被触发时置 byUser = true，本函数据此放弃重试 */
  cancel: { byUser: boolean },
  handlers: {
    onProgress?: (percent: number) => void
    /** 每次尝试都会回调，确保 abort 作用于**当前**这个任务 */
    onTaskReady?: (taskId: string) => void
    isCancelled?: () => boolean
  },
): Promise<void> {
  let lastErr: unknown

  for (let attempt = 0; attempt < SLICE_RETRY_DELAYS.length; attempt++) {
    const delay = SLICE_RETRY_DELAYS[attempt] ?? 0
    if (delay) await new Promise((r) => setTimeout(r, delay))
    if (cancel.byUser || handlers.isCancelled?.()) throw new UploadAbortedError()

    try {
      await new Promise<void>((resolve, reject) => {
        cos.sliceUploadFile(
          {
            Bucket: params.Bucket,
            Region: params.Region,
            Key: params.Key,
            FilePath: params.FilePath,
            onProgress: (p: { percent: number }) =>
              handlers.onProgress?.(Math.floor((p.percent || 0) * 100)),
            // SDK 是任务式调用：TaskId 只能通过 onTaskReady 拿到，用它才能取消进行中的分片上传
            onTaskReady: (taskId: string) => {
              handlers.onTaskReady?.(taskId)
            },
          },
          (err: unknown) => {
            if (err) reject(err)
            else resolve()
          },
        )
      })
      return
    } catch (e) {
      lastErr = e
      // 用户已取消：立刻中断，不再重试
      if (cancel.byUser || handlers.isCancelled?.()) throw new UploadAbortedError()
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('分片上传失败，请检查网络后重试')
}

/** 直传媒体文件，返回落库后的素材记录。onProgress 回调 0~100 */
export async function uploadMediaFile(opts: {
  filePath: string
  storeId: string
  type: 'IMAGE' | 'VIDEO' | 'AUDIO'
  durationMs?: number
  sizeBytes?: number
  /** 视频封面图本地路径（chooseMedia 的 thumbTempFilePath）：COS 模式随视频一起上报，用于生成缩略图 */
  thumbFilePath?: string
  /**
   * 素材归属：默认 CREATION（创作素材）。
   * 门店主图 / 门店视频传 STORE，标记为门店资料，不会混进创作素材池。
   */
  ownerType?: 'CREATION' | 'STORE' | 'DISH'
  onProgress?: (percent: number) => void
  /**
   * 拿到可取消句柄。页面卸载时调用 abort() 会立即停止传输，
   * 并且不会再调用 /upload/complete（避免「用户已离开却留下一条素材记录」）。
   */
  onTask?: (task: UploadTaskHandle) => void
  /** 调用方持有的取消标志；一旦为 true，各阶段之间会尽快抛 UploadAbortedError 中断 */
  isCancelled?: () => boolean
}): Promise<MediaAsset> {
  const aborted = () => {
    if (opts.isCancelled?.()) throw new UploadAbortedError()
  }
  const sts = await http.post<StsCredential>('/upload/sts')
  const ext = (opts.filePath.split('.').pop() || (opts.type === 'IMAGE' ? 'jpg' : opts.type === 'AUDIO' ? 'm4a' : 'mp4')).toLowerCase()

  if (sts.mode === 'local') {
    const token = Taro.getStorageSync<string>(STORAGE_KEYS.token)
    const uploadTask = Taro.uploadFile({
      url: `${BASE_URL}/upload/local`,
      filePath: opts.filePath,
      name: 'file',
      header: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-Platform': PLATFORM,
      },
      formData: {
        storeId: opts.storeId,
        type: opts.type,
        ...(opts.durationMs ? { durationMs: String(Math.round(opts.durationMs)) } : {}),
        ...(opts.ownerType ? { ownerType: opts.ownerType } : {}),
      },
    })
    uploadTask.onProgressUpdate((p) => opts.onProgress?.(p.progress))
    opts.onTask?.({ abort: () => { try { uploadTask.abort() } catch { /* 已结束 */ } } })
    const result = await uploadTask
    aborted()
    let body: { code?: number; message?: string; data?: MediaAsset }
    try { body = JSON.parse(result.data || '{}') as typeof body } catch { throw new Error('上传服务返回格式错误') }
    if (result.statusCode < 200 || result.statusCode >= 300 || body.code !== 0 || !body.data) {
      throw new Error(body.message || '上传失败')
    }
    opts.onProgress?.(100)
    return body.data
  }

  // COS 模式：服务端读不到本地视频文件，改由客户端先传封面图，再把对象键随视频上报
  let coverKey: string | undefined
  if (opts.type === 'VIDEO' && opts.thumbFilePath) {
    try {
      const cover = await uploadMediaFile({
        filePath: opts.thumbFilePath,
        storeId: opts.storeId,
        type: 'IMAGE',
        ownerType: opts.ownerType,
        isCancelled: opts.isCancelled,
      })
      coverKey = cover.cosKey
    } catch (e) {
      // 调用方主动取消要往外抛，不能当成「封面上传失败」吞掉
      if (e instanceof UploadAbortedError) throw e
      // 封面上传失败不阻断视频上传，缩略图后续可再补
      coverKey = undefined
    }
  }
  aborted()

  const key = `${sts.prefix}${Date.now()}_${randomStr(6)}.${ext}`

  // 用户主动取消的标记：abort 句柄置位后，分片上传不再重试（见 sliceUploadWithRetry）
  const cancel = { byUser: false }
  // 签名用凭证：分片上传期间可能被 getAuthorization 换成新的一份（见下面回调的说明）
  let activeCred = sts

  const cos = new COS({
    getAuthorization: (_opt: unknown, cb: (info: unknown) => void) => {
      const serve = (cred: StsCredential) =>
        cb({
          TmpSecretId: cred.tmpSecretId,
          TmpSecretKey: cred.tmpSecretKey,
          XCosSecurityToken: cred.sessionToken,
          ExpiredTime: cred.expiredTime,
          StartTime: cred.startTime,
        })
      // ★ 凭证不能全程冻结：SDK 对**每个分片**都调一次本回调签名，而 2GB 长上传动辄
      //   几十分钟 —— 一旦越过 expiredTime，后续每个分片都拿着过期凭证 403，
      //   「同 key 续传」恰恰在最需要它的长上传场景系统性失效，桶里还留碎片。
      //   临近过期（留 5 分钟签名余量）就换新；换新失败先给旧的，比重试空转强。
      const nowSec = Math.floor(Date.now() / 1000)
      if (activeCred.expiredTime - nowSec > 300) { serve(activeCred); return }
      http
        .post<StsCredential>('/upload/sts')
        .then((fresh) => {
          activeCred = fresh
          serve(fresh)
        })
        .catch(() => serve(activeCred))
    },
  })

  await sliceUploadWithRetry(
    cos,
    { Bucket: sts.bucket, Region: sts.region, Key: key, FilePath: opts.filePath },
    cancel,
    {
      onProgress: opts.onProgress,
      onTaskReady: (taskId: string) => {
        opts.onTask?.({
          abort: () => {
            cancel.byUser = true
            try { cos.cancelTask(taskId) } catch { /* 任务已结束 */ }
          },
        })
      },
      isCancelled: opts.isCancelled,
    },
  )
  aborted() // 传输完成但用户已离开，不再落库

  return confirmUploadWithRetry({
    cosKey: key,
    storeId: opts.storeId,
    type: opts.type,
    sizeBytes: opts.sizeBytes ?? 0,
    ...(opts.durationMs ? { durationMs: Math.round(opts.durationMs) } : {}),
    ...(coverKey ? { coverKey } : {}),
    ...(opts.ownerType ? { ownerType: opts.ownerType } : {}),
  }, key)
}

/** 直传一个视频文件，返回落库后的素材记录。onProgress 回调 0~100 */
export function uploadVideoFile(opts: {
  filePath: string
  storeId: string
  /** 视频时长（ms）：chooseMedia 的 duration×1000；用于合成按时长计价 */
  durationMs?: number
  /** 文件大小（字节）：chooseMedia 的 size */
  sizeBytes?: number
  /** 视频封面图本地路径：chooseMedia 的 thumbTempFilePath，COS 模式用它生成缩略图 */
  thumbFilePath?: string
  /** 素材归属：门店视频传 STORE，避免混进创作素材池 */
  ownerType?: 'CREATION' | 'STORE' | 'DISH'
  onProgress?: (percent: number) => void
  /** 拿到可取消句柄（页面卸载时 abort() 会停止传输且不落库） */
  onTask?: (task: UploadTaskHandle) => void
  /** 调用方持有的取消标志 */
  isCancelled?: () => boolean
}): Promise<MediaAsset> {
  return uploadMediaFile({ ...opts, type: 'VIDEO' })
}

/** 上传用户自定义配音文件（微信文件选择器返回的 mp3/m4a/wav 等）。 */
export function uploadAudioFile(opts: {
  filePath: string
  storeId: string
  durationMs?: number
  sizeBytes?: number
  onProgress?: (percent: number) => void
  onTask?: (task: UploadTaskHandle) => void
  isCancelled?: () => boolean
}): Promise<MediaAsset> {
  return uploadMediaFile({ ...opts, type: 'AUDIO' })
}
