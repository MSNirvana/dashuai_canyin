import { useEffect, useState } from 'react'
import { Table, Input, Select, Tag, Space, Button } from 'tdesign-react'
import { Link } from 'react-router-dom'
import { request } from '../lib/http'
import dayjs from 'dayjs'

interface MerchantRow {
  id: string
  phone: string
  nickname: string | null
  status: string
  createdAt: string
  beanAccount?: { balance: string; grantBalance: string; totalRecharge: string; totalConsume: string } | null
  memberships: { package: { name: string; code: string } }[]
  _count: { stores: number; creations: number; orders: number }
}

interface PageData<T> {
  list: T[]
  total: number
  page: number
  pageSize: number
}

export default function MerchantsPage() {
  const [phone, setPhone] = useState('')
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [data, setData] = useState<PageData<MerchantRow> | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const r = await request<PageData<MerchantRow>>({
        url: '/merchants',
        params: {
          ...(phone ? { phone } : {}),
          ...(status ? { status } : {}),
          page,
          pageSize,
        },
      })
      setData(r)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, status])

  return (
    <div>
      <div className="page-header">
        <h2>商家管理</h2>
        <Space>
          <Input
            placeholder="按手机号搜索"
            value={phone}
            onChange={(v) => setPhone(v as string)}
            clearable
          />
          <Select
            placeholder="状态"
            clearable
            value={status}
            onChange={(v) => setStatus((v as string) || undefined)}
            style={{ width: 160 }}
            options={[
              { label: '正常', value: 'ACTIVE' },
              { label: '禁用', value: 'DISABLED' },
            ]}
          />
          <Button theme="primary" onClick={() => { setPage(1); void load() }}>搜索</Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        data={data?.list ?? []}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          onChange: (pageInfo) => { setPage(pageInfo.current); setPageSize(pageInfo.pageSize) },
        }}
        columns={[
          { colKey: 'phone', title: '手机号', width: 130 },
          { colKey: 'nickname', title: '昵称', width: 160 },
          {
            colKey: 'status', title: '状态', width: 100,
            render: ({ row }: { row: MerchantRow }) => (
              <Tag theme={row.status === 'ACTIVE' ? 'success' : 'danger'}>
                {row.status === 'ACTIVE' ? '正常' : '禁用'}
              </Tag>
            ),
          },
          {
            colKey: 'balance', title: '积分余额',
            render: ({ row }: { row: MerchantRow }) =>
              row.beanAccount ? `${row.beanAccount.balance} + 赠 ${row.beanAccount.grantBalance}` : '—',
          },
          {
            colKey: 'member', title: '会员',
            render: ({ row }: { row: MerchantRow }) => {
              const m = row.memberships[0]
              return m ? <Tag theme="primary">{m.package.name}</Tag> : <span className="muted">非会员</span>
            },
          },
          { colKey: 'stores', title: '门店数', width: 90, render: ({ row }: { row: MerchantRow }) => row._count.stores },
          { colKey: 'creations', title: '创作', width: 80, render: ({ row }: { row: MerchantRow }) => row._count.creations },
          { colKey: 'createdAt', title: '注册时间', width: 170, render: ({ row }: { row: MerchantRow }) => dayjs(row.createdAt).format('YYYY-MM-DD HH:mm') },
          {
            colKey: 'op', title: '操作', width: 90, fixed: 'right',
            render: ({ row }: { row: MerchantRow }) => (
              <Link to={`/merchants/${row.id}`}>详情</Link>
            ),
          },
        ]}
      />
    </div>
  )
}
