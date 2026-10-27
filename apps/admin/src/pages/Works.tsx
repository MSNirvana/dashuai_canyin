import { useEffect, useState } from 'react'
import {
  Button,
  Tag,
  Dialog,
  Input,
  InputNumber,
  Select,
  Switch,
  message,
} from 'tdesign-react'
import DataTable from '../lib/table'
import Field, { FieldGroup } from '../components/Field'
import AssetUploader from '../components/AssetUploader'
import { confirmDialog } from '../lib/confirm'
import { fmtMinute } from '../lib/datetime'
import { request } from '../lib/http'

/**
 * 首页「优秀作品」运营页
 *
 * 与商家数据解耦：作品是运营内容，商家删创作 / 清素材都不会让作品消失。
 *
 * ★★★ 2026-10-26 按「现在的小程序」大幅收口。小程序那边已经变成：
 *   首页卡片 → 点一下在全屏播放器里播（`pages/home/index.tsx::playWork`），
 *   **没有详情页、没有「生成同款」、没有「套用配方」**。于是这一页里
 *   「只服务于那三个入口」的东西全部删掉了，别再加回来：
 *
 *   · **同款配方整块**（文案款式 / 镜头复杂度 / 标题建议 / 推荐音色 / 运营点评 / 分镜骨架）
 *     —— 它唯一的去向就是详情页展示 + 「生成同款」预填。`recipeJson` 列仍留在库里
 *     （历史数据不动），但后台不再读写：`PUT` 不带这个字段时服务端是**跳过**的
 *     （`work.service.ts::updateWork` 的 `input.recipeJson === undefined ? {} : …`），
 *     所以存量配方不会被清掉。
 *   · **子分类** —— 小程序首页的分类横滑是按 `category` 聚合的（`listCategories` 只 groupBy
 *     category），详情页没了之后 `subCategory` 一个展示位都没有。
 *   · **时长(秒)** —— 小程序不显示作品时长；从成片入库时服务端会自己写这个值。
 *   · **「同款」计数** —— `markWorkClone` 在小程序里已无调用点，这个数永远停在 2026-10-26，
 *     摆在列表里只会让人误以为「没人用」。
 */

interface Work {
  id: string
  title: string
  category: string
  tags: string[] | null
  coverKey: string | null
  videoKey: string | null
  sort: number
  enabled: boolean
  sourceType: string
  viewCount: number
  publishedAt: string | null
}

interface WorkListResult {
  page: number
  pageSize: number
  total: number
  hasMore: boolean
  items: Work[]
}

/** 可入库的商家成片（已入库的不会再返回） */
interface ImportableTask {
  id: string
  resultKey: string | null
  durationMs: number | null
  grade: string
  createdAt: string
  /** 合成完成时间；历史任务可能为 null ⇒ 显示时回退 createdAt */
  finishAt: string | null
  title: string | null
  storeName: string | null
  storeCategory: string | null
  merchantPhone: string | null
  merchantNickname: string | null
}

/** 分类候选：接口按 category 聚合，这里只做下拉建议，仍可自由输入 */
const CATEGORY_OPTIONS = ['餐饮', '教培', '美业', '生活服务', '休闲娱乐', '其他'].map((c) => ({
  label: c,
  value: c,
}))

/**
 * 作品视频 / 封面的上传上限。
 *
 * ⚠ 这三个数字必须同值，改一个就要改全部：
 *   · 本文件（选文件时的预校验，给运营一句人话）
 *   · server/src/services/work.service.ts 的 MAX_WORK_VIDEO_BYTES / MAX_WORK_COVER_BYTES
 *   · deploy/nginx/dashuai-admin.conf 的 client_max_body_size（110m）
 * 漏掉 nginx 那处的话本地开发（vite 直连 3000，不过 nginx）永远测不出问题，上线才 413。
 */
const MAX_WORK_VIDEO_MB = 100
const MAX_WORK_COVER_MB = 5

interface FormState {
  title: string
  category: string
  tagsText: string
  coverKey: string
  videoKey: string
  sort: number
  enabled: boolean
}

