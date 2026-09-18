import { useState } from 'react'
import { Select, Tag, Progress, Button, message } from 'tdesign-react'
import DataTable from '../lib/table'
import { useListQuery } from '../lib/useListQuery'
import DeliverDialog from '../components/DeliverDialog'
import MaterialsDialog from '../components/MaterialsDialog'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'
import { fmtMinute } from '../lib/datetime'
import {
  GRADE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  isPremiumActionable,
  slaLeft,
  type Material,
  type RenderRow,
} from '../lib/render-task'

/**
 * 合成任务（全档位）。
 *
 * 这一页保留「不打散的全量表」：排查「某个商家的任务到底怎么了」时需要它。
 * 精品档的**日常作业**不在这里做 —— 那是「精品接单」页（默认只看进行中），
 * 两者共用同一套交付/素材弹窗与状态文案，不存在两份会漂的实现。
 */
export default function RenderTasksPage() {
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [grade, setGrade] = useState<string | undefined>(undefined)
  const [deliverRow, setDeliverRow] = useState<RenderRow | null>(null)
  const [materials, setMaterials] = useState<{ row: RenderRow; list: Material[] } | null>(null)

  // 分页 + 筛选竞态防护统一由 useListQuery 处理（原先 pageSize 写死、分页控件绑常量 current 点不动）
  const { data, loading, pagination, reload: load } = useListQuery<RenderRow>({
    url: '/render/tasks',
    params: { status, grade },
    pageSize: 20,
  })

  const act = async (row: RenderRow, action: 'claim' | 'fail') => {
    if (action === 'fail') {
      const ok = await confirmDialog('标记失败', `任务 #${row.id} 标记失败将全额退还 ${row.beanCharged} 积分，确认？`)
      if (!ok) return
    }
    try {
      await request({ url: `/render/tasks/${row.id}/${action}`, method: 'POST', data: action === 'fail' ? { reason: '后台人工标记失败' } : {} })
      message.success(action === 'claim' ? '已接单' : '已标记失败并退款')
      load()
    } catch {}
  }

  const openMaterials = async (row: RenderRow) => {
    try {
      const list = await request<Material[]>({ url: `/render/tasks/${row.id}/materials` })
      setMaterials({ row, list })
    } catch {}
  }

  return (
    <div>
      <div className="page-header">
        <h2>合成任务 · 合计 {data?.total ?? 0}</h2>
        <div>
          <Select placeholder="状态" clearable value={status} onChange={(v) => setStatus((v as string) || undefined)} style={{ width: 140, marginRight: 12 }}
            // 选项从 STATUS_LABELS 取（不再手工拼 `Object.keys(STATUS_COLORS) + 'SLA_TIMEOUT'`）：
            // 那份拼法会让 SLA_TIMEOUT 漏掉中文名，页面上直接把英文码显示给运营。
            options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ label, value }))}
          />
          <Select placeholder="档位" clearable value={grade} onChange={(v) => setGrade((v as string) || undefined)} style={{ width: 140 }}
            options={Object.entries(GRADE_LABELS).map(([value, label]) => ({ label, value }))}
          />
        </div>
      </div>

      <DataTable
        rowKey="id"
        data={data?.list ?? []}
        loading={loading}
        pagination={pagination}
        columns={[
          { colKey: 'createdAt', title: '提交时间', width: 165, render: ({ row }: any) => fmtMinute(row.createdAt) },
          { colKey: 'merchant', title: '商家', width: 125, render: ({ row }: any) => row.merchant?.phone ?? '—' },
          { colKey: 'grade', title: '档位', width: 80, render: ({ row }: any) => (
            <Tag theme={row.grade === 'PREMIUM' ? 'warning' : row.grade === 'BASIC' ? 'default' : 'primary'}>
              {GRADE_LABELS[row.grade] ?? row.grade}
            </Tag>
          ) },
          { colKey: 'status', title: '状态', width: 90,
            render: ({ row }: any) => <Tag theme={STATUS_COLORS[row.status] ?? 'default'}>{STATUS_LABELS[row.status] ?? row.status}</Tag>,
          },
          { colKey: 'progress', title: '进度', width: 160,
            render: ({ row }: any) => (
              <Progress
                percentage={row.status === 'SUCCESS' ? 100 : (row.status === 'FAILED' || row.status === 'TIMEOUT' || row.status === 'SLA_TIMEOUT' || row.status === 'CANCELLED') ? 0 : row.progress}
                status={row.status === 'FAILED' || row.status === 'TIMEOUT' || row.status === 'SLA_TIMEOUT' ? 'error' : undefined}
                size="small"
              />
            ),
          },
          { colKey: 'beanCharged', title: '积分', width: 80 },
          { colKey: 'durationMs', title: '时长', width: 90, render: ({ row }: any) => row.durationMs ? `${Math.round(row.durationMs / 1000)}s` : '—' },
          { colKey: 'deadlineAt', title: 'SLA 剩余', width: 100, render: ({ row }: any) => isPremiumActionable(row) ? slaLeft(row.deadlineAt) : '—' },
          { colKey: 'error', title: '错误', ellipsis: true, render: ({ row }: any) => row.errorMsg ?? '—' },
          { colKey: 'op', title: '操作', width: 240, fixed: 'right',
            render: ({ row }: any) => isPremiumActionable(row) ? (
              <>
                {row.status === 'MANUAL_PENDING' && (
                  <Button size="small" variant="text" theme="primary" onClick={() => act(row, 'claim')}>接单</Button>
                )}
                <Button size="small" variant="text" onClick={() => openMaterials(row)}>素材</Button>
                <Button size="small" variant="text" theme="success" onClick={() => setDeliverRow(row)}>交付</Button>
                <Button size="small" variant="text" theme="danger" onClick={() => act(row, 'fail')}>失败退款</Button>
              </>
            ) : (
              <span style={{ color: '#999' }}>—</span>
            ),
          },
        ]}
      />

      <DeliverDialog task={deliverRow} onClose={() => setDeliverRow(null)} onDone={load} />
      <MaterialsDialog data={materials} onClose={() => setMaterials(null)} />
    </div>
  )
}
