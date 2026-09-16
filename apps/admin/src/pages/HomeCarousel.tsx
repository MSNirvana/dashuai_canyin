import { useEffect, useState } from 'react'
import { Button, Dialog, Input, InputNumber, Select, Switch, Tag, message } from 'tdesign-react'
import DataTable from '../lib/table'
import Field, { FieldGroup } from '../components/Field'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

/**
 * 首页轮播图（小程序首页顶部那张「创作入口」卡片）。
 *
 * ── 存哪儿：复用系统配置，不新建表、不新加接口 ──────────────────────────────
 * 落在既有 `system_setting` 里的一行：
 *     groupKey='home' / settingKey='carousel' / valueType='JSON' / isPublic=true
 * 于是：
 *   · 后台读写走既有的 `/admin/api/v1/settings`（Settings.tsx 用的同一套）；
 *   · 小程序读的是既有的**公开**接口 `GET /api/v1/system/settings`（免登录）。
 * 本页只负责把那段 JSON 编排成人能改的样子，其余链路一行都不动。
 *
 * ⚠ 服务端对 JSON 类型做了一次「简化」：coerceValue 里 parse 完又 stringify 回去，
 *   所以小程序拿到的是**字符串**、得自己再 parse。本页存的时候也就存字符串化的数组。
 *   （见 server/src/routes/system-settings.ts）
 *
 * ── 图片地址必须是「可公开访问的完整 URL」──────────────────────────────────
 * 小程序是直接把这个值塞进 <Image src>，它不做签名、也不认对象键。
 * 首页现有那批图在 COS 的 `static/mini/home/` 下（ACL: public-read），
 * 源文件在 apps/mini/src/assets/home/，改图后跑 `npm run assets:upload` 重新上传。
 * 这里**故意不做文件上传控件**：后台目前没有上传接口（优秀作品的封面也是手填 key），
 * 而轮播图是低频运营动作，填 URL + 预览足够；真要做上传，得先加 admin 侧的上传路由。
 */

type LinkCode = 'NONE' | 'CREATE' | 'CREATIONS' | 'STORES' | 'MEMBER' | 'WORK'

type Slide = {
  id: string
  image: string
  kicker: string
  title: string
  desc: string
  actionText: string
  link: LinkCode
  workId: string
  enabled: boolean
  sort: number
}

type Setting = {
  id: string
  groupKey: string
  settingKey: string
  settingVal: string
  valueType: string
  displayName: string
  description: string | null
  sort: number
  isPublic: boolean
}

const GROUP_KEY = 'home'
const SETTING_KEY = 'carousel'

/**
 * 跳转白名单。**必须与小程序端 `apps/mini/src/services/home.ts::CarouselLink` 逐一对应** ——
 * 两边靠这组字符串对齐，多一个少一个都会让小程序把该值当成非法值降级成「不跳转」。
 *
 * 为什么是白名单而不是让运营填页面路径：小程序跳到未注册的路由会失败，
 * 而路由清单在 `src/app.config.ts` 里、还分了包，手填迟早出错。
 */
const LINK_OPTIONS: Array<{ label: string; value: LinkCode }> = [
  { label: '不跳转（纯展示）', value: 'NONE' },
  { label: '开始创作', value: 'CREATE' },
  { label: '全部创作', value: 'CREATIONS' },
  { label: '门店列表', value: 'STORES' },
  { label: '订阅与积分', value: 'MEMBER' },
  { label: '指定优秀作品（需填作品 ID）', value: 'WORK' },
]

/** 首页兜底那张图（与小程序 services/home.ts::FALLBACK_SLIDE 用的是同一个 URL） */
const SEED_IMAGE =
  'https://dashuai-1485028436.cos.ap-beijing.myqcloud.com/static/mini/home/create-hero.jpg'

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** 第一张的默认值：把现在线上那张卡片原样带出来，运营改一处就能加第二张 */
const SEED_SLIDE: Slide = {
  id: '',
  image: SEED_IMAGE,
  kicker: '从一道菜开始',
  title: '做一条能带来客人的视频',
  desc: 'AI 帮你想文案、排分镜，现场拍完就能出片',
  actionText: '开始创作',
  link: 'CREATE',
  workId: '',
  enabled: true,
  sort: 0,
}

const EMPTY_SLIDE: Slide = {
  id: '',
  image: '',
  kicker: '',
  title: '',
  desc: '',
  actionText: '',
  link: 'NONE',
  workId: '',
  enabled: true,
  sort: 0,
}

/** 把库里存的 JSON 收敛成可编辑的行；解析不了就返回空数组（并在页面上提示） */
function parseSlides(raw: string): Slide[] {
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object' && !Array.isArray(it))
      .map((it, i) => {
        const link = LINK_OPTIONS.some((o) => o.value === it.link) ? (it.link as LinkCode) : 'NONE'
        return {
          id: String(it.id ?? `slide-${i}`),
          image: String(it.image ?? ''),
          kicker: String(it.kicker ?? ''),
          title: String(it.title ?? ''),
          desc: String(it.desc ?? ''),
          actionText: String(it.actionText ?? ''),
          link,
          workId: String(it.workId ?? ''),
          enabled: it.enabled !== false,
          sort: Number(it.sort ?? i),
        }
      })
  } catch {
    return []
  }
}

