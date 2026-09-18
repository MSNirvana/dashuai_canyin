import { useState } from 'react'
import { Input, Select, Button, Dialog, InputNumber, message, Space } from 'tdesign-react'
import DataTable from '../lib/table'
import { useListQuery } from '../lib/useListQuery'
import Field, { FieldGroup } from '../components/Field'
import { request } from '../lib/http'
import { fmtMinute } from '../lib/datetime'

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
  // 商家 ID 是「点了查询才生效」的输入框，不能每敲一个字就重查，所以与生效值分开存
  const [merchantIdInput, setMerchantIdInput] = useState('')
  const [merchantId, setMerchantId] = useState('')
  const [type, setType] = useState<string | undefined>(undefined)
  const [adjustOpen, setAdjustOpen] = useState(false)
  /**
   * 调账表单。`requestId` 是**幂等键**：
   *
   * ★ 它必须与「一次调账意图」同生命周期，而不是每次请求新生成一个。
   *   服务端按 (merchantId, bizType='ADMIN', requestId, type='ADJUST') 唯一索引去重 ——
   *   键一换，去重就完全失效：双击一下按钮、或请求超时后重试一次，余额真的会被改两遍，
   *   而两条流水看起来都完全正常（不同 requestId，唯一索引不拦）。
   *   所以：**开弹窗时生成一次**，成功提交后才换新的；失败重试沿用同一个键。
   */
  const newAdjustRequestId = () => `adj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const [adjust, setAdjust] = useState({
    merchantId: '',
    amount: 0,
    bucket: 'RECHARGE' as 'RECHARGE' | 'GRANT',
    remark: '',
    requestId: newAdjustRequestId(),
  })
  /** 提交中：同步挡住连点（服务端虽然幂等，但让用户看到两次「调账成功」本身就是误导） */
  const [adjustSubmitting, setAdjustSubmitting] = useState(false)

  /**
   * 改任何一个字段 = 换了**调账意图** ⇒ 必须换幂等键。
   *
   * ★ 这一步不能省。服务端的去重是按 requestId 命中就**直接返回上次的余额快照、不再改账**，
   *   所以「同一把键 + 改过的金额」会被当成重放：运营把 100 改成 200 提交，
   *   页面回「调账成功」，库里却仍是 100 —— 静默的金额不符，比重复扣加更难发现。
   *   反过来，不动字段直接重试沿用同一把键，才是幂等真正要保护的那个场景。
   */
  const setAdjustField = (patch: Partial<typeof adjust>) =>
    setAdjust((s) => ({ ...s, ...patch, requestId: newAdjustRequestId() }))

  // 分页 + 竞态防护：原先只请求第 1 页、pageSize 写死 50，且没有分页控件
  const { data, loading, pagination, reload: load } = useListQuery<LedgerRow>({
    url: '/bean/ledger',
    params: { ...(merchantId ? { merchantId } : {}), ...(type ? { type } : {}) },
    pageSize: 20,
  })

  const doAdjust = async () => {
    if (adjustSubmitting) return
    setAdjustSubmitting(true)
    try {
      const r = (await request({
        url: '/bean/adjust',
        method: 'POST',
        data: {
          merchantId: adjust.merchantId,
          amount: String(adjust.amount),
          bucket: adjust.bucket,
          remark: adjust.remark,
          requestId: adjust.requestId,
        },
      })) as { duplicated?: boolean } | undefined
      // 服务端如实回报是不是重放；不区分的话，运营会以为「又调了一次」，然后手动再调一次
      message.success(r?.duplicated ? '这笔调账之前已生效，本次没有重复扣加' : '调账成功')
      setAdjustOpen(false)
      setAdjust({ merchantId: '', amount: 0, bucket: 'RECHARGE', remark: '', requestId: newAdjustRequestId() })
      load()
    } catch {
      // 失败时**保留同一个 requestId**：用户点「重试」是接着同一次调账意图，
      // 换新键就等于把幂等保护关掉
    } finally {
      setAdjustSubmitting(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>积分流水 · 共 {data?.total ?? 0} 条</h2>
        <Space>
          <Input placeholder="商家ID" value={merchantIdInput} onChange={(v) => setMerchantIdInput(v as string)} clearable style={{ width: 200 }}
            onEnter={() => setMerchantId(merchantIdInput.trim())} />
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
          <Button onClick={() => setMerchantId(merchantIdInput.trim())}>查询</Button>
          {/* 打开弹窗 = 开始一次新的调账意图 ⇒ 换一把新的幂等键 */}
          <Button
            theme="primary"
            onClick={() => {
              setAdjust((s) => ({ ...s, requestId: newAdjustRequestId() }))
              setAdjustOpen(true)
            }}
          >
            手动调账
          </Button>
        </Space>
      </div>

      <DataTable
        rowKey="id"
        data={data?.list ?? []}
        loading={loading}
        pagination={pagination}
        columns={[
          { colKey: 'createdAt', title: '时间', width: 170, render: ({ row }: any) => fmtMinute(row.createdAt) },
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
        // 提交中禁用「确定」：连点两次虽然服务端有幂等键兜住，但用户会看到两条「调账成功」
        confirmBtn={{ loading: adjustSubmitting }}
        width={520}
      >
        <FieldGroup labelWidth={120}>
          <Field label="商家 ID">
            <Input value={adjust.merchantId} onChange={(v) => setAdjustField({ merchantId: v as string })} placeholder="必填" />
          </Field>
          <Field label="金额（正数补/负数扣）">
            <InputNumber value={adjust.amount} onChange={(v) => setAdjustField({ amount: v as number })} />
          </Field>
          <Field label="桶">
            <Select value={adjust.bucket} onChange={(v) => setAdjustField({ bucket: v as 'RECHARGE' | 'GRANT' })}
              options={[{ label: '充值积分', value: 'RECHARGE' }, { label: '赠积分', value: 'GRANT' }]} />
          </Field>
          <Field label="原因">
            <Input value={adjust.remark} onChange={(v) => setAdjustField({ remark: v as string })} placeholder="必填，留作审计" />
          </Field>
        </FieldGroup>
      </Dialog>
    </div>
  )
}
