import { useEffect, useState } from 'react'
import { Table, Button, Tag, Dialog, Form, Input, InputNumber, Select, Switch, message } from 'tdesign-react'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

interface AiScene {
  id: string
  code: string
  name: string
  promptTemplate: string
  fallbackTemplate: string | null
  defaultModelId: string
  fallbackModelIds: number[] | string[]
  beanPrice: string
  timeoutMs: number
  maxRetries: number
  enabled: boolean
}

interface AiModel { id: string; modelCode: string; displayName: string; provider: { code: string; name: string } }

export default function AiScenesPage() {
  const [list, setList] = useState<AiScene[]>([])
  const [models, setModels] = useState<AiModel[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<AiScene | null>(null)
  const [form, setForm] = useState({
    code: '', name: '', promptTemplate: '', fallbackTemplate: '',
    defaultModelId: '', fallbackModelIds: '' as string, // comma sep
    beanPrice: '5', timeoutMs: 30000, maxRetries: 2, enabled: true,
  })

  const load = async () => {
    try {
      const [s, m] = await Promise.all([
        request<AiScene[]>({ url: '/ai/scenes' }),
        request<AiModel[]>({ url: '/ai/models' }),
      ])
      setList(s)
      setModels(m)
    } catch {
      message.error('加载失败')
    }
  }
  useEffect(() => { void load() }, [])

  const startCreate = () => {
    setEditing(null)
    setForm({
      code: '', name: '', promptTemplate: '', fallbackTemplate: '',
      defaultModelId: models[0]?.id ?? '', fallbackModelIds: '',
      beanPrice: '5', timeoutMs: 30000, maxRetries: 2, enabled: true,
    })
    setOpen(true)
  }
  const startEdit = (s: AiScene) => {
    setEditing(s)
    setForm({
      code: s.code, name: s.name, promptTemplate: s.promptTemplate,
      fallbackTemplate: s.fallbackTemplate ?? '',
      defaultModelId: s.defaultModelId,
      fallbackModelIds: Array.isArray(s.fallbackModelIds) ? s.fallbackModelIds.join(',') : '',
      beanPrice: String(s.beanPrice), timeoutMs: s.timeoutMs, maxRetries: s.maxRetries, enabled: s.enabled,
    })
    setOpen(true)
  }

  const submit = async () => {
    const fallbackIds = form.fallbackModelIds.split(',').map((s) => Number(s.trim())).filter((n) => n > 0)
    const payload = {
      ...form,
      fallbackModelIds: fallbackIds,
      temperature: null,
      maxOutputTokens: null,
    }
    try {
      if (editing) await request({ url: `/ai/scenes/${editing.id}`, method: 'PUT', data: payload })
      else await request({ url: '/ai/scenes', method: 'POST', data: payload })
      message.success('已保存')
      setOpen(false)
      void load()
    } catch {}
  }

  const remove = async (s: AiScene) => {
    const ok = await confirmDialog('删除场景', `确认删除「${s.name}」？`)
    if (!ok) return
    try {
      await request({ url: `/ai/scenes/${s.id}`, method: 'DELETE' })
      message.success('已删除')
      void load()
    } catch {}
  }

  const modelOpt = (m: AiModel) => ({ label: `${m.provider.code} / ${m.modelCode} - ${m.displayName}`, value: m.id })

  return (
    <div>
      <div className="page-header">
        <h2>AI 场景 · 提示词与默认/备用模型</h2>
        <Button theme="primary" onClick={startCreate}>新增场景</Button>
      </div>
      <Table
        rowKey="id"
        data={list}
        columns={[
          { colKey: 'code', title: '编码', width: 200 },
          { colKey: 'name', title: '名称' },
          { colKey: 'beanPrice', title: '标价(豆)', width: 90 },
          { colKey: 'timeoutMs', title: '超时(ms)', width: 100 },
          { colKey: 'enabled', title: '启用', width: 80, render: ({ row }: any) => row.enabled ? <Tag theme="success">是</Tag> : <Tag>否</Tag> },
          { colKey: 'op', title: '操作', width: 160, fixed: 'right',
            render: ({ row }: any) => (
              <>
                <Button size="small" variant="text" onClick={() => startEdit(row)}>编辑</Button>
                <Button size="small" variant="text" theme="danger" onClick={() => remove(row)}>删除</Button>
              </>
            ),
          },
        ]}
      />

      <Dialog header={editing ? '编辑场景' : '新增场景'} visible={open} onClose={() => setOpen(false)} onConfirm={submit} width={720}>
        <Form labelWidth={120}>
          <Form.FormItem label="编码"><Input value={form.code} onChange={(v) => setForm((f) => ({ ...f, code: v as string }))} placeholder="如 copy_generate" /></Form.FormItem>
          <Form.FormItem label="名称"><Input value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v as string }))} /></Form.FormItem>
          <Form.FormItem label="提示词模板"><Input value={form.promptTemplate} onChange={(v) => setForm((f) => ({ ...f, promptTemplate: v as string }))} placeholder="支持 {{variable}}" /></Form.FormItem>
          <Form.FormItem label="兜底模板"><Input value={form.fallbackTemplate} onChange={(v) => setForm((f) => ({ ...f, fallbackTemplate: v as string }))} placeholder="通道全挂时返回" /></Form.FormItem>
          <Form.FormItem label="默认模型">
            <Select value={form.defaultModelId} onChange={(v) => setForm((f) => ({ ...f, defaultModelId: v as string }))} options={models.map(modelOpt)} filterable />
          </Form.FormItem>
          <Form.FormItem label="备用模型 ID（逗号）"><Input value={form.fallbackModelIds} onChange={(v) => setForm((f) => ({ ...f, fallbackModelIds: v as string }))} placeholder="11,14,15" /></Form.FormItem>
          <Form.FormItem label="标价(豆)"><InputNumber value={Number(form.beanPrice)} onChange={(v) => setForm((f) => ({ ...f, beanPrice: String(v as number) }))} min={0} /></Form.FormItem>
          <Form.FormItem label="超时(ms)"><InputNumber value={form.timeoutMs} onChange={(v) => setForm((f) => ({ ...f, timeoutMs: v as number }))} min={1000} /></Form.FormItem>
          <Form.FormItem label="重试次数"><InputNumber value={form.maxRetries} onChange={(v) => setForm((f) => ({ ...f, maxRetries: v as number }))} min={0} /></Form.FormItem>
          <Form.FormItem label="启用"><Switch value={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v as boolean }))} /></Form.FormItem>
        </Form>
      </Dialog>
    </div>
  )
}
