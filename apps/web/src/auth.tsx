import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, clearSession, getSession, saveSession } from './api'
import type { LoginResult } from './types'

interface AuthContextValue {
  session: ReturnType<typeof getSession>
  login: (phone: string, code: string) => Promise<void>
  sendCode: (phone: string) => Promise<{ cooldownSec: number; demoLogin?: boolean }>
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

  const value = useMemo(() => ({ session, login, sendCode, logout }), [session, login, sendCode, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
