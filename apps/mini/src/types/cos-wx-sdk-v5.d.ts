// cos-wx-sdk-v5 小程序 COS SDK 的最小类型声明（官方无 TS 类型）
declare module 'cos-wx-sdk-v5' {
  class COS {
    constructor(options: {
      getAuthorization?: (opt: unknown, cb: (info: unknown) => void) => void
      [key: string]: unknown
    })
    sliceUploadFile(params: Record<string, unknown>, cb: (err: unknown, data: unknown) => void): void
    uploadFile(params: Record<string, unknown>, cb: (err: unknown, data: unknown) => void): void
  }
  export default COS
}
