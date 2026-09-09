import { useEffect, useState } from 'react'
import { Table, Button, Tag, Dialog, Form, Input, InputNumber, Switch, Select, message, Space } from 'tdesign-react'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

interface Provider {
  id: string
  code: string
  name: string
  providerType: string
  protocol: string
  baseUrl: string
  apiKeyMasked: string | null
  enabled: boolean
  priority: number
  healthStatus: string
  lastTestAt: string | null
  lastTestLatencyMs: number | null
  lastTestStatus: string | null
  lastTestError: string | null
  monthlyBudgetFen: number | null
  usedBudgetFen: number
}

const EMPTY: Partial<Provider> & { apiKey: string } = {
  code: '',
  name: '',
  providerType: 'OPENAI',
  protocol: 'OPENAI_COMPATIBLE',
  baseUrl: '',
  apiKey: '',
  enabled: true,
  priority: 100,
  monthlyBudgetFen: null,
}

export default function AiProvidersPage() {
  const [list, setList] = useState<Provider[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [form, setForm] = useState({ ...EMPTY })

  const load = () =>
    request<Provider[]>({ url: '/ai/providers' })
      .then(setList)
      .catch(() => message.error('加载失败'))

  useEffect(() => { void load() }, [])

  const startCreate = () => { setEditing(null); setForm({ ...EMPTY }); setOpen(true) }
  const startEdit = (p: Provider) => {
    setEditing(p)
    setForm({
      code: p.code, name: p.name, providerType: p.providerType, protocol: p.protocol as any,
      baseUrl: p.baseUrl, apiKey: '', enabled: p.enabled, priority: p.priority,
      monthlyBudgetFen: p.monthlyBudgetFen,
    })
    setOpen(true)
  }

  const submit = async () => {
    const payload: any = { ...form }
    if (!payload.apiKey) delete payload.apiKey
    try {
      if (editing) await request({ url: `/ai/providers/${editing.id}`, method: 'PUT', data: payload })
      else await request({ url: '/ai/providers', method: 'POST', data: payload })
      message.success('已保存')
      setOpen(false)
      void load()
    } catch {}
  }

  const remove = async (p: Provider) => {
    const ok = await confirmDialog('删除 AI 通道', `将一并清理其下模型与调用日志，确认删除「${p.name}」？`)
    if (!ok) return
    try {
      await request({ url: `/ai/providers/${p.id}`, method: 'DELETE' })
      message.success('已删除')
      void load()
    } catch {}
  }

  const toggle = async (p: Provider) => {
    try {
      await request({ url: `/ai/providers/${p.id}/enable`, method: 'POST', data: { enabled: !p.enabled } })
      message.success('已切换')
      void load()
    } catch {}
  }

  const testOne = async (p: Provider) => {
    // 找到第一个 enabled 模型
    const models = await request<{ id: string; modelCode: string; providerId: string }[]>({ url: '/ai/models', params: { providerId: p.id } })
    const m = models[0]
    if (!m) { message.warning('该通道没有可用模型，无法测试'); return }
    const r = await request<{ ok: boolean; latencyMs: number; errorMsg: string | null }>({
      url: `/ai/providers/${p.id}/test`,
      method: 'POST',
      data: { modelCode: m.modelCode },
    })
    if (r.ok) message.success(`${p.name} 测试成功 · 延迟 ${r.latencyMs}ms`)
    else message.error(`${p.name} 失败: ${r.errorMsg ?? '未知'}`)
    void load()
  }

  const testAll = async () => {
    const r = await request<{ providerId: string; code: string; ok: boolean; latencyMs: number; errorMsg: string | null }[]>({
      url: '/ai/providers/test-all',
      method: 'POST',
    })
    void load()
    const ok = r.filter((x) => x.ok).length
    message.success(`测试完成：${ok}/${r.length} 通过`)
    console.log(r)
  }

  return (
    <div>
      <div className="page-header">
        <h2>AI 通道配置</h2>
        <Space>
          <Button onClick={testAll}>一键测试全部</Button>
          <Button theme="primary" onClick={startCreate}>新增通道</Button>
        </Space>
      </div>
      <Table
        rowKey="id"
        data={list}
        columns={[
          { colKey: 'name', title: '名称' },
          { colKey: 'code', title: '编码', width: 140 },
          { colKey: 'providerType', title: '类型', width: 110 },
          { colKey: 'protocol', title: '协议', width: 160 },
          { colKey: 'baseUrl', title: 'Base URL', render: ({ row }: any) => <code style={{ fontSize: 12 }}>{row.baseUrl}</code> },
          { colKey: 'apiKeyMasked', title: 'Key (掩码)', width: 150, render: ({ row }: any) => row.apiKeyMasked ?? <span className="muted">未配</span> },
          { colKey: 'priority', title: '优先级', width: 90 },
          { colKey: 'enabled', title: '启用', width: 80, render: ({ row }: any) => row.enabled ? <Tag theme="success">是</Tag> : <Tag>否</Tag> },
          { colKey: 'healthStatus', title: '健康', width: 110,
            render: ({ row }: any) => <Tag theme={row.healthStatus === 'DOWN' ? 'danger' : row.healthStatus === 'DEGRADED' ? 'warning' : 'success'}>{row.healthStatus}</Tag>,
          },
          { colKey: 'lastTest', title: '最近测试', width: 180,
            render: ({ row }: any) => row.lastTestAt ? `${new Date(row.lastTestAt).toLocaleString()} · ${row.lastTestStatus}` : '—',
          },
          { colKey: 'budget', title: '月预算(分)/已用', width: 150, render: ({ row }: any) => row.monthlyBudgetFen ? `${row.usedBudgetFen}/${row.monthlyBudgetFen}` : '不限' },
          { colKey: 'op', title: '操作', width: 240, fixed: 'right',
            render: ({ row }: any) => (
              <Space size="small">
                <Button size="small" variant="text" onClick={() => toggle(row)}>{row.enabled ? '停用' : '启用'}</Button>
                <Button size="small" variant="text" onClick={() => testOne(row)}>测试</Button>
                <Button size="small" variant="text" onClick={() => startEdit(row)}>编辑</Button>
                <Button size="small" variant="text" theme="danger" onClick={() => remove(row)}>删除</Button>
              </Space>
            ),
          },
        ]}
      />

      <Dialog
        header={editing ? '编辑通道' : '新增通道'}
        visible={open}
        onClose={() => setOpen(false)}
        onConfirm={submit}
        width={600}
      >
        <Form labelWidth={120}>
          <Form.FormItem label="编码"><Input value={form.code} onChange={(v) => setForm((s) => ({ ...s, code: v as string }))} placeholder="如 deepseek-main" /></Form.FormItem>
          <Form.FormItem label="名称"><Input value={form.name} onChange={(v) => setForm((s) => ({ ...s, name: v as string }))} /></Form.FormItem>
          <Form.FormItem label="类型">
            <Select value={form.providerType} onChange={(v) => setForm((s) => ({ ...s, providerType: v as string }))}
              options={['OPENAI', 'DEEPSEEK', 'ANTHROPIC', 'QWEN', 'DOUBAO', 'HUNYUAN', 'CUSTOM'].map((v) => ({ label: v, value: v }))} />
          </Form.FormItem>
          <Form.FormItem label="协议">
            <Select value={form.protocol} onChange={(v) => setForm((s) => ({ ...s, protocol: v as string }))}
              options={[{ label: 'OPENAI_COMPATIBLE', value: 'OPENAI_COMPATIBLE' }, { label: 'ANTHROPIC_NATIVE', value: 'ANTHROPIC_NATIVE' }]} />
          </Form.FormItem>
          <Form.FormItem label="Base URL"><Input value={form.baseUrl} onChange={(v) => setForm((s) => ({ ...s, baseUrl: v as string }))} placeholder="https://api.deepseek.com/v1" /></Form.FormItem>
          <Form.FormItem label={editing ? '新 API Key（留空不变）' : 'API Key'}>
            <Input
              type="password"
              value={form.apiKey}
              onChange={(v) => setForm((s) => ({ ...s, apiKey: v as string }))}
              placeholder={editing ? '不修改请留空' : 'sk-...'}
            />
          </Form.FormItem>
          <Form.FormItem label="优先级"><InputNumber value={form.priority} onChange={(v) => setForm((s) => ({ ...s, priority: v as number }))} min={0} /></Form.FormItem>
          <Form.FormItem label="月预算(分)">
            <InputNumber value={form.monthlyBudgetFen ?? undefined} onChange={(v) => setForm((s) => ({ ...s, monthlyBudgetFen: (v as number) ?? null }))} placeholder="不填=不限" />
          </Form.FormItem>
          <Form.FormItem label="启用"><Switch value={!!form.enabled} onChange={(v) => setForm((s) => ({ ...s, enabled: v as boolean }))} /></Form.FormItem>
        </Form>
      </Dialog>
    </div>
  )
}
