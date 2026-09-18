import { useState } from 'react'
import { Button, Progress, Radio, Tag, message } from 'tdesign-react'
import DataTable from '../lib/table'
import { useListQuery } from '../lib/useListQuery'
import DeliverDialog from '../components/DeliverDialog'
import MaterialsDialog from '../components/MaterialsDialog'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'
import { fmtMinute } from '../lib/datetime'
import {
  PREMIUM_ACTIVE_STATUSES,
  STATUS_COLORS,
  STATUS_LABELS,
  isPremiumActionable,
  slaLeft,
  type Material,
  type RenderRow,
} from '../lib/render-task'

/**
 * 精品接单 · 独立工作台。
 *
 * ── 为什么要从「合成任务」里单拉一页 ────────────────────────────────────────
 * 精品（PREMIUM）是**人工剪辑**档：任务进来后停在「待接单」，等剪辑师接走、剪完、交付。
 * 它的工作节奏与另两个档位（BASIC/AI 由机器跑，人只需要看结果）完全不同 ——
 * 混在同一张表里时，剪辑师每天第一件事是先把档位筛成「精品」、再在几百条机器任务里
 * 找自己那几条待接的单，而「今天还有哪些活没交」这件事在界面上根本没有答案。
 * 这一页把它固定成 PREMIUM，并把默认视图设成「进行中」（待接单 + 剪辑中）。
 *
 * ── 为什么「合成任务」页**不删**精品 ────────────────────────────────────────
 * 那边保留全档位（含精品）的视角：排查「这个商家的任务到底怎么了」时需要一张
 * 不打散的表。两页共用同一套交付/素材弹窗与状态文案（lib/render-task.ts、
 * components/{DeliverDialog,MaterialsDialog}.tsx），所以不存在两份会漂的实现。
 */

/** 视图 = 常用筛选的语义化预设。比让剪辑师自己拼「状态 + 档位」两个下拉更不容易筛错 */
const VIEWS = [
  { label: '进行中', value: 'ACTIVE' },
  { label: '待接单', value: 'MANUAL_PENDING' },
  { label: '剪辑中', value: 'MANUAL_DOING' },
  { label: '已交付', value: 'SUCCESS' },
  { label: '全部', value: 'ALL' },
] as const

type ViewValue = (typeof VIEWS)[number]['value']

/** 视图 → 查询参数。★ 只用一套（status 或 statuses），两个都传会被服务端当交集 */
function viewParams(view: ViewValue): { status?: string; statuses?: string } {
  if (view === 'ACTIVE') return { statuses: PREMIUM_ACTIVE_STATUSES.join(',') }
  if (view === 'ALL') return {}
  return { status: view }
}

