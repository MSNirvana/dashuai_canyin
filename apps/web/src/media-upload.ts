import { api, API_BASE, getSession } from './api'

/**
 * 素材上传。
 *
 * ★ 三段式，与小程序完全同构（web 端没有「拍摄」，只有选文件，但链路一样）：
 *   ① `POST /upload/sts` 拿临时密钥；
 *   ② **浏览器直传 COS**（`cos-js-sdk-v5`，不经我们自己的服务器）；
 *   ③ `POST /upload/complete` 让服务端核对对象并落 `media_asset` 行。
 *   少任何一段都会出问题：跳过 ③ 就是「文件在桶里、数据库没有」的孤儿对象，
 *   既不出现在任何列表里，也不参与合成。
 *
 * ★★★ 浏览器直传的**硬前提是桶的 CORS**。生产桶原本一条 CORS 规则都没有
 *   （小程序的 `wx.request` 不受同源策略约束，所以从来没配过），
 *   网页直接 PUT 会被预检拦成 `403 CORSResponse: This CORS request is not allowed`。
 *   2026-10-26 已给桶加了一条规则：来源 `https://dspcz.top` / `https://www.dspcz.top`，
 *   方法 GET/PUT/POST/HEAD，headers `*`，暴露 ETag。
 *   ⇒ 以后换域名必须同步这条规则，否则网页上传会挂，而**报错只有一行 403**。
 *
 * ★ 为什么单文件走 `putObject` 而不是一律分片：几十 MB 的短视频一次 PUT 就完了，
 *   分片要额外的 init/list/complete 三次往返。超过 `SLICE_THRESHOLD` 才切分片，
 *   那是「弱网下别整段重传」的收益点。
 */

const SLICE_THRESHOLD = 8 * 1024 * 1024
/** 单文件上限。服务端 multer 允许 2GB，但网页端上传是单次 PUT/分片串行，先按 500MB 兜住误选 */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024

export interface StsCredential {
  tmpSecretId: string
  tmpSecretKey: string
  sessionToken: string
  /** 秒级时间戳 */
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
  durationMs?: number | null
  status: string
  coverKey?: string | null
}

export interface UploadProgress {
  /** 0~100 */
  percent: number
  loadedBytes: number
  totalBytes: number
}

export const getUploadSts = () => api<StsCredential>('/upload/sts', { method: 'POST' })

function randomDigits(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10)
  return s
}

function extensionOf(file: File): string {
  const fromName = file.name.includes('.') ? file.name.split('.').pop() : ''
  if (fromName && /^[a-z0-9]{2,5}$/i.test(fromName)) return fromName.toLowerCase()
  // 名字没后缀时退回按 MIME 猜：容器厂商的 MIME 五花八门，只认这几个最稳的
  if (file.type === 'video/quicktime') return 'mov'
  if (file.type === 'video/x-matroska') return 'mkv'
  return 'mp4'
}

/**
 * 把 COS SDK 的错误压成一句能看懂的话。
 *
 * ★ 必须归一化：SDK 回调里的 err 是 `{ error: { Code, Message }, statusCode, headers }`，
 *   不是 Error 实例。直接 `String(err)` 得到 `[object Object]`，
 *   界面上就只剩一句「上传失败」——而真正该看的是 AccessDenied（凭证/权限）
 *   还是 CORSResponse（跨域没配对）还是 timeout。
 */
export function describeStorageError(e: unknown): string {
  const o = (e ?? {}) as { error?: { Code?: string; Message?: string }; statusCode?: number; message?: string }
  const code = o.error?.Code ?? ''
  const msg = o.error?.Message ?? o.message ?? ''
  const status = o.statusCode ? `HTTP ${o.statusCode} ` : ''
  if (/CORSResponse|CORS/i.test(msg) || /CORS/i.test(code)) {
    return `${status}对象存储拒绝跨域请求（桶的 CORS 规则没放行本站域名）`
  }
  if (/AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|Forbidden/i.test(`${code} ${msg}`)) {
    return `${status}对象存储拒绝：凭证过期或权限不足`
  }
  if (/timeout|Timeout/i.test(`${code} ${msg}`)) return `${status}上传超时，请检查网络后重试`
  return `${status}${msg || code || '上传失败'}`
}

/** 读本地视频的时长与分辨率（合成按时长计价，服务端拿不到文件就靠这里上报） */
export function readVideoMeta(file: File): Promise<{ durationMs?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    // 元数据读不出来不该挡住上传：时长只是计价依据，分辨率只是记录
    const done = (value: { durationMs?: number; width?: number; height?: number }) => {
      URL.revokeObjectURL(url)
      resolve(value)
    }
    const timer = window.setTimeout(() => done({}), 8000)
    video.onloadedmetadata = () => {
      window.clearTimeout(timer)
      done({
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      })
    }
    video.onerror = () => {
      window.clearTimeout(timer)
      done({})
    }
    video.src = url
  })
}

