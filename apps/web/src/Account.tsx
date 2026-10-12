import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, CalendarDays, Coins, Crown, Database, Fuel, UserRound } from 'lucide-react'
import { api, ApiError } from './api'
import { useAuth } from './auth'
import { ErrorBlock, formatDate, formatNumber, LoadingBlock, maskPhone, PageHeader } from './components'
import type { AccountInfo } from './types'

export function Account() {
  const { session } = useAuth()
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = useCallback(async () => { setLoading(true); setError(''); try { setInfo(await api<AccountInfo>('/orders/me')) } catch (e) { setError(e instanceof ApiError ? e.message : '网络连接异常') } finally { setLoading(false) } }, [])
  useEffect(() => { void load() }, [load])

  return <section className="page-section"><div className="container"><PageHeader eyebrow="账户中心" title="你好，欢迎回来" description="会员状态、积分余额和存储用量。" />{loading ? <LoadingBlock /> : error ? <ErrorBlock message={error} retry={() => void load()} /> : info && <><div className="account-hero"><div className="profile-block"><div className="profile-avatar"><UserRound /></div><div><span>当前账户</span><h2>{session?.merchant.nickname || maskPhone(session?.merchant.phone || '')}</h2><p>{session?.merchant.nickname ? maskPhone(session?.merchant.phone || '') : '手机号账户'}</p></div></div><div className={info.subscription.active ? 'member-badge active' : 'member-badge'}><Crown /><div><span>{info.subscription.active ? '有效会员' : '尚未开通会员'}</span><strong>{info.subscription.planName || '普通账户'}</strong></div></div></div><div className="stat-grid"><article className="stat-card"><div className="stat-icon"><Coins /></div><span>可用积分</span><strong>{formatNumber(info.balance.available)}</strong><small>余额与赠送积分合计</small></article><article className="stat-card"><div className="stat-icon"><CalendarDays /></div><span>会员有效期</span><strong className="date-value">{info.subscription.active ? formatDate(info.subscription.endAt) : '未开通'}</strong><small>{info.subscription.active ? `本期赠送 ${formatNumber(info.subscription.grantPoints)} 积分` : '开通后可购买积分加油包'}</small></article><article className="stat-card"><div className="stat-icon"><Database /></div><span>存储空间</span><strong>{formatBytes(info.storage.usedBytes)}</strong><small>总额度 {formatBytes(info.storage.quotaBytes)}</small></article></div><div className="account-actions"><Link to="/pricing"><Crown /><div><strong>{info.subscription.active ? '续订会员' : '开通会员'}</strong><span>查看当前可售方案</span></div><ArrowRight /></Link><Link to="/pricing"><Fuel /><div><strong>积分加油包</strong><span>{info.subscription.active ? '为账户补充积分' : '开通会员后可购买'}</span></div><ArrowRight /></Link><Link to="/orders"><Coins /><div><strong>我的订单</strong><span>查看支付状态与历史记录</span></div><ArrowRight /></Link></div></>}</div></section>
}

function formatBytes(value: string): string { const bytes = Number(value); if (!Number.isFinite(bytes)) return '—'; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB` }
