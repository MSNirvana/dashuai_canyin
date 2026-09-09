// 认证接口

import Taro from '@tarojs/taro'
import { http } from './request'
import { STORAGE_KEYS } from '../config'

export interface LoginResult {
  token: string
  refreshToken: string
  merchant: {
    id: string
    phone: string
    nickname: string | null
    avatarUrl: string | null
    isNew: boolean
  }
  member: { isMember: boolean; endAt: string | null }
  bean: { balance: string; grantBalance: string; available: string; frozen: string }
}

/** 微信一键登录：phoneCode 来自 getPhoneNumber，wxLoginCode 来自 wx.login */
export function wechatLogin(data: { phoneCode: string; wxLoginCode: string }) {
  return http.post<LoginResult>('/auth/wechat-login', data, { silent: true })
}

/** 发送短信验证码 */
export function sendSmsCode(phone: string) {
  return http.post<{ cooldownSec: number }>('/auth/sms/send', { phone, scene: 'LOGIN' }, { silent: true })
}

/** 手机号 + 验证码登录（兜底通道） */
export function loginByPhone(phone: string, code: string) {
  return http.post<LoginResult>('/auth/login', { phone, code }, { silent: true })
}

/** 是否开启开发登录旁路（本地联调用，生产默认 false） */
export function getDevMode() {
  return http.get<{ enabled: boolean }>('/auth/dev-mode', undefined, { silent: true })
}

/** 开发登录：直接按手机号创建/找回账号，不依赖真实微信/短信 */
export function devLogin(phone: string) {
  return http.post<LoginResult>('/auth/dev-login', { phone }, { silent: true })
}

/** 当前豆余额 */
export function getBeanAccount() {
  return http.get<{ balance: string; grantBalance: string; available: string }>('/bean/account', undefined, {
    silent: true,
  })
}

export function saveSession(res: LoginResult) {
  Taro.setStorageSync(STORAGE_KEYS.token, res.token)
  Taro.setStorageSync(STORAGE_KEYS.refreshToken, res.refreshToken)
  Taro.setStorageSync(STORAGE_KEYS.merchant, res.merchant)
}

export function clearSession() {
  Taro.removeStorageSync(STORAGE_KEYS.token)
  Taro.removeStorageSync(STORAGE_KEYS.refreshToken)
  Taro.removeStorageSync(STORAGE_KEYS.merchant)
  Taro.removeStorageSync(STORAGE_KEYS.currentStoreId)
}
