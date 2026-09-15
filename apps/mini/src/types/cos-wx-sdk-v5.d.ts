// cos-wx-sdk-v5 小程序 COS SDK 的最小类型声明（官方无 TS 类型）
//
// 修正记录：原先把 sliceUploadFile / uploadFile 的返回值标成 void，与 SDK 实际行为不符。
// 源码 node_modules/cos-wx-sdk-v5/src/task.js 中 `task.transferToTaskMethod(API_MAP, 'sliceUploadFile')`
// 把这两个接口改造成**任务式**调用：默认走 _addTask，返回 TaskId，并把 TaskId 通过
// params.onTaskReady 回调抛出来；取消/暂停接口挂在 COS 实例上（cos.cancelTask / cos.pauseTask）。
// 只有显式传 `SkipTask: true` 时才会退回「直接调用、无返回值」的老行为。
declare module 'cos-wx-sdk-v5' {
  /** 任务式上传时由 SDK 生成的字符串标识 */
  type TaskId = string

  interface UploadTaskParams {
    Bucket: string
    Region: string
    Key?: string
    FilePath?: string
    onProgress?: (info: { percent: number; loaded?: number; total?: number; speed?: number }) => void
    /** 任务入队后回调，用于拿到 TaskId 做取消 / 暂停 */
    onTaskReady?: (taskId: TaskId) => void
    /** 跳过 SDK 内部任务队列（传 true 时接口不再返回 TaskId） */
    SkipTask?: boolean
    [key: string]: unknown
  }

  class COS {
    constructor(options: {
      getAuthorization?: (opt: unknown, cb: (info: unknown) => void) => void
      [key: string]: unknown
    })
    /** 分片上传；默认任务式调用，返回 TaskId */
    sliceUploadFile(params: UploadTaskParams, cb: (err: unknown, data: unknown) => void): TaskId
    /** 简单上传；默认任务式调用，返回 TaskId */
    uploadFile(params: UploadTaskParams, cb: (err: unknown, data: unknown) => void): TaskId
    /** 取消任务（进行中或排队中） */
    cancelTask(taskId: TaskId): void
    /** 暂停任务（配合任务的续传能力使用） */
    pauseTask(taskId: TaskId): void
    /** 当前任务列表，可查 state / loaded / size / percent */
    getTaskList(): Array<{ id: TaskId; state: string; loaded: number; size: number; percent: number }>
  }
  export default COS
}
