declare module 'cos-nodejs-sdk-v5' {
  interface GetObjectUrlParams {
    Bucket: string
    Region: string
    Key: string
    Sign?: boolean
    Expires?: number
  }
  interface GetObjectUrlResult {
    Url?: string
  }
  type GetObjectUrlCallback = (err: Error | null, data: GetObjectUrlResult) => void

  // 下载：Output 传 fs.WriteStream 走流式落盘，避免大文件占满内存
  interface GetObjectParams {
    Bucket: string
    Region: string
    Key: string
    Output?: unknown
  }
  interface GetObjectResult {
    Body?: unknown
    headers?: Record<string, string>
  }
  type GetObjectCallback = (err: Error | null, data?: GetObjectResult) => void

  // 上传：Body 传 fs.ReadStream / Buffer。
  // ★ 本文件用 `declare module` **整体覆盖**了 SDK 自带的 index.d.ts ⇒ 这里没写的字段
  //   在项目里就等于不存在（类型报错「does not exist in type 'PutObjectParams'」，
  //   哪怕 node_modules 里的 d.ts 明明声明了）。加字段时改这里，别去改 node_modules。
  interface PutObjectParams {
    Bucket: string
    Region: string
    Key: string
    Body?: unknown
    ContentType?: string
    /**
     * 对象级预设 ACL。**故意只放开 'public-read' 这一个值**：
     * 不传 = 保持私有（其余所有调用方要的就是这个），而明确要公开的只有
     * `lib/cos.ts::uploadPublicObject`（运营公开图）。桶里还有商家私密素材，
     * 把整份 ACL 枚举放开，等于给「误把一个私密文件传成公开」留了口子。
     */
    ACL?: 'public-read'
    /** RFC 2616 缓存指令，作为对象元数据保存 */
    CacheControl?: string
  }
  interface PutObjectResult {
    headers?: Record<string, string>
    ETag?: string
  }
  type PutObjectCallback = (err: Error | null, data: PutObjectResult) => void

  interface HeadObjectParams {
    Bucket: string
    Region: string
    Key: string
  }
  interface HeadObjectResult {
    headers?: Record<string, string>
    // COS 的 HeadObject 在响应体里也直接给出这两个字段（SDK 会解析成驼峰）。
    // 上传完成确认要按它们核对「对象真实存在、真实大小」——只读 headers 在部分
    // 代理/版本下拿不到小写的 content-length，两个来源都留着更稳。
    ContentLength?: string | number
    ContentType?: string
    ETag?: string
  }

  // 列举桶内对象（存储孤儿对象 GC 用）。IsTruncated 在 COS 响应里是字符串 'true'/'false'，
  // 这里放宽成 string | boolean，避免调用方为了兼容再写一层判断。
  interface GetBucketParams {
    Bucket: string
    Region: string
    Prefix?: string
    Marker?: string
    MaxKeys?: number
    Delimiter?: string
  }
  interface BucketObjectItem {
    Key?: string
    Size?: string | number
    LastModified?: string
  }
  interface GetBucketResult {
    Name?: string
    Prefix?: string
    Contents?: BucketObjectItem[]
    IsTruncated?: string | boolean
    NextMarker?: string
  }
  type GetBucketCallback = (err: Error | null, data: GetBucketResult) => void

  // 删除单个对象（GC 用）
  interface DeleteObjectParams {
    Bucket: string
    Region: string
    Key: string
  }
  interface DeleteObjectResult {
    headers?: Record<string, string>
  }
  type DeleteObjectCallback = (err: Error | null, data?: DeleteObjectResult) => void

  // 列举**未完成的分片上传**（俗称「碎片」）。
  // 关键：碎片不属于对象，ListObjects(getBucket) **看不到**它们 ——
  // 只有 ListMultipartUploads(multipartList) 能看到。失败的上传会留下碎片并持续计费。
  interface MultipartListParams {
    Bucket: string
    Region: string
    Prefix?: string
    Delimiter?: string
    MaxUploads?: number
    KeyMarker?: string
    UploadIdMarker?: string
  }
  interface MultipartUploadItem {
    Key?: string
    UploadId?: string
    /** 该 UploadId 的创建时间，ISO8601 */
    Initiated?: string
  }
  interface MultipartListResult {
    Upload?: MultipartUploadItem[]
    IsTruncated?: string | boolean
    NextKeyMarker?: string
    NextUploadIdMarker?: string
  }
  type MultipartListCallback = (err: Error | null, data: MultipartListResult) => void

  // 中止一个未完成的分片上传（回收碎片占用的空间）
  interface MultipartAbortParams {
    Bucket: string
    Region: string
    Key: string
    UploadId: string
  }
  interface MultipartAbortResult {
    headers?: Record<string, string>
  }
  type MultipartAbortCallback = (err: Error | null, data?: MultipartAbortResult) => void

  export default class COS {
    constructor(config: { SecretId: string; SecretKey: string })
    getObjectUrl(params: GetObjectUrlParams, callback: GetObjectUrlCallback): void
    // 不传 callback 时 SDK 返回 Promise
    getObject(params: GetObjectParams, callback: GetObjectCallback): void
    getObject(params: GetObjectParams): Promise<GetObjectResult>
    putObject(params: PutObjectParams): Promise<PutObjectResult>
    putObject(params: PutObjectParams, callback: PutObjectCallback): void
    headObject(params: HeadObjectParams): Promise<HeadObjectResult>
    getBucket(params: GetBucketParams, callback: GetBucketCallback): void
    getBucket(params: GetBucketParams): Promise<GetBucketResult>
    deleteObject(params: DeleteObjectParams, callback: DeleteObjectCallback): void
    deleteObject(params: DeleteObjectParams): Promise<DeleteObjectResult>
    multipartList(params: MultipartListParams, callback: MultipartListCallback): void
    multipartList(params: MultipartListParams): Promise<MultipartListResult>
    multipartAbort(params: MultipartAbortParams, callback: MultipartAbortCallback): void
    multipartAbort(params: MultipartAbortParams): Promise<MultipartAbortResult>
  }
}
