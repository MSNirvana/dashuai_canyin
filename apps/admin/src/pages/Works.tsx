import { useEffect, useState } from 'react'
import {
  Button,
  Tag,
  Dialog,
  Input,
  InputNumber,
  Select,
  Switch,
  Textarea,
  message,
} from 'tdesign-react'
import DataTable from '../lib/table'
import Field, { FieldGroup } from '../components/Field'
import AssetUploader from '../components/AssetUploader'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

/**
 * 首页「优秀作品」运营页
 *
 * 与商家数据解耦：作品是运营内容，商家删创作 / 清素材都不会让作品消失。
 * 核心字段是 recipeJson（同款配方）——小程序端「生成同款」把它预填进创作流，
 * 「AI 直接生成」则按它自动跑文案 + 分镜。
 */

interface ShotSkeleton {
  shotType?: string
  shotSize?: string
  durationSuggest?: number
  line?: string
  visualReq?: string
}

interface RecipeJson {
  track?: string
  complexity?: string
  titleHint?: string
  voiceId?: string
  shotSkeleton?: ShotSkeleton[]
  notes?: string
}

interface Work {
  id: string
  title: string
  category: string
  subCategory: string | null
  tags: string[] | null
  coverKey: string | null
  videoKey: string | null
  durationMs: number | null
  sort: number
  enabled: boolean
  sourceType: string
  sourceTaskId: string | null
  viewCount: number
  cloneCount: number
  publishedAt: string | null
  recipeJson: RecipeJson | null
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

const TRACK_OPTIONS = [
  { label: '流量款', value: 'TRAFFIC' },
  { label: '人设型', value: 'PERSONA' },
  { label: '干货型', value: 'KNOWLEDGE' },
  { label: '产品型', value: 'PRODUCT' },
  { label: '真诚推荐型', value: 'RECOMMEND' },
]

/**
 * ★ 存量配方的 track 老值 → 新款（2026-09-21 四款改型）。
 * 与小程序 `services/creation.ts` 的 `LEGACY_TRACK_ALIASES`、服务端
 * `creation.service.ts` 的同名常量必须**保持一致的三条映射**。
 * ★ 不映射的后果是这一栏显示成空白 / 「待补全」——后台会以为这条配方坏了，
 *   其实是款式改过名（看起来像数据缺失，而不是像版本问题）。
 */
const LEGACY_TRACK_LABELS: Record<string, string> = {
  INTRO: '产品型',
  QUALITY: '人设型',
  NORMAL: '产品型',
}

/** 取配方的款式中文名：先查新款，再查老值映射，都不中才返回 undefined */
function trackLabelOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  return TRACK_OPTIONS.find((o) => o.value === v)?.label ?? LEGACY_TRACK_LABELS[v]
}

const COMPLEXITY_OPTIONS = [
  { label: '简单（2~3 镜）', value: 'SIMPLE' },
  { label: '复杂（4~6 镜）', value: 'COMPLEX' },
  { label: '精细（7~9 镜）', value: 'FINE' },
]

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

interface ShotDraft {
  shotType: string
  shotSize: string
  durationSuggest: number | null
  visualReq: string
}

interface FormState {
  title: string
  category: string
  subCategory: string
  tagsText: string
  coverKey: string
  videoKey: string
  durationSec: number | null
  sort: number
  enabled: boolean
  track: string
  complexity: string
  titleHint: string
  voiceId: string
  notes: string
  shots: ShotDraft[]
}

const EMPTY_SHOT: ShotDraft = { shotType: '', shotSize: '', durationSuggest: null, visualReq: '' }

const EMPTY_FORM: FormState = {
  title: '',
  category: '餐饮',
  subCategory: '',
  tagsText: '',
  coverKey: '',
  videoKey: '',
  durationSec: null,
  sort: 0,
  enabled: false,
  track: '',
  complexity: '',
  titleHint: '',
  voiceId: '',
  notes: '',
  shots: [],
}

/** 逗号 / 顿号 / 空格都能当分隔符，运营从表格里粘贴也能用 */
function parseTags(text: string) {
  return text
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10)
}

function recipeToForm(recipe: RecipeJson | null): Pick<
  FormState,
  'track' | 'complexity' | 'titleHint' | 'voiceId' | 'notes' | 'shots'
