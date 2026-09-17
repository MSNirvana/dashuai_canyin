// 对象存储：合成 worker 用 —— 下载素材到本地临时文件、上传成片回桶
// 复用 cos-nodejs-sdk-v5；未配置时返回 null（dev 环境下 FFMPEG_WORKER 应为 false，不会走到这里）
import { createWriteStream, createReadStream, stat } from 'node:fs'
import { promisify } from 'node:util'
import COS from 'cos-nodejs-sdk-v5'
import {
  copyFileToLocalObject,
  copyLocalObjectToFile,
  deleteLocalObject,
  isLocalStorage,
  listLocalObjects,
  localObjectExists,
  writeLocalObject,
  type StorageObject,
} from './local-storage.js'
import { assertSafeObjectKey } from './object-key.js'

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
/** 生成对象临时签名 URL，供 ChatCut 等外部处理服务拉取私有素材。 */
export async function signedObjectUrl(key: string, expiresSeconds = 3600): Promise<string> {
  if (isLocalStorage()) throw new Error('ChatCut 仅支持可公网访问的 COS 素材，不能使用本地存储模式')
  const c = getClient()
  if (!c) throw new Error('COS 未配置（需 COS_SECRET_ID/KEY/BUCKET/REGION）')
  return await new Promise<string>((resolve, reject) => {
    c.getObjectUrl({
      Bucket: process.env.COS_BUCKET!,
      Region: process.env.COS_REGION!,
      Key: key,
      Sign: true,
      Expires: expiresSeconds,
    }, (error, data) => {
      if (error) return reject(error)
      if (!data.Url) return reject(new Error('COS 未返回对象地址'))
      resolve(data.Url)
    })
  })
}

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

/**
 * 上传一个**匿名可读**的对象 —— 对象级设 `ACL: public-read`。
 *
 * ── 为什么必须与 `uploadFile()` 分开，而不是给它加个 acl 参数 ──────────────
 * 本桶是**私有桶**（里面还有商家上传的菜品图、人设图、成片）。`uploadFile()` 不传 ACL，
 * 传上去的对象默认私有；而公开图必须匿名可读。把 ACL 做成 uploadFile 的一个可选参数，
 * 意味着以后有人在私密素材的调用点上误传了 public，**不会报任何错**，只是那个文件
 * 悄无声息地对全世界开放了。所以这里用一个**独立函数名**把「这个对象会公开」
 * 写在调用点上，让代码审查时一眼可见。
 *
 * 另：不动桶级权限。项目已有的公开图（static/mini/… 首页那批）也是这么做的，
 * 理由见 apps/mini/scripts/upload-static-assets.mjs 顶部注释。
 */
export async function uploadPublicObject(key: string, body: Buffer, contentType: string): Promise<void> {
  assertSafeObjectKey(key, 'public object key')
  if (isLocalStorage()) {
    await writeLocalObject(key, body)
    return
  }
  const c = getClient()
  if (!c) throw new Error('COS 未配置（需 COS_SECRET_ID/KEY/BUCKET/REGION）')
  await c.putObject({
    Bucket: process.env.COS_BUCKET!,
    Region: process.env.COS_REGION!,
    Key: key,
    Body: body,
    ContentType: contentType,
    ACL: 'public-read',
    // 键里带随机段（每次上传都是新键），内容不会原地变化 ⇒ 可以放心长缓存
    CacheControl: 'public, max-age=604800',
  })
}

/**
 * 公开读对象的访问地址。**只对 `uploadPublicObject` 写过的对象有效** ——
 * 其它对象是私有的，拿这个 URL 去访问会 403。
 */
export function publicObjectUrl(key: string): string {
  return `https://${process.env.COS_BUCKET ?? ''}.cos.${process.env.COS_REGION ?? ''}.myqcloud.com/${key}`
}

/** 单页列举上限。COS 默认 1000，显式写出便于看清分页行为。 */
const LIST_PAGE_SIZE = 1000

/**
 * 列举存储中所有 `prefix` 开头的对象（本地模式 / COS 模式统一入口）。
 *
 * 为什么需要它：孤儿对象 GC 必须知道「存储里实际有什么」，而此前本模块只有
 * 「按已知 key 判存在」的能力，无法反向列举。缺少这一步，GC 根本无从下手。
 *
 * COS 侧用 `getBucket` 分页拉取：`IsTruncated` 为字符串 `'true'` 时才继续，
 * 且**优先用响应里的 `NextMarker`**；某些情况下 SDK 不返回它，此时退化为
 * 「用本页最后一个 Key 作为 Marker」——COS 的 Marker 语义是「从该键之后开始」，
 * 所以这样做不会重复也不会漏，只是少一次服务端优化。
 */
