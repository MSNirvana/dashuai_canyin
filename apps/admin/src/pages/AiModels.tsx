import { useEffect, useState } from 'react'
import { Button, Tag, Dialog, Input, InputNumber, Select, Switch, message, Space } from 'tdesign-react'
import DataTable from '../lib/table'
import Field, { FieldGroup } from '../components/Field'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

/**
 * 模型能力（ai_model.capability）的可选值。
 *
 * ★ 必须与服务端 `server/src/ai/model-capabilities.ts::MODEL_CAPABILITIES` **逐字一致**：
 *   服务端路由用 `z.enum` 校验 —— 这里少一个值 = 某个能力永远选不出来；
 *   这里多一个值 = 保存时直接被 400 拒绝，而报错只显示「参数错误」。
 *   两个包互相独立（前端不能 import 服务端代码），所以这是**故意复制的镜像**，改请两边一起改。
 *
 * 为什么必须改成下拉：这个字段是**分类字段**（后台筛选 / 场景选模型都要读它），
 * 原来的自由文本框里出现 `text` / `TEXT ` / `对话` 都合法，筛选会静默漏掉这些行。
 */
const CAPABILITIES = [
  { value: 'TEXT', label: '文本 TEXT' },
  { value: 'VISION', label: '视觉 VISION' },
  { value: 'IMAGE', label: '图像 IMAGE' },
  { value: 'VIDEO', label: '视频 VIDEO' },
  { value: 'TTS', label: '语音 TTS' },
  { value: 'EMBEDDING', label: '向量 EMBEDDING' },
] as const

const CAPABILITY_LABELS: Record<string, string> = {
  TEXT: '文本',
  VISION: '视觉',
  IMAGE: '图像',
  VIDEO: '视频',
  TTS: '语音',
  EMBEDDING: '向量',
}

/** 存量行可能是历史自由文本（大小写/空格不一致），归一后再喂给 Select，否则下拉显示空白 */
function normalizeCapability(v: unknown): string {
  const up = typeof v === 'string' ? v.trim().toUpperCase() : ''
  return CAPABILITIES.some((c) => c.value === up) ? up : 'TEXT'
}

/** 列表里只显示中文（下拉里才需要「文本 TEXT」这种带代码的形式） */
function capLabel(v: unknown): string {
  const key = normalizeCapability(v)
  return CAPABILITY_LABELS[key] ?? key
}

/**
 * 「默认三条顶级模型」预置模板。
 *
 * 价格不是编的：取自生产库实际入库值（分/百万 token），与
 * `server/scripts/setup-ai-channels.ts` 的 PRICES 同源，依据见 `deploy/AI通道配置-2026-09-15.md`。
 * 点模板只是替运营省去手抄单价 —— **它不改变任何默认路由**（候选链在 ai_scene 上，这里不动）。
 *
 * ⚠ 上下文 / 输出上限是**仅供后台记录**的展示字段：网关真正使用的输出上限是
 *   `ai_scene.max_output_tokens`（见 gateway.ts），模型级这两个字段目前不参与调用与计费。
 *   填它们是为了把「这个模型大概能吃多少」留个档，别把它当成生效中的限制。
 *
 * channelHint 用来顺手选中同名字通道（按 code / name 子串匹配，匹配不到就保持原选择）。
 */
const MODEL_PRESETS = [
  {
    key: 'gpt', label: 'GPT', channelHint: 'gpt',
    modelCode: 'gpt-5.5', displayName: 'GPT（gpt-5.5）', capability: 'TEXT',
    maxContextTokens: 400000, maxOutputTokens: 128000,
    inputPricePerMtok: 2880, outputPricePerMtok: 17280,
  },
  {
    key: 'claude', label: 'Claude', channelHint: 'claude',
    modelCode: 'claude-sonnet-5', displayName: 'Claude（claude-sonnet-5）', capability: 'TEXT',
    maxContextTokens: 200000, maxOutputTokens: 64000,
    inputPricePerMtok: 2880, outputPricePerMtok: 14400,
  },
  {
    key: 'deepseek', label: 'DeepSeek', channelHint: 'deepseek',
    modelCode: 'deepseek-v4-flash', displayName: 'DeepSeek（deepseek-v4-flash）', capability: 'TEXT',
    maxContextTokens: 128000, maxOutputTokens: 8192,
    inputPricePerMtok: 864, outputPricePerMtok: 3456,
  },
] as const

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
    unitPriceMicroFen: number
  enabled: boolean
  provider: { code: string; name: string }
}

