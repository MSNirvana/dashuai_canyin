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
      <aside className="login-side" aria-label="后台介绍">
        <div className="login-side__brand"><img className="login-side__logo" src="/logo-transparent.png" alt="大帅餐饮" /><span>大帅餐饮</span></div>
        <div className="login-side__copy">
          <span className="login-side__eyebrow">OPERATIONS CONSOLE</span>
          <h1>把门店内容，<br />做成能用的视频。</h1>
          <p>从商家资料、口播文案到成片交付，统一在一个后台处理。</p>
        </div>
        <div className="login-side__footer">内容运营工作台 · 内部使用</div>
      </aside>
      <form className="login-card" onSubmit={submit}>
        <div className="login-card__brand"><img className="login-card__logo" src="/logo-transparent.png" alt="大帅餐饮" /><span>大帅餐饮</span></div>
        <div className="login-card__title">登录管理后台</div>
        <p className="login-card__subtitle">使用管理员账号继续</p>
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
      </form>
    </div>
  )
}
