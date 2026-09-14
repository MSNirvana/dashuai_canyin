import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { auth, request } from '../lib/http'

export interface AdminUser {
  id: string
  username: string
}

interface AuthCtx {
  token: string | null
  admin: AdminUser | null
  setSession: (token: string, admin: AdminUser) => void
  logout: () => void
}

const Ctx = createContext<AuthCtx>({
  token: null,
  admin: null,
  setSession: () => undefined,
  logout: () => undefined,
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(auth.token())
  const [admin, setAdmin] = useState<AdminUser | null>(auth.admin())

  useEffect(() => {
    const onStorage = () => {
      setToken(auth.token())
      setAdmin(auth.admin())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // 启动时校验一次会话：localStorage 里的 token 可能早已过期，而 RequireAuth 只看「有没有这个字符串」，
  // 不校验就会带着失效 token 渲染出一个请求全失败的「空页面」。401 由 http 拦截器统一清会话 + 跳登录页。
  useEffect(() => {
    if (!auth.token()) return
    void request({ url: '/auth/me', method: 'GET' }).catch(() => undefined)
  }, [])

  const ctx: AuthCtx = {
    token,
    admin,
    setSession: (t, a) => {
      auth.setSession(t, a)
      setToken(t)
      setAdmin(a)
    },
    logout: () => {
      auth.clear()
      setToken(null)
      setAdmin(null)
    },
  }
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>
}

export function useAuth() {
  return useContext(Ctx)
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { token } = useAuth()
  const loc = useLocation()
  if (!token) return <Navigate to="/login" state={{ from: loc }} replace />
  return <>{children}</>
}
