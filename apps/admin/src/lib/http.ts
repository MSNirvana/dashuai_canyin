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
    const body = err.response?.data
    const msg = body?.message ?? err.message ?? '网络错误'
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
