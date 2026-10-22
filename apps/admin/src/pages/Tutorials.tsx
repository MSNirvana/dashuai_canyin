import { useEffect, useState } from 'react'
import { Button, Tag, Dialog, Input, InputNumber, Select, Switch, message } from 'tdesign-react'
import DataTable from '../lib/table'
import Field, { FieldGroup } from '../components/Field'
import AssetUploader from '../components/AssetUploader'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

/**
 * 参考视频 · 内容管理（平台级，不属于任何商家）。
 *
 * 对应小程序：`我的 → 参考视频` 分组列表 → `pages/tutorial/index?category=…`
 *
 * ── 2026-10-22 起不再上传视频，改填视频号 feedId ──────────────────────────
 * 小程序端已经没有播放器（原因见 apps/mini/src/pages/tutorial/index.tsx 顶部：
 * 内嵌被判「文娱-其他视频」类目，而 `<channel-video>` 又因视频号未认证＝无主体走不通）。
 * 现在端上只用 `wx.openChannelsActivity` 跳到视频号播放，所以这里要的是 **feedId**。
 *
 * ★ 视频上传端点（`POST /tutorials/upload`）**仍然保留**，只是不再有视频入口：
 *   它还被「封面上传」用着（同一个端点，`kind=cover`）。历史行的 `video_key` 也还在库里，
 *   编辑老记录时表单会原样带回去（见 FormState.videoKey 的注释）。
 */

/** 与 server/src/lib/tutorial-categories.ts 的 code **逐字一致**（文案各端自己拥有） */
const CATEGORIES = [
  { label: '怎么拍', value: 'SHOOTING' },
  { label: '怎么剪', value: 'EDITING' },
  { label: '怎么发', value: 'OPERATION' },
  { label: '怎么用', value: 'MANUAL' },
]

/**
 * 分类名：**后台可改**（2026-10-22），存在系统设置 `tutorial.category_titles`。
 * 上面那张 CATEGORIES 只是兜底 —— 改名字以接口返回的 titles 为准，
 * 所以表格与下拉都用 `labelOf`，别直接读 CATEGORIES。
 */
type TitleMap = Record<string, string>

const labelOf = (titles: TitleMap, code: string) =>
  titles[code] || CATEGORIES.find((c) => c.value === code)?.label || code

/** 与 server 的 TUTORIAL_TITLE_BANNED_WORDS 同一批词 */
const BANNED_TITLE_WORDS = ['课程', '教程', '教学', '学习', '技巧', '知识', '手册']

/**
 * ⚠ 封面这两个数字必须同值，改一个就要改全部：
 *   · 本文件（选文件时的预校验，给运营一句人话）
 *   · server/src/services/tutorial.service.ts 的 MAX_TUTORIAL_COVER_BYTES
 *
 * ★ 视频 2026-10-13 已按要求**放开大小限制**，所以这里不再有对应的 MB 常量：
 *   AssetUploader 不传 `maxMb` 即「不限」。权威校验只剩两处 ——
 *   server/src/services/tutorial.service.ts 的 MAX_TUTORIAL_VIDEO_BYTES（= Infinity）
 *   与 deploy/nginx/dashuai-admin.conf 的 `client_max_body_size 0`。
 *   ⚠ 那两处**本地都测不出来**（vite 直连 3000、不过 nginx），改的时候别只改前端。
 */
const MAX_COVER_MB = 5

interface Tutorial {
  id: string
  category: string
  title: string
  videoKey: string | null
  coverKey: string | null
  /** 视频号视频标识。**这是小程序端能不能看这条的唯一判据**（空 ⇒ 不下发） */
  feedId: string | null
  /** 视频号 ID；留空 ⇒ 服务端用 env `TUTORIAL_FINDER_USER_NAME` 兜底 */
  finderUserName: string | null
  durationMs: number | null
  sort: number
  enabled: boolean
  createdAt: string
}

