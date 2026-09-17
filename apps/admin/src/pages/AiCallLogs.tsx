import { useState } from 'react'
import { Select, Tag, Input } from 'tdesign-react'
import DataTable from '../lib/table'
import { useListQuery } from '../lib/useListQuery'
import dayjs from 'dayjs'

interface CallLog {
  id: string
  sceneCode: string
  status: string
  isFallback: boolean
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costFen: number
  beanCharged: string
  /** 被场景单次上限截断、由平台承担的积分数（>0 说明上限在贴钱） */
  absorbedBeans: string
  latencyMs: number
  errorMsg: string | null
  createdAt: string
  merchant: { phone: string; nickname: string | null } | null
  provider: { code: string; name: string }
  model: { modelCode: string; displayName: string }
}

export default function AiCallLogsPage() {
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [scene, setScene] = useState<string | undefined>(undefined)
  // 分页 + 筛选竞态防护：原先只请求第 1 页、pageSize 写死 50，且没有分页控件
  const { data, loading, pagination } = useListQuery<CallLog>({
    url: '/ai/call-logs',
    params: { status, sceneCode: scene },
    pageSize: 20,
  })

  return (
    <div>
      <div className="page-header">
        <h2>AI 调用日志 · 合计 {data?.total ?? 0}</h2>
        <div>
          <Select placeholder="场景" clearable value={scene} onChange={(v) => setScene((v as string) || undefined)} style={{ width: 180, marginRight: 12 }}
            options={[
              { label: 'COPY', value: 'copy_generate' },
              { label: 'STORYBOARD', value: 'storyboard_generate' },
              { label: 'SHOT_LIBRARY', value: 'shot_library' },
              { label: 'TEST', value: 'TEST' },
            ]} />
          <Select placeholder="状态" clearable value={status} onChange={(v) => setStatus((v as string) || undefined)} style={{ width: 140 }}
            options={['SUCCESS', 'FAILED', 'TIMEOUT', 'FALLBACK_USED', 'TEST'].map((v) => ({ label: v, value: v }))} />
        </div>
      </div>

      <DataTable
        rowKey="id"
        data={data?.list ?? []}
        loading={loading}
        pagination={pagination}
        columns={[
          { colKey: 'createdAt', title: '时间', width: 170, render: ({ row }: any) => dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss') },
          { colKey: 'merchant', title: '商家', width: 130, render: ({ row }: any) => row.merchant?.phone ?? '—' },
          { colKey: 'sceneCode', title: '场景', width: 140 },
          { colKey: 'provider', title: '通道·模型', render: ({ row }: any) => `${row.provider.code} / ${row.model.modelCode}` },
          { colKey: 'status', title: '状态', width: 110,
            render: ({ row }: any) => (
              <Tag theme={row.status === 'SUCCESS' ? 'success' : row.status === 'FAILED' || row.status === 'TIMEOUT' ? 'danger' : 'warning'}>
                {row.status}{row.isFallback ? ' (fallback)' : ''}
              </Tag>
            ),
          },
          { colKey: 'tokens', title: 'tokens(in/out)', width: 140, render: ({ row }: any) => `${row.promptTokens}/${row.completionTokens}` },
          { colKey: 'costFen', title: '成本(分)', width: 100 },
          { colKey: 'beanCharged', title: '扣积分', width: 90 },
          { colKey: 'absorbedBeans', title: '平台补贴', width: 110,
            render: ({ row }: any) => {
              const n = Number(row.absorbedBeans ?? 0)
              return n > 0 ? <Tag theme="warning">贴 {n} 积分</Tag> : <span style={{ color: '#999' }}>—</span>
            },
          },
          { colKey: 'latencyMs', title: '延迟(ms)', width: 100 },
          { colKey: 'errorMsg', title: '错误', render: ({ row }: any) => row.errorMsg ?? '—' },
        ]}
      />
    </div>
  )
}
