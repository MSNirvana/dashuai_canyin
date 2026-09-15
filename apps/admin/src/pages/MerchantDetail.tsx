import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Card, Descriptions, Tag, Button, Input, message } from 'tdesign-react'
import DataTable from '../lib/table'
import { request } from '../lib/http'
import { confirmDialog } from '../lib/confirm'
import dayjs from 'dayjs'

interface BeanAccount {
  balance: string
  grantBalance: string
  frozen: string
  totalRecharge: string
  totalConsume: string
}
interface LedgerRow {
  id: string
  type: string
  amount: string
  balanceAfter: string
  remark: string | null
  createdAt: string
}
interface Membership {
  id: string
  package: { name: string; code: string; durationDays: number; priceFen: number }
  startAt: string
  endAt: string
  status: string
}
interface MerchantDetail {
  id: string
  phone: string
  nickname: string | null
  status: string
  createdAt: string
  stores: { id: string; name: string; isDefault: boolean; category: string | null }[]
  beanAccount: BeanAccount | null
  ledgers: LedgerRow[]
  orders: { id: string; orderNo: string; orderType: string; amountFen: number | string; status: string; paidAt: string | null; createdAt: string }[]
  memberships: Membership[]
  _count: { stores: number; creations: number; renderTasks: number }
}
interface MemberPackage {
  id: string
  code: string
  name: string
  durationDays: number
  priceFen: number
  grantBeans: string
  enabled: boolean
}
interface OpenResult {
  orderNo: string
  packageName: string
  renewed: boolean
  endAt: string
  grantPoints: string
}

