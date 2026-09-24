// 运行环境配置

declare const __API_BASE_URL__: string

// ★ 平台判断只许出现在 src/platform/**（约定见 docs/12-多端架构约定.md 红线 1）。
//   PLATFORM 保留在这里，但**只用于请求头 X-Platform**（services/request.ts、
//   services/profile.ts、services/upload.ts），它不是分支判断。
//
//   原来这里还有三个常量：IS_WEAPP / IS_DOUYIN / SUPPORT_WX_QUICK_LOGIN。
//   它们**全仓零调用点**，是「看着像已经适配过」的误导源（排查时白跑一趟），已删除。
//   端能力现在由 platform.capabilities 提供（src/platform/），页面据此隐藏入口。
export const PLATFORM = (process.env.TARO_ENV ?? 'weapp') as 'weapp' | 'tt' | 'h5'
export const IS_DEV = process.env.NODE_ENV === 'development'

/** 在 Taro 构建配置中注入，避免把 Node.js 的 process 对象带入小程序运行时。 */
export const BASE_URL = __API_BASE_URL__

export const STORAGE_KEYS = {
  token: 'ds_token',
  refreshToken: 'ds_refresh_token',
  merchant: 'ds_merchant',
  currentStoreId: 'ds_current_store_id',
} as const