const EMPTY_FORM: FormState = {
  title: '',
  category: '餐饮',
  tagsText: '',
  coverKey: '',
  videoKey: '',
  sort: 0,
  enabled: false,
}

/** 逗号 / 顿号 / 空格都能当分隔符，运营从表格里粘贴也能用 */
function parseTags(text: string) {
  return text
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10)
}

export default function WorksPage() {
  const [list, setList] = useState<Work[]>([])
  const [loading, setLoading] = useState(false)
  const [filterCategory, setFilterCategory] = useState('')
  const [filterEnabled, setFilterEnabled] = useState('')

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Work | null>(null)
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<{ url: string; kind: 'image' | 'video' } | null>(null)
  /** 正在抽封面的作品 id，用于给按钮加 loading */
  const [coverId, setCoverId] = useState<string | null>(null)

  const [importOpen, setImportOpen] = useState(false)
  const [importTaskId, setImportTaskId] = useState('')
  const [importing, setImporting] = useState(false)
  const [tasks, setTasks] = useState<ImportableTask[]>([])
  const [tasksLoading, setTasksLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const r = await request<WorkListResult>({
        url: '/works',
        params: {
          pageSize: 100,
          ...(filterCategory ? { category: filterCategory } : {}),
          ...(filterEnabled ? { enabled: filterEnabled } : {}),
        },
      })
      setList(r.items)
    } catch {
      /* 错误已在 request 层 toast */
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    // 依赖筛选条件：改动即重新拉取
  }, [filterCategory, filterEnabled])

  const startCreate = () => {
    setEditing(null)
    setForm({ ...EMPTY_FORM })
    setOpen(true)
  }

  const startEdit = (w: Work) => {
    setEditing(w)
    setForm({
      title: w.title,
      category: w.category,
      tagsText: (w.tags ?? []).join('、'),
      coverKey: w.coverKey ?? '',
      videoKey: w.videoKey ?? '',
      sort: w.sort,
      enabled: w.enabled,
    })
    setOpen(true)
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  /**
   * 组装 payload：空串一律转 null，避免把「清空」写成了空字符串。
   * ★ 只发这一页还管得着的字段 —— `subCategory` / `durationMs` / `recipeJson` 一律不发，
   *   服务端对 `undefined` 是跳过（保留原值），所以存量数据不会被这次改版擦掉。
   */
  const buildPayload = () => ({
    title: form.title.trim(),
    category: form.category.trim(),
    tags: parseTags(form.tagsText),
    coverKey: form.coverKey.trim() || null,
    videoKey: form.videoKey.trim() || null,
    sort: form.sort ?? 0,
    enabled: form.enabled,
  })

  const submit = async () => {
    if (!form.title.trim()) return message.warning('请填写标题')
    if (!form.category.trim()) return message.warning('请填写分类')

    setSaving(true)
    try {
      const payload = buildPayload()
      if (editing) await request({ url: `/works/${editing.id}`, method: 'PUT', data: payload })
      else await request({ url: '/works', method: 'POST', data: payload })
      message.success('已保存')
      setOpen(false)
      await load()
    } catch {
      /* 已 toast */
    } finally {
      setSaving(false)
    }
  }

  /** 列表内直接上下架：不用进弹窗改 enabled 再保存 */
  const toggleEnabled = async (w: Work) => {
    try {
      await request({ url: `/works/${w.id}`, method: 'PUT', data: { enabled: !w.enabled } })
      message.success(w.enabled ? '已下架' : '已上架')
      await load()
    } catch {
      /* 已 toast */
    }
  }

  const remove = async (w: Work) => {
    const okDel = await confirmDialog('删除作品', `删除「${w.title}」？小程序首页将立即不再展示。`)
    if (!okDel) return
    try {
      await request({ url: `/works/${w.id}`, method: 'DELETE' })
      message.success('已删除')
      await load()
    } catch {
      /* 已 toast */
    }
  }

  /** 预览素材：先换签名地址，图片直接弹窗，视频交给浏览器新窗口播放 */
  const previewKey = async (key: string, kind: 'image' | 'video') => {
    try {
      const r = await request<{ url: string | null }>({
        url: '/media/preview',
        params: { key },
      })
      if (!r.url) return message.warning('该素材在当前存储下无法签名')
      if (kind === 'video') window.open(r.url, '_blank', 'noopener')
      else setPreview({ url: r.url, kind })
    } catch {
      /* 已 toast */
    }
  }

  const importFromTask = async () => {
    const taskId = importTaskId.trim()
    if (!taskId) return message.warning('请选择或填写合成任务 ID')
    setImporting(true)
    try {
      const w = await request<Work>({
        url: '/works/from-render-task',
        method: 'POST',
        data: { taskId },
      })
      message.success(`已入库草稿「${w.title}」，补齐标题、分类与封面后再上架`)
      setImportOpen(false)
      setImportTaskId('')
      await load()
    } catch {
      /* 已 toast */
    } finally {
      setImporting(false)
    }
  }

  /** 按 videoKey 重新抽一帧当封面（服务端 ffmpeg 抽帧 + 写回对象存储） */
  const genCover = async (w: Work) => {
    setCoverId(w.id)
    try {
      await request({ url: `/works/${w.id}/cover`, method: 'POST' })
      message.success('封面已抽取')
      await load()
    } catch {
      /* 已 toast：无视频 / ffmpeg 不可用 / 对象存储读不到都会给出具体原因 */
    } finally {
      setCoverId(null)
    }
  }

  /** 打开入库弹窗：拉一次可入库成片，已入库的不会出现在列表里 */
  const openImport = async () => {
    setImportTaskId('')
    setImportOpen(true)
    setTasksLoading(true)
    try {
      setTasks(await request<ImportableTask[]>({ url: '/works/importable-tasks', params: { limit: 30 } }))
    } catch {
      setTasks([])
    } finally {
      setTasksLoading(false)
    }
  }

  const fmtDuration = (ms: number | null) =>
    ms ? `${Math.round(ms / 100) / 10}s` : '—'

  return (
    <div>
      <div className="page-header">
        <h2>首页优秀作品</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="outline" onClick={openImport}>
            从成片入库
          </Button>
          <Button theme="primary" onClick={startCreate}>
            新增作品
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <span style={{ color: '#666', fontSize: 14 }}>筛选</span>
        <Select
          style={{ width: 160 }}
          value={filterCategory}
          onChange={(v) => setFilterCategory(v as string)}
          options={[{ label: '全部分类', value: '' }, ...CATEGORY_OPTIONS]}
        />
        <Select
          style={{ width: 140 }}
          value={filterEnabled}
          onChange={(v) => setFilterEnabled(v as string)}
          options={[
            { label: '全部状态', value: '' },
            { label: '已上架', value: 'true' },
            { label: '未上架', value: 'false' },
          ]}
        />
        <span style={{ color: '#999', fontSize: 13 }}>共 {list.length} 条</span>
      </div>

      <DataTable
        rowKey="id"
        loading={loading}
        data={list}
        columns={[
          { colKey: 'title', title: '标题', ellipsis: true },
          { colKey: 'category', title: '分类', width: 120 },
          {
            colKey: 'tags',
            title: '标签',
            width: 180,
            render: ({ row }: any) =>
              (row.tags ?? []).length ? (
                <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(row.tags as string[]).map((t) => (
                    <Tag key={t} variant="light">
                      {t}
                    </Tag>
                  ))}
                </span>
              ) : (
                '—'
              ),
          },
          {
            colKey: 'media',
            title: '素材',
            width: 170,
            render: ({ row }: any) => (
              <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                {row.coverKey ? (
                  <Button size="small" variant="text" onClick={() => previewKey(row.coverKey, 'image')}>
                    封面
                  </Button>
                ) : null}
                {row.videoKey ? (
                  <Button size="small" variant="text" onClick={() => previewKey(row.videoKey, 'video')}>
                    视频
                  </Button>
                ) : null}
                {row.videoKey ? (
                  <Button
                    size="small"
                    variant="text"
                    loading={coverId === row.id}
                    onClick={() => genCover(row)}
                  >
                    {row.coverKey ? '重抽封面' : '抽封面'}
                  </Button>
                ) : null}
                {!row.coverKey && !row.videoKey ? <span style={{ color: '#bbb' }}>未上传</span> : null}
              </span>
            ),
          },
          { colKey: 'sort', title: '排序', width: 70 },
          { colKey: 'viewCount', title: '浏览', width: 80 },
          {
            colKey: 'enabled',
            title: '上架',
            width: 90,
            render: ({ row }: any) =>
              row.enabled ? <Tag theme="success">已上架</Tag> : <Tag theme="warning">未上架</Tag>,
          },
          {
            colKey: 'sourceType',
            title: '来源',
            width: 100,
            render: ({ row }: any) => (
              <Tag variant="light">{row.sourceType === 'RENDER' ? '成片入库' : '手工'}</Tag>
            ),
          },
          {
            colKey: 'op',
            title: '操作',
            width: 190,
            fixed: 'right',
            render: ({ row }: any) => (
              <>
                <Button size="small" variant="text" onClick={() => startEdit(row)}>
                  编辑
                </Button>
                <Button size="small" variant="text" onClick={() => toggleEnabled(row)}>
                  {row.enabled ? '下架' : '上架'}
                </Button>
                <Button size="small" variant="text" theme="danger" onClick={() => remove(row)}>
                  删除
                </Button>
              </>
            ),
          },
        ]}
      />

      {/* ── 新增 / 编辑 ── */}
      <Dialog
        header={editing ? `编辑作品 · ${editing.title}` : '新增作品'}
        visible={open}
        onClose={() => setOpen(false)}
        onConfirm={submit}
        confirmBtn={{ content: '保存', loading: saving }}
        width={640}
      >
        <FieldGroup labelWidth={110}>
          <Field label="标题" required>
            <Input
              value={form.title}
              onChange={(v) => set('title', v as string)}
              placeholder="如 麻婆豆腐爆款短视频"
            />
          </Field>
          <Field label="分类" required help="小程序首页的「优秀作品」按分类横滑，运营自定">
            <Select
              value={form.category}
              onChange={(v) => set('category', v as string)}
              options={CATEGORY_OPTIONS}
              filterable
              creatable
              placeholder="选择或输入新分类"
            />
          </Field>
          <Field label="标签" help="最多 10 个，逗号 / 顿号 / 空格分隔；首页卡片只展示前 2 个">
            <Input value={form.tagsText} onChange={(v) => set('tagsText', v as string)} placeholder="如 高翻台、出餐快" />
          </Field>
          <Field
            label="封面 Key"
            help="COS 对象键，与合成成片同一存储；填好后点列表「封面」可预览。也可以直接在下面选一张图上传（≤5MB），上传后键会填进这一栏。首页卡片会完整显示整张封面，建议竖版 9:16。"
          >
            <Input value={form.coverKey} onChange={(v) => set('coverKey', v as string)} placeholder="选填" />
            <div style={{ marginTop: 8 }}>
              <AssetUploader
                endpoint="/works/upload"
                kind="cover"
                accept="image/*"
                maxMb={MAX_WORK_COVER_MB}
                uploadLabel="选择封面并上传"
                value={form.coverKey}
                onClear={() => set('coverKey', '')}
                onUploaded={(r) => set('coverKey', r.coverKey ?? form.coverKey)}
              />
            </div>
          </Field>
          <Field
            label="视频 Key"
            help="私有桶，播放地址每次访问重新签名（1 小时有效）。也可以直接在下面选本地视频上传（≤100MB，MP4 / MOV / WebM / AVI），上传后会自动抽一帧当封面。没有视频的作品，小程序里点卡片只会提示「还没有可播放的成片」。"
          >
            <Input value={form.videoKey} onChange={(v) => set('videoKey', v as string)} placeholder="选填" />
            <div style={{ marginTop: 8 }}>
              <AssetUploader
                endpoint="/works/upload"
                kind="video"
                accept="video/*"
                maxMb={MAX_WORK_VIDEO_MB}
                uploadLabel="选择视频并上传"
                value={form.videoKey}
                onClear={() => set('videoKey', '')}
                onUploaded={(r) =>
                  setForm((f) => ({
                    ...f,
                    videoKey: r.videoKey ?? f.videoKey,
                    // 服务端会顺手抽首帧当封面，但**只在运营没有手选封面时**补上，不覆盖人工选择
                    coverKey: f.coverKey || r.coverKey || '',
                  }))
                }
              />
            </div>
          </Field>
          <Field label="排序" help="数字越小越靠前">
            <InputNumber value={form.sort} onChange={(v) => set('sort', (v as number) ?? 0)} />
          </Field>
          <Field label="立即上架" help="未上架的作品只存在于后台，小程序首页看不到">
            <Switch value={form.enabled} onChange={(v) => set('enabled', v as boolean)} />
          </Field>
        </FieldGroup>
      </Dialog>

      {/* ── 封面预览 ── */}
      <Dialog
        header="封面预览"
        visible={!!preview}
        onClose={() => setPreview(null)}
        footer={null}
        width={420}
      >
        {preview ? (
          <img
            src={preview.url}
            alt="封面预览"
            style={{ width: '100%', borderRadius: 8, display: 'block' }}
          />
        ) : null}
      </Dialog>

      {/* ── 从成片入库 ── */}
      <Dialog
        header="从成片入库"
        visible={importOpen}
        onClose={() => setImportOpen(false)}
        onConfirm={importFromTask}
        confirmBtn={{ content: '入库为草稿', loading: importing, disabled: !importTaskId.trim() }}
        width={640}
      >
        <div style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
          挑一条商家已合成成功的成片，入库后是<b>未上架草稿</b>，补齐标题、分类与封面再上架。
          已入库过的成片不会重复出现在下面。
        </div>

        {tasksLoading ? (
          <div style={{ padding: '32px 0', textAlign: 'center', color: '#999' }}>加载中…</div>
        ) : tasks.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center', color: '#999' }}>
            没有可入库的成片（要么还没合成成功，要么都已经入库了）
          </div>
        ) : (
          <div
            style={{
              maxHeight: 320,
              overflowY: 'auto',
              border: '1px solid var(--td-component-stroke)',
              borderRadius: 6,
            }}
          >
            {tasks.map((t) => {
              const on = importTaskId === t.id
              return (
                <div
                  key={t.id}
                  onClick={() => setImportTaskId(t.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--td-component-stroke)',
                    background: on ? 'var(--td-brand-color-light)' : undefined,
                  }}
                >
                  <span
                    style={{
                      flex: '0 0 18px',
                      height: 18,
                      borderRadius: '50%',
                      border: on ? '5px solid var(--td-brand-color)' : '1px solid #c6c6c6',
                      boxSizing: 'border-box',
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>
                      {t.title || `${t.storeName ?? '未命名门店'}的成片`}
                    </span>
                    <span style={{ display: 'block', color: '#999', fontSize: 12, marginTop: 2 }}>
                      #{t.id} · {t.storeName ?? '—'} · {fmtDuration(t.durationMs)} · {t.grade} ·
                      商家 {t.merchantNickname || t.merchantPhone || '—'}
                    </span>
                    {!!t.resultKey && (
                      <span
                        style={{
                          display: 'block',
                          color: '#bbb',
                          fontSize: 11,
                          marginTop: 2,
                          wordBreak: 'break-all',
                        }}
                      >
                        {t.resultKey}
                      </span>
                    )}
                  </span>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      gap: 4,
                      flex: '0 0 auto',
                    }}
                  >
                    <Tag variant="light">{t.storeCategory || '未分类'}</Tag>
                    {/* 成片日期：合成完成时间优先，历史任务没有就回退任务创建时间 */}
                    <span
                      style={{
                        color: '#999',
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {fmtMinute(t.finishAt ?? t.createdAt)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <FieldGroup labelWidth={110}>
            <Field
              label="任务 ID"
              help="从上表点选即可；列表里没有时也可手动填任务 ID"
            >
              <Input
                value={importTaskId}
                onChange={(v) => setImportTaskId(v as string)}
                placeholder="点上面的列表选择，或直接输入如 24"
              />
            </Field>
          </FieldGroup>
        </div>
      </Dialog>
    </div>
  )
}