export default function PremiumOrdersPage() {
  const [view, setView] = useState<ViewValue>('ACTIVE')
  const [deliverRow, setDeliverRow] = useState<RenderRow | null>(null)
  const [materials, setMaterials] = useState<{ row: RenderRow; list: Material[] } | null>(null)

  const { data, loading, pagination, reload } = useListQuery<RenderRow>({
    url: '/render/tasks',
    params: { grade: 'PREMIUM', ...viewParams(view) },
    pageSize: 20,
  })

  const claim = async (row: RenderRow) => {
    try {
      await request({ url: `/render/tasks/${row.id}/claim`, method: 'POST' })
      message.success('已接单')
      reload()
    } catch {
      /* 已在 request 层 toast（含「可能已被接走」） */
    }
  }

  const fail = async (row: RenderRow) => {
    const ok = await confirmDialog(
      '标记失败',
      `任务 #${row.id} 标记失败将全额退还 ${row.beanCharged} 积分，确认？`,
    )
    if (!ok) return
    try {
      await request({
        url: `/render/tasks/${row.id}/fail`,
        method: 'POST',
        data: { reason: '后台人工标记失败' },
      })
      message.success('已标记失败并退款')
      reload()
    } catch {
      /* 已在 request 层 toast */
    }
  }

  const openMaterials = async (row: RenderRow) => {
    try {
      const list = await request<Material[]>({ url: `/render/tasks/${row.id}/materials` })
      setMaterials({ row, list })
    } catch {
      /* 已在 request 层 toast */
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>精品接单 · 合计 {data?.total ?? 0}</h2>
        <div>
          <Radio.Group variant="default-filled" size="small" value={view} onChange={(v) => setView(v as ViewValue)}>
            {VIEWS.map((v) => (
              <Radio.Button key={v.value} value={v.value}>
                {v.label}
              </Radio.Button>
            ))}
          </Radio.Group>
          <Button size="small" variant="outline" style={{ marginLeft: 12 }} onClick={reload}>
            刷新
          </Button>
        </div>
      </div>

      <div className="page-tip">
        精品档是<b>人工剪辑</b>：任务会先停在「待接单」，剪辑师接单 → 剪好 → <b>交付成片</b>。
        交付时可以直接<b>上传成片视频</b>（自动探测时长、自动抽一帧当封面），不用再去别处上传再抄对象键。
        <br />
        ⚠ 请留意「SLA 剩余」：超时未交付的任务会被系统<b>自动全额退款</b>并标记失败。
      </div>

      <DataTable
        rowKey="id"
        data={data?.list ?? []}
        loading={loading}
        pagination={pagination}
        columns={[
          {
            colKey: 'createdAt',
            title: '提交时间',
            width: 165,
            render: ({ row }: any) => fmtMinute(row.createdAt),
          },
          { colKey: 'taskNo', title: '任务号', width: 100, render: ({ row }: any) => `#${row.id}` },
          { colKey: 'merchant', title: '商家', width: 125, render: ({ row }: any) => row.merchant?.phone ?? '—' },
          {
            colKey: 'status',
            title: '状态',
            width: 95,
            render: ({ row }: any) => (
              <Tag theme={STATUS_COLORS[row.status] ?? 'default'}>
                {STATUS_LABELS[row.status] ?? row.status}
              </Tag>
            ),
          },
          {
            colKey: 'deadlineAt',
            title: 'SLA 剩余',
            width: 100,
            render: ({ row }: any) => {
              if (!isPremiumActionable(row)) return '—'
              const left = slaLeft(row.deadlineAt)
              return left === '已超时' ? <span className="danger-text">{left}</span> : left
            },
          },
          {
            colKey: 'progress',
            title: '进度',
            width: 140,
            render: ({ row }: any) => (
              <Progress
                percentage={row.status === 'SUCCESS' ? 100 : isPremiumActionable(row) ? row.progress : 0}
                status={row.status === 'FAILED' || row.status === 'TIMEOUT' || row.status === 'SLA_TIMEOUT' ? 'error' : undefined}
                size="small"
              />
            ),
          },
          { colKey: 'beanCharged', title: '积分', width: 75 },
          {
            colKey: 'durationMs',
            title: '时长',
            width: 80,
            render: ({ row }: any) => (row.durationMs ? `${Math.round(row.durationMs / 1000)}s` : '—'),
          },
          { colKey: 'error', title: '错误', ellipsis: true, render: ({ row }: any) => row.errorMsg ?? '—' },
          {
            colKey: 'op',
            title: '操作',
            width: 250,
            fixed: 'right',
            render: ({ row }: any) =>
              isPremiumActionable(row) ? (
                <>
                  {row.status === 'MANUAL_PENDING' && (
                    <Button size="small" variant="text" theme="primary" onClick={() => claim(row)}>
                      接单
                    </Button>
                  )}
                  <Button size="small" variant="text" onClick={() => openMaterials(row)}>
                    素材
                  </Button>
                  <Button size="small" variant="text" theme="success" onClick={() => setDeliverRow(row)}>
                    交付
                  </Button>
                  <Button size="small" variant="text" theme="danger" onClick={() => fail(row)}>
                    失败退款
                  </Button>
                </>
              ) : (
                <span style={{ color: '#999' }}>—</span>
              ),
          },
        ]}
      />

      <DeliverDialog task={deliverRow} onClose={() => setDeliverRow(null)} onDone={reload} />
      <MaterialsDialog data={materials} onClose={() => setMaterials(null)} />
    </div>
  )
}
