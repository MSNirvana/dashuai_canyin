import { useEffect, useState } from 'react'
import { Table, Button, Tag, Dialog, Form, Input, InputNumber, Select, Switch, message } from 'tdesign-react'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

interface Lib {
  id: string
  code: string
  name: string
  category: string
  tips: string | null
  source: string
  demoVideoKey: string | null
  demoCoverKey: string | null
  sort: number
  enabled: boolean
}

const CATEGORIES = ['FOOD_CLOSEUP', 'OWNER_TALK', 'POT_OUT', 'ENVIRONMENT', 'INGREDIENT', 'COOKING']

const EMPTY: Partial<Lib> = { code: '', name: '', category: 'FOOD_CLOSEUP', tips: '', source: 'MANUAL', demoVideoKey: '', demoCoverKey: '', sort: 0, enabled: true }

export default function ShotLibraryPage() {
  const [list, setList] = useState<Lib[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Lib | null>(null)
  const [form, setForm] = useState({ ...EMPTY })

  const load = () =>
    request<Lib[]>({ url: '/shot-library' })
      .then(setList)
      .catch(() => message.error('加载失败'))
  useEffect(() => { void load() }, [])

  const startCreate = () => { setEditing(null); setForm({ ...EMPTY }); setOpen(true) }
  const startEdit = (s: Lib) => {
    setEditing(s)
    setForm({
      code: s.code, name: s.name, category: s.category, tips: s.tips ?? '',
      source: s.source, demoVideoKey: s.demoVideoKey ?? '', demoCoverKey: s.demoCoverKey ?? '',
      sort: s.sort, enabled: s.enabled,
    })
    setOpen(true)
  }

  const submit = async () => {
    try {
      if (editing) await request({ url: `/shot-library/${editing.id}`, method: 'PUT', data: form })
      else await request({ url: '/shot-library', method: 'POST', data: form })
      message.success('已保存')
      setOpen(false)
      void load()
    } catch {}
  }

  const remove = async (s: Lib) => {
    const ok = await confirmDialog('删除镜头', `删除「${s.name}」？`)
    if (!ok) return
    try {
      await request({ url: `/shot-library/${s.id}`, method: 'DELETE' })
      message.success('已删除')
      void load()
    } catch {}
  }

  return (
    <div>
      <div className="page-header">
        <h2>镜头库（拍摄手法）</h2>
        <Button theme="primary" onClick={startCreate}>新增</Button>
      </div>
      <Table
        rowKey="id"
        data={list}
        columns={[
          { colKey: 'name', title: '名称' },
          { colKey: 'code', title: '编码', width: 200 },
          { colKey: 'category', title: '分类', width: 160 },
          { colKey: 'source', title: '来源', width: 100, render: ({ row }: any) => <Tag>{row.source}</Tag> },
          { colKey: 'tips', title: '拍摄要点', render: ({ row }: any) => row.tips ?? '—' },
          { colKey: 'sort', title: '排序', width: 80 },
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

      <Dialog header={editing ? '编辑镜头' : '新增镜头'} visible={open} onClose={() => setOpen(false)} onConfirm={submit} width={600}>
        <Form labelWidth={120}>
          <Form.FormItem label="编码"><Input value={form.code} onChange={(v) => setForm((f) => ({ ...f, code: v as string }))} placeholder="如 food_steam_closeup" /></Form.FormItem>
          <Form.FormItem label="名称"><Input value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v as string }))} /></Form.FormItem>
          <Form.FormItem label="分类">
            <Select value={form.category} onChange={(v) => setForm((f) => ({ ...f, category: v as string }))} options={CATEGORIES.map((c) => ({ label: c, value: c }))} />
          </Form.FormItem>
          <Form.FormItem label="拍摄要点"><Input value={form.tips ?? ''} onChange={(v) => setForm((f) => ({ ...f, tips: v as string }))} /></Form.FormItem>
          <Form.FormItem label="示范视频 Key"><Input value={form.demoVideoKey ?? ''} onChange={(v) => setForm((f) => ({ ...f, demoVideoKey: v as string }))} /></Form.FormItem>
          <Form.FormItem label="示范封面 Key"><Input value={form.demoCoverKey ?? ''} onChange={(v) => setForm((f) => ({ ...f, demoCoverKey: v as string }))} /></Form.FormItem>
          <Form.FormItem label="排序"><InputNumber value={form.sort} onChange={(v) => setForm((f) => ({ ...f, sort: v as number }))} /></Form.FormItem>
          <Form.FormItem label="启用"><Switch value={!!form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v as boolean }))} /></Form.FormItem>
        </Form>
      </Dialog>
    </div>
  )
}
