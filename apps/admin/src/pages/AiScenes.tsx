import { useEffect, useMemo, useState } from 'react'
import { Button, Tag, Dialog, Input, Textarea, InputNumber, Select, Switch, message } from 'tdesign-react'
import DataTable from '../lib/table'
import Field, { FieldGroup } from '../components/Field'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

interface AiModelRef {
  id: string
  modelCode: string
  displayName: string
  enabled?: boolean
  provider?: { code: string; name: string }
}

interface AiScene {
  id: string
  code: string
  name: string
  promptTemplate: string
  fallbackTemplate: string | null
  defaultModelId: string
  fallbackModelIds: string[]
  beanPrice: string
  timeoutMs: number
  maxRetries: number
  temperature: number | null
  maxOutputTokens: number | null
  enabled: boolean
  hasCaller?: boolean
  callCount?: number
  /** 该场景支持的提示词变量白名单（保存时按它校验；空=未登记，不校验） */
  variables?: string[]
  defaultModel?: AiModelRef | null
  fallbackModels?: AiModelRef[]
}

interface AiModel extends AiModelRef {
  providerId: string
  enabled: boolean
  provider: { code: string; name: string }
}

/** 分组：文案创作 / 分镜脚本 / 合成增强 */
const GROUPS = [
  { key: 'all', label: '全部' },
  { key: 'copy', label: '文案创作' },
  { key: 'storyboard', label: '分镜脚本' },
  { key: 'synth', label: '合成增强' },
] as const

type GroupKey = (typeof GROUPS)[number]['key']

/** 容错：tdesign Table 渲染表头时也会调用列的 render，此时 row 为空 */
function groupOf(code?: string | null): GroupKey {
  if (typeof code !== 'string') return 'synth'
  if (code.startsWith('copy_')) return 'copy'
  if (code === 'storyboard_generate') return 'storyboard'
  return 'synth'
}

const GROUP_LABEL: Record<string, string> = {
  copy: '文案创作',
  storyboard: '分镜脚本',
  synth: '合成增强',
}

/** 模型展示名：通道码与模型码相同（如 gpt-5.6-sol）时只显示一次，避免「x / x」 */
function fmtModel(m?: AiModelRef | null): string {
  if (!m) return '—'
  const p = m.provider?.code
  return p && p !== m.modelCode ? `${p} / ${m.modelCode}` : m.modelCode
}

const emptyForm = () => ({
  code: '',
  name: '',
  promptTemplate: '',
  fallbackTemplate: '',
  defaultModelId: '',
  fallbackModelIds: [] as string[],
  beanPrice: '5',
  timeoutMs: 30000,
  maxRetries: 1,
  temperature: 0.7 as number,
  maxOutputTokens: 800 as number,
  enabled: true,
})