export async function listObjects(prefix: string): Promise<StorageObject[]> {
  if (isLocalStorage()) return listLocalObjects(prefix)

  const c = getClient()
  if (!c) throw new Error('COS 未配置（需 COS_SECRET_ID/KEY/BUCKET/REGION）')
  const bucket = process.env.COS_BUCKET!
  const region = process.env.COS_REGION!

  const out: StorageObject[] = []
  let marker: string | undefined
  // 防御性上限，避免后端异常返回 `IsTruncated=true` 但 marker 不变时死循环
  for (let page = 0; page < 10_000; page++) {
    const res = await new Promise<{
      Contents?: Array<{ Key?: string; Size?: string | number; LastModified?: string }>
      IsTruncated?: string | boolean
      NextMarker?: string
    }>((resolve, reject) => {
      c.getBucket(
        { Bucket: bucket, Region: region, Prefix: prefix, Marker: marker, MaxKeys: LIST_PAGE_SIZE },
        (err: Error | null, data: unknown) => (err ? reject(err) : resolve(data as never)),
      )
    })

    const contents = res.Contents ?? []
    for (const item of contents) {
      if (!item.Key) continue
      out.push({
        key: item.Key,
        sizeBytes: Number(item.Size ?? 0),
        lastModifiedMs: item.LastModified ? Date.parse(item.LastModified) : 0,
      })
    }

    const truncated = res.IsTruncated === true || res.IsTruncated === 'true'
    if (!truncated) break
    const next = res.NextMarker ?? contents[contents.length - 1]?.Key
    if (!next || next === marker) break
    marker = next
  }
  return out
}

/**
 * 删除单个对象。入口先做对象键安全校验，非法键（`..`、空段、编码分隔符）直接抛错，
 * 不会走到存储删除。本地模式复用 localPathForKey 的前缀白名单校验。
 */
export async function deleteObject(key: string): Promise<void> {
  assertSafeObjectKey(key, 'gc delete key')
  if (isLocalStorage()) return deleteLocalObject(key)

  const c = getClient()
  if (!c) throw new Error('COS 未配置（需 COS_SECRET_ID/KEY/BUCKET/REGION）')
  await new Promise<void>((resolve, reject) => {
    c.deleteObject(
      { Bucket: process.env.COS_BUCKET!, Region: process.env.COS_REGION!, Key: key },
      (err: Error | null) => (err ? reject(err) : resolve()),
    )
  })
}

export type { StorageObject }

/** 一个未完成的分片上传（碎片） */
export interface MultipartFragment {
  key: string
  uploadId: string
  /** UploadId 的创建时间（毫秒）；后端未提供时为 0 */
  initiatedMs: number
}

/**
 * 列举**未完成的分片上传**（碎片），按前缀。
 *
 * ★ 为什么必须单独一个接口：碎片不是对象，`getBucket` 看不到它们。
 *   上传失败（小程序弱网、用户切后台被系统杀死）会留下 UploadId 及其已上传分片，
 *   这些分片**照样占用存储并计费**，却不会出现在任何对象列表里，
 *   也不会出现在同目录下 `ls` 的输出中 —— 是典型的「看不见的成本」。
 *
 * 本地存储模式没有分片概念（走 multer 直接落盘），返回空数组。
 */
export async function listMultipartUploads(prefix: string): Promise<MultipartFragment[]> {
  if (isLocalStorage()) return []
  const c = getClient()
  if (!c) throw new Error('COS 未配置（需 COS_SECRET_ID/KEY/BUCKET/REGION）')
  const bucket = process.env.COS_BUCKET!
  const region = process.env.COS_REGION!

  const out: MultipartFragment[] = []
  let keyMarker: string | undefined
  let uploadIdMarker: string | undefined
  for (let page = 0; page < 10_000; page++) {
    const res = await new Promise<{
      Upload?: Array<{ Key?: string; UploadId?: string; Initiated?: string }>
      IsTruncated?: string | boolean
      NextKeyMarker?: string
      NextUploadIdMarker?: string
    }>((resolve, reject) => {
      c.multipartList(
        {
          Bucket: bucket,
          Region: region,
          Prefix: prefix,
          MaxUploads: LIST_PAGE_SIZE,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        },
        (err: Error | null, data: unknown) => (err ? reject(err) : resolve(data as never)),
      )
    })

    for (const item of res.Upload ?? []) {
      if (!item.Key || !item.UploadId) continue
      out.push({
        key: item.Key,
        uploadId: item.UploadId,
        initiatedMs: item.Initiated ? Date.parse(item.Initiated) : 0,
      })
    }

    const truncated = res.IsTruncated === true || res.IsTruncated === 'true'
    if (!truncated) break
    if (!res.NextKeyMarker && !res.NextUploadIdMarker) break
    if (res.NextKeyMarker === keyMarker && res.NextUploadIdMarker === uploadIdMarker) break
    keyMarker = res.NextKeyMarker
    uploadIdMarker = res.NextUploadIdMarker
  }
  return out
}

/** 中止一个未完成的分片上传：其已上传分片会被立即回收。 */
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  assertSafeObjectKey(key, 'gc abort key')
  if (isLocalStorage()) return
  const c = getClient()
  if (!c) throw new Error('COS 未配置（需 COS_SECRET_ID/KEY/BUCKET/REGION）')
  await new Promise<void>((resolve, reject) => {
    c.multipartAbort(
      { Bucket: process.env.COS_BUCKET!, Region: process.env.COS_REGION!, Key: key, UploadId: uploadId },
      (err: Error | null) => (err ? reject(err) : resolve()),
    )
  })
}