> {
  const r = recipe ?? {}
  return {
    track: r.track ?? '',
    complexity: r.complexity ?? '',
    titleHint: r.titleHint ?? '',
    voiceId: r.voiceId ?? '',
    notes: r.notes ?? '',
    shots: (r.shotSkeleton ?? []).map((s) => ({
      shotType: s.shotType ?? '',
      shotSize: s.shotSize ?? '',
      durationSuggest: s.durationSuggest ?? null,
      visualReq: s.visualReq ?? '',
    })),
  }
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
      subCategory: w.subCategory ?? '',
      tagsText: (w.tags ?? []).join('、'),
      coverKey: w.coverKey ?? '',
      videoKey: w.videoKey ?? '',
      durationSec: w.durationMs ? Math.round(w.durationMs / 1000) : null,
      sort: w.sort,
      enabled: w.enabled,
      ...recipeToForm(w.recipeJson),
    })
    setOpen(true)
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const addShot = () => setForm((f) => ({ ...f, shots: [...f.shots, { ...EMPTY_SHOT }] }))
  const removeShot = (i: number) =>
    setForm((f) => ({ ...f, shots: f.shots.filter((_, idx) => idx !== i) }))
  const patchShot = (i: number, patch: Partial<ShotDraft>) =>
    setForm((f) => ({ ...f, shots: f.shots.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) }))

  /** 组装 payload：空串一律转 null，避免把「清空」写成了空字符串 */
  const buildPayload = () => {
    const shots: ShotSkeleton[] = form.shots
      .map((s) => {
        const o: ShotSkeleton = {}
        if (s.shotType.trim()) o.shotType = s.shotType.trim()
        if (s.shotSize.trim()) o.shotSize = s.shotSize.trim()
        if (s.durationSuggest) o.durationSuggest = s.durationSuggest
        if (s.visualReq.trim()) o.visualReq = s.visualReq.trim()
        return o
      })
      .filter((s) => Object.keys(s).length > 0)

    const recipe: RecipeJson = {}
    if (form.track) recipe.track = form.track
    if (form.complexity) recipe.complexity = form.complexity
    if (form.titleHint.trim()) recipe.titleHint = form.titleHint.trim()
    if (form.voiceId.trim()) recipe.voiceId = form.voiceId.trim()
    if (form.notes.trim()) recipe.notes = form.notes.trim()
    if (shots.length) recipe.shotSkeleton = shots

    return {
      title: form.title.trim(),
      category: form.category.trim(),
      subCategory: form.subCategory.trim() || null,
      tags: parseTags(form.tagsText),
      coverKey: form.coverKey.trim() || null,
      videoKey: form.videoKey.trim() || null,
      durationMs: form.durationSec ? Math.round(form.durationSec * 1000) : null,
      sort: form.sort ?? 0,
      enabled: form.enabled,
      recipeJson: recipe,
    }
  }

  const submit = async () => {
    if (!form.title.trim()) return message.warning('请填写标题')
    if (!form.category.trim()) return message.warning('请填写分类')
    if (form.shots.length > 20) return message.warning('分镜骨架最多 20 条')
    const badShot = form.shots.find(
      (s) => s.durationSuggest !== null && (s.durationSuggest < 1 || s.durationSuggest > 60),
    )
    if (badShot) return message.warning('单个镜头时长需在 1~60 秒之间')

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
      message.success(`已入库草稿「${w.title}」，补全配方后再上架`)
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
          {
            colKey: 'category',
            title: '分类',
            width: 150,
            render: ({ row }: any) => (
              <span>
                {row.category}
                {row.subCategory ? ` / ${row.subCategory}` : ''}
              </span>
            ),
          },
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
          {
            colKey: 'recipe',
            title: '配方',
            width: 170,
            render: ({ row }: any) => {
              const r = (row.recipeJson ?? {}) as RecipeJson
              const track = trackLabelOf(r.track)
              const cx = COMPLEXITY_OPTIONS.find((o) => o.value === r.complexity)?.label
              if (!track && !cx && !(r.shotSkeleton ?? []).length) {
                return <span style={{ color: '#d54941' }}>待补全</span>
              }
              return (
                <span style={{ fontSize: 13 }}>
                  {track ?? '未设款式'} · {cx ? cx.replace(/（.*）/, '') : '未设复杂度'}
                  {r.shotSkeleton?.length ? ` · ${r.shotSkeleton.length} 镜` : ''}
                </span>
              )
            },
          },
          { colKey: 'sort', title: '排序', width: 70 },
          {
            colKey: 'stat',
            title: '浏览/同款',
            width: 110,
            render: ({ row }: any) => (
              <span style={{ fontSize: 13 }}>
                {row.viewCount} / {row.cloneCount}
              </span>
            ),
          },
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
        width={720}
      >
        <FieldGroup labelWidth={110}>
          <Field label="标题" required>
            <Input
              value={form.title}
              onChange={(v) => set('title', v as string)}
              placeholder="如 麻婆豆腐爆款短视频"
            />
          </Field>
          <Field label="分类" required help="小程序首页按分类横滑，运营自定">
            <Select
              value={form.category}
              onChange={(v) => set('category', v as string)}
              options={CATEGORY_OPTIONS}
              filterable
              creatable
              placeholder="选择或输入新分类"
            />
          </Field>
          <Field label="子分类">
            <Input value={form.subCategory} onChange={(v) => set('subCategory', v as string)} placeholder="选填" />
          </Field>
          <Field label="标签" help="最多 10 个，逗号 / 顿号 / 空格分隔；首页卡片只展示前 2 个">
            <Input value={form.tagsText} onChange={(v) => set('tagsText', v as string)} placeholder="如 高翻台、出餐快" />
          </Field>
          <Field
            label="封面 Key"
            help="COS 对象键，与合成成片同一存储；填好后点列表「封面」可预览。也可以直接在下面选一张图上传（≤5MB），上传后键会填进这一栏。"
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
            help="私有桶，播放地址每次访问重新签名（1 小时有效）。也可以直接在下面选本地视频上传（≤100MB，MP4 / MOV / WebM / AVI），上传后会自动抽一帧当封面。"
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
          <Field label="时长(秒)">
            <InputNumber
              value={form.durationSec ?? undefined}
              onChange={(v) => set('durationSec', (v as number) ?? null)}
              placeholder="选填"
            />
          </Field>
          <Field label="排序" help="数字越小越靠前">
            <InputNumber value={form.sort} onChange={(v) => set('sort', (v as number) ?? 0)} />
          </Field>
          <Field label="立即上架" help="未上架的作品只存在于后台，小程序首页看不到">
            <Switch value={form.enabled} onChange={(v) => set('enabled', v as boolean)} />
          </Field>
        </FieldGroup>

        <div style={{ margin: '20px 0 8px', fontWeight: 600 }}>同款配方</div>
        <div style={{ color: '#999', fontSize: 12, marginBottom: 12 }}>
          小程序端「生成同款」会把这些值预填进创作页。填了分镜骨架的话，创作会直接按它预置好分镜
          （不再走 AI 分镜、也不扣那笔积分），用户可以在拍摄页逐条改，或用「重新生成」换成 AI 版。
          文案款式 / 复杂度 / 标题建议一律只是预填，用户在创作页仍可改。
        </div>
        <FieldGroup labelWidth={110}>
          <Field label="文案款式">
            <Select
              value={form.track}
              onChange={(v) => set('track', v as string)}
              options={[{ label: '不指定', value: '' }, ...TRACK_OPTIONS]}
            />
          </Field>
          <Field label="镜头复杂度">
            <Select
              value={form.complexity}
              onChange={(v) => set('complexity', v as string)}
              options={[{ label: '不指定', value: '' }, ...COMPLEXITY_OPTIONS]}
            />
          </Field>
          <Field label="标题建议">
            <Input
              value={form.titleHint}
              onChange={(v) => set('titleHint', v as string)}
              placeholder="套用同款时预填的创作标题"
            />
          </Field>
          <Field label="推荐音色" help="填 TTS 供应商的 voiceId，选填">
            <Input value={form.voiceId} onChange={(v) => set('voiceId', v as string)} placeholder="选填" />
          </Field>
          <Field label="运营点评" help="展示在作品详情页的「这条作品好在哪」">
            <Textarea
              value={form.notes}
              onChange={(v) => set('notes', v as string)}
              autosize={{ minRows: 2, maxRows: 4 }}
              placeholder="如 前 3 秒直接上出锅镜头，钩子够快"
            />
          </Field>
          <Field
            label="分镜骨架"
            help="最多 20 条。详情页用它展示镜头结构；小程序「生成同款」会把它直接预置成创作的分镜（省掉一次 AI 分镜扣费），用户可逐条改或重新生成。"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {form.shots.map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <div style={{ flex: '0 0 110px' }}>
                    <Input
                      value={s.shotType}
                      onChange={(v) => patchShot(i, { shotType: v as string })}
                      placeholder="镜头"
                    />
                  </div>
                  <div style={{ flex: '0 0 90px' }}>
                    <Input
                      value={s.shotSize}
                      onChange={(v) => patchShot(i, { shotSize: v as string })}
                      placeholder="景别"
                    />
                  </div>
                  <div style={{ flex: '0 0 80px' }}>
                    <InputNumber
                      value={s.durationSuggest ?? undefined}
                      onChange={(v) => patchShot(i, { durationSuggest: (v as number) ?? null })}
                      placeholder="秒"
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Input
                      value={s.visualReq}
                      onChange={(v) => patchShot(i, { visualReq: v as string })}
                      placeholder="画面要求"
                    />
                  </div>
                  <Button size="small" variant="text" theme="danger" onClick={() => removeShot(i)}>
                    删除
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  size="small"
                  variant="outline"
                  disabled={form.shots.length >= 20}
                  onClick={addShot}
                >
                  添加镜头
                </Button>
              </div>
            </div>
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
          挑一条商家已合成成功的成片，入库后是<b>未上架草稿</b>，补齐分类与配方再上架。
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
                  <Tag variant="light">{t.storeCategory || '未分类'}</Tag>
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