export default function AiScenesPage() {
  const [list, setList] = useState<AiScene[]>([])
  const [models, setModels] = useState<AiModel[]>([])
  const [filter, setFilter] = useState<GroupKey>('all')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<AiScene | null>(null)
  const [form, setForm] = useState(emptyForm())

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

  const shown = useMemo(
    () => (filter === 'all' ? list : list.filter((s) => groupOf(s.code) === filter)),
    [list, filter],
  )

  // 把模型引用、分组、状态预先拍平成纯文本列，避免在 render 里取值（表头渲染时 row 为空）
  const rows = useMemo(
    () =>
      shown.map((s) => ({
        ...s,
        groupLabel: GROUP_LABEL[groupOf(s.code)] ?? '—',
        defaultModelText: fmtModel(s.defaultModel),
        fallbackModelText: s.fallbackModels?.length
          ? s.fallbackModels.map((m) => m.modelCode).join(', ')
          : '—',
      })),
    [shown],
  )

  const liveCount = list.filter((s) => s.hasCaller).length
  const pendingCount = list.length - liveCount

  /**
   * 当前表单里场景编码支持的变量（用于把「可用变量」直接显示在编辑弹窗里）。
   * 新增场景时随编码输入联动；查不到（场景未登记白名单）就是空数组 —— 那种情况下服务端也不校验。
   */
  const allowedVars = useMemo(
    () => list.find((s) => s.code === form.code.trim())?.variables ?? [],
    [list, form.code],
  )

  const startCreate = () => {
    setEditing(null)
    setForm({ ...emptyForm(), defaultModelId: models[0]?.id ?? '' })
    setOpen(true)
  }
  const startEdit = (s: AiScene) => {
    setEditing(s)
    setForm({
      code: s.code,
      name: s.name,
      promptTemplate: s.promptTemplate,
      fallbackTemplate: s.fallbackTemplate ?? '',
      defaultModelId: s.defaultModelId,
      fallbackModelIds: Array.isArray(s.fallbackModelIds) ? s.fallbackModelIds.map(String) : [],
      beanPrice: String(s.beanPrice),
      timeoutMs: s.timeoutMs,
      maxRetries: s.maxRetries,
      temperature: s.temperature ?? 0.7,
      maxOutputTokens: s.maxOutputTokens ?? 0,
      enabled: s.enabled,
    })
    setOpen(true)
  }

  const submit = async () => {
    if (!form.code.trim() || !form.name.trim() || !form.promptTemplate.trim()) {
      message.warning('编码 / 名称 / 提示词模板为必填')
      return
    }
    if (!form.defaultModelId) {
      message.warning('请选择默认模型')
      return
    }
    const payload = {
      code: form.code.trim(),
      name: form.name.trim(),
      promptTemplate: form.promptTemplate,
      fallbackTemplate: form.fallbackTemplate || null,
      defaultModelId: form.defaultModelId,
      fallbackModelIds: form.fallbackModelIds,
      beanPrice: String(form.beanPrice),
      timeoutMs: form.timeoutMs,
      maxRetries: form.maxRetries,
      temperature: form.temperature,
      maxOutputTokens: form.maxOutputTokens > 0 ? form.maxOutputTokens : null,
      enabled: form.enabled,
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
    const ok = await confirmDialog('删除场景', `确认删除「${s.name}」？业务层若仍在调用该 sceneCode 会直接报错。`)
    if (!ok) return
    try {
      await request({ url: `/ai/scenes/${s.id}`, method: 'DELETE' })
      message.success('已删除')
      void load()
    } catch {}
  }

  const modelOpt = (m: AiModel | AiModelRef) => ({
    label: m.enabled === false ? `${fmtModel(m)}（已停用）` : fmtModel(m),
    value: m.id,
  })

  return (
    <div>
      <div className="page-header">
        <h2>AI 场景 · Skill 提示词与模型绑定</h2>
        <Button theme="primary" onClick={startCreate}>新增场景</Button>
      </div>

      <p className="page-tip">
        每个场景（Skill）对应一条可在本页编辑的提示词，业务层只传 <code>sceneCode</code> + 变量。
        共 <b>{list.length}</b> 个：已接入业务 <b>{liveCount}</b> 个、待接入 <b>{pendingCount}</b> 个。
        <br />
        模板变量：<code>{'{{storeName}} {{category}} {{city}} {{dishName}} {{dishIntro}} {{sellingPoints}} {{persona}} {{copyText}} {{complexity}} {{complexityLabel}} {{shotCountRule}} {{shotLibrary}}'}</code>
      </p>

      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        {GROUPS.map((g) => {
          const n = g.key === 'all' ? list.length : list.filter((s) => groupOf(s.code) === g.key).length
          const active = filter === g.key
          return (
            <Button
              key={g.key}
              size="small"
              variant={active ? 'base' : 'outline'}
              theme={active ? 'primary' : 'default'}
              onClick={() => setFilter(g.key)}
            >
              {g.label}（{n}）
            </Button>
          )
        })}
      </div>

      <DataTable
        rowKey="id"
        data={rows}
        columns={[
          { colKey: 'groupLabel', title: '分类', width: 96 },
          { colKey: 'code', title: '场景编码', width: 176 },
          { colKey: 'name', title: '名称', ellipsis: true, width: 240 },
          { colKey: 'defaultModelText', title: '默认模型', width: 180 },
          { colKey: 'fallbackModelText', title: '备用模型', width: 140 },
          { colKey: 'beanPrice', title: '冻结(豆)', width: 84 },
          { colKey: 'callCount', title: '调用次数', width: 96 },
          {
            colKey: 'status', title: '状态', width: 132,
            cell: ({ row }: any) =>
              row?.id ? (
                <>
                  {row.hasCaller
                    ? <Tag theme="success" variant="light">已接入</Tag>
                    : <Tag variant="light">待接入</Tag>}
                  {!row.enabled && <Tag theme="warning" variant="light" style={{ marginLeft: 4 }}>停用</Tag>}
                </>
              ) : null,
          },
          {
            colKey: 'op', title: '操作', width: 130, fixed: 'right',
            cell: ({ row }: any) =>
              row?.id ? (
                <>
                  <Button size="small" variant="text" onClick={() => startEdit(row)}>编辑</Button>
                  <Button size="small" variant="text" theme="danger" onClick={() => remove(row)}>删除</Button>
                </>
              ) : null,
          },
        ]}
      />

      <Dialog
        header={editing ? `编辑场景 · ${editing.code}` : '新增场景'}
        visible={open}
        onClose={() => setOpen(false)}
        onConfirm={submit}
        width={880}
      >
        <FieldGroup labelWidth={132}>
          <Field label="场景编码">
            <Input
              value={form.code}
              disabled={!!editing}
              onChange={(v) => setForm((f) => ({ ...f, code: v as string }))}
              placeholder="如 copy_traffic（业务层按此 code 调用，编辑时不可改）"
            />
          </Field>
          <Field label="名称">
            <Input value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v as string }))} />
          </Field>
          <Field
            label="提示词模板"
            help={
              allowedVars.length ? (
                <>
                  可用变量（写成 <code>{'{{变量名}}'}</code>，写错会被替换成空白且照常扣豆）：
                  {allowedVars.map((v) => (
                    <Tag key={v} variant="light" style={{ marginLeft: 6 }}>
                      {`{{${v}}}`}
                    </Tag>
                  ))}
                </>
              ) : (
                <>该场景未登记变量白名单，保存时不做变量校验（新增的自定义场景默认可写任意变量）。</>
              )
            }
          >
            <Textarea
              value={form.promptTemplate}
              onChange={(v) => setForm((f) => ({ ...f, promptTemplate: v as string }))}
              placeholder="支持 {{变量}}，如 {{storeName}} / {{storeIntro}} / {{dishName}} / {{persona}}；分镜场景另有 {{copyText}} / {{complexityLabel}} / {{shotLibrary}}"
              autosize={{ minRows: 10, maxRows: 24 }}
            />
          </Field>
          <Field label="兜底模板">
            <Textarea
              value={form.fallbackTemplate}
              onChange={(v) => setForm((f) => ({ ...f, fallbackTemplate: v as string }))}
              placeholder="所有通道失败时返回（不扣豆）；分镜/JSON 类场景请填可解析的 JSON"
              autosize={{ minRows: 3, maxRows: 10 }}
            />
          </Field>
          <Field label="默认模型">
            <Select
              value={form.defaultModelId}
              onChange={(v) => setForm((f) => ({ ...f, defaultModelId: v as string }))}
              options={models.map(modelOpt)}
              filterable
              placeholder="首选执行模型（须为已启用通道）"
            />
          </Field>
          <Field label="备用模型">
            <Select
              multiple
              value={form.fallbackModelIds}
              onChange={(v) => setForm((f) => ({ ...f, fallbackModelIds: (v as string[]) ?? [] }))}
              options={models.map(modelOpt)}
              filterable
              clearable
              placeholder="默认模型失败后按序尝试，可多选"
            />
          </Field>
          <Field label="冻结上限(豆)">
            <InputNumber value={Number(form.beanPrice)} onChange={(v) => setForm((f) => ({ ...f, beanPrice: String(v ?? 0) }))} min={0} />
          </Field>
          <Field label="超时(ms)">
            <InputNumber value={form.timeoutMs} onChange={(v) => setForm((f) => ({ ...f, timeoutMs: (v as number) ?? 30000 }))} min={1000} step={1000} />
          </Field>
          <Field label="重试次数">
            <InputNumber value={form.maxRetries} onChange={(v) => setForm((f) => ({ ...f, maxRetries: (v as number) ?? 0 }))} min={0} max={5} />
          </Field>
          <Field label="温度">
            <InputNumber value={form.temperature} onChange={(v) => setForm((f) => ({ ...f, temperature: (v as number) ?? 0.7 }))} min={0} max={2} step={0.05} />
          </Field>
          <Field label="输出上限(tokens)">
            <InputNumber value={form.maxOutputTokens} onChange={(v) => setForm((f) => ({ ...f, maxOutputTokens: (v as number) ?? 0 }))} min={0} step={100} />
          </Field>
          <Field label="启用">
            <Switch value={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v as boolean }))} />
          </Field>
        </FieldGroup>
      </Dialog>
    </div>
  )
}
