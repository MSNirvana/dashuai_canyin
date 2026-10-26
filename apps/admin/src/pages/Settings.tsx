import { useEffect, useState, useMemo } from 'react'
import { Button, Tag, Dialog, Input, InputNumber, Select, Switch, message } from 'tdesign-react'
import DataTable from '../lib/table'
import Field, { FieldGroup } from '../components/Field'
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
const COLOR_SETTINGS = [
  { key: 'color_brightness', label: '亮度' },
  { key: 'color_contrast', label: '对比度' },
  { key: 'color_saturation', label: '饱和度' },
  { key: 'color_sharpen', label: '锐化' },
] as const

/**
 * 基本美颜。与调色同页面、但**独立成卡片**：区间只有非负 0~100。
 * ★ 服务端校验也按 0~100 单独一条（validateRenderBeautySetting），
 *   填负数会被拒，报错文案与调色不同。
 */
const BEAUTY_SETTINGS = [{ key: 'beauty_smooth', label: '磨皮' }] as const

export default function SettingsPage() {
  const [list, setList] = useState<Setting[]>([])
  const [group, setGroup] = useState<string | undefined>('bean')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Setting | null>(null)
  const [colorDraft, setColorDraft] = useState<Record<string, number>>({})
  const [beautyDraft, setBeautyDraft] = useState<Record<string, number>>({})
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
  const colorSettings = COLOR_SETTINGS.map((item) => ({
    ...item,
    setting: list.find((s) => s.groupKey === 'render' && s.settingKey === item.key),
  }))
  const beautySettings = BEAUTY_SETTINGS.map((item) => ({
    ...item,
    setting: list.find((s) => s.groupKey === 'render' && s.settingKey === item.key),
  }))

  const updateColorSetting = async (setting: Setting) => {
    const value = colorDraft[setting.settingKey] ?? Number(setting.settingVal)
    if (!Number.isInteger(value) || value < -100 || value > 100) {
      message.warning('请输入 -100 到 100 之间的整数')
      return
    }
    if (String(value) === setting.settingVal) return
    try {
      await request({
        url: `/settings/${setting.id}`,
        method: 'PUT',
        data: { ...setting, settingVal: String(value) },
      })
      setList((current) => current.map((item) => item.id === setting.id ? { ...item, settingVal: String(value) } : item))
      message.success('调色参数已保存，最迟 60 秒内用于新开始的 AI 合成')
    } catch {}
  }

  const updateBeautySetting = async (setting: Setting) => {
    const value = beautyDraft[setting.settingKey] ?? Number(setting.settingVal)
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      message.warning('磨皮强度请输入 0 到 100 之间的整数')
      return
    }
    if (String(value) === setting.settingVal) return
    try {
      await request({
        url: `/settings/${setting.id}`,
        method: 'PUT',
        data: { ...setting, settingVal: String(value) },
      })
      setList((current) => current.map((item) => item.id === setting.id ? { ...item, settingVal: String(value) } : item))
      message.success('美颜参数已保存，最迟 60 秒内用于新开始的 AI 合成')
    } catch {}
  }

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

      <div className="form-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>AI 成片调色</h3>
        <p style={{ marginTop: 0, color: 'var(--td-text-color-secondary)' }}>
          统一作用于新开始的 AI 合成。范围 -100～100；保持 0 时不添加对应滤镜，也不会增加额外处理。
        </p>
        <FieldGroup labelWidth={120}>
          {colorSettings.map(({ key, label, setting }) => (
            <Field key={key} label={label}>
              {setting ? (
                <InputNumber
                  value={colorDraft[key] ?? Number(setting.settingVal)}
                  min={-100}
                  max={100}
                  step={1}
                  onChange={(value) => setColorDraft((current) => ({ ...current, [key]: Number(value) }))}
                  onBlur={() => void updateColorSetting(setting)}
                  style={{ width: 220 }}
                />
              ) : (
                <span style={{ color: 'var(--td-error-color)' }}>配置未初始化，请先运行调色配置初始化脚本</span>
              )}
            </Field>
          ))}
        </FieldGroup>
      </div>

      <div className="form-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>基本美颜设置</h3>
        <p style={{ marginTop: 0, color: 'var(--td-text-color-secondary)' }}>
          统一作用于新开始的 AI 合成。范围 0～100；保持 0 时不添加磨皮滤镜，也不会增加额外处理。
          磨皮是全画面的双边滤波，不区分皮肤与背景，调得过高会连菜品纹理一起抹平。
        </p>
        <FieldGroup labelWidth={120}>
          {beautySettings.map(({ key, label, setting }) => (
            <Field key={key} label={label}>
              {setting ? (
                <InputNumber
                  value={beautyDraft[key] ?? Number(setting.settingVal)}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(value) => setBeautyDraft((current) => ({ ...current, [key]: Number(value) }))}
                  onBlur={() => void updateBeautySetting(setting)}
                  style={{ width: 220 }}
                />
              ) : (
                <span style={{ color: 'var(--td-error-color)' }}>配置未初始化，请先运行调色配置初始化脚本</span>
              )}
            </Field>
          ))}
        </FieldGroup>
      </div>

      <DataTable
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
        <FieldGroup labelWidth={120}>
          <Field label="分组"><Input value={form.groupKey} onChange={(v) => setForm((f) => ({ ...f, groupKey: v as string }))} /></Field>
          <Field label="键"><Input value={form.settingKey} onChange={(v) => setForm((f) => ({ ...f, settingKey: v as string }))} /></Field>
          <Field label="值"><Input value={form.settingVal} onChange={(v) => setForm((f) => ({ ...f, settingVal: v as string }))} /></Field>
          <Field label="类型">
            <Select value={form.valueType} onChange={(v) => setForm((f) => ({ ...f, valueType: v as Setting['valueType'] }))} options={TYPES.map((t) => ({ label: t, value: t }))} />
          </Field>
          <Field label="显示名"><Input value={form.displayName} onChange={(v) => setForm((f) => ({ ...f, displayName: v as string }))} /></Field>
          <Field label="描述"><Input value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v as string }))} /></Field>
          <Field label="排序"><InputNumber value={form.sort} onChange={(v) => setForm((f) => ({ ...f, sort: v as number }))} /></Field>
          <Field label="小程序端可见"><Switch value={form.isPublic} onChange={(v) => setForm((f) => ({ ...f, isPublic: v as boolean }))} /></Field>
        </FieldGroup>
      </Dialog>
    </div>
  )
}
