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

/**
 * ★ `silent`：失败的请求**不弹 toast**，只把错误抛给调用方。
 *
 * 为什么需要它：http 拦截器默认「任何非 0 的响应都 message.error」，这对用户主动触发的
 * 操作是对的（点了「保存」必须有回音）。但后台有**常驻轮询**（顶栏未处理告警数，每 60s 一次），
 * 后端一旦不可用，运营就会每分钟被弹一次「请求失败」—— 最后的结果是把这个提示通道整个关掉，
 * 连真正的报错也看不见了。轮询失败应当**静默保留上一次的数字**。
 *
 * ⚠ 只抑制「提示」，不抑制「副作用」：401 / 登录过期仍然照常清会话并跳登录页，
 *   否则后台会带着一个失效 token 一直渲染、每个请求都失败（就是那个「后台打不开」的老 bug）。
 */
declare module 'axios' {
  export interface AxiosRequestConfig {
    silent?: boolean
  }
}

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
    const silent = res.config?.silent === true
    if (body?.code === 4001) {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(ADMIN_KEY)
      if (!location.pathname.endsWith('/login')) {
        location.href = '/login'
      }
      throw new ApiErrorProxy(body.code, body.message, body.traceId)
    }
    if (!silent) message.error(body?.message ?? '请求失败', 2000)
    throw new ApiErrorProxy(body?.code ?? -1, body?.message ?? '请求失败', body?.traceId)
  },
  (err: AxiosError<ApiEnvelope>) => {
    const status = err.response?.status
    const body = err.response?.data
    const msg = body?.message ?? err.message ?? '网络错误'
    const silent = err.config?.silent === true
    // 登录态失效统一收口：服务端 adminAuth 失效时返回 HTTP 401 + code 1001（登录接口失败是 4001）。
    // 这里必须清会话并回登录页 —— 只弹 toast 不跳转的话，页面会带着一个失效 token 继续渲染，
    // 所有请求持续失败且刷新无效，表现就是「后台打不开」。
    if (status === 401 || body?.code === 1001 || body?.code === 4001) {
      auth.clear()
      const onLogin = location.pathname.endsWith('/login')
      // 登录页本身要显示真实原因（如「用户名或密码错误」），不要覆盖成「登录已过期」
      if (!silent) message.error(onLogin ? msg : '登录已过期，请重新登录', 2000)
      if (!onLogin) location.href = '/login'
      throw new ApiErrorProxy(body?.code ?? 1001, msg, body?.traceId)
    }
    if (!silent) message.error(msg, 2000)
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
