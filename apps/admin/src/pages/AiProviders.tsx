import { useEffect, useState } from 'react'
import { Button, Tag, Dialog, Input, InputNumber, Switch, Select, message, Space } from 'tdesign-react'
import DataTable from '../lib/table'
import Field, { FieldGroup } from '../components/Field'
import { confirmDialog } from '../lib/confirm'
// 时间走统一口径（原来是 toLocaleString()，格式随浏览器语言变、还带秒）
import { fmtMinute } from '../lib/datetime'
import { request } from '../lib/http'

interface Provider {
  id: string
  code: string
  name: string
  providerType: string
  protocol: string
  baseUrl: string
  apiKeyMasked: string | null
  enabled: boolean
  priority: number
  healthStatus: string
  /** 这行的 enabled=false 是健康体检 sweeper 自己写的（探测恢复后会自动打开），不是运营手动停用 */
  autoDisabled: boolean
  lastTestAt: string | null
  lastTestLatencyMs: number | null
  lastTestStatus: string | null
  lastTestError: string | null
  monthlyBudgetFen: number | null
  usedBudgetFen: number
}

const EMPTY: Partial<Provider> & { apiKey: string } = {
  code: '',
  name: '',
  providerType: 'OPENAI',
  protocol: 'OPENAI_COMPATIBLE',
  baseUrl: '',
  apiKey: '',
  enabled: true,
  priority: 100,
  monthlyBudgetFen: null,
}

/**
 * 手动健康体检（POST /ai/providers/health-sweep）的返回体。
 * ★ 它只回「有没有启动」，不回结果：一轮体检最坏约 18.5 分钟（3 通道 × 4 轮 × 90s），
 *   远超 nginx 的 300s 读超时，同步等只会拿到 504 而通道其实已经改了状态。
 */
interface SweepTriggerResult {
  started: boolean
  reason?: string
}