interface FormState {
  category: string
  title: string
  /**
   * ⚠ 表单里**已经不再提供视频上传**（2026-10-22 起小程序只跳转视频号播放）。
   * 这个字段留着只为「编辑老记录时原样带回去」—— 提交时若传 null 会把库里已存的
   * 对象键清掉，而那个文件还在 COS 上、GC 也还没扫到，等于凭空断掉一条引用。
   */
  videoKey: string
  coverKey: string
  feedId: string
  finderUserName: string
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
  feedId: '',
  finderUserName: '',
  durationSec: null,
  sort: 0,
  enabled: true,
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

  /**
   * 四个分类的**显示名**（运营可改）。
   * ★ 为什么要加这个：小程序「我的」页那四行、分类页的导航标题、分享卡片标题，
   *   全部读这里。改名字不需要重新发版、也不需要重新提审。
   * ★ 与列表分开发：列表可以按分类筛，名字是全量四份，不该跟着筛选条件反复拉。
   */
  // 初值用本地兜底填满 —— 接口没回来（或挂了）时输入框也是可读的四个默认名，
  // 不会出现「一片空白 + 一保存就报不能留空」
  const [titles, setTitles] = useState<TitleMap>(
    Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label])),
  )
  const [titlesSaving, setTitlesSaving] = useState(false)

  const loadTitles = async () => {
    try {
      const r = await request<{ titles: TitleMap }>({ url: '/tutorials/categories' })
      setTitles(r.titles)
    } catch {
      /* 已在 request 层 toast；名字拿不到就退回 CATEGORIES 兜底，不挡页面 */
    }
  }

  const saveTitles = async () => {
    // ★ 前端这道只是省一次往返；**真正的闸门在服务端**（routes/admin.ts 的 findBannedTitleWord），
    //   因为直接调接口/粘贴进来的词，界面上拦不住。
    for (const c of CATEGORIES) {
      const v = (titles[c.value] ?? '').trim()
      if (!v) {
        message.error(`「${c.label}」不能留空`)
        return
      }
      const hit = BANNED_TITLE_WORDS.find((w) => v.includes(w))
      if (hit) {
        message.error(`「${v}」里不能出现「${hit}」——这类词会把小程序指向「在线课程」类目`)
        return
      }
    }
    setTitlesSaving(true)
    try {
      const payload = Object.fromEntries(CATEGORIES.map((c) => [c.value, (titles[c.value] ?? '').trim()]))
      const r = await request<{ titles: TitleMap }>({
        url: '/tutorials/categories',
        method: 'PUT',
        data: { titles: payload },
      })
      setTitles(r.titles)
      message.success('分类名称已保存，小程序下次进页面即生效')
    } catch {
      /* 已在 request 层 toast */
    } finally {
      setTitlesSaving(false)
    }
  }

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

  useEffect(() => {
    void loadTitles()
    // 只在进页面时拉一次：名字与筛选条件无关
  }, [])

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
      feedId: t.feedId ?? '',
      finderUserName: t.finderUserName ?? '',
      durationSec: t.durationMs ? Math.round(t.durationMs / 1000) : null,
      sort: t.sort,
      enabled: t.enabled,
    })
    setOpen(true)
  }

  const submit = async () => {
    if (!form.title.trim()) {
      message.error('请填写标题')
      return
    }
    // ★ 硬挡：feedId 为空时服务端不会下发这一条，运营却会以为「保存成功了」
    if (!form.feedId.trim()) {
      message.error('请填写视频号 feedId —— 不填这条在小程序里不会出现')
      return
    }
    setSaving(true)
    try {
      const payload = {
        category: form.category,
        title: form.title.trim(),
        videoKey: form.videoKey || null,
        coverKey: form.coverKey || null,
        feedId: form.feedId.trim() || null,
        finderUserName: form.finderUserName.trim() || null,
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
      '删除',
      `删除「${t.title}」？若这条还传过封面，封面文件会一起删除，不可恢复。视频号里的视频不受影响。若只是暂时不想让用户看到，请改用「下架」。`,
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
        <h2>参考视频 · 内容管理</h2>
        <Button theme="primary" onClick={startCreate}>
          新增一条
        </Button>
      </div>

      {/* ── 分类名称（运营可改）──────────────────────────────────────────
          改这里 = 改小程序「我的 → 参考视频」那四行、分类页导航标题、分享卡片标题。
          ★ 存服务端（系统设置），**不需要重新发版、也不需要重新提审**。
          ★ 禁词的三处防线：这里只是提示；真正拦住的是服务端 400；
            守护脚本 verify-tutorial-visibility 再钉一层（防止有人把服务端那道删了）。 */}
      <div
        style={{
          border: '1px solid #e7e7e7',
          borderRadius: 8,
          padding: '12px 16px 14px',
          marginBottom: 16,
          background: '#fafafa',
        }}
      >
        <div style={{ marginBottom: 10 }}>
          <strong style={{ marginRight: 10 }}>分类名称</strong>
          <span style={{ color: '#999', fontSize: 13 }}>
            小程序「我的 → 参考视频」那四行、以及分类页标题都用这里的名字
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {CATEGORIES.map((c) => (
            <div key={c.value} style={{ width: 168 }}>
              <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>
                {c.label} <span style={{ color: '#bbb', fontSize: 12 }}>({c.value})</span>
              </div>
              <Input
                value={titles[c.value] ?? ''}
                maxlength={8}
                placeholder={c.label}
                onChange={(v) => setTitles({ ...titles, [c.value]: String(v) })}
              />
            </div>
          ))}
          <Button variant="outline" loading={titlesSaving} onClick={saveTitles}>
            保存名称
          </Button>
        </div>
        <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
          最多 8 个字；不能出现「课程／教程／教学／学习／技巧／知识／手册」——这几个词会把小程序指向「在线课程」类目。
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <span style={{ color: '#666', fontSize: 14 }}>筛选</span>
        <Select
          style={{ width: 160 }}
          value={filterCategory}
          onChange={(v) => setFilterCategory(v as string)}
          options={[
            { label: '全部分类', value: '' },
            ...CATEGORIES.map((c) => ({ label: labelOf(titles, c.value), value: c.value })),
          ]}
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
          { colKey: 'category', title: '分类', width: 110, render: ({ row }: any) => <Tag>{labelOf(titles, row.category)}</Tag> },
          { colKey: 'title', title: '课程标题', ellipsis: true },
          {
            colKey: 'feedId',
            title: '视频号',
            width: 100,
            render: ({ row }: any) =>
              row.feedId ? <Tag theme="success">已配</Tag> : <Tag theme="warning">未配</Tag>,
          },
          {
            colKey: 'coverKey',
            title: '封面',
            width: 90,
            render: ({ row }: any) => (
              <Button
                size="small"
                variant="text"
                disabled={!row.coverKey}
                onClick={() => void previewKey(row.coverKey, 'image')}
              >
                {row.coverKey ? '预览' : '无'}
              </Button>
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
        header={editing ? '编辑' : '新增'}
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
              options={CATEGORIES.map((c) => ({ label: labelOf(titles, c.value), value: c.value }))}
            />
          </Field>
          <Field label="标题" required>
            <Input
              value={form.title}
              onChange={(v) => setForm((f) => ({ ...f, title: v as string }))}
              placeholder="如：手机横着拿，画面才稳"
            />
          </Field>
          <Field
            label="视频号 feedId"
            required
            help="视频号助手（channels.weixin.qq.com）→「动态管理」→ 找到这条视频 → 复制 feedId。格式是 export/ 开头的一长串。★ 不填这条在小程序里不会出现：端上已改为跳转视频号播放，这一列就是唯一判据。"
          >
            <Input
              value={form.feedId}
              onChange={(v) => setForm((f) => ({ ...f, feedId: v as string }))}
              placeholder="如 export/UzFfBgAA..."
            />
          </Field>
          <Field label="视频号 ID" help="sph 开头。只有一个视频号时可以留空，服务端会用全局默认值（env TUTORIAL_FINDER_USER_NAME）。">
            <Input
              value={form.finderUserName}
              onChange={(v) => setForm((f) => ({ ...f, finderUserName: v as string }))}
              placeholder="留空 = 用全局默认，如 sphy2kl2JBjm1Ax"
            />
          </Field>
          <Field label="封面" help={`选填。列表里有封面就显示缩略图，不传则是纯文字条目（不影响点击观看）。不超过 ${MAX_COVER_MB}MB。`}>
            <AssetUploader
              endpoint="/tutorials/upload"
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
