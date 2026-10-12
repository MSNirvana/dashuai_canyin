import type { LoginResult, PendingPayment } from './types'

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || '/api/v1'
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

  if (response.status === 401 && options.auth !== false && options.retry !== false && session) {
    const renewed = await refreshSession(session)
    return api<T>(path, {
      ...options,
      retry: false,
      headers: { ...Object.fromEntries(headers.entries()), Authorization: `Bearer ${renewed.token}` },
    })
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
