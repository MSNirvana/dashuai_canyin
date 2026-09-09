import { useEffect, useState } from 'react'
import { Table, Select, Tag, Progress, Button, Dialog, Form, Input, InputNumber, message } from 'tdesign-react'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'
import dayjs from 'dayjs'

interface RenderRow {
  id: string
  merchantId: string
  status: string
  grade: string
  progress: number
  beanCharged: string
  cacheHit: boolean
  durationMs: number | null
  errorCode: string | null
  errorMsg: string | null
  createdAt: string
  finishAt: string | null
  assignedAt: string | null
  deadlineAt: string | null
  merchant: { phone: string; nickname: string | null } | null
}

interface Material {
  seq: number
  shotId: string
  line: string | null
  trimStartMs: number
  trimEndMs: number | null
  durationMs: number | null
  cosKey: string
  playUrl: string | null
}

const STATUS_COLORS: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'primary'> = {
  QUEUED: 'default',
  RUNNING: 'warning',
  SUCCESS: 'success',
  FAILED: 'danger',
  TIMEOUT: 'danger',
  CANCELLED: 'default',
  MANUAL_PENDING: 'primary',
  MANUAL_DOING: 'primary',
}

const STATUS_LABELS: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '合成中',
  SUCCESS: '已完成',
  FAILED: '失败',
  TIMEOUT: '超时',
  CANCELLED: '已取消',
  MANUAL_PENDING: '待接单',
  MANUAL_DOING: '剪辑中',
}

const GRADE_LABELS: Record<string, string> = { BASIC: '基础', AI: 'AI', PREMIUM: '精品' }

