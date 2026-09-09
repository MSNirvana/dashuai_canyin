import { useEffect, useState } from 'react'
import { Row, Col, Tag } from 'tdesign-react'
import { request } from '../lib/http'
import dayjs from 'dayjs'

interface Dashboard {
  merchants: { total: number; active: number; todayNew: number }
  stores: number
  creations: { total: number; today: number }
  renderTasks: { total: number; today: number; running: number; failed24h: number }
  finance: {
    todayRechargeFen: number
    todayMemberFen: number
    monthRechargeFen: number
    todayBeanConsumed: string
    todayAiCostFen: number
    marginFen: number
  }
  ai: { providers: number; enabledProviders: number; downProviders: number; todayCalls: number; todayFallbackPct: number }
}

const fen2yuan = (fen: number) => (fen / 100).toFixed(2)

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value}</div>
      {hint && <div className="stat-card__hint">{hint}</div>}
    </div>
  )
}

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    request<Dashboard>({ url: '/dashboard' })
      .then(setData)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div>加载中…</div>
  if (!data) return <div className="danger-text">暂无数据</div>

  return (
    <div>
      <div className="page-header"><h2>仪表盘 · {dayjs().format('YYYY-MM-DD')}</h2></div>

      <h3 style={{ marginTop: 0, marginBottom: 12 }}>商家与内容</h3>
      <Row gutter={16}>
        <Col span={6}><Stat label="商家总数" value={data.merchants.total} hint={`活跃 ${data.merchants.active} · 今日新增 ${data.merchants.todayNew}`} /></Col>
        <Col span={6}><Stat label="门店总数" value={data.stores} /></Col>
        <Col span={6}><Stat label="创作数" value={data.creations.total} hint={`今日 ${data.creations.today}`} /></Col>
        <Col span={6}><Stat label="合成任务" value={data.renderTasks.total} hint={`今日 ${data.renderTasks.today} · 进行中 ${data.renderTasks.running}`} /></Col>
      </Row>

      <h3 style={{ marginTop: 24, marginBottom: 12 }}>财务</h3>
      <Row gutter={16}>
        <Col span={6}><Stat label="今日实收（加油包）" value={`¥ ${fen2yuan(data.finance.todayRechargeFen)}`} hint={`本月 ¥ ${fen2yuan(data.finance.monthRechargeFen)}`} /></Col>
        <Col span={6}><Stat label="今日实收（订阅）" value={`¥ ${fen2yuan(data.finance.todayMemberFen)}`} /></Col>
        <Col span={6}><Stat label="今日 AI 真实成本" value={`¥ ${fen2yuan(data.finance.todayAiCostFen)}`} hint={`毛利 ¥ ${fen2yuan(data.finance.marginFen)}`} /></Col>
        <Col span={6}><Stat label="今日消耗积分" value={data.finance.todayBeanConsumed} /></Col>
      </Row>

      <h3 style={{ marginTop: 24, marginBottom: 12 }}>AI</h3>
      <Row gutter={16}>
        <Col span={6}><Stat label="AI 通道" value={data.ai.providers} hint={`启用 ${data.ai.enabledProviders}`} /></Col>
        <Col span={6}><Stat label="DOWN 通道" value={data.ai.downProviders} /></Col>
        <Col span={6}><Stat label="今日 AI 调用" value={data.ai.todayCalls} /></Col>
        <Col span={6}>
          <Stat
            label="今日备用通道占比"
            value={
              data.ai.todayFallbackPct >= 30 ? (
                <Tag theme="warning">{data.ai.todayFallbackPct}%</Tag>
              ) : (
                <span>{data.ai.todayFallbackPct}%</span>
              )
            }
            hint="> 30% 需关注"
          />
        </Col>
      </Row>

      {data.renderTasks.failed24h > 0 && (
        <div className="danger-text" style={{ marginTop: 24 }}>
          ⚠ 最近 24 小时失败合成任务 {data.renderTasks.failed24h} 条，请到「合成任务」排查
        </div>
      )}
    </div>
  )
}
