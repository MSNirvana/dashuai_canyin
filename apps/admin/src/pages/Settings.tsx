import { useEffect, useState, useMemo } from 'react'
import { Table, Button, Tag, Dialog, Form, Input, InputNumber, Select, Switch, message } from 'tdesign-react'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

interface Setting {
  id: string
  groupKey: string
  settingKey: string
  settingVal: string
  valueType: 'STRING' | 'INT' | 'BOOL' | 'JSON' | 'DECIMAL'
  displayName: string
  description: string | null
  sort: number
  isPublic: boolean
}

const TYPES: Setting['valueType'][] = ['STRING', 'INT', 'BOOL', 'JSON', 'DECIMAL']

export default function SettingsPage() {
  const [list, setList] = useState<Setting[]>([])
  const [group, setGroup] = useState<string | undefined>('bean')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Setting | null>(null)
  const [form, setForm] = useState({
    groupKey: 'bean', settingKey: '', settingVal: '', valueType: 'STRING' as Setting['valueType'],
    displayName: '', description: '', sort: 0, isPublic: false,
  })

  const load = () =>
    request<Setting[]>({ url: '/settings' })
      .then(setList)
      .catch(() => message.error('加载失败'))
  useEffect(() => { void load() }, [])

  const groups = useMemo(() => Array.from(new Set(list.map((s) => s.groupKey))), [list])

  const filtered = list.filter((s) => group ? s.groupKey === group : true)

  const startCreate = () => {
    setEditing(null)
    setForm({ groupKey: group ?? 'bean', settingKey: '', settingVal: '', valueType: 'STRING', displayName: '', description: '', sort: 0, isPublic: false })
    setOpen(true)
  }
  const startEdit = (s: Setting) => {
    setEditing(s)
    setForm({
      groupKey: s.groupKey, settingKey: s.settingKey, settingVal: s.settingVal,
      valueType: s.valueType, displayName: s.displayName, description: s.description ?? '',
      sort: s.sort, isPublic: s.isPublic,
    })
    setOpen(true)
  }

  const submit = async () => {
    try {
      if (editing) await request({ url: `/settings/${editing.id}`, method: 'PUT', data: form })
      else await request({ url: '/settings', method: 'POST', data: form })
      message.success('已保存')
      setOpen(false)
      void load()
    } catch {}
  }

  const remove = async (s: Setting) => {
    const ok = await confirmDialog('删除配置', `删除「${s.settingKey}」？运行中的进程可能缓存该值，重启后生效。`)
    if (!ok) return
    try {
      await request({ url: `/settings/${s.id}`, method: 'DELETE' })
      message.success('已删除')
      void load()
    } catch {}
  }

  return (
    <div>
      <div className="page-header">
        <h2>系统配置</h2>
        <div>
          <Select value={group} onChange={(v) => setGroup((v as string) || undefined)} clearable placeholder="全部分组" style={{ width: 180, marginRight: 12 }}
            options={groups.map((g) => ({ label: g, value: g }))} />
          <Button theme="primary" onClick={startCreate}>新增配置</Button>
        </div>
      </div>

      <Table
        rowKey="id"
        data={filtered}
        columns={[
          { colKey: 'groupKey', title: '分组', width: 110 },
          { colKey: 'settingKey', title: '键', width: 180 },
          { colKey: 'settingVal', title: '值', render: ({ row }: any) => <code style={{ fontSize: 12 }}>{row.settingVal}</code> },
          { colKey: 'valueType', title: '类型', width: 100, render: ({ row }: any) => <Tag>{row.valueType}</Tag> },
          { colKey: 'displayName', title: '显示名' },
          { colKey: 'isPublic', title: '公开', width: 80, render: ({ row }: any) => row.isPublic ? <Tag theme="primary">是</Tag> : <Tag>否</Tag> },
          { colKey: 'sort', title: '排序', width: 80 },
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

      <Dialog header={editing ? '编辑配置' : '新增配置'} visible={open} onClose={() => setOpen(false)} onConfirm={submit} width={600}>
        <Form labelWidth={120}>
          <Form.FormItem label="分组"><Input value={form.groupKey} onChange={(v) => setForm((f) => ({ ...f, groupKey: v as string }))} /></Form.FormItem>
          <Form.FormItem label="键"><Input value={form.settingKey} onChange={(v) => setForm((f) => ({ ...f, settingKey: v as string }))} /></Form.FormItem>
          <Form.FormItem label="值"><Input value={form.settingVal} onChange={(v) => setForm((f) => ({ ...f, settingVal: v as string }))} /></Form.FormItem>
          <Form.FormItem label="类型">
            <Select value={form.valueType} onChange={(v) => setForm((f) => ({ ...f, valueType: v as Setting['valueType'] }))} options={TYPES.map((t) => ({ label: t, value: t }))} />
          </Form.FormItem>
          <Form.FormItem label="显示名"><Input value={form.displayName} onChange={(v) => setForm((f) => ({ ...f, displayName: v as string }))} /></Form.FormItem>
          <Form.FormItem label="描述"><Input value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v as string }))} /></Form.FormItem>
          <Form.FormItem label="排序"><InputNumber value={form.sort} onChange={(v) => setForm((f) => ({ ...f, sort: v as number }))} /></Form.FormItem>
          <Form.FormItem label="小程序端可见"><Switch value={form.isPublic} onChange={(v) => setForm((f) => ({ ...f, isPublic: v as boolean }))} /></Form.FormItem>
        </Form>
      </Dialog>
    </div>
  )
}