function slaLeft(deadlineAt: string | null): string {
  if (!deadlineAt) return '—'
  const hours = dayjs(deadlineAt).diff(dayjs(), 'hour', true)
  if (hours < 0) return '已超时'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`
  return `${Math.round(hours)} 小时`
}

export default function RenderTasksPage() {
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [grade, setGrade] = useState<string | undefined>(undefined)
  const [data, setData] = useState<{ list: RenderRow[]; total: number } | null>(null)
  const [loading, setLoading] = useState(false)

  // 交付弹窗
  const [deliverRow, setDeliverRow] = useState<RenderRow | null>(null)
  const [deliverForm, setDeliverForm] = useState({ resultKey: '', previewKey: '', durationSec: '' })
  // 素材弹窗
  const [materials, setMaterials] = useState<{ row: RenderRow; list: Material[] } | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const r = await request<{ list: RenderRow[]; total: number; page: number; pageSize: number }>({
        url: '/render/tasks',
        params: { status, grade, pageSize: 50 },
      })
      setData({ list: r.list, total: r.total })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [status, grade])

  const act = async (row: RenderRow, action: 'claim' | 'fail') => {
    if (action === 'fail') {
      const ok = await confirmDialog('标记失败', `任务 #${row.id} 标记失败将全额退还 ${row.beanCharged} 积分，确认？`)
      if (!ok) return
    }
    try {
      await request({ url: `/render/tasks/${row.id}/${action}`, method: 'POST', data: action === 'fail' ? { reason: '后台人工标记失败' } : {} })
      message.success(action === 'claim' ? '已接单' : '已标记失败并退款')
      void load()
    } catch {}
  }

  const openDeliver = (row: RenderRow) => {
    setDeliverRow(row)
    // 默认成片 Key 与机器合成约定一致：renders/{merchantId}/{taskId}.mp4
    setDeliverForm({ resultKey: `renders/${row.merchantId}/${row.id}.mp4`, previewKey: '', durationSec: '' })
  }

  const submitDeliver = async () => {
    if (!deliverRow) return
    if (!deliverForm.resultKey.trim()) {
      message.warning('请填写成片 COS Key')
      return
    }
    try {
      await request({
        url: `/render/tasks/${deliverRow.id}/deliver`,
        method: 'POST',
        data: {
          resultKey: deliverForm.resultKey.trim(),
          ...(deliverForm.previewKey.trim() ? { previewKey: deliverForm.previewKey.trim() } : {}),
          ...(deliverForm.durationSec ? { durationMs: Math.round(Number(deliverForm.durationSec) * 1000) } : {}),
        },
      })
      message.success('已交付，积分已结算')
      setDeliverRow(null)
      void load()
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
        <h2>合成任务 · 剪辑工作台 · 合计 {data?.total ?? 0}</h2>
        <div>
          <Select placeholder="状态" clearable value={status} onChange={(v) => setStatus((v as string) || undefined)} style={{ width: 140, marginRight: 12 }}
            options={[...Object.keys(STATUS_COLORS), 'SLA_TIMEOUT'].map((s) => ({ label: STATUS_LABELS[s] ?? s, value: s }))}
          />
          <Select placeholder="档位" clearable value={grade} onChange={(v) => setGrade((v as string) || undefined)} style={{ width: 140 }}
            options={Object.entries(GRADE_LABELS).map(([value, label]) => ({ label, value }))}
          />
        </div>
      </div>

      <Table
        rowKey="id"
        data={data?.list ?? []}
        loading={loading}
        pagination={{ total: data?.total ?? 0, pageSize: 50, current: 1 }}
        columns={[
          { colKey: 'createdAt', title: '提交时间', width: 165, render: ({ row }: any) => dayjs(row.createdAt).format('MM-DD HH:mm:ss') },
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
          { colKey: 'deadlineAt', title: 'SLA 剩余', width: 100, render: ({ row }: any) => row.grade === 'PREMIUM' && row.status !== 'SUCCESS' && row.status !== 'FAILED' ? slaLeft(row.deadlineAt) : '—' },
          { colKey: 'error', title: '错误', ellipsis: true, render: ({ row }: any) => row.errorMsg ?? '—' },
          { colKey: 'op', title: '操作', width: 240, fixed: 'right',
            render: ({ row }: any) => row.grade === 'PREMIUM' && (row.status === 'MANUAL_PENDING' || row.status === 'MANUAL_DOING') ? (
              <>
                {row.status === 'MANUAL_PENDING' && (
                  <Button size="small" variant="text" theme="primary" onClick={() => act(row, 'claim')}>接单</Button>
                )}
                <Button size="small" variant="text" onClick={() => openMaterials(row)}>素材</Button>
                <Button size="small" variant="text" theme="success" onClick={() => openDeliver(row)}>交付</Button>
                <Button size="small" variant="text" theme="danger" onClick={() => act(row, 'fail')}>失败退款</Button>
              </>
            ) : (
              <span style={{ color: '#999' }}>—</span>
            ),
          },
        ]}
      />

      {/* 交付成片 */}
      <Dialog header={`交付成片 · 任务 #${deliverRow?.id ?? ''}`} visible={!!deliverRow} onClose={() => setDeliverRow(null)} onConfirm={submitDeliver} width={560}>
        <Form labelWidth={110}>
          <Form.FormItem label="成片 COS Key" status={deliverForm.resultKey ? undefined : 'error'}>
            <Input value={deliverForm.resultKey} onChange={(v) => setDeliverForm((f) => ({ ...f, resultKey: v as string }))}
              placeholder="如 renders/12/35.mp4（剪辑成品上传 COS 后的 Key）" />
          </Form.FormItem>
          <Form.FormItem label="封面 Key（可选）">
            <Input value={deliverForm.previewKey} onChange={(v) => setDeliverForm((f) => ({ ...f, previewKey: v as string }))} />
          </Form.FormItem>
          <Form.FormItem label="成片时长（秒，可选）">
            <InputNumber value={deliverForm.durationSec ? Number(deliverForm.durationSec) : undefined}
              onChange={(v) => setDeliverForm((f) => ({ ...f, durationSec: v === undefined ? '' : String(v) }))} min={0} />
          </Form.FormItem>
        </Form>
        <div style={{ color: '#999', fontSize: 12 }}>交付后立即结算用户积分（按提交时冻结金额），任务标记完成，用户端即可播放。</div>
      </Dialog>

      {/* 素材清单 */}
      <Dialog header={`素材清单 · 任务 #${materials?.row.id ?? ''}`} visible={!!materials} footer={false} onClose={() => setMaterials(null)} width={680}>
        <Table
          rowKey="seq"
          size="small"
          data={materials?.list ?? []}
          columns={[
            { colKey: 'seq', title: '#', width: 50 },
            { colKey: 'line', title: '口播文案', ellipsis: true, render: ({ row }: any) => row.line ?? '—' },
            { colKey: 'dur', title: '时长', width: 90, render: ({ row }: any) => {
              const d = row.trimEndMs && row.trimEndMs > row.trimStartMs ? row.trimEndMs - row.trimStartMs : row.durationMs
              return d ? `${Math.round(d / 1000)}s` : '—'
            } },
            { colKey: 'op', title: '下载', width: 90, render: ({ row }: any) => row.playUrl
              ? <a href={row.playUrl} target="_blank" rel="noreferrer">下载</a>
              : <span style={{ color: '#999' }}>演示环境</span> },
          ]}
        />
        <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>签名链接 1 小时内有效；演示环境未配置 COS，仅展示素材信息。</div>
      </Dialog>
    </div>
  )
}