const linkLabel = (c: LinkCode) => LINK_OPTIONS.find((o) => o.value === c)?.label ?? c

export default function HomeCarouselPage() {
  const [row, setRow] = useState<Setting | null>(null)
  const [slides, setSlides] = useState<Slide[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  /** 库里已有这一项、但 settingVal 不是合法的 JSON 数组 —— 保存会覆盖它，先警示 */
  const [broken, setBroken] = useState(false)
  const [open, setOpen] = useState(false)
  const [editingIndex, setEditingIndex] = useState(-1)
  const [form, setForm] = useState<Slide>(EMPTY_SLIDE)

  const load = async () => {
    setLoading(true)
    try {
      const list = await request<Setting[]>({ url: '/settings' })
      const found = list.find((s) => s.groupKey === GROUP_KEY && s.settingKey === SETTING_KEY) ?? null
      const parsed = found ? parseSlides(found.settingVal) : []
      setRow(found)
      setSlides(parsed)
      setBroken(!!found && parsed.length === 0 && found.settingVal.trim() !== '[]')
    } catch {
      /* 已 toast */
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const validate = (s: Slide): string => {
    if (!s.image.trim()) return '图片地址不能为空'
    // 小程序直接把它当 <Image src>，填对象键或相对路径都会白图
    if (!/^https?:\/\//i.test(s.image.trim())) return '图片地址要填完整的 http(s) 链接'
    if (!s.title.trim()) return '标题不能为空（小程序靠它撑起整张卡片）'
    if (s.link === 'WORK' && !s.workId.trim()) return '跳转选了「指定优秀作品」，就要填作品 ID'
    return ''
  }

  const addSlide = () => {
    setEditingIndex(-1)
    // 一张都没有时用「现在线上那张」当模板：运营只改图就能多一张
    const base = slides.length === 0 ? SEED_SLIDE : EMPTY_SLIDE
    setForm({ ...base, id: newId() })
    setOpen(true)
  }

  const openEdit = (idx: number) => {
    setEditingIndex(idx)
    setForm({ ...slides[idx]! })
    setOpen(true)
  }

  const submitSlide = () => {
    const err = validate(form)
    if (err) { message.warning(err); return }
    setSlides((prev) => {
      const next = [...prev]
      if (editingIndex >= 0) next[editingIndex] = form
      else next.push(form)
      return next
    })
    setOpen(false)
  }

  const removeSlide = async (idx: number) => {
    const ok = await confirmDialog('删除这一张', `删除「${slides[idx]?.title || '未命名'}」？保存后小程序才会生效。`)
    if (ok) setSlides((prev) => prev.filter((_, i) => i !== idx))
  }

  /** 顺序就是展示顺序（保存时按当前下标重写 sort），所以只需要上移/下移 */
  const move = (idx: number, delta: number) => {
    setSlides((prev) => {
      const to = idx + delta
      if (to < 0 || to >= prev.length) return prev
      const next = [...prev]
      const [item] = next.splice(idx, 1)
      next.splice(to, 0, item!)
      return next
    })
  }

  const save = async () => {
    for (const [i, s] of slides.entries()) {
      const err = validate(s)
      if (err) { message.warning(`第 ${i + 1} 张：${err}`); return }
    }
    const payload = {
      groupKey: GROUP_KEY,
      settingKey: SETTING_KEY,
      // 下标即顺序，落库前统一重写 sort，避免出现两个 0 或空洞
      settingVal: JSON.stringify(slides.map((s, i) => ({ ...s, sort: i }))),
      valueType: 'JSON' as const,
      displayName: '首页轮播图',
      description: '小程序首页顶部「创作入口」的轮播。留空则回退到内置默认单张；保存后小程序下次进入首页生效。',
      sort: 0,
      isPublic: true, // 必须公开：小程序是免登录拉取的
    }
    setSaving(true)
    try {
      if (row) await request({ url: `/settings/${row.id}`, method: 'PUT', data: payload })
      else await request({ url: '/settings', method: 'POST', data: payload })
      message.success(slides.length === 0 ? '已保存（将回退到默认单张）' : '已保存')
      await load()
    } catch {
      /* 已 toast */
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>首页轮播图</h2>
        <div>
          <Button style={{ marginRight: 12 }} onClick={addSlide}>新增一张</Button>
          <Button theme="primary" loading={saving} onClick={save}>保存</Button>
        </div>
      </div>

      <div className="page-tip">
        小程序首页顶部的「创作入口」卡片。配 1 张时就是一张静态卡片（不轮播、不显示圆点），
        配 2 张以上才会自动轮播。<br />
        图片填<b>可公开访问的完整 URL</b>（COS 上 <code>ACL: public-read</code> 的对象，例如
        <code>static/mini/home/…</code>）；填对象键或相对路径小程序会显示白图。<br />
        清空全部并保存 = 回退到内置那张默认卡片。改动<b>保存后即时生效</b>，小程序下次进入首页即可看到。
      </div>

      {broken && (
        <div className="page-tip" style={{ color: '#e1251b', borderColor: '#f5c2c0', background: '#fef2f2' }}>
          库里已存在这一项，但它的值不是合法的 JSON 数组（可能是手工改过）。
          现在列表显示为空 —— <b>点「保存」会用当前列表覆盖它</b>；想先看一眼原值，去「系统设置」按分组
          <code>home</code> 找 <code>carousel</code>。
        </div>
      )}

      <DataTable
        rowKey="id"
        loading={loading}
        data={slides}
        columns={[
          { colKey: 'no', title: '顺序', width: 70, render: ({ rowIndex }: any) => rowIndex + 1 },
          {
            colKey: 'image', title: '预览', width: 180,
            render: ({ row }: any) =>
              row.image
                ? <img src={row.image} alt="" style={{ width: 150, height: 56, objectFit: 'cover', borderRadius: 6, background: '#eee' }} />
                : <span className="muted">未填图</span>,
          },
          { colKey: 'title', title: '标题' },
          { colKey: 'actionText', title: '按钮', width: 110, render: ({ row }: any) => row.actionText || <span className="muted">无</span> },
          { colKey: 'link', title: '点击行为', width: 190, render: ({ row }: any) => <span>{linkLabel(row.link)}{row.link === 'WORK' ? `（${row.workId || '缺 ID'}）` : ''}</span> },
          {
            colKey: 'enabled', title: '状态', width: 90,
            render: ({ row }: any) => row.enabled ? <Tag theme="primary">启用</Tag> : <Tag>停用</Tag>,
          },
          {
            colKey: 'op', title: '操作', width: 250, fixed: 'right',
            render: ({ row, rowIndex }: any) => (
              <>
                <Button size="small" variant="text" disabled={rowIndex === 0} onClick={() => move(rowIndex, -1)}>上移</Button>
                <Button size="small" variant="text" disabled={rowIndex === slides.length - 1} onClick={() => move(rowIndex, 1)}>下移</Button>
                <Button size="small" variant="text" onClick={() => openEdit(rowIndex)}>编辑</Button>
                <Button size="small" variant="text" theme="danger" onClick={() => removeSlide(rowIndex)}>删除</Button>
              </>
            ),
          },
        ]}
      />

      <Dialog
        header={editingIndex >= 0 ? `编辑第 ${editingIndex + 1} 张` : '新增一张'}
        visible={open}
        onClose={() => setOpen(false)}
        onConfirm={submitSlide}
        width={640}
      >
        <FieldGroup labelWidth={110}>
          <Field
            label="图片地址"
            required
            help="完整的 https 链接。建议 750×420 左右（卡片是 3:1.68 的横向比例），否则会被裁切"
          >
            <Input value={form.image} onChange={(v) => setForm((f) => ({ ...f, image: v as string }))} placeholder="https://…/static/mini/home/banner-1.jpg" />
          </Field>
          {!!form.image && /^https?:\/\//i.test(form.image) && (
            <Field label=" ">
              <img src={form.image} alt="" style={{ width: 300, height: 112, objectFit: 'cover', borderRadius: 6, background: '#eee' }} />
            </Field>
          )}
          <Field label="上方小字" help="留空则不显示">
            <Input value={form.kicker} onChange={(v) => setForm((f) => ({ ...f, kicker: v as string }))} placeholder="从一道菜开始" />
          </Field>
          <Field label="标题" required help="建议不超过 14 个字；超过两行会被省略">
            <Input value={form.title} onChange={(v) => setForm((f) => ({ ...f, title: v as string }))} placeholder="做一条能带来客人的视频" />
          </Field>
          <Field label="描述" help="留空则不显示">
            <Input value={form.desc} onChange={(v) => setForm((f) => ({ ...f, desc: v as string }))} placeholder="AI 帮你想文案、排分镜，现场拍完就能出片" />
          </Field>
          <Field label="按钮文字" help="留空则不显示按钮（整张卡片仍可点击）">
            <Input value={form.actionText} onChange={(v) => setForm((f) => ({ ...f, actionText: v as string }))} placeholder="开始创作" />
          </Field>
          <Field label="点击行为">
            <Select value={form.link} onChange={(v) => setForm((f) => ({ ...f, link: v as LinkCode }))} options={LINK_OPTIONS} />
          </Field>
          {form.link === 'WORK' && (
            <Field label="作品 ID" required help="「优秀作品」列表里的 ID">
              <Input value={form.workId} onChange={(v) => setForm((f) => ({ ...f, workId: v as string }))} placeholder="例如 12" />
            </Field>
          )}
          <Field label="启用" help="停用的不会下发给小程序，也不用删掉重配">
            <Switch value={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v as boolean }))} />
          </Field>
          <Field label="排序">
            <InputNumber
              value={form.sort}
              onChange={(v) => setForm((f) => ({ ...f, sort: Number(v) || 0 }))}
              style={{ width: 120 }}
            />
            <span className="muted" style={{ marginLeft: 8 }}>保存时会按列表顺序重写，这里一般不用管</span>
          </Field>
        </FieldGroup>
      </Dialog>
    </div>
  )
}
