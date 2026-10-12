import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { AlertTriangle, CheckCircle2, Clock3, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import { api, ApiError, clearPendingPayment, getPendingPayment, isWechatBrowser, safeH5Url, savePendingPayment } from './api'
import { formatDate, formatMoney } from './components'
import { useAuth } from './auth'
import type { OrderItem, PayOrder } from './types'

const POLL_DELAYS = [2000, 3000, 5000, 8000, 13000, 20000]

export function Pay() {
  const { orderNo = '' } = useParams()
  const { session } = useAuth()
  const navigate = useNavigate()
  const [pending, setPending] = useState(() => getPendingPayment())
  const [order, setOrder] = useState<OrderItem | null>(null)
  const [qr, setQr] = useState('')
  const [checking, setChecking] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const pollIndex = useRef(0)

  const readOrder = useCallback(async (activeQuery: boolean) => {
    const path = `/orders/${encodeURIComponent(orderNo)}${activeQuery ? '/query' : ''}`
    return api<OrderItem>(path, { method: activeQuery ? 'POST' : 'GET' })
  }, [orderNo])

  const applyOrder = useCallback((next: OrderItem) => {
    setOrder(next)
    if (next.status === 'PAID') clearPendingPayment()
  }, [])

  useEffect(() => {
    if (!orderNo) return
    let cancelled = false
    readOrder(false).then((result) => { if (!cancelled) applyOrder(result) }).catch((e) => { if (!cancelled) setError(messageOf(e)) })
    return () => { cancelled = true }
  }, [orderNo, readOrder, applyOrder])

  useEffect(() => {
    if (!pending?.codeUrl || pending.orderNo !== orderNo) { setQr(''); return }
    QRCode.toDataURL(pending.codeUrl, { width: 260, margin: 1, color: { dark: '#2b211c', light: '#ffffff' } }).then(setQr).catch(() => setError('支付二维码生成失败，请刷新后重试'))
  }, [pending, orderNo])

  useEffect(() => {
    if (!pending || pending.orderNo !== orderNo || order?.status === 'PAID' || ['EXPIRED', 'CANCELLED'].includes(order?.status || '')) return
    let cancelled = false
    pollIndex.current = 0
    let timer = 0
    const schedule = () => {
      if (cancelled || pollIndex.current >= POLL_DELAYS.length) return
      const delay = POLL_DELAYS[pollIndex.current++]
      timer = window.setTimeout(async () => {
        if (cancelled) return
        try {
          const result = await readOrder(true)
          applyOrder(result)
          if (['PAID', 'EXPIRED', 'CANCELLED'].includes(result.status)) return
        } catch { /* 自动轮询失败不覆盖支付指引 */ }
        schedule()
      }, delay)
    }
    schedule()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [pending, orderNo, order?.status, readOrder, applyOrder])

  const manuallyCheck = async () => {
    setChecking(true); setError('')
    try { applyOrder(await readOrder(true)) } catch (e) { setError(messageOf(e)) } finally { setChecking(false) }
  }

  const preparePayment = async () => {
    if (!pending || !session) return
    setPreparing(true); setError('')
    try {
      const result = await api<PayOrder>(`/web/orders/${encodeURIComponent(orderNo)}/pay`, { method: 'POST', body: { scene: pending.scene } })
      const next = { ...pending, ...result }
      savePendingPayment(next); setPending(next); pollIndex.current = 0
    } catch (e) { setError(messageOf(e)) } finally { setPreparing(false) }
  }

  if (order?.status === 'PAID') return <ResultState success title="支付已确认" text="服务端已确认订单支付成功，相关权益将按订单规则发放。" action={<button className="button" onClick={() => navigate('/account')}>查看账户</button>} />
  if (order && ['EXPIRED', 'CANCELLED'].includes(order.status)) return <ResultState title={order.status === 'EXPIRED' ? '订单已过期' : '订单已取消'} text="该订单已无法继续支付，请返回套餐页重新选择。" action={<Link className="button" to="/pricing">返回套餐页</Link>} />

  const h5Url = pending?.h5Url ? safeH5Url(pending.h5Url) : null
  const usablePending = pending?.orderNo === orderNo

  return <section className="pay-page"><div className="container"><div className="pay-card"><div className="pay-head"><span className="eyebrow">收银台</span><h1>{usablePending ? pending.title : '订单支付'}</h1><p>订单号 {orderNo}</p></div><div className="pay-amount"><span>应付金额</span><strong>{formatMoney(order?.amountFen ?? pending?.amountFen ?? 0)}</strong><small><Clock3 />请在 {formatDate(pending?.expireAt ?? order?.expireAt)} 前完成支付</small></div>{usablePending ? <div className="pay-method">{pending.scene === 'NATIVE' ? <>{qr ? <img className="qr-code" src={qr} alt="微信支付二维码" /> : <div className="qr-loading"><LoaderCircle />正在生成二维码</div>}<h2>使用微信扫码支付</h2><p>{isWechatBrowser() ? '当前在微信内，可长按上方二维码选择「识别二维码」完成支付。' : '请打开微信扫一扫，完成后返回本页确认结果。'}</p></> : <>{isWechatBrowser() && <div className="wechat-warning"><AlertTriangle /><span>微信内暂不支持本次 H5 支付，请点击右上角菜单，选择在浏览器中打开。</span></div>}{h5Url ? <a className="button h5-button" href={h5Url}>前往微信支付 <ExternalLink size={18} /></a> : <div className="form-notice error">支付链接不符合安全要求，请重新获取。</div>}<p>支付完成后请返回本页确认订单状态。</p></>}</div> : <div className="missing-payment"><AlertTriangle /><h2>未找到当前会话的支付信息</h2><p>为避免不同账号间复用支付信息，请从套餐页重新进入；若这是当前账号的待支付订单，可尝试重新获取支付方式。</p></div>}{error && <div className="form-notice error">{error}</div>}<div className="pay-actions">{usablePending && <button className="button" onClick={() => void manuallyCheck()} disabled={checking}>{checking ? '正在向服务端确认' : '我已完成支付'} <RefreshCw size={17} /></button>}{usablePending && <button className="button secondary" onClick={() => void preparePayment()} disabled={preparing}>{preparing ? '正在获取' : '重新获取支付方式'}</button>}<Link className="text-button" to="/orders">返回订单列表</Link></div><div className="pay-security"><ShieldCheck /><span>页面不会根据跳转结果直接判定成功，只有服务端订单状态为 PAID 才会展示支付成功。</span></div></div></div></section>
}

function ResultState({ success = false, title, text, action }: { success?: boolean; title: string; text: string; action: React.ReactNode }) { return <section className="result-page"><div className="result-card">{success ? <CheckCircle2 className="success-icon" /> : <AlertTriangle className="warning-icon" />}<h1>{title}</h1><p>{text}</p>{action}</div></section> }
function messageOf(error: unknown): string { return error instanceof ApiError ? error.message : '网络连接异常，请稍后重试' }
