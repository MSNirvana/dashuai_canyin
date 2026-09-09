import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Card, Descriptions, Table, Tag, Button, message } from 'tdesign-react'
import { request } from '../lib/http'
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
  memberships: { id: string; package: { name: string }; startAt: string; endAt: string; status: string }[]
  _count: { stores: number; creations: number; renderTasks: number }
}

export default function MerchantDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<MerchantDetail | null>(null)
  const [loading, setLoading] = useState(true)

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

  if (loading) return <div>加载中…</div>
  if (!data) return <div className="danger-text">未找到商家</div>

  const acc = data.beanAccount
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
        <Table
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
        <Table
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
        <Table
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