/** 本地存储模式（只在本机跑 server 时出现）走 multipart 中转，浏览器不需要碰 COS */
async function uploadLocal(file: File, storeId: string, meta: { durationMs?: number; width?: number; height?: number }): Promise<MediaAsset> {
  const session = getSession()
  const form = new FormData()
  form.append('file', file)
  form.append('storeId', storeId)
  form.append('type', 'VIDEO')
  if (meta.durationMs) form.append('durationMs', String(meta.durationMs))
  if (meta.width) form.append('width', String(meta.width))
  if (meta.height) form.append('height', String(meta.height))

  const response = await fetch(`${API_BASE}/upload/local`, {
    method: 'POST',
    headers: session ? { Authorization: `Bearer ${session.token}` } : undefined,
    body: form,
  })
  const payload = (await response.json()) as { code: number; message: string; data?: MediaAsset }
  if (!response.ok || payload.code !== 0 || !payload.data) throw new Error(payload.message || '上传失败')
  return payload.data
}

/**
 * 上传一个视频文件，返回落库后的素材记录（带 `id`，用来绑到分镜）。
 *
 * ★★★ 对象键必须由**客户端**生成，且必须落在 `sts.prefix` 之下：
 *   服务端 `confirmUpload` 会校验前缀（`uploads/{merchantId}/`），
 *   前缀不对直接 2008 拒掉 —— 而我们这边已经白传了一次文件。
 */
export async function uploadVideo(
  file: File,
  opts: { storeId: string; onProgress?: (p: UploadProgress) => void },
): Promise<{ asset: MediaAsset; durationMs?: number }> {
  if (!file.size) throw new Error('这个文件是空的，换一个再试')
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`文件有点大（${(file.size / 1024 / 1024).toFixed(0)}MB），请压一下再传，或分几段拍`)
  }

  const meta = await readVideoMeta(file)
  const sts = await getUploadSts()

  if (sts.mode === 'local') {
    const asset = await uploadLocal(file, opts.storeId, meta)
    opts.onProgress?.({ percent: 100, loadedBytes: file.size, totalBytes: file.size })
    return { asset, durationMs: meta.durationMs }
  }

  // ★ 动态 import：SDK 只在上传时才需要，不进首屏 bundle
  const mod = await import('cos-js-sdk-v5')
  const COS = (mod as unknown as { default: new (o: unknown) => CosClient }).default

  // 凭证不能一次冻结全程：SDK 对**每个分片**都调一次授权回调，长上传会越过 expiredTime。
  // 临近过期（留 5 分钟签名余量）就换一份新的，换不到先给旧的（比重试空转强）。
  let active = sts
  const cos = new COS({
    getAuthorization: (_options: unknown, callback: (params: unknown) => void) => {
      const serve = (cred: StsCredential) =>
        callback({
          TmpSecretId: cred.tmpSecretId,
          TmpSecretKey: cred.tmpSecretKey,
          XCosSecurityToken: cred.sessionToken,
          StartTime: cred.startTime,
          ExpiredTime: cred.expiredTime,
        })
      const nowSec = Math.floor(Date.now() / 1000)
      if (active.expiredTime - nowSec > 300) {
        serve(active)
        return
      }
      getUploadSts()
        .then((fresh) => {
          active = fresh
          serve(fresh)
        })
        .catch(() => serve(active))
    },
  })

  const key = `${sts.prefix}${Date.now()}_${randomDigits(6)}.${extensionOf(file)}`

  await new Promise<void>((resolve, reject) => {
    const onProgress = (p: { percent?: number; loaded?: number; total?: number }) => {
      const percent = Math.round((p.percent ?? 0) * 100)
      opts.onProgress?.({
        percent: Math.max(0, Math.min(100, percent)),
        loadedBytes: p.loaded ?? 0,
        totalBytes: p.total ?? file.size,
      })
    }
    const callback = (err: unknown) => (err ? reject(new Error(describeStorageError(err))) : resolve())
    if (file.size > SLICE_THRESHOLD) {
      cos.sliceUploadFile({ Bucket: sts.bucket, Region: sts.region, Key: key, Body: file, onProgress }, callback)
    } else {
      cos.putObject({ Bucket: sts.bucket, Region: sts.region, Key: key, Body: file, onProgress }, callback)
    }
  })

  const asset = await api<MediaAsset>('/upload/complete', {
    method: 'POST',
    body: {
      cosKey: key,
      storeId: opts.storeId,
      type: 'VIDEO',
      sizeBytes: file.size,
      ...(meta.durationMs ? { durationMs: meta.durationMs } : {}),
      ...(meta.width ? { width: meta.width } : {}),
      ...(meta.height ? { height: meta.height } : {}),
    },
  })
  opts.onProgress?.({ percent: 100, loadedBytes: file.size, totalBytes: file.size })
  return { asset, durationMs: meta.durationMs }
}

/** 对象键 → 带签名的播放地址（过期时间由服务端决定，不要缓存太久） */
export const getPlayUrlByKey = (key: string) =>
  api<{ url: string | null; dev?: boolean }>(`/media/play-url?key=${encodeURIComponent(key)}`)

/** SDK 的最小结构声明：只写我们用到的两个方法，避免把整个 SDK 的类型拖进来 */
interface CosClient {
  putObject(
    params: { Bucket: string; Region: string; Key: string; Body: File; onProgress?: (p: { percent?: number; loaded?: number; total?: number }) => void },
    callback: (err: unknown) => void,
  ): void
  sliceUploadFile(
    params: { Bucket: string; Region: string; Key: string; Body: File; onProgress?: (p: { percent?: number; loaded?: number; total?: number }) => void },
    callback: (err: unknown) => void,
  ): void
}
