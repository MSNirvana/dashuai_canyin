// 认证接口

import Taro from '@tarojs/taro'
import { http } from './request'
import { STORAGE_KEYS } from '../config'
import { bumpSessionGeneration } from '../utils/session'

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

/**
 * 发送短信验证码。
 *
 * ★ `demoLogin: true` 表示服务端**根本没有发短信** —— 这个手机号是演示账号、且后台给它配了
 *   固定登录验证码，请直接用那枚码登录。调用方**必须**据此换掉「验证码已发送」那句提示：
 *   否则用户会盯着一台永远不会响的手机等短信，而正确的做法（直接输码）就摆在眼前。
 *   ★ 服务端仍然返回 `cooldownSec`，所以倒计时照常走 —— 「点了完全没反应」比「假装发了」更像坏了。
 */
export function sendSmsCode(phone: string) {
  return http.post<{ cooldownSec: number; demoLogin?: boolean }>(
    '/auth/sms/send',
    { phone, scene: 'LOGIN' },
    { silent: true },
  )
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

/** 当前积分余额 */
export function getBeanAccount() {
  return http.get<{ balance: string; grantBalance: string; available: string }>('/bean/account', undefined, {
    silent: true,
  })
}

/**
 * 会话代次（session generation）在 utils/session.ts —— 故意做成零依赖的叶子模块，
 * 避免 request ⇄ auth 的循环依赖（细节见那个文件顶部的说明）。
 */
export function saveSession(res: LoginResult) {
  Taro.setStorageSync(STORAGE_KEYS.token, res.token)
  Taro.setStorageSync(STORAGE_KEYS.refreshToken, res.refreshToken)
  Taro.setStorageSync(STORAGE_KEYS.merchant, res.merchant)
  // 新会话开始：之前那次 refresh 的回包从此不再有资格写 storage
  bumpSessionGeneration()
}

export function clearSession() {
  Taro.removeStorageSync(STORAGE_KEYS.token)
  Taro.removeStorageSync(STORAGE_KEYS.refreshToken)
  Taro.removeStorageSync(STORAGE_KEYS.merchant)
  Taro.removeStorageSync(STORAGE_KEYS.currentStoreId)
  bumpSessionGeneration()
}
