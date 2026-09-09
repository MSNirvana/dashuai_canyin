import { useEffect, useState } from 'react'
import { Table, Button, Tag, Dialog, Form, Input, InputNumber, Select, Switch, message } from 'tdesign-react'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

interface AiModel {
  id: string
  providerId: string
  modelCode: string
  displayName: string
  capability: string
  maxContextTokens: number | null
  maxOutputTokens: number | null
  inputPricePerMtok: number
  outputPricePerMtok: number
  enabled: boolean
  provider: { code: string; name: string }
}

export default function AiModelsPage() {
  const [list, setList] = useState<AiModel[]>([])
  const [providers, setProviders] = useState<{ id: string; name: string; code: string }[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<AiModel | null>(null)
  const [form, setForm] = useState({
    providerId: '', modelCode: '', displayName: '', capability: 'TEXT',
    maxContextTokens: 0 as number, maxOutputTokens: 0 as number,
    inputPricePerMtok: 0, outputPricePerMtok: 0, enabled: true,
  })

  const load = async () => {
    try {
      const [m, p] = await Promise.all([
        request<AiModel[]>({ url: '/ai/models' }),
        request<{ id: string; name: string; code: string }[]>({ url: '/ai/providers' }),
      ])
      setList(m)
      setProviders(p)
    } catch {
      message.error('加载失败')
    }
  }
  useEffect(() => { void load() }, [])

  const startCreate = () => {
    setEditing(null)
    setForm({
      providerId: providers[0]?.id ?? '', modelCode: '', displayName: '', capability: 'TEXT',
      maxContextTokens: 0, maxOutputTokens: 0,
      inputPricePerMtok: 0, outputPricePerMtok: 0, enabled: true,
    })
    setOpen(true)
  }
  const startEdit = (m: AiModel) => {
    setEditing(m)
    setForm({
      providerId: m.providerId, modelCode: m.modelCode, displayName: m.displayName, capability: m.capability,
      maxContextTokens: m.maxContextTokens ?? 0, maxOutputTokens: m.maxOutputTokens ?? 0,
      inputPricePerMtok: m.inputPricePerMtok, outputPricePerMtok: m.outputPricePerMtok, enabled: m.enabled,
    })
    setOpen(true)
  }

  const submit = async () => {
    const payload = {
      ...form,
      maxContextTokens: form.maxContextTokens || null,
      maxOutputTokens: form.maxOutputTokens || null,
    }
    try {
      if (editing) await request({ url: `/ai/models/${editing.id}`, method: 'PUT', data: payload })
      else await request({ url: '/ai/models', method: 'POST', data: payload })
      message.success('已保存')
      setOpen(false)
      void load()
    } catch {}
  }

  const remove = async (m: AiModel) => {
    const ok = await confirmDialog('删除模型', `将清理该模型的调用日志，确认删除「${m.displayName}」？`)
    if (!ok) return
    try {
      await request({ url: `/ai/models/${m.id}`, method: 'DELETE' })
      message.success('已删除')
      void load()
    } catch {}
  }

  return (
    <div>
      <div className="page-header">
        <h2>AI 模型 / 价格</h2>
        <Button theme="primary" onClick={startCreate}>新增模型</Button>
      </div>
      <Table
        rowKey="id"
        data={list}
        columns={[
          { colKey: 'displayName', title: '显示名' },
          { colKey: 'modelCode', title: 'modelCode' },
          { colKey: 'provider', title: '通道', width: 160, render: ({ row }: any) => `${row.provider.code} - ${row.provider.name}` },
          { colKey: 'capability', title: '能力', width: 90 },
          { colKey: 'inputPricePerMtok', title: '输入(分/MTok)', width: 130 },
          { colKey: 'outputPricePerMtok', title: '输出(分/MTok)', width: 130 },
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

      <Dialog header={editing ? '编辑模型' : '新增模型'} visible={open} onClose={() => setOpen(false)} onConfirm={submit} width={560}>
        <Form labelWidth={120}>
          <Form.FormItem label="通道">
            <Select value={form.providerId} onChange={(v) => setForm((f) => ({ ...f, providerId: v as string }))}
              options={providers.map((p) => ({ label: `${p.code} - ${p.name}`, value: p.id }))} />
          </Form.FormItem>
          <Form.FormItem label="Model Code"><Input value={form.modelCode} onChange={(v) => setForm((f) => ({ ...f, modelCode: v as string }))} placeholder="如 deepseek-v3" /></Form.FormItem>
          <Form.FormItem label="显示名"><Input value={form.displayName} onChange={(v) => setForm((f) => ({ ...f, displayName: v as string }))} /></Form.FormItem>
          <Form.FormItem label="能力"><Input value={form.capability} onChange={(v) => setForm((f) => ({ ...f, capability: v as string }))} /></Form.FormItem>
          <Form.FormItem label="上下文上限(tokens)"><InputNumber value={form.maxContextTokens} onChange={(v) => setForm((f) => ({ ...f, maxContextTokens: v as number }))} min={0} /></Form.FormItem>
          <Form.FormItem label="最大输出(tokens)"><InputNumber value={form.maxOutputTokens} onChange={(v) => setForm((f) => ({ ...f, maxOutputTokens: v as number }))} min={0} /></Form.FormItem>
          <Form.FormItem label="输入(分/MTok)"><InputNumber value={form.inputPricePerMtok} onChange={(v) => setForm((f) => ({ ...f, inputPricePerMtok: v as number }))} min={0} /></Form.FormItem>
          <Form.FormItem label="输出(分/MTok)"><InputNumber value={form.outputPricePerMtok} onChange={(v) => setForm((f) => ({ ...f, outputPricePerMtok: v as number }))} min={0} /></Form.FormItem>
          <Form.FormItem label="启用"><Switch value={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v as boolean }))} /></Form.FormItem>
        </Form>
      </Dialog>
    </div>
  )
}
