import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Button, Tag, Dialog, Input, InputNumber, Select, Switch, message } from 'tdesign-react'
import DataTable from '../lib/table'
import Field, { FieldGroup } from '../components/Field'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

/**
 * 教学中心 · 课程管理（平台级，不属于任何商家）。
 *
 * 对应小程序：`我的 → 学习中心` 四宫格 → `pages/tutorial/index?category=…`
 *
 * ── 这个页面与其它运营页最大的不同：它带**上传** ───────────────────────────
 * 后台此前没有任何上传端点（见 HomeCarousel.tsx 顶部注释：轮播图只能填 URL）。
 * 教学视频是 100MB 级的二进制，手填对象键完全不现实，所以本轮补了后台第一条上传通道：
 * `POST /admin/api/v1/tutorials/upload`（字段名 `file`，另带 `kind=video|cover`）。
 * 上传**复用了 lib/http 的 axios 实例**而不是 tdesign 的 Upload：
 *   · 组件走自己的请求实现就绕过了拦截器里的 Authorization 与统一错误提示，
 *     401 不会跳登录、后端返回的「只支持 MP4…」也不会显示出来；
 *   · 而这里只需要「表单里放一个文件输入 + 我自己控制什么时候传」，
 *     原生 input + axios 已经够，少一层不受控的黑盒。
 */

/** 与 server/src/lib/tutorial-categories.ts 的 code **逐字一致**（文案各端自己拥有） */
const CATEGORIES = [
  { label: '拍摄技巧', value: 'SHOOTING' },
  { label: '剪辑教程', value: 'EDITING' },
  { label: '运营知识', value: 'OPERATION' },
  { label: '使用手册', value: 'MANUAL' },
]

const categoryLabel = (code: string) => CATEGORIES.find((c) => c.value === code)?.label ?? code

/**
 * ⚠ 这三个数字必须同值，改一个就要改全部：
 *   · 本文件（选文件时的预校验，给运营一句人话）
 *   · server/src/services/tutorial.service.ts 的 MAX_TUTORIAL_VIDEO_BYTES / MAX_TUTORIAL_COVER_BYTES
 *   · deploy/nginx/dashuai-admin.conf 的 client_max_body_size（110m）
 */
const MAX_VIDEO_MB = 100
const MAX_COVER_MB = 5

interface Tutorial {
  id: string
  category: string
  title: string
  videoKey: string | null
  coverKey: string | null
  durationMs: number | null
  sort: number
  enabled: boolean
  createdAt: string
}

interface FormState {
  category: string
  title: string
  videoKey: string
  coverKey: string
  /** 表单里用**秒**（人写秒比写毫秒自然），提交时 ×1000 */
  durationSec: number | null
  sort: number
  enabled: boolean
}

const EMPTY_FORM: FormState = {
  category: 'SHOOTING',
  title: '',
  videoKey: '',
  coverKey: '',
  durationSec: null,
  sort: 0,
  enabled: true,
}

/** 服务端 upload 接口的返回（两种 kind 的字段不同） */
interface UploadResult {
  videoKey?: string
  coverKey?: string
  sizeBytes: number
  contentType?: string
}

/**
 * 单个素材的上传控件：选文件 → 上传 → 回填对象键。
 *
 * 做成一体的原因：这个页面有视频和封面两个位置，拆成「按钮 + 状态 + 进度 + 清空」
 * 四套 state 会让页面主体被上传逻辑淹没，而两处的行为完全一样（只有大小上限与 accept 不同）。
 */
