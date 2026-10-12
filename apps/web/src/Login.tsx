import { FormEvent, useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, LockKeyhole, MessageSquare, Phone } from 'lucide-react'
import { ApiError } from './api'
import { useAuth } from './auth'

/**
 * 登录页。
 *
 * ★ 文案按「30-50 岁门店经营者」写：左侧那栏只留一句话说清楚「登录能干什么」。
 *   改版前这里堆了 eyebrow + 两行标题 + 三行技术说明（「令牌仅保存在当前标签页会话」之类），
 *   对老板没有任何信息量 ⇒ 已删。
 * ★ 「我已阅读并同意」的勾选框**默认不勾**，这是合规前提，别改成默认勾上。
 */
export function Login() {
  const { session, login, sendCode } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (seconds <= 0) return
    const timer = window.setInterval(() => setSeconds((v) => v - 1), 1000)
    return () => window.clearInterval(timer)
  }, [seconds])

  if (session) return <Navigate to="/account" replace />

  const requestCode = async () => {
    setError(''); setNotice('')
    if (!/^1\d{10}$/.test(phone)) { setError('请输入正确的 11 位手机号'); return }
    setSending(true)
    try {
      const result = await sendCode(phone)
      setSeconds(Math.max(1, result.cooldownSec || 60))
      setNotice(result.demoLogin ? '演示账号无需接收短信，请输入已提供的登录码。' : '验证码已发送，请留意短信。')
    } catch (e) { setError(errorMessage(e)) } finally { setSending(false) }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    if (!/^1\d{10}$/.test(phone)) { setError('请输入正确的 11 位手机号'); return }
    if (!/^\d{6}$/.test(code)) { setError('请输入 6 位验证码'); return }
    if (!agreed) { setError('请先阅读并同意基础服务规则与隐私协议'); return }
    setSubmitting(true)
    try {
      await login(phone, code)
      const target = (location.state as { from?: string } | null)?.from || '/account'
      navigate(target, { replace: true })
    } catch (e) { setError(errorMessage(e)) } finally { setSubmitting(false) }
  }

  return (
    <section className="auth-page">
      <div className="container auth-grid">
        <div className="auth-copy">
          <h1>登录后就能用</h1>
          <p>手机号登录，和小程序是同一个账号。</p>
        </div>
        <div className="auth-card">
          <div className="auth-card-title">
            <div className="round-icon"><LockKeyhole /></div>
            <div>
              <h2>手机号登录</h2>
              <p>没有注册过，会自动创建账号</p>
            </div>
          </div>
          <form onSubmit={submit}>
            <label>
              手机号
              <div className="input-wrap">
                <Phone size={19} />
                <input
                  inputMode="numeric" autoComplete="tel" maxLength={11} value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} placeholder="请输入手机号"
                />
              </div>
            </label>
            <label>
              验证码
              <div className="code-row">
                <div className="input-wrap">
                  <MessageSquare size={19} />
                  <input
                    inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="6 位验证码"
                  />
                </div>
                <button
                  type="button" className="code-button" disabled={sending || seconds > 0}
                  onClick={requestCode}
                >
                  {seconds > 0 ? `${seconds}s 后重发` : sending ? '发送中' : '获取验证码'}
                </button>
              </div>
            </label>
            {notice && <div className="form-notice success">{notice}</div>}
            {error && <div className="form-notice error">{error}</div>}
            <label className="agreement">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>我已阅读并同意 <Link to="/rules" target="_blank">《基础服务规则》</Link>和 <Link to="/privacy" target="_blank">《隐私协议》</Link></span>
            </label>
            <button className="button submit-button" disabled={submitting}>
              {submitting ? '正在登录' : '登录'} <ArrowRight size={18} />
            </button>
          </form>
        </div>
      </div>
    </section>
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return '网络连接异常，请稍后重试'
}
