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

  // 上传：Body 传 fs.ReadStream
  interface PutObjectParams {
    Bucket: string
    Region: string
    Key: string
    Body?: unknown
    ContentType?: string
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
  }

  export default class COS {
    constructor(config: { SecretId: string; SecretKey: string })
    getObjectUrl(params: GetObjectUrlParams, callback: GetObjectUrlCallback): void
    // 不传 callback 时 SDK 返回 Promise
    getObject(params: GetObjectParams, callback: GetObjectCallback): void
    getObject(params: GetObjectParams): Promise<GetObjectResult>
    putObject(params: PutObjectParams): Promise<PutObjectResult>
    putObject(params: PutObjectParams, callback: PutObjectCallback): void
    headObject(params: HeadObjectParams): Promise<HeadObjectResult>
  }
}
