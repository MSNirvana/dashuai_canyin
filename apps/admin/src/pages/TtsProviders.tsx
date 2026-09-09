import { useEffect, useState } from 'react'
import { Table, Button, Tag, Dialog, Form, Input, InputNumber, Switch, message } from 'tdesign-react'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

interface Tts {
  id: string
  code: string
  name: string
  appId: string | null
  voiceId: string | null
  enabled: boolean
  priority: number
  hasApiKey: boolean
  hasSecretId: boolean
  updatedAt: string
}

const EMPTY = { code: '', name: '', appId: '', secretId: '', apiKey: '', voiceId: '', enabled: true, priority: 100 }

export default function TtsProvidersPage() {
  const [list, setList] = useState<Tts[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Tts | null>(null)
  const [form, setForm] = useState({ ...EMPTY })

  const load = () =>
    request<Tts[]>({ url: '/tts/providers' })
      .then(setList)
      .catch(() => message.error('加载失败'))
  useEffect(() => { void load() }, [])

  const startCreate = () => {
    setEditing(null)
    setForm({ ...EMPTY })
    setOpen(true)
  }
  const startEdit = (p: Tts) => {
    setEditing(p)
    setForm({
      code: p.code, name: p.name, appId: p.appId ?? '', secretId: '', apiKey: '',
      voiceId: p.voiceId ?? '', enabled: p.enabled, priority: p.priority,
    })
    setOpen(true)
  }

  const submit = async () => {
    const payload: Record<string, unknown> = { name: form.name, appId: form.appId || null, voiceId: form.voiceId || null, enabled: form.enabled, priority: form.priority }
    if (form.secretId) payload.secretId = form.secretId
    if (form.apiKey) payload.apiKey = form.apiKey
    try {
      if (editing) {
        await request({ url: `/tts/providers/${editing.code}`, method: 'PUT', data: payload })
      } else {
        await request({ url: `/tts/providers/${form.code}`, method: 'PUT', data: { ...payload, code: form.code } })
      }
      message.success('已保存')
      setOpen(false)
      void load()
    } catch {}
  }

  const remove = async (p: Tts) => {
    const ok = await confirmDialog('删除 TTS 供应商', `删除「${p.name}」？`)
    if (!ok) return
    try {
      await request({ url: `/tts/providers/${p.code}`, method: 'DELETE' })
      message.success('已删除')
      void load()
    } catch {}
  }

  const toggle = async (p: Tts) => {
    try {
      await request({ url: `/tts/providers/${p.code}/enable`, method: 'POST', data: { enabled: !p.enabled } })
      message.success('已切换')
      void load()
    } catch {}
  }

  return (
    <div>
      <div className="page-header">
        <h2>TTS 供应商（腾讯云 / 火山 / 自定义）</h2>
        <Button theme="primary" onClick={startCreate}>新增</Button>
      </div>
      <Table
        rowKey="code"
        data={list}
        columns={[
          { colKey: 'name', title: '名称' },
          { colKey: 'code', title: '编码', width: 140 },
          { colKey: 'appId', title: 'AppID', width: 160 },
          { colKey: 'hasSecretId', title: 'SecretID', width: 100, render: ({ row }: any) => row.hasSecretId ? <Tag theme="success">已配</Tag> : <span className="muted">缺</span> },
          { colKey: 'hasApiKey', title: 'API Key', width: 100, render: ({ row }: any) => row.hasApiKey ? <Tag theme="success">已配</Tag> : <span className="muted">缺</span> },
          { colKey: 'voiceId', title: '默认音色', width: 160, render: ({ row }: any) => row.voiceId ?? '—' },
          { colKey: 'priority', title: '优先级', width: 90 },
          { colKey: 'enabled', title: '启用', width: 80, render: ({ row }: any) => row.enabled ? <Tag theme="success">是</Tag> : <Tag>否</Tag> },
          { colKey: 'op', title: '操作', width: 240, fixed: 'right',
            render: ({ row }: any) => (
              <>
                <Button size="small" variant="text" onClick={() => toggle(row)}>{row.enabled ? '停用' : '启用'}</Button>
                <Button size="small" variant="text" onClick={() => startEdit(row)}>编辑</Button>
                <Button size="small" variant="text" theme="danger" onClick={() => remove(row)}>删除</Button>
              </>
            ),
          },
        ]}
      />

      <Dialog header={editing ? '编辑供应商' : '新增供应商'} visible={open} onClose={() => setOpen(false)} onConfirm={submit} width={560}>
        <Form labelWidth={120}>
          <Form.FormItem label="编码">
            <Input value={form.code} onChange={(v) => setForm((f) => ({ ...f, code: v as string }))} disabled={!!editing} placeholder="tencent / volcano / 自定义" />
          </Form.FormItem>
          <Form.FormItem label="名称"><Input value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v as string }))} /></Form.FormItem>
          <Form.FormItem label="AppID">
            <Input value={form.appId ?? ''} onChange={(v) => setForm((f) => ({ ...f, appId: v as string }))} placeholder="腾讯云需填" />
          </Form.FormItem>
          <Form.FormItem label={editing ? '新 SecretID（留空不变）' : 'SecretID'}>
            <Input type="password" value={form.secretId} onChange={(v) => setForm((f) => ({ ...f, secretId: v as string }))} />
          </Form.FormItem>
          <Form.FormItem label={editing ? '新 API Key（留空不变）' : 'API Key'}>
            <Input type="password" value={form.apiKey} onChange={(v) => setForm((f) => ({ ...f, apiKey: v as string }))} placeholder="sk-..." />
          </Form.FormItem>
          <Form.FormItem label="默认音色">
            <Input value={form.voiceId ?? ''} onChange={(v) => setForm((f) => ({ ...f, voiceId: v as string }))} placeholder="如 BV001_streaming" />
          </Form.FormItem>
          <Form.FormItem label="优先级"><InputNumber value={form.priority} onChange={(v) => setForm((f) => ({ ...f, priority: v as number }))} min={0} /></Form.FormItem>
          <Form.FormItem label="启用"><Switch value={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v as boolean }))} /></Form.FormItem>
        </Form>
      </Dialog>
    </div>
  )
}
