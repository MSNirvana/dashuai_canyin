import { useEffect, useState } from 'react'
import { Table, Button, Tag, Dialog, Form, Input, InputNumber, Switch, message } from 'tdesign-react'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

interface BeanPackage {
  id: string
  name: string
  beans: string
  bonusBeans: string
  priceFen: number
  memberPriceFen: number
  tag: string | null
  sort: number
  enabled: boolean
}

const EMPTY = {
  name: '',
  beans: 0,
  bonusBeans: 0,
  priceFen: 0,
  memberPriceFen: 0,
  tag: '',
  sort: 0,
  enabled: true,
}

export default function BeanPackagesPage() {
  const [list, setList] = useState<BeanPackage[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<BeanPackage | null>(null)
  const [form, setForm] = useState({ ...EMPTY })

  const load = () =>
    request<BeanPackage[]>({ url: '/bean-packages' })
      .then(setList)
      .catch(() => message.error('加载失败'))

  useEffect(() => { void load() }, [])

  const startCreate = () => {
    setEditing(null)
    setForm({ ...EMPTY })
    setOpen(true)
  }

  const startEdit = (p: BeanPackage) => {
    setEditing(p)
    setForm({
      name: p.name,
      beans: Number(p.beans),
      bonusBeans: Number(p.bonusBeans),
      priceFen: p.priceFen,
      memberPriceFen: p.memberPriceFen,
      tag: p.tag ?? '',
      sort: p.sort,
      enabled: p.enabled,
    })
    setOpen(true)
  }

  const submit = async () => {
    const payload = {
      ...form,
      beans: String(form.beans),
      bonusBeans: String(form.bonusBeans),
    }
    try {
      if (editing) {
        await request({ url: `/bean-packages/${editing.id}`, method: 'PUT', data: payload })
      } else {
        await request({ url: '/bean-packages', method: 'POST', data: payload })
      }
      message.success('已保存')
      setOpen(false)
      void load()
    } catch {
      /* 拦截器已提示 */
    }
  }

  const remove = async (p: BeanPackage) => {
    const ok = await confirmDialog('删除加油包', `确认删除「${p.name}」？`)
    if (!ok) return
    try {
      await request({ url: `/bean-packages/${p.id}`, method: 'DELETE' })
      message.success('已删除')
      void load()
    } catch {}
  }

  return (
    <div>
      <div className="page-header">
        <h2>加油包配置</h2>
        <Button theme="primary" onClick={startCreate}>新增加油包</Button>
      </div>
      <Table
        rowKey="id"
        data={list}
        columns={[
          { colKey: 'name', title: '名称' },
          { colKey: 'beans', title: '基础豆', width: 100 },
          { colKey: 'bonusBeans', title: '赠送豆', width: 100 },
          { colKey: 'priceFen', title: '原价(分)', width: 110 },
          { colKey: 'memberPriceFen', title: '会员价(分)', width: 130 },
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
        header={editing ? '编辑加油包' : '新增加油包'}
        visible={open}
        onClose={() => setOpen(false)}
        onConfirm={submit}
        width={560}
      >
        <Form labelWidth={120}>
          <Form.FormItem label="名称">
            <Input value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v as string }))} />
          </Form.FormItem>
          <Form.FormItem label="基础豆数">
            <InputNumber value={form.beans} onChange={(v) => setForm((f) => ({ ...f, beans: v as number }))} min={0} />
          </Form.FormItem>
          <Form.FormItem label="赠送豆数">
            <InputNumber value={form.bonusBeans} onChange={(v) => setForm((f) => ({ ...f, bonusBeans: v as number }))} min={0} />
          </Form.FormItem>
          <Form.FormItem label="原价（分）">
            <InputNumber value={form.priceFen} onChange={(v) => setForm((f) => ({ ...f, priceFen: v as number }))} min={1} />
          </Form.FormItem>
          <Form.FormItem label="会员价（分）">
            <InputNumber value={form.memberPriceFen} onChange={(v) => setForm((f) => ({ ...f, memberPriceFen: v as number }))} min={1} />
          </Form.FormItem>
          <Form.FormItem label="角标">
            <Input value={form.tag ?? ''} onChange={(v) => setForm((f) => ({ ...f, tag: v as string }))} placeholder="如「热卖」「超值」" />
          </Form.FormItem>
          <Form.FormItem label="排序">
            <InputNumber value={form.sort} onChange={(v) => setForm((f) => ({ ...f, sort: v as number }))} />
          </Form.FormItem>
          <Form.FormItem label="上架">
            <Switch value={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v as boolean }))} />
          </Form.FormItem>
        </Form>
      </Dialog>
    </div>
  )
}
