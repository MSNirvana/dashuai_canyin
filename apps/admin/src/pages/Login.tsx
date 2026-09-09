import { useState, type FormEvent } from 'react'
import { Input, Button } from 'tdesign-react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

interface LoginRes {
  token: string
  admin: { id: string; username: string; displayName: string | null }
}

export default function LoginPage() {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('admin123456')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const nav = useNavigate()
  const loc = useLocation()
  const { setSession } = useAuth()

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setErr(null)
    setLoading(true)
    try {
      const r = await fetch('/admin/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const body = (await r.json()) as { code: number; message?: string; data?: LoginRes }
      if (!r.ok || body.code !== 0 || !body.data) {
        setErr(body.message ?? '登录失败')
        return
      }
      setSession(body.data.token, {
        id: body.data.admin.id,
        username: body.data.admin.username,
      })
      const from = (loc.state as { from?: { pathname: string } } | null)?.from?.pathname
      nav(from && from !== '/login' ? from : '/dashboard', { replace: true })
    } catch (e) {
      setErr((e as Error).message ?? '网络错误')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-card__title">大帅餐饮 · 管理后台</div>
        <div className="login-card__form">
          <label className="login-card__field">
            <span>用户名</span>
            <Input
              value={username}
              onChange={(v) => setUsername(v as string)}
              placeholder="请输入管理员账号"
              autocomplete="username"
            />
          </label>
          <label className="login-card__field">
            <span>密码</span>
            <Input
              type="password"
              value={password}
              onChange={(v) => setPassword(v as string)}
              placeholder="请输入密码"
              autocomplete="current-password"
            />
          </label>
          {err && <div className="danger-text" style={{ marginBottom: 12 }}>{err}</div>}
          <Button theme="primary" type="submit" block loading={loading}>
            登 录
          </Button>
        </div>
        <div className="login-card__hint">
          默认账号 admin / admin123456（仅种子已写入时可用）
        </div>
      </form>
    </div>
  )
}
