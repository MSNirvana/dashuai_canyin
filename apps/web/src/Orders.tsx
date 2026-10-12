import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, ClipboardList, Coins, Crown, ReceiptText } from 'lucide-react'
import { api, ApiError, getPendingPayment } from './api'
import { EmptyState, ErrorBlock, formatDate, formatMoney, LoadingBlock, PageHeader } from './components'
import type { OrderPage } from './types'

const PAGE_SIZE = 8

export function Orders() {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [data, setData] = useState<OrderPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = useCallback(async () => { setLoading(true); setError(''); try { setData(await api<OrderPage>(`/orders?page=${page}&pageSize=${PAGE_SIZE}`)) } catch (e) { setError(e instanceof ApiError ? e.message : '网络连接异常') } finally { setLoading(false) } }, [page])
  useEffect(() => { void load() }, [load])
  const pending = getPendingPayment()

  return <section className="page-section"><div className="container"><PageHeader eyebrow="订单记录" title="我的订单" description="付款是否成功，看这里的状态。" />{pending && new Date(pending.expireAt).getTime() > Date.now() && <button className="continue-pay" onClick={() => navigate(`/pay/${pending.orderNo}`)}><span><ReceiptText />有一笔待支付订单</span><strong>继续支付</strong></button>}{loading ? <LoadingBlock /> : error ? <ErrorBlock message={error} retry={() => void load()} /> : !data?.list.length ? <EmptyState icon={<ClipboardList />} title="还没有订单" text="选择会员套餐后，订单记录会出现在这里。" action={<Link className="button small" to="/pricing">查看套餐</Link>} /> : <><div className="order-list">{data.list.map((order) => <article className="order-row" key={order.orderNo}><div className={order.orderType === 'MEMBER' ? 'order-kind member' : 'order-kind bean'}>{order.orderType === 'MEMBER' ? <Crown /> : <Coins />}</div><div className="order-main"><div><h3>{order.title || (order.orderType === 'MEMBER' ? '会员订阅' : '积分加油包')}</h3><span className={`status ${order.status.toLowerCase()}`}>{statusLabel(order.status)}</span></div><p>订单号 {order.orderNo}</p><small>创建时间 {formatDate(order.createdAt)}</small></div><div className="order-amount"><strong>{formatMoney(order.amountFen)}</strong>{order.status === 'PENDING' && pending?.orderNo === order.orderNo && <button onClick={() => navigate(`/pay/${order.orderNo}`)}>继续支付</button>}</div></article>)}</div><div className="pagination"><button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}><ChevronLeft />上一页</button><span>第 {data.page} 页 · 共 {data.total} 笔</span><button disabled={!data.hasMore} onClick={() => setPage((v) => v + 1)}>下一页<ChevronRight /></button></div></>}</div></section>
}

function statusLabel(status: string): string { return ({ PAID: '已支付', PENDING: '待支付', EXPIRED: '已过期', CANCELLED: '已取消', REFUNDED: '已退款' } as Record<string, string>)[status] || status }
