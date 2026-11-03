import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, clearSession, getSession, saveSession } from './api'
import type { LoginResult } from './types'

interface AuthContextValue {
  session: ReturnType<typeof getSession>
  login: (phone: string, code: string) => Promise<void>
  sendCode: (phone: string) => Promise<{ cooldownSec: number; demoLogin?: boolean }>
  /** 取一枚只读的演示会话（免登录进工作台）。失败说明演示数据不可用，调用方应回落到登录页。 */
  startDemo: () => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(getSession)

  useEffect(() => {
    const sync = () => setSession(getSession())
    window.addEventListener('dashuai:session-changed', sync)
    return () => window.removeEventListener('dashuai:session-changed', sync)
  }, [])

  const login = useCallback(async (phone: string, code: string) => {
    const result = await api<LoginResult>('/auth/login', {
      method: 'POST',
      auth: false,
      body: { phone, code },
    })
    setSession(saveSession(result))
  }, [])

  const sendCode = useCallback((phone: string) =>
    api<{ cooldownSec: number; demoLogin?: boolean }>('/auth/sms/send', {
      method: 'POST',
      auth: false,
      body: { phone },
    }), [])

  const logout = useCallback(() => {
    clearSession()
    setSession(null)
  }, [])

  /**
   * 免登录的演示工作台。
   * ★ 服务端签的是 `scope='demo'` 的**只读** token（写操作 1007），所以这里不需要
   *   也不应该做「能力阉割」以外的任何事 —— 数据是真的，权限是假的。
   * ★ 失败不吞：演示号没配 / 白名单为空 / 限流，调用方要能回落到登录页。
   */
  const startDemo = useCallback(async () => {
    const result = await api<LoginResult>('/web/demo/session', { method: 'POST', auth: false })
    setSession(saveSession(result))
  }, [])

  const value = useMemo(
    () => ({ session, login, sendCode, startDemo, logout }),
    [session, login, sendCode, startDemo, logout],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