export default function MerchantDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<MerchantDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [plan, setPlan] = useState<MemberPackage | null>(null)
  const [remark, setRemark] = useState('')
  const [opening, setOpening] = useState(false)

  const load = () => {
    if (!id) return
    setLoading(true)
    request<MerchantDetail>({ url: `/merchants/${id}` })
      .then(setData)
      .catch(() => message.error('加载失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    void load()
    // 会员套餐是全局配置，取一次即可；用于在界面上显示「开通 30 天会送 98000 积分」
    request<MemberPackage[]>({ url: '/member-packages' })
      .then((list) => setPlan(list.find((p) => p.code === 'SUBSCRIPTION' && p.enabled) ?? list[0] ?? null))
      .catch(() => setPlan(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const toggleStatus = async () => {
    if (!data) return
    const next = data.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'
    const r = await request<{ status: string }>({
      url: `/merchants/${data.id}/status`,
      method: 'POST',
      data: { status: next },
    })
    message.success(`已${next === 'ACTIVE' ? '启用' : '禁用'}`)
    setData((d) => d ? { ...d, status: r.status } : d)
  }

  // 后台手动开通 / 续期会员：支付未开放期间用户线下付款后的兜底通道。
  // 走的是与微信支付回调完全相同的结算链（赠豆进会员桶、随会员到期清零、重复开通＝顺延）。
  const openMembership = async () => {
    if (!data) return
    const current = data.memberships.find((m) => m.status === 'ACTIVE' && dayjs(m.endAt).isAfter(dayjs()))
    const days = plan?.durationDays ?? 30
    const feeYuan = plan ? (plan.priceFen / 100).toFixed(0) : '980'
    const grantPoints = plan?.grantBeans ?? '98000'
    const base = current ? dayjs(current.endAt) : dayjs()
    const willEnd = base.add(days, 'day')
    const okd = await confirmDialog(
      current ? '续期会员' : '手动开通会员',
      `确认为「${data.phone}」${current ? '续期' : '开通'}会员？\n\n` +
        `套餐：${plan?.name ?? '订阅会员'}（¥${feeYuan} / ${days} 天）\n` +
        `将立即赠送 ${grantPoints} 积分（会员积分，随会员到期清零）\n` +
        `到期时间：${willEnd.format('YYYY-MM-DD HH:mm')}` +
        (current ? `\n（在现有到期时间 ${dayjs(current.endAt).format('YYYY-MM-DD')} 上顺延 ${days} 天）` : '') +
        `\n\n此操作会生成一张 0 元会员订单用于留痕，不可撤销。`,
    )
    if (!okd) return
    setOpening(true)
    try {
      const r = await request<OpenResult>({
        url: `/merchants/${data.id}/membership`,
        method: 'POST',
        data: { remark: remark.trim() || undefined },
      })
      message.success(
        `已${r.renewed ? '续期' : '开通'}会员，有效期至 ${dayjs(r.endAt).format('YYYY-MM-DD')}，赠送 ${r.grantPoints} 积分`,
      )
      setRemark('')
      load()
    } catch {
      // http 层已统一提示
    } finally {
      setOpening(false)
    }
  }

  if (loading) return <div>加载中…</div>
  if (!data) return <div className="danger-text">未找到商家</div>

  const acc = data.beanAccount
  const now = dayjs()
  const current = data.memberships.find((m) => m.status === 'ACTIVE' && dayjs(m.endAt).isAfter(now))
  const history = data.memberships.filter((m) => m.id !== current?.id)
  return (
    <div>
      <div className="page-header">
        <h2>商家详情 · {data.phone}</h2>
        <Button
          theme={data.status === 'ACTIVE' ? 'danger' : 'primary'}
          onClick={toggleStatus}
        >
          {data.status === 'ACTIVE' ? '禁用账号' : '恢复账号'}
        </Button>
      </div>

      <Card title="基本信息" style={{ marginBottom: 16 }}>
        <Descriptions column={2}>
          <Descriptions.DescriptionsItem label="手机号">{data.phone}</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="昵称">{data.nickname ?? '—'}</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="状态">
            <Tag theme={data.status === 'ACTIVE' ? 'success' : 'danger'}>{data.status}</Tag>
          </Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="注册时间">{dayjs(data.createdAt).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="门店 / 创作 / 合成任务">
            {data._count.stores} / {data._count.creations} / {data._count.renderTasks}
          </Descriptions.DescriptionsItem>
        </Descriptions>
      </Card>

      <Card
        title="会员"
        style={{ marginBottom: 16 }}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input
              value={remark}
              onChange={(v) => setRemark(v as string)}
              placeholder="备注（如：微信转账 980）"
              style={{ width: 200 }}
            />
            <Button theme="primary" loading={opening} onClick={openMembership}>
              {current ? '续期会员' : '手动开通会员'}
            </Button>
          </div>
        }
      >
        <Descriptions column={4}>
          <Descriptions.DescriptionsItem label="会员状态">
            <Tag theme={current ? 'success' : 'warning'}>{current ? '有效' : '未开通'}</Tag>
          </Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="套餐">{current?.package.name ?? '—'}</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="到期时间">
            {current ? dayjs(current.endAt).format('YYYY-MM-DD HH:mm') : '—'}
          </Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="剩余天数">
            {current ? `${dayjs(current.endAt).diff(dayjs(), 'day')} 天` : '—'}
          </Descriptions.DescriptionsItem>
        </Descriptions>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          {plan
            ? `开通/续期一次 = ${plan.durationDays} 天 + ${plan.grantBeans} 积分（¥${(plan.priceFen / 100).toFixed(0)}）。积分进会员桶，随会员到期清零；已有会员则在其到期时间上顺延。`
            : '未取到会员套餐配置，请先到「会员套餐」页确认 SUBSCRIPTION 已启用。'}
        </div>
        {data.memberships.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <DataTable
              rowKey="id"
              data={data.memberships}
              columns={[
                { colKey: 'package', title: '套餐', render: ({ row }: any) => row.package?.name ?? '—' },
                { colKey: 'startAt', title: '开始', width: 170, render: ({ row }: any) => dayjs(row.startAt).format('YYYY-MM-DD HH:mm') },
                { colKey: 'endAt', title: '到期', width: 170, render: ({ row }: any) => dayjs(row.endAt).format('YYYY-MM-DD HH:mm') },
                { colKey: 'status', title: '状态', width: 100, render: ({ row }: any) => (row.status === 'ACTIVE' && dayjs(row.endAt).isAfter(dayjs()) ? '有效' : row.status) },
              ]}
            />
          </div>
        )}
      </Card>

      <Card title="积分账户" style={{ marginBottom: 16 }}>
        {acc ? (
          <Descriptions column={4}>
            <Descriptions.DescriptionsItem label="可用充值豆">{acc.balance}</Descriptions.DescriptionsItem>
            <Descriptions.DescriptionsItem label="赠豆余额">{acc.grantBalance}</Descriptions.DescriptionsItem>
            <Descriptions.DescriptionsItem label="冻结">{acc.frozen}</Descriptions.DescriptionsItem>
            <Descriptions.DescriptionsItem label="累计充值">{acc.totalRecharge}</Descriptions.DescriptionsItem>
            <Descriptions.DescriptionsItem label="累计消耗">{acc.totalConsume}</Descriptions.DescriptionsItem>
          </Descriptions>
        ) : (
          <span className="muted">暂无账务</span>
        )}
      </Card>

      <Card title={`门店 (${data.stores.length})`} style={{ marginBottom: 16 }}>
        <DataTable
          rowKey="id"
          data={data.stores}
          columns={[
            { colKey: 'name', title: '门店名' },
            { colKey: 'category', title: '品类', render: ({ row }: any) => row.category ?? '—' },
            { colKey: 'isDefault', title: '默认', render: ({ row }: any) => row.isDefault ? '✓' : '' },
          ]}
        />
      </Card>

      <Card title="最近流水（50 条）" style={{ marginBottom: 16 }}>
        <DataTable
          rowKey="id"
          data={data.ledgers}
          columns={[
            { colKey: 'createdAt', title: '时间', width: 170, render: ({ row }: any) => dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss') },
            { colKey: 'type', title: '类型', width: 100 },
            { colKey: 'amount', title: '变动' },
            { colKey: 'balanceAfter', title: '余额' },
            { colKey: 'remark', title: '备注' },
          ]}
        />
      </Card>

      <Card title="最近订单（20 条）">
        <DataTable
          rowKey="id"
          data={data.orders}
          columns={[
            { colKey: 'orderNo', title: '订单号' },
            { colKey: 'orderType', title: '类型' },
            { colKey: 'amountFen', title: '金额(分)' },
            { colKey: 'status', title: '状态' },
            { colKey: 'paidAt', title: '支付时间', render: ({ row }: any) => row.paidAt ? dayjs(row.paidAt).format('YYYY-MM-DD HH:mm') : '—' },
          ]}
        />
      </Card>
    </div>
  )
}
