import { useEffect, useState } from 'react'
import { Table, Input, Select, Button, Dialog, Form, InputNumber, message, Space } from 'tdesign-react'
import { request } from '../lib/http'
import dayjs from 'dayjs'

interface LedgerRow {
  id: string
  merchantId: string
  type: string
  bucket: string
  amount: string
  balanceAfter: string
  bizType: string | null
  remark: string | null
  createdAt: string
  merchant: { phone: string; nickname: string | null } | null
}

export default function BeanLedgerPage() {
  const [merchantId, setMerchantId] = useState('')
  const [type, setType] = useState<string | undefined>(undefined)
  const [data, setData] = useState<{ list: LedgerRow[]; total: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [adjust, setAdjust] = useState({ merchantId: '', amount: 0, bucket: 'RECHARGE' as 'RECHARGE' | 'GRANT', remark: '' })

  const load = async () => {
    setLoading(true)
    try {
      const r = await request<{ list: LedgerRow[]; total: number; page: number; pageSize: number }>({
        url: '/bean/ledger',
        params: {
          ...(merchantId ? { merchantId } : {}),
          ...(type ? { type } : {}),
          pageSize: 50,
        },
      })
      setData({ list: r.list, total: r.total })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [type])

  const doAdjust = async () => {
    try {
      await request({
        url: '/bean/adjust',
        method: 'POST',
        data: {
          merchantId: adjust.merchantId,
          amount: String(adjust.amount),
          bucket: adjust.bucket,
          remark: adjust.remark,
        },
      })
      message.success('调账成功')
      setAdjustOpen(false)
      setAdjust({ merchantId: '', amount: 0, bucket: 'RECHARGE', remark: '' })
      void load()
    } catch {}
  }

  return (
    <div>
      <div className="page-header">
        <h2>积分流水 · 共 {data?.total ?? 0} 条</h2>
        <Space>
          <Input placeholder="商家ID" value={merchantId} onChange={(v) => setMerchantId(v as string)} clearable style={{ width: 200 }} />
          <Select placeholder="类型" clearable value={type} onChange={(v) => setType((v as string) || undefined)} style={{ width: 160 }}
            options={[
              { label: 'RECHARGE', value: 'RECHARGE' },
              { label: 'GRANT', value: 'GRANT' },
              { label: 'FREEZE', value: 'FREEZE' },
              { label: 'CONSUME', value: 'CONSUME' },
              { label: 'UNFREEZE', value: 'UNFREEZE' },
              { label: 'ADJUST', value: 'ADJUST' },
              { label: 'REFUND', value: 'REFUND' },
              { label: 'EXPIRE', value: 'EXPIRE' },
            ]}
          />
          <Button onClick={load}>查询</Button>
          <Button theme="primary" onClick={() => setAdjustOpen(true)}>手动调账</Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        data={data?.list ?? []}
        loading={loading}
        columns={[
          { colKey: 'createdAt', title: '时间', width: 170, render: ({ row }: any) => dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss') },
          { colKey: 'merchant', title: '商家', width: 160, render: ({ row }: any) => row.merchant ? `${row.merchant.phone}` : `ID:${row.merchantId}` },
          { colKey: 'type', title: '类型', width: 100 },
          { colKey: 'bucket', title: '桶', width: 90 },
          { colKey: 'amount', title: '变动', width: 120, render: ({ row }: any) => (
            <span className={Number(row.amount) < 0 ? 'danger-text' : 'success-text'}>{row.amount}</span>
          ) },
          { colKey: 'balanceAfter', title: '余额', width: 120 },
          { colKey: 'bizType', title: '业务', width: 130, render: ({ row }: any) => row.bizType ?? '—' },
          { colKey: 'remark', title: '备注', render: ({ row }: any) => row.remark ?? '—' },
        ]}
      />

      <Dialog
        header="手动调账"
        visible={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        onConfirm={doAdjust}
        width={520}
      >
        <Form labelWidth={120}>
          <Form.FormItem label="商家 ID">
            <Input value={adjust.merchantId} onChange={(v) => setAdjust((s) => ({ ...s, merchantId: v as string }))} placeholder="必填" />
          </Form.FormItem>
          <Form.FormItem label="金额（正数补/负数扣）">
            <InputNumber value={adjust.amount} onChange={(v) => setAdjust((s) => ({ ...s, amount: v as number }))} />
          </Form.FormItem>
          <Form.FormItem label="桶">
            <Select value={adjust.bucket} onChange={(v) => setAdjust((s) => ({ ...s, bucket: v as 'RECHARGE' | 'GRANT' }))}
              options={[{ label: '充值豆', value: 'RECHARGE' }, { label: '赠豆', value: 'GRANT' }]} />
          </Form.FormItem>
          <Form.FormItem label="原因">
            <Input value={adjust.remark} onChange={(v) => setAdjust((s) => ({ ...s, remark: v as string }))} placeholder="必填，留作审计" />
          </Form.FormItem>
        </Form>
      </Dialog>
    </div>
  )
}
