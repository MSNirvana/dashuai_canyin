import type { LoginResult, PendingPayment } from './types'

// ★ 导出给需要**不经过 JSON 封装**的调用方（目前只有 multipart 上传）：
//   它们要自己拼 URL 与 header，若各自写死一份 '/api/v1'，一旦改了
//   VITE_API_BASE_URL 就会出现「普通接口走新地址、上传还在老地址」的分叉。
export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || '/api/v1'
const SESSION_KEY = 'dashuai-web-session'
const PENDING_KEY = 'dashuai-web-pending-payment'

type Envelope<T> = { code: number; message: string; data?: T; traceId?: string }

type StoredSession = LoginResult & { sessionId: string }

export class ApiError extends Error {
  constructor(
    message: string,
    public code: number,
    public status: number,
    public traceId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function readJson<T>(key: string): T | null {
  try {
    const value = sessionStorage.getItem(key)
    return value ? (JSON.parse(value) as T) : null
  } catch {
    sessionStorage.removeItem(key)
    return null
  }
}

export function getSession(): StoredSession | null {
  return readJson<StoredSession>(SESSION_KEY)
}

export function saveSession(result: LoginResult): StoredSession {
  const previous = getSession()
  const sessionId = previous?.merchant.id === result.merchant.id ? previous.sessionId : crypto.randomUUID()
  const stored = { ...result, sessionId }
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(stored))
  if (previous && previous.merchant.id !== result.merchant.id) clearPendingPayment()
  return stored
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY)
  clearPendingPayment()
}

export function getPendingPayment(): PendingPayment | null {
  const pending = readJson<PendingPayment>(PENDING_KEY)
  const current = getSession()
  if (!pending || !current || pending.merchantId !== current.merchant.id) {
    if (pending) sessionStorage.removeItem(PENDING_KEY)
    return null
  }
  return pending
}

export function savePendingPayment(payment: PendingPayment): void {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(payment))
}

export function clearPendingPayment(): void {
  sessionStorage.removeItem(PENDING_KEY)
}

let refreshFlight: Promise<StoredSession> | null = null

async function parseEnvelope<T>(response: Response): Promise<T> {
  let payload: Envelope<T>
  try {
    payload = (await response.json()) as Envelope<T>
  } catch {
    throw new ApiError('服务响应异常，请稍后重试', -1, response.status)
  }
  if (!response.ok || payload.code !== 0 || payload.data === undefined) {
    throw new ApiError(payload.message || '请求失败', payload.code, response.status, payload.traceId)
  }
  return payload.data
}

async function refreshSession(expected: StoredSession): Promise<StoredSession> {
  if (!refreshFlight) {
    refreshFlight = (async () => {
      const latest = getSession()
      if (!latest || latest.sessionId !== expected.sessionId || latest.refreshToken !== expected.refreshToken) {
        throw new ApiError('登录状态已变化，请重试', 1001, 401)
      }
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: expected.refreshToken }),
      })
      const result = await parseEnvelope<LoginResult>(response)
      const current = getSession()
      if (!current || current.sessionId !== expected.sessionId || current.merchant.id !== result.merchant.id) {
        throw new ApiError('登录账号已切换，请重试', 1001, 401)
      }
      return saveSession(result)
    })().catch((error) => {
      const current = getSession()
      if (current?.sessionId === expected.sessionId) clearSession()
      window.dispatchEvent(new Event('dashuai:session-changed'))
      throw error
    }).finally(() => {
      refreshFlight = null
    })
  }
  return refreshFlight
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  auth?: boolean
  retry?: boolean
}

/**
 * 演示会话的「续期」。
 *
 * ★ 服务端**刻意不给演示 token 发 refreshToken**（`signRefresh` 不接受 scope），
 *   2 小时自然失效 —— 这样没人能靠刷新把演示态永久续下去。
 * ★ 但访客不该在两小时后看到「登录已过期」：那时再取一枚新的演示 token 就是。
 *   单 IP 每小时 40 次的门槛（服务端 `/web/demo/session`），一次 2 小时才用掉 1 次。
 * ★ 必须**去重**：一个页面可能同时打三四个接口，全都 401 ⇒ 没有这一层就会请求三四个 token。
 */
let demoFlight: Promise<StoredSession> | null = null

function renewDemoSession(): Promise<StoredSession> {
  if (!demoFlight) {
    demoFlight = api<LoginResult>('/web/demo/session', { method: 'POST', auth: false, retry: false })
      .then((result) => saveSession(result))
      .finally(() => {
        demoFlight = null
      })
  }
  return demoFlight
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = getSession()
  const headers = new Headers(options.headers)
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  if (options.auth !== false && session) headers.set('Authorization', `Bearer ${session.token}`)

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  // ★ 演示会话（`demo`）没有 refreshToken：拿空串去换 /auth/refresh 一定会 1001，
  //   而那条失败路径会 clearSession 把人踢回登录页 —— 演示访客不该被这么对待。
  //   所以演示态走自己那条：重新取一枚演示 token 再重试一次（不碰 clearSession）。
  if (response.status === 401 && options.auth !== false && options.retry !== false && session) {
    if (session.demo) {
      try {
        const renewed = await renewDemoSession()
        return api<T>(path, {
          ...options,
          retry: false,
          headers: { ...Object.fromEntries(headers.entries()), Authorization: `Bearer ${renewed.token}` },
        })
      } catch {
        // 拿不到新会话（被限流 / 演示数据不可用）就按原来的 401 抛出去，别把错误换成另一个。
      }
    } else if (session.refreshToken) {
      const renewed = await refreshSession(session)
      return api<T>(path, {
        ...options,
        retry: false,
        headers: { ...Object.fromEntries(headers.entries()), Authorization: `Bearer ${renewed.token}` },
      })
    }
  }
  return parseEnvelope<T>(response)
}

export function safeH5Url(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.hostname !== 'wx.tenpay.com') return null
    if (!url.searchParams.has('redirect_url')) {
      url.searchParams.set('redirect_url', `${window.location.origin}/pay/return`)
    }
    return url.toString()
  } catch {
    return null
  }
}

export function isWechatBrowser(): boolean {
  return /MicroMessenger/i.test(navigator.userAgent)
}