function AssetUploader({
  kind,
  accept,
  maxMb,
  uploadLabel,
  value,
  hint,
  onUploaded,
  onClear,
}: {
  kind: 'video' | 'cover'
  accept: string
  maxMb: number
  uploadLabel: string
  value: string
  hint?: string
  onUploaded: (r: UploadResult) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)

  const pick = () => {
    if (busy) return
    inputRef.current?.click()
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // 立刻清空 input 的值：不清的话「再选同一个文件」不会触发 change，运营会以为按钮坏了
    e.target.value = ''
    if (!file) return

    const mb = file.size / 1024 / 1024
    if (mb > maxMb) {
      message.error(`${kind === 'video' ? '视频' : '封面'}不能超过 ${maxMb}MB（当前 ${mb.toFixed(1)}MB）`)
      return
    }

    setBusy(true)
    setPct(0)
    try {
      const fd = new FormData()
      // 字段名固定 file（服务端 multer.single('file')），不能改
      fd.append('file', file)
      const r = await request<UploadResult>({
        url: `/tutorials/upload?kind=${kind}`,
        method: 'POST',
        data: fd,
        // 默认 30s 不够：100MB 上传（尤其运营在弱网下）轻松超时
        timeout: 0,
        onUploadProgress: (ev) => {
          if (ev.total) setPct(Math.round((ev.loaded / ev.total) * 100))
        },
      })
      message.success(`${kind === 'video' ? '视频' : '封面'}已上传`)
      onUploaded(r)
    } catch {
      /* 失败原因已在 request 层 toast（含后端那句「只支持 MP4 / MOV / WebM / AVI 视频」） */
    } finally {
      setBusy(false)
      setPct(0)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input ref={inputRef} type="file" accept={accept} style={{ display: 'none' }} onChange={onFile} />
        <Button size="small" variant="outline" loading={busy} onClick={pick}>
          {busy ? `上传中 ${pct}%` : value ? '重新上传' : uploadLabel}
        </Button>
        {value ? (
          <>
            <Tag theme="success">已上传</Tag>
            <Button size="small" variant="text" onClick={onClear}>
              清除
            </Button>
          </>
        ) : null}
      </div>
      {value ? (
        <div style={{ marginTop: 6, fontSize: 12, color: '#888', wordBreak: 'break-all' }}>{value}</div>
      ) : null}
      {hint ? <div style={{ marginTop: 6, fontSize: 12, color: '#999' }}>{hint}</div> : null}
    </div>
  )
}

export default function TutorialsPage() {
  const [list, setList] = useState<Tutorial[]>([])
  const [filterCategory, setFilterCategory] = useState('')
  const [filterEnabled, setFilterEnabled] = useState('')
  const [loading, setLoading] = useState(false)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Tutorial | null>(null)
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<{ url: string; kind: 'image' | 'video' } | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const rows = await request<Tutorial[]>({
        url: '/tutorials',
        params: {
          ...(filterCategory ? { category: filterCategory } : {}),
          ...(filterEnabled ? { enabled: filterEnabled } : {}),
        },
      })
      setList(rows)
    } catch {
      /* 已在 request 层 toast */
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

  const startEdit = (t: Tutorial) => {
    setEditing(t)
    setForm({
      category: t.category,
      title: t.title,
      videoKey: t.videoKey ?? '',
      coverKey: t.coverKey ?? '',
      durationSec: t.durationMs ? Math.round(t.durationMs / 1000) : null,
      sort: t.sort,
      enabled: t.enabled,
    })
    setOpen(true)
  }

  const submit = async () => {
    if (!form.title.trim()) {
      message.error('请填写课程标题')
      return
    }
    setSaving(true)
    try {
      const payload = {
        category: form.category,
        title: form.title.trim(),
        videoKey: form.videoKey || null,
        coverKey: form.coverKey || null,
        durationMs: form.durationSec ? Math.round(form.durationSec * 1000) : null,
        sort: form.sort,
        enabled: form.enabled,
      }
      if (editing) await request({ url: `/tutorials/${editing.id}`, method: 'PUT', data: payload })
      else await request({ url: '/tutorials', method: 'POST', data: payload })
      message.success('已保存')
      setOpen(false)
      void load()
    } catch {
      /* 已在 request 层 toast */
    } finally {
      setSaving(false)
    }
  }

  const remove = async (t: Tutorial) => {
    const ok = await confirmDialog(
      '删除课程',
      `删除「${t.title}」？视频文件会一起删除，不可恢复。若只是暂时不想让用户看到，请改用「下架」。`,
    )
    if (!ok) return
    try {
      await request({ url: `/tutorials/${t.id}`, method: 'DELETE' })
      message.success('已删除')
      void load()
    } catch {
      /* 已在 request 层 toast */
    }
  }

  /** 预览素材：先换签名地址。视频交给浏览器新窗口播（后台里塞 <video> 反而更别扭） */
  const previewKey = async (key: string, kind: 'image' | 'video') => {
    try {
      const r = await request<{ url: string | null }>({ url: '/media/preview', params: { key } })
      if (!r.url) return message.warning('该素材在当前存储下无法签名')
      if (kind === 'video') window.open(r.url, '_blank', 'noopener')
      else setPreview({ url: r.url, kind })
    } catch {
      /* 已在 request 层 toast */
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>教学中心 · 课程管理</h2>
        <Button theme="primary" onClick={startCreate}>
          新增课程
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <span style={{ color: '#666', fontSize: 14 }}>筛选</span>
        <Select
          style={{ width: 160 }}
          value={filterCategory}
          onChange={(v) => setFilterCategory(v as string)}
          options={[{ label: '全部分类', value: '' }, ...CATEGORIES]}
        />
        <Select
          style={{ width: 140 }}
          value={filterEnabled}
          onChange={(v) => setFilterEnabled(v as string)}
          options={[
            { label: '全部状态', value: '' },
            { label: '已上架', value: 'true' },
            { label: '已下架', value: 'false' },
          ]}
        />
        <span style={{ color: '#999', fontSize: 13 }}>
          共 {list.length} 条 · 顺序按「分类 → 排序 → 新到旧」
        </span>
      </div>

      <DataTable
        rowKey="id"
        loading={loading}
        data={list}
        columns={[
          { colKey: 'category', title: '分类', width: 110, render: ({ row }: any) => <Tag>{categoryLabel(row.category)}</Tag> },
          { colKey: 'title', title: '课程标题', ellipsis: true },
          {
            colKey: 'videoKey',
            title: '素材',
            width: 170,
            render: ({ row }: any) => (
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  size="small"
                  variant="text"
                  disabled={!row.videoKey}
                  onClick={() => void previewKey(row.videoKey, 'video')}
                >
                  {row.videoKey ? '播放视频' : '无视频'}
                </Button>
                <Button
                  size="small"
                  variant="text"
                  disabled={!row.coverKey}
                  onClick={() => void previewKey(row.coverKey, 'image')}
                >
                  封面
                </Button>
              </div>
            ),
          },
          {
            colKey: 'durationMs',
            title: '时长',
            width: 90,
            render: ({ row }: any) => (row.durationMs ? `${Math.round(row.durationMs / 1000)}s` : '—'),
          },
          { colKey: 'sort', title: '排序', width: 70 },
          {
            colKey: 'enabled',
            title: '状态',
            width: 90,
            render: ({ row }: any) => (row.enabled ? <Tag theme="success">上架</Tag> : <Tag>下架</Tag>),
          },
          {
            colKey: 'op',
            title: '操作',
            width: 150,
            fixed: 'right',
            render: ({ row }: any) => (
              <>
                <Button size="small" variant="text" onClick={() => startEdit(row)}>
                  编辑
                </Button>
                <Button size="small" variant="text" theme="danger" onClick={() => void remove(row)}>
                  删除
                </Button>
              </>
            ),
          },
        ]}
      />

      <Dialog
        header={editing ? '编辑课程' : '新增课程'}
        visible={open}
        onClose={() => setOpen(false)}
        onConfirm={submit}
        confirmBtn={saving ? '保存中…' : '保存'}
        width={640}
      >
        <FieldGroup labelWidth={110}>
          <Field label="分类" required>
            <Select
              value={form.category}
              onChange={(v) => setForm((f) => ({ ...f, category: v as string }))}
              options={CATEGORIES}
            />
          </Field>
          <Field label="课程标题" required>
            <Input
              value={form.title}
              onChange={(v) => setForm((f) => ({ ...f, title: v as string }))}
              placeholder="如：【门店拍摄】前推 / 环绕 / 旋转 / 后拉"
            />
          </Field>
          <Field
            label="视频"
            required
            help={`支持 MP4 / MOV / WebM / AVI，不超过 ${MAX_VIDEO_MB}MB。小程序端建议用 H.264 编码的 MP4，兼容性最好。`}
          >
            <AssetUploader
              kind="video"
              accept="video/*"
              maxMb={MAX_VIDEO_MB}
              uploadLabel="选择视频并上传"
              value={form.videoKey}
              onClear={() => setForm((f) => ({ ...f, videoKey: '' }))}
              onUploaded={(r) =>
                setForm((f) => ({
                  ...f,
                  videoKey: r.videoKey ?? f.videoKey,
                  // 服务端会自动抽首帧当封面，但**只在运营没有手选封面时**补上，不覆盖人工选择
                  coverKey: f.coverKey || r.coverKey || '',
                }))
              }
            />
          </Field>
          <Field label="封面" help={`选填。留空时用视频首帧；单独上传可换成更好看的图，不超过 ${MAX_COVER_MB}MB。`}>
            <AssetUploader
              kind="cover"
              accept="image/*"
              maxMb={MAX_COVER_MB}
              uploadLabel="上传封面"
              value={form.coverKey}
              onClear={() => setForm((f) => ({ ...f, coverKey: '' }))}
              onUploaded={(r) => setForm((f) => ({ ...f, coverKey: r.coverKey ?? f.coverKey }))}
            />
          </Field>
          <Field label="时长（秒）" help="选填，只用于后台与列表展示">
            <InputNumber
              value={form.durationSec ?? undefined}
              onChange={(v) => setForm((f) => ({ ...f, durationSec: (v as number) ?? null }))}
              placeholder="如 192"
            />
          </Field>
          <Field label="排序" help="数字越小越靠前；同序时新上传的在前">
            <InputNumber value={form.sort} onChange={(v) => setForm((f) => ({ ...f, sort: (v as number) ?? 0 }))} />
          </Field>
          <Field label="上架">
            <Switch value={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v as boolean }))} />
          </Field>
        </FieldGroup>
      </Dialog>

      {/* 封面大图预览（视频直接开新窗口，不在这里内嵌播放器） */}
      <Dialog header="封面预览" visible={!!preview} onClose={() => setPreview(null)} footer={null} width={520}>
        {preview ? (
          <img src={preview.url} alt="封面预览" style={{ width: '100%', borderRadius: 8, display: 'block' }} />
        ) : null}
      </Dialog>
    </div>
  )
}
