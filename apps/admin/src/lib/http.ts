import axios, { AxiosError, type AxiosResponse } from 'axios'
import { message } from 'tdesign-react'

export interface ApiError {
  code: number
  message: string
  traceId?: string
}

export interface ApiEnvelope<T = unknown> {
  code: number
  message: string
  data?: T
  traceId: string
}

const TOKEN_KEY = 'admin_token'
const ADMIN_KEY = 'admin_user'

export const http = axios.create({
  baseURL: '/admin/api/v1',
  timeout: 30_000,
})

http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

http.interceptors.response.use(
  (res: AxiosResponse<ApiEnvelope>) => {
    const body = res.data
    if (body?.code === 0) return res
    if (body?.code === 4001) {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(ADMIN_KEY)
      if (!location.pathname.endsWith('/login')) {
        location.href = '/login'
      }
      throw new ApiErrorProxy(body.code, body.message, body.traceId)
    }
    message.error(body?.message ?? '请求失败', 2000)
    throw new ApiErrorProxy(body?.code ?? -1, body?.message ?? '请求失败', body?.traceId)
  },
  (err: AxiosError<ApiEnvelope>) => {
    const status = err.response?.status
    const body = err.response?.data
    const msg = body?.message ?? err.message ?? '网络错误'
    // 登录态失效统一收口：服务端 adminAuth 失效时返回 HTTP 401 + code 1001（登录接口失败是 4001）。
    // 这里必须清会话并回登录页 —— 只弹 toast 不跳转的话，页面会带着一个失效 token 继续渲染，
    // 所有请求持续失败且刷新无效，表现就是「后台打不开」。
    if (status === 401 || body?.code === 1001 || body?.code === 4001) {
      auth.clear()
      const onLogin = location.pathname.endsWith('/login')
      // 登录页本身要显示真实原因（如「用户名或密码错误」），不要覆盖成「登录已过期」
      message.error(onLogin ? msg : '登录已过期，请重新登录', 2000)
      if (!onLogin) location.href = '/login'
      throw new ApiErrorProxy(body?.code ?? 1001, msg, body?.traceId)
    }
    message.error(msg, 2000)
    throw new ApiErrorProxy(body?.code ?? -1, msg, body?.traceId)
  },
)

export class ApiErrorProxy extends Error {
  code: number
  traceId?: string
  constructor(code: number, message: string, traceId?: string) {
    super(message)
    this.code = code
    this.traceId = traceId
  }
}

/** 拆包：data 字段直接返回；带类型提示 */
export async function request<T>(config: Parameters<typeof http.request>[0]): Promise<T> {
  const res = await http.request<ApiEnvelope<T>>(config)
  return (res.data as ApiEnvelope<T>).data as T
}

export const auth = {
  token: () => localStorage.getItem(TOKEN_KEY),
  admin: () => {
    const raw = localStorage.getItem(ADMIN_KEY)
    return raw ? (JSON.parse(raw) as { id: string; username: string }) : null
  },
  setSession(token: string, admin: { id: string; username: string }) {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(ADMIN_KEY, JSON.stringify(admin))
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(ADMIN_KEY)
  },
}
