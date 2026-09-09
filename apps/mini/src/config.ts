// 运行环境配置

declare const __API_BASE_URL__: string

export const PLATFORM = (process.env.TARO_ENV ?? 'weapp') as 'weapp' | 'tt' | 'h5'
export const IS_WEAPP = PLATFORM === 'weapp'
export const IS_DOUYIN = PLATFORM === 'tt'
export const IS_DEV = process.env.NODE_ENV === 'development'

/** 在 Taro 构建配置中注入，避免把 Node.js 的 process 对象带入小程序运行时。 */
export const BASE_URL = __API_BASE_URL__

/** 微信一键登录（getPhoneNumber）目前仅微信端可用；抖音端降级为手机号验证码 */
export const SUPPORT_WX_QUICK_LOGIN = IS_WEAPP

export const STORAGE_KEYS = {
  token: 'ds_token',
  refreshToken: 'ds_refresh_token',
  merchant: 'ds_merchant',
  currentStoreId: 'ds_current_store_id',
} as const
