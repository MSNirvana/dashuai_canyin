// 素材直传：拉 STS 临时密钥 → cos-wx-sdk-v5 分片上传 → 后端确认落库
// 单文件最大 2GB，分片续传由 SDK 内部 TaskId 接管
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
  status: string
  coverKey?: string | null
}

function randomStr(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10)
  return s
}

/** 直传媒体文件，返回落库后的素材记录。onProgress 回调 0~100 */
export async function uploadMediaFile(opts: {
  filePath: string
  storeId: string
  type: 'IMAGE' | 'VIDEO'
  durationMs?: number
  sizeBytes?: number
  onProgress?: (percent: number) => void
}): Promise<MediaAsset> {
  const sts = await http.post<StsCredential>('/upload/sts')
  const ext = (opts.filePath.split('.').pop() || (opts.type === 'IMAGE' ? 'jpg' : 'mp4')).toLowerCase()

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
      },
    })
    uploadTask.onProgressUpdate((p) => opts.onProgress?.(p.progress))
    const result = await uploadTask
    let body: { code?: number; message?: string; data?: MediaAsset }
    try { body = JSON.parse(result.data || '{}') as typeof body } catch { throw new Error('上传服务返回格式错误') }
    if (result.statusCode < 200 || result.statusCode >= 300 || body.code !== 0 || !body.data) {
      throw new Error(body.message || '上传失败')
    }
    opts.onProgress?.(100)
    return body.data
  }

  const key = `${sts.prefix}${Date.now()}_${randomStr(6)}.${ext}`

  const cos = new COS({
    getAuthorization: (_opt: unknown, cb: (info: unknown) => void) => {
      cb({
        TmpSecretId: sts.tmpSecretId,
        TmpSecretKey: sts.tmpSecretKey,
        XCosSecurityToken: sts.sessionToken,
        ExpiredTime: sts.expiredTime,
        StartTime: sts.startTime,
      })
    },
  })

  await new Promise<void>((resolve, reject) => {
    cos.sliceUploadFile(
      {
        Bucket: sts.bucket,
        Region: sts.region,
        Key: key,
        FilePath: opts.filePath,
        onProgress: (p: { percent: number }) => opts.onProgress?.(Math.floor((p.percent || 0) * 100)),
      },
      (err: unknown) => {
        if (err) reject(err)
        else resolve()
      },
    )
  })

  return http.post<MediaAsset>('/upload/complete', {
    cosKey: key,
    storeId: opts.storeId,
    type: opts.type,
    sizeBytes: opts.sizeBytes ?? 0,
    ...(opts.durationMs ? { durationMs: Math.round(opts.durationMs) } : {}),
  })
}

/** 直传一个视频文件，返回落库后的素材记录。onProgress 回调 0~100 */
export function uploadVideoFile(opts: {
  filePath: string
  storeId: string
  /** 视频时长（ms）：chooseMedia 的 duration×1000；用于合成按时长计价 */
  durationMs?: number
  /** 文件大小（字节）：chooseMedia 的 size */
  sizeBytes?: number
  onProgress?: (percent: number) => void
}): Promise<MediaAsset> {
  return uploadMediaFile({ ...opts, type: 'VIDEO' })
}
