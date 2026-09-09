// 对象存储：合成 worker 用 —— 下载素材到本地临时文件、上传成片回桶
// 复用 cos-nodejs-sdk-v5；未配置时返回 null（dev 环境下 FFMPEG_WORKER 应为 false，不会走到这里）
import { createWriteStream, createReadStream, stat } from 'node:fs'
import { promisify } from 'node:util'
import COS from 'cos-nodejs-sdk-v5'
import { copyFileToLocalObject, copyLocalObjectToFile, isLocalStorage, localObjectExists } from './local-storage.js'

const statP = promisify(stat)

let client: COS | null = null
function getClient(): COS | null {
  if (client) return client
  const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION } = process.env
  if (COS_SECRET_ID && COS_SECRET_KEY && COS_BUCKET && COS_REGION) {
    client = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY })
  }
  return client
}

/** COS 是否已配置（worker 启动时会据此告警） */
export function cosReady(): boolean {
  return isLocalStorage() || !!getClient()
}

/** 对象是否存在（中间产物缓存命中判定）。未配置或异常一律返回 false，走重算 */
export async function objectExists(key: string): Promise<boolean> {
  if (isLocalStorage()) return localObjectExists(key)
  const c = getClient()
  if (!c) return false
  const bucket = process.env.COS_BUCKET!
  const region = process.env.COS_REGION!
  try {
    await c.headObject({ Bucket: bucket, Region: region, Key: key })
    return true
  } catch {
    return false
  }
}

/** 下载对象到本地文件（流式，避免大文件占满内存） */
export function downloadToFile(key: string, localPath: string): Promise<void> {
  if (isLocalStorage()) return copyLocalObjectToFile(key, localPath)
  const c = getClient()
  if (!c) return Promise.reject(new Error('COS 未配置（需 COS_SECRET_ID/KEY/BUCKET/REGION）'))
  const bucket = process.env.COS_BUCKET!
  const region = process.env.COS_REGION!
  return new Promise((resolve, reject) => {
    const out = createWriteStream(localPath)
    out.on('error', reject)
    out.on('finish', resolve)
    const params: any = { Bucket: bucket, Region: region, Key: key, Output: out }
    c.getObject(params, (err: Error | null) => {
      if (err) {
        out.destroy()
        reject(err)
      }
    })
  })
}

/** 上传本地文件到桶，返回字节数 */
export async function uploadFile(localPath: string, key: string, contentType = 'video/mp4'): Promise<number> {
  if (isLocalStorage()) return copyFileToLocalObject(localPath, key)
  const c = getClient()
  if (!c) throw new Error('COS 未配置（需 COS_SECRET_ID/KEY/BUCKET/REGION）')
  const bucket = process.env.COS_BUCKET!
  const region = process.env.COS_REGION!
  await c.putObject({
    Bucket: bucket,
    Region: region,
    Key: key,
    Body: createReadStream(localPath),
    ContentType: contentType,
  })
  const st = await statP(localPath)
  return st.size
}
