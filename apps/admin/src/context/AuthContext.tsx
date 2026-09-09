import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { auth } from '../lib/http'

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
