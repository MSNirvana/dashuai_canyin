import { useEffect, useState } from 'react'
import { Table, Button, Tag, Dialog, Form, Input, InputNumber, Switch, message } from 'tdesign-react'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

interface MemberPackage {
  id: string
  code: string
  name: string
  durationDays: number
  priceFen: number
  grantBeans: string
  rightsJson: unknown | null
  tag: string | null
  sort: number
  enabled: boolean
}

const EMPTY = {
  code: '',
  name: '',
  durationDays: 30,
  priceFen: 9800,
  grantBeans: 98000,
  rightsJson: '',
  tag: '',
  sort: 0,
  enabled: true,
}

export default function MemberPackagesPage() {
  const [list, setList] = useState<MemberPackage[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<MemberPackage | null>(null)
  const [form, setForm] = useState({ ...EMPTY })

  const load = () =>
    request<MemberPackage[]>({ url: '/member-packages' })
      .then(setList)
      .catch(() => message.error('加载失败'))

  useEffect(() => { void load() }, [])

  const startCreate = () => { setEditing(null); setForm({ ...EMPTY }); setOpen(true) }
  const startEdit = (p: MemberPackage) => {
    setEditing(p)
    setForm({
      code: p.code,
      name: p.name,
      durationDays: p.durationDays,
      priceFen: p.priceFen,
      grantBeans: Number(p.grantBeans),
      rightsJson: p.rightsJson ? JSON.stringify(p.rightsJson) : '',
      tag: p.tag ?? '',
      sort: p.sort,
      enabled: p.enabled,
    })
    setOpen(true)
  }

  const submit = async () => {
    const payload = {
      ...form,
      grantBeans: String(form.grantBeans),
      rightsJson: form.rightsJson.trim() ? (() => { try { return JSON.parse(form.rightsJson) } catch { message.error('rights JSON 格式错误'); throw new Error('bad json') } })() : undefined,
    }
    try {
      if (editing) await request({ url: `/member-packages/${editing.id}`, method: 'PUT', data: payload })
      else await request({ url: '/member-packages', method: 'POST', data: payload })
      message.success('已保存')
      setOpen(false)
      void load()
    } catch {}
  }

  const remove = async (p: MemberPackage) => {
    const ok = await confirmDialog('删除套餐', `确认删除「${p.name}」？已有订阅不受影响，但后续无法再选该套餐。`)
    if (!ok) return
    try {
      await request({ url: `/member-packages/${p.id}`, method: 'DELETE' })
      message.success('已删除')
      void load()
    } catch {}
  }

  return (
    <div>
      <div className="page-header">
        <h2>会员套餐配置</h2>
        <Button theme="primary" onClick={startCreate}>新增套餐</Button>
      </div>
      <Table
        rowKey="id"
        data={list}
        columns={[
          { colKey: 'code', title: '编码', width: 120 },
          { colKey: 'name', title: '名称' },
          { colKey: 'durationDays', title: '天数', width: 80 },
          { colKey: 'priceFen', title: '价格(分)', width: 110 },
          { colKey: 'grantBeans', title: '赠豆', width: 110 },
          { colKey: 'tag', title: '角标', width: 100, render: ({ row }: any) => row.tag ?? '—' },
          { colKey: 'enabled', title: '状态', width: 90, render: ({ row }: any) => row.enabled ? <Tag theme="success">上架</Tag> : <Tag>下架</Tag> },
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

      <Dialog
        header={editing ? '编辑套餐' : '新增套餐'}
        visible={open}
        onClose={() => setOpen(false)}
        onConfirm={submit}
        width={560}
      >
        <Form labelWidth={120}>
          <Form.FormItem label="编码"><Input value={form.code} onChange={(v) => setForm((f) => ({ ...f, code: v as string }))} placeholder="如 monthly / yearly" /></Form.FormItem>
          <Form.FormItem label="名称"><Input value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v as string }))} /></Form.FormItem>
          <Form.FormItem label="有效期(天)"><InputNumber value={form.durationDays} onChange={(v) => setForm((f) => ({ ...f, durationDays: v as number }))} min={1} /></Form.FormItem>
          <Form.FormItem label="价格(分)"><InputNumber value={form.priceFen} onChange={(v) => setForm((f) => ({ ...f, priceFen: v as number }))} min={1} /></Form.FormItem>
          <Form.FormItem label="赠豆数"><InputNumber value={form.grantBeans} onChange={(v) => setForm((f) => ({ ...f, grantBeans: v as number }))} min={0} /></Form.FormItem>
          <Form.FormItem label="权益 JSON"><Input value={form.rightsJson} onChange={(v) => setForm((f) => ({ ...f, rightsJson: v as string }))} placeholder='{"uploadQuotaGb":5}' /></Form.FormItem>
          <Form.FormItem label="角标"><Input value={form.tag ?? ''} onChange={(v) => setForm((f) => ({ ...f, tag: v as string }))} /></Form.FormItem>
          <Form.FormItem label="排序"><InputNumber value={form.sort} onChange={(v) => setForm((f) => ({ ...f, sort: v as number }))} /></Form.FormItem>
          <Form.FormItem label="上架"><Switch value={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v as boolean }))} /></Form.FormItem>
        </Form>
      </Dialog>
    </div>
  )
}