export default function AiProvidersPage() {
  const [list, setList] = useState<Provider[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [form, setForm] = useState({ ...EMPTY })
  const [sweeping, setSweeping] = useState(false)

  const load = () =>
    request<Provider[]>({ url: '/ai/providers' })
      .then(setList)
      .catch(() => message.error('加载失败'))

  useEffect(() => { void load() }, [])

  const startCreate = () => { setEditing(null); setForm({ ...EMPTY }); setOpen(true) }
  const startEdit = (p: Provider) => {
    setEditing(p)
    setForm({
      code: p.code, name: p.name, providerType: p.providerType, protocol: p.protocol as any,
      baseUrl: p.baseUrl, apiKey: '', enabled: p.enabled, priority: p.priority,
      monthlyBudgetFen: p.monthlyBudgetFen,
    })
    setOpen(true)
  }

  const submit = async () => {
    const payload: any = { ...form }
    if (!payload.apiKey) delete payload.apiKey
    try {
      if (editing) await request({ url: `/ai/providers/${editing.id}`, method: 'PUT', data: payload })
      else await request({ url: '/ai/providers', method: 'POST', data: payload })
      message.success('已保存')
      setOpen(false)
      void load()
    } catch {}
  }

  const remove = async (p: Provider) => {
    const ok = await confirmDialog('删除 AI 通道', `将一并清理其下模型与调用日志，确认删除「${p.name}」？`)
    if (!ok) return
    try {
      await request({ url: `/ai/providers/${p.id}`, method: 'DELETE' })
      message.success('已删除')
      void load()
    } catch {}
  }

  /**
   * 手动触发一轮健康体检（与常驻 sweeper 同一段逻辑）。
   * 与「一键测试全部」的区别：那个只读（只写 last_test_*），这个**会真的改启用状态**。
   */
  const healthSweep = async () => {
    setSweeping(true)
    try {
      const r = await request<SweepTriggerResult>({ url: '/ai/providers/health-sweep', method: 'POST' })
      if (!r.started) {
        message.warning(r.reason ?? '体检已在进行中，请稍后刷新列表')
        return
      }
      message.success('体检已在后台开始（通常 1~3 分钟）')
      // 体检是异步跑的：列表里的「最近测试 / 启用 / 健康」会在过程中逐步变化，
      // 这里自动刷两次，省得运营自己盯着按刷新（按钮的 loading 只管触发那一次请求）。
      window.setTimeout(() => void load(), 20_000)
      window.setTimeout(() => void load(), 90_000)
    } catch {
      // 拦截器已提示；这里只负责恢复按钮状态
    } finally {
      setSweeping(false)
    }
  }

  const toggle = async (p: Provider) => {
    try {
      await request({ url: `/ai/providers/${p.id}/enable`, method: 'POST', data: { enabled: !p.enabled } })
      message.success('已切换')
      void load()
    } catch {}
  }

  const testOne = async (p: Provider) => {
    // 找到第一个 enabled 模型
    const models = await request<{ id: string; modelCode: string; providerId: string }[]>({ url: '/ai/models', params: { providerId: p.id } })
    const m = models[0]
    if (!m) { message.warning('该通道没有可用模型，无法测试'); return }
    const r = await request<{ ok: boolean; latencyMs: number; errorMsg: string | null }>({
      url: `/ai/providers/${p.id}/test`,
      method: 'POST',
      data: { modelCode: m.modelCode },
      // ★ 必须放大超时：探活请求体改成了内容型。旧写法发 'ping'，其读数**不可复现**
      //   （同一形态实测有过 200/4.9s、400、200 但耗 90s），拿它判活判死都会错；
      //   而内容型 gpt-5.5 实测要 36~52s 才回完，
      //   而 axios 实例默认 30s —— 不放大就会「前端先放弃、后端成功」，
      //   症状正是运营最熟悉的那句「点了没反应」。服务端 nginx 读超时是 300s。
      timeout: 120_000,
    })
    if (r.ok) message.success(`${p.name} 测试成功 · 延迟 ${r.latencyMs}ms`)
    else message.error(`${p.name} 失败: ${r.errorMsg ?? '未知'}`)
    void load()
  }

  const testAll = async () => {
    const r = await request<{ providerId: string; code: string; ok: boolean; latencyMs: number; errorMsg: string | null }[]>({
      url: '/ai/providers/test-all',
      method: 'POST',
      // 同上：并发测 3 条通道，慢的那条（gpt）本身就要 ~45s
      timeout: 180_000,
    })
    void load()
    const ok = r.filter((x) => x.ok).length
    message.success(`测试完成：${ok}/${r.length} 通过`)
    // 原来这里是一句 console.log(r) 调试残留（r 里含各通道的 errorMsg，可能带敏感信息）。
    // 但「哪些通道没过」这条信息本身有用，所以改成提示给操作者，而不是删掉了事。
    const failed = r.filter((x) => !x.ok)
    if (failed.length) {
      const names = failed.map((x) => x.code).join('、')
      message.warning(`${failed.length} 个通道未通过：${names}（鼠标悬停对应行可看具体报错）`)
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>AI 通道配置</h2>
        <Space>
          <Button onClick={testAll}>一键测试全部</Button>
          <Button onClick={healthSweep} loading={sweeping}>立即体检</Button>
          <Button theme="primary" onClick={startCreate}>新增通道</Button>
        </Space>
      </div>
      <p className="muted" style={{ margin: '-8px 0 12px' }}>
        健康体检每 30 分钟自动跑一轮：探测失败的通道会被自动停用（标记「自动停用」），探测恢复后自动启用。
        最近 24 小时内有真实调用成功的通道不会被探测、也不会被停用（真实证据优先于合成探测）。
        它只改启用状态，不改候选顺序、不改优先级。「立即体检」在后台异步执行（约 1~3 分钟），会真的改启用状态。
        「一键测试全部」是只读的，只刷新最近测试结果。
      </p>
      <DataTable
        rowKey="id"
        data={list}
        columns={[
          { colKey: 'name', title: '名称' },
          { colKey: 'code', title: '编码', width: 140 },
          { colKey: 'providerType', title: '类型', width: 110 },
          { colKey: 'protocol', title: '协议', width: 160 },
          { colKey: 'baseUrl', title: 'Base URL', render: ({ row }: any) => <code style={{ fontSize: 12 }}>{row.baseUrl}</code> },
          { colKey: 'apiKeyMasked', title: 'Key (掩码)', width: 150, render: ({ row }: any) => row.apiKeyMasked ?? <span className="muted">未配</span> },
          { colKey: 'priority', title: '优先级', width: 90 },
          { colKey: 'enabled', title: '启用', width: 110,
            render: ({ row }: any) =>
              !row?.id ? '启用'
                : row.enabled ? <Tag theme="success">是</Tag>
                  : row.autoDisabled ? (
                    // 与人工「停用」必须长得不一样：否则运营会以为是自己关的，去点「启用」
                    // 却又被下一轮体检关掉，看起来像「按钮没生效」
                    <Tag theme="warning">自动停用</Tag>
                  ) : <Tag>否</Tag>,
          },
          { colKey: 'healthStatus', title: '健康', width: 110,
            render: ({ row }: any) => <Tag theme={row.healthStatus === 'DOWN' ? 'danger' : row.healthStatus === 'DEGRADED' ? 'warning' : 'success'}>{row.healthStatus}</Tag>,
          },
          { colKey: 'lastTest', title: '最近测试', width: 180,
            render: ({ row }: any) => row.lastTestAt ? `${fmtMinute(row.lastTestAt)} · ${row.lastTestStatus}` : '—',
          },
          { colKey: 'budget', title: '月预算(分)/已用', width: 150, render: ({ row }: any) => row.monthlyBudgetFen ? `${row.usedBudgetFen}/${row.monthlyBudgetFen}` : '不限' },
          { colKey: 'op', title: '操作', width: 240, fixed: 'right',
            render: ({ row }: any) => (
              <Space size="small">
                <Button size="small" variant="text" onClick={() => toggle(row)}>{row.enabled ? '停用' : '启用'}</Button>
                <Button size="small" variant="text" onClick={() => testOne(row)}>测试</Button>
                <Button size="small" variant="text" onClick={() => startEdit(row)}>编辑</Button>
                <Button size="small" variant="text" theme="danger" onClick={() => remove(row)}>删除</Button>
              </Space>
            ),
          },
        ]}
      />

      <Dialog
        header={editing ? '编辑通道' : '新增通道'}
        visible={open}
        onClose={() => setOpen(false)}
        onConfirm={submit}
        width={600}
      >
        <FieldGroup labelWidth={120}>
          <Field label="编码"><Input value={form.code} onChange={(v) => setForm((s) => ({ ...s, code: v as string }))} placeholder="如 deepseek-main" /></Field>
          <Field label="名称"><Input value={form.name} onChange={(v) => setForm((s) => ({ ...s, name: v as string }))} /></Field>
          <Field label="类型">
            <Select value={form.providerType} onChange={(v) => setForm((s) => ({ ...s, providerType: v as string }))}
              options={['OPENAI', 'DEEPSEEK', 'ANTHROPIC', 'QWEN', 'DOUBAO', 'HUNYUAN', 'CUSTOM'].map((v) => ({ label: v, value: v }))} />
          </Field>
          <Field label="协议">
            <Select value={form.protocol} onChange={(v) => setForm((s) => ({ ...s, protocol: v as string }))}
              options={[{ label: 'OPENAI_COMPATIBLE', value: 'OPENAI_COMPATIBLE' }, { label: 'ANTHROPIC_NATIVE', value: 'ANTHROPIC_NATIVE' }]} />
          </Field>
          <Field label="Base URL"><Input value={form.baseUrl} onChange={(v) => setForm((s) => ({ ...s, baseUrl: v as string }))} placeholder="https://api.deepseek.com/v1" /></Field>
          <Field label={editing ? '新 API Key（留空不变）' : 'API Key'}>
            <Input
              type="password"
              value={form.apiKey}
              onChange={(v) => setForm((s) => ({ ...s, apiKey: v as string }))}
              placeholder={editing ? '不修改请留空' : 'sk-...'}
            />
          </Field>
          <Field label="优先级"><InputNumber value={form.priority} onChange={(v) => setForm((s) => ({ ...s, priority: v as number }))} min={0} /></Field>
          <Field label="月预算(分)">
            <InputNumber value={form.monthlyBudgetFen ?? undefined} onChange={(v) => setForm((s) => ({ ...s, monthlyBudgetFen: (v as number) ?? null }))} placeholder="不填=不限" />
          </Field>
          <Field
            label="启用"
            help={
              editing?.autoDisabled
                ? '当前是「自动停用」（健康体检写入）。保存本表单不会改变归属，体检通过后仍会自动启用；要长期停用（不再自动恢复）请回列表点该行的「停用」。'
                : undefined
            }
          >
            <Switch value={!!form.enabled} onChange={(v) => setForm((s) => ({ ...s, enabled: v as boolean }))} />
          </Field>
        </FieldGroup>
      </Dialog>
    </div>
  )
}
