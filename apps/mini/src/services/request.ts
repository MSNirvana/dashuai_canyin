// 统一请求封装：鉴权 / 平台标识 / 401 自动续期 / 错误归一化

import Taro from '@tarojs/taro'
import { BASE_URL, PLATFORM, STORAGE_KEYS } from '../config'

export interface ApiError {
  code: number
  message: string
  traceId?: string
}

export const ERROR_TEXT: Record<number, string> = {
  1001: '登录已过期，请重新登录',
  1002: '验证码错误或已过期',
  1003: '发送过于频繁，请稍后再试',
  2001: '积分不足',
  2003: '门店数量已达上限',
  2005: '需要订阅后才能使用该功能',
  2007: '请求参数与此前提交不一致，请更换 requestId',
  3001: '文件超出大小限制',
  3002: '素材不存在或未就绪',
  3006: '档位不存在或未启用',
  3007: '账号未绑定微信，无法支付',
  4001: '已有合成任务进行中',
  4002: '合成失败，请重试',
  4003: '请先为分镜上传素材',
  4008: '上传空间不足',
  4047: '合成任务不存在',
  5001: 'AI 服务繁忙，请稍后再试',
}

let refreshing: Promise<string | null> | null = null

async function doRefresh(): Promise<string | null> {
  const refreshToken = Taro.getStorageSync<string>(STORAGE_KEYS.refreshToken)
  if (!refreshToken) return null
  try {
    const res = await Taro.request({
      url: `${BASE_URL}/auth/refresh`,
      method: 'POST',
      data: { refreshToken },
    })
    const body = res.data as { code: number; data?: { token: string; refreshToken: string } }
    if (body?.code === 0 && body.data?.token) {
      Taro.setStorageSync(STORAGE_KEYS.token, body.data.token)
      Taro.setStorageSync(STORAGE_KEYS.refreshToken, body.data.refreshToken)
      return body.data.token
    }
  } catch {
    /* ignore */
  }
  return null
}

function clearLoginState() {
  Taro.removeStorageSync(STORAGE_KEYS.token)
  Taro.removeStorageSync(STORAGE_KEYS.refreshToken)
  Taro.removeStorageSync(STORAGE_KEYS.merchant)
}

function redirectToLogin() {
  const pages = Taro.getCurrentPages()
  const current = pages[pages.length - 1]?.route ?? ''
  Taro.eventCenter.trigger('auth:required')
  if (!current.includes('pages/mine')) {
    Taro.switchTab({ url: '/pages/mine/index' })
  }
}

function guideSubscription() {
  const pages = Taro.getCurrentPages()
  const current = pages[pages.length - 1]
  const route = current?.route ?? ''
  const options = (current as { options?: Record<string, string> } | undefined)?.options ?? {}
  const query = Object.keys(options)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(options[key] ?? '')}`)
    .join('&')
  const redirect = `/${route}${query ? `?${query}` : ''}`
  Taro.showModal({
    title: '需要订阅',
    content: '订阅后才能使用生成能力，前往订阅与积分页面？',
    confirmText: '去订阅',
    cancelText: '稍后再说',
  }).then((result) => {
    if (result.confirm) {
      Taro.navigateTo({ url: `/pages/recharge/index?redirect=${encodeURIComponent(redirect)}` })
    }
  })
}

interface RequestOptions<T> {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  data?: unknown
  header?: Record<string, string>
  /** 401 时是否自动续期后重试，默认 true */
  autoRefresh?: boolean
  silent?: boolean
  timeout?: number
}

export async function request<T>(options: RequestOptions<T>): Promise<T> {
  const { url, method = 'GET', data, header = {}, autoRefresh = true, silent = false, timeout = 30000 } = options

  const send = async (token?: string | null) => {
    const storeId = Taro.getStorageSync<string>(STORAGE_KEYS.currentStoreId)
    const res = await Taro.request({
      url: `${BASE_URL}${url}`,
      method,
      data: data as never,
      timeout,
      header: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-Platform': PLATFORM,
        ...(storeId ? { 'X-Store-Id': storeId } : {}),
        ...header,
      },
    })
    return res
  }

  let token = Taro.getStorageSync<string>(STORAGE_KEYS.token)
  let res = await send(token)
  let body = res.data as { code: number; message?: string; data?: T; traceId?: string }

  if (body?.code === 1001 && autoRefresh) {
    if (!refreshing) refreshing = doRefresh().finally(() => (refreshing = null))
    const newToken = await refreshing
    if (newToken) {
      res = await send(newToken)
      body = res.data as typeof body
    } else {
      clearLoginState()
      redirectToLogin()
    }
  }

  if (body?.code === 0) return body.data as T

  const err: ApiError = {
    code: body?.code ?? -1,
    message: body?.message ?? ERROR_TEXT[body?.code ?? -1] ?? '请求失败',
    traceId: body?.traceId,
  }
  if (!silent) {
    if (err.code === 2005) guideSubscription()
    else Taro.showToast({ title: err.message, icon: 'none', duration: 2000 })
  }
  throw err
}

export const http = {
  get: <T>(url: string, data?: unknown, opt?: Partial<RequestOptions<T>>) =>
    request<T>({ url, method: 'GET', data, ...opt }),
  post: <T>(url: string, data?: unknown, opt?: Partial<RequestOptions<T>>) =>
    request<T>({ url, method: 'POST', data, ...opt }),
  put: <T>(url: string, data?: unknown, opt?: Partial<RequestOptions<T>>) =>
    request<T>({ url, method: 'PUT', data, ...opt }),
  del: <T>(url: string, data?: unknown, opt?: Partial<RequestOptions<T>>) =>
    request<T>({ url, method: 'DELETE', data, ...opt }),
}