/** 通道下拉只需要这几个字段，但每一个都参与排序/标注，别退化成 {id,name,code} */
interface ProviderLite {
  id: string
  code: string
  name: string
  enabled: boolean
  healthStatus: string
  autoDisabled: boolean
  lastTestLatencyMs: number | null
  lastTestStatus: string | null
}

export default function AiModelsPage() {
  const [list, setList] = useState<AiModel[]>([])
  const [providers, setProviders] = useState<ProviderLite[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<AiModel | null>(null)
  const [form, setForm] = useState({
    providerId: '', modelCode: '', displayName: '', capability: 'TEXT',
    maxContextTokens: 0 as number, maxOutputTokens: 0 as number,
    inputPricePerMtok: 0, outputPricePerMtok: 0, unitPriceMicroFen: 0, enabled: true,
  })

  const load = async () => {
    try {
      const [m, p] = await Promise.all([
        request<AiModel[]>({ url: '/ai/models' }),
        request<ProviderLite[]>({ url: '/ai/providers' }),
      ])
      setList(m)
      setProviders(p)
    } catch {
      message.error('加载失败')
    }
  }
  useEffect(() => { void load() }, [])

  /**
   * 通道下拉的顺序：先看「现在能不能用」，再看实测延迟。
   *
   * 为什么不沿用接口顺序（enabled desc, priority asc）：那是**人工优先级**，
   * 下拉里看不出「这条已经 DOWN / 被自动停用 / 上次探测就失败」—— 于是很容易
   * 把一个此刻明显更差的通道选成主通道。排序只是**建议顺序**，不改变任何已存在的候选链。
   */
  const rank = (p: ProviderLite) => (p.enabled ? 0 : 2) + (p.healthStatus === 'HEALTHY' ? 0 : 1)
  const latencyOf = (p: ProviderLite) =>
    p.lastTestStatus === 'SUCCESS' && p.lastTestLatencyMs != null
      ? p.lastTestLatencyMs
      : Number.POSITIVE_INFINITY
  const sortedProviders = [...providers].sort((a, b) => {
    const d = rank(a) - rank(b)
    if (d !== 0) return d
    const d2 = latencyOf(a) - latencyOf(b)
    if (d2 !== 0) return d2
    return a.code.localeCompare(b.code)
  })

  const providerLabel = (p: ProviderLite) => {
    // 把「不可用」的原因直接写进选项文案：运营在这里看到的必须是**此刻的状态**，不是历史优先级
    const notes: string[] = []
    if (!p.enabled) notes.push(p.autoDisabled ? '自动停用' : '已停用')
    else if (p.lastTestStatus === 'FAILED') notes.push('上次探测失败')
    else if (p.lastTestLatencyMs != null) notes.push(`${p.lastTestLatencyMs}ms`)
    else if (p.healthStatus !== 'HEALTHY') notes.push(p.healthStatus)
    return `${p.code} - ${p.name}${notes.length ? `（${notes.join(' · ')}）` : ''}`
  }

  const startCreate = () => {
    setEditing(null)
    setForm({
      providerId: providers[0]?.id ?? '', modelCode: '', displayName: '', capability: 'TEXT',
      maxContextTokens: 0, maxOutputTokens: 0,
      inputPricePerMtok: 0, outputPricePerMtok: 0, unitPriceMicroFen: 0, enabled: true,
    })
    setOpen(true)
  }
  const startEdit = (m: AiModel) => {
    setEditing(m)
    setForm({
      providerId: m.providerId, modelCode: m.modelCode, displayName: m.displayName,
      // ★ 归一后再塞进表单：存量行若带历史自由文本，Select 会显示成空白（看起来像"没选"），
      //   直接保存就等于把该行能力悄悄改成空值
      capability: normalizeCapability(m.capability),
      maxContextTokens: m.maxContextTokens ?? 0, maxOutputTokens: m.maxOutputTokens ?? 0,
      inputPricePerMtok: m.inputPricePerMtok, outputPricePerMtok: m.outputPricePerMtok,
      unitPriceMicroFen: m.unitPriceMicroFen ?? 0,
      enabled: m.enabled,
    })
    setOpen(true)
  }

  /** 一键填入「顶级模型」模板；顺带按 channelHint 选中同名通道（找不到就保持原选） */
  const applyPreset = (preset: (typeof MODEL_PRESETS)[number]) => {
    const hit = sortedProviders.find(
      (p) =>
        p.code.toLowerCase().includes(preset.channelHint) ||
        p.name.toLowerCase().includes(preset.channelHint),
    )
    setForm((f) => ({
      ...f,
      providerId: hit?.id ?? f.providerId,
      modelCode: preset.modelCode,
      displayName: preset.displayName,
      capability: preset.capability,
      maxContextTokens: preset.maxContextTokens,
      maxOutputTokens: preset.maxOutputTokens,
      inputPricePerMtok: preset.inputPricePerMtok,
      outputPricePerMtok: preset.outputPricePerMtok,
      unitPriceMicroFen: 0,
    }))
    if (hit) message.success(`已填入 ${preset.label} · 通道 ${hit.code}`)
    else message.warning(`已填入 ${preset.label}，但没有找到名字含「${preset.channelHint}」的通道，请手动选`)
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
      <DataTable
        rowKey="id"
        data={list}
        columns={[
          { colKey: 'displayName', title: '显示名' },
          { colKey: 'modelCode', title: 'modelCode' },
          // 注意：tdesign Table 渲染表头时也会调用 render，此时 row 为空，必须判空（否则整页崩）
          { colKey: 'provider', title: '通道', width: 160, render: ({ row }: any) => (row?.provider ? `${row.provider.code} - ${row.provider.name}` : '通道') },
          { colKey: 'capability', title: '能力', width: 110, render: ({ row }: any) => (row ? capLabel(row.capability) : '能力') },
          { colKey: 'inputPricePerMtok', title: '输入(分/MTok)', width: 130 },
          { colKey: 'outputPricePerMtok', title: '输出(分/MTok)', width: 130 },
          { colKey: 'unitPriceMicroFen', title: '图片(微分/张)', width: 130 },
          { colKey: 'enabled', title: '启用', width: 80, render: ({ row }: any) => (row ? (row.enabled ? <Tag theme="success">是</Tag> : <Tag>否</Tag>) : '启用') },
          { colKey: 'op', title: '操作', width: 160, fixed: 'right',
            render: ({ row }: any) =>
              row?.id ? (
                <>
                  <Button size="small" variant="text" onClick={() => startEdit(row)}>编辑</Button>
                  <Button size="small" variant="text" theme="danger" onClick={() => remove(row)}>删除</Button>
                </>
              ) : null,
          },
        ]}
      />

      <Dialog header={editing ? '编辑模型' : '新增模型'} visible={open} onClose={() => setOpen(false)} onConfirm={submit} width={600}>
        <FieldGroup labelWidth={120}>
          {!editing && (
            <Field label="顶级模型">
              {/* 只在新增时出现：编辑态已经有确定身份，这排按钮会把既存模型改成别的模型 */}
              <Space size="small">
                {MODEL_PRESETS.map((p) => (
                  <Button key={p.key} size="small" variant="outline" onClick={() => applyPreset(p)}>
                    {p.label}
                  </Button>
                ))}
              </Space>
            </Field>
          )}
          <Field label="通道">
            <Select value={form.providerId} onChange={(v) => setForm((f) => ({ ...f, providerId: v as string }))}
              options={sortedProviders.map((p) => ({ label: providerLabel(p), value: p.id }))} />
          </Field>
          <Field label="Model Code"><Input value={form.modelCode} onChange={(v) => setForm((f) => ({ ...f, modelCode: v as string }))} placeholder="如 deepseek-v3" /></Field>
          <Field label="显示名"><Input value={form.displayName} onChange={(v) => setForm((f) => ({ ...f, displayName: v as string }))} /></Field>
          <Field label="能力">
            <Select value={form.capability} onChange={(v) => setForm((f) => ({ ...f, capability: v as string }))}
              options={CAPABILITIES.map((c) => ({ label: c.label, value: c.value }))} />
          </Field>
          <Field label="上下文上限(tokens)"><InputNumber value={form.maxContextTokens} onChange={(v) => setForm((f) => ({ ...f, maxContextTokens: v as number }))} min={0} /></Field>
          <Field label="最大输出(tokens)"><InputNumber value={form.maxOutputTokens} onChange={(v) => setForm((f) => ({ ...f, maxOutputTokens: v as number }))} min={0} /></Field>
          <Field label="输入(分/MTok)"><InputNumber value={form.inputPricePerMtok} onChange={(v) => setForm((f) => ({ ...f, inputPricePerMtok: v as number }))} min={0} /></Field>
          <Field label="输出(分/MTok)"><InputNumber value={form.outputPricePerMtok} onChange={(v) => setForm((f) => ({ ...f, outputPricePerMtok: v as number }))} min={0} /></Field>
          <Field label="图片(微分/张)"><InputNumber value={form.unitPriceMicroFen} onChange={(v) => setForm((f) => ({ ...f, unitPriceMicroFen: v as number }))} min={0} /></Field>
          <Field label="启用"><Switch value={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v as boolean }))} /></Field>
        </FieldGroup>
      </Dialog>
    </div>
  )
}
