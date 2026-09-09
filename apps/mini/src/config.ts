// 运行环境配置

export const PLATFORM = (process.env.TARO_ENV ?? 'weapp') as 'weapp' | 'tt' | 'h5'
export const IS_WEAPP = PLATFORM === 'weapp'
export const IS_DOUYIN = PLATFORM === 'tt'
export const IS_DEV = process.env.NODE_ENV === 'development'

/** 后端地址：未配置时仅连接本地；生产部署必须显式注入已备案的 HTTPS 域名。 */
const configuredBaseUrl = process.env.TARO_APP_API_BASE_URL?.trim()
export const BASE_URL = configuredBaseUrl || (IS_DEV
  ? 'http://localhost:3000/api/v1'
  : 'https://REPLACE_ME.example.com/api/v1')

/** 微信一键登录（getPhoneNumber）目前仅微信端可用；抖音端降级为手机号验证码 */
export const SUPPORT_WX_QUICK_LOGIN = IS_WEAPP

export const STORAGE_KEYS = {
  token: 'ds_token',
  refreshToken: 'ds_refresh_token',
  merchant: 'ds_merchant',
  currentStoreId: 'ds_current_store_id',
} as const
