import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Button, Dialog, Input, InputNumber, Select, Switch, Tag, message } from 'tdesign-react'
import DataTable from '../lib/table'
import Field, { FieldGroup } from '../components/Field'
import { confirmDialog } from '../lib/confirm'
// 「已保存 x」的落库时间读数：走统一口径的时分（原来是 toLocaleTimeString，带秒）
import { fmtClock } from '../lib/datetime'
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
 * ── 图片：直接上传，地址由服务端生成，运营不填 ─────────────────────────────
 * 小程序是直接把这个值塞进 <Image src>：它**不签名、也不认对象键**，所以只能是一条
 * **长期匿名可读的完整 URL**。于是三种候选地址只有一种能用 ——
 *   · 签名 URL（服务端媒体那套，1 小时过期）⇒ 用户下次打开就是裂图；
 *   · 对象键 ⇒ 小程序不知道去哪取；
 *   · 公开直链 ⇒ 唯一可行。
 * 为此新增了 `POST /admin/api/v1/uploads/carousel-image`：服务端按**文件内容**判断类型
 * （魔数嗅探，不信 Content-Type 也不信文件名），写进 COS 的 `static/admin/carousel/`，
 * 并只给这一个对象设 `ACL: public-read`（桶仍是私有桶，里面还有商家私密素材），
 * 最后返回 CDN 直链。完整理由（含为什么不能复用商家上传那套、以及为什么这个前缀
 * 不会被孤儿对象 GC 误删）见 `server/src/services/public-asset.service.ts` 顶部。
 *
 * ⚠ 图片字段**只有上传入口，没有手填输入框**（按需求，2026-09-16）。因此编辑一张
 *   「图片是手填的老数据」时，`form.image` 里那个字符串会**原样保留并提交** ——
 *   不重新上传就不会动它，不会因为「没有输入框」而把老数据洗空。
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
 * 单张图上限。
 * ⚠ 三处必须一致：这里（前端预校验，纯体验）、
 *   server/src/services/public-asset.service.ts::MAX_PUBLIC_IMAGE_BYTES（服务端权威校验）、
 *   deploy/nginx/dashuai-admin.conf 的 client_max_body_size（生产入口，默认 1MB 会先拦掉）。
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

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
  desc: '', // 副标题已按需求下线（2026-09-16）
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
  const [uploading, setUploading] = useState(false)
  /** 隐藏的文件选择框。用原生 input 而不是 tdesign 的 <Upload>：见 pickImage 的说明 */
  const fileRef = useRef<HTMLInputElement>(null)
  /** 最近一次**确认落库**的时间：给运营一个「确实存进去了」的凭据 */
  const [savedAt, setSavedAt] = useState('')
  const [saveError, setSaveError] = useState('')
  /**
   * 已落库那份 slides 的序列化值。与当前 slides 不一致 = 有改动还没落库。
   *
   * ★ 这里是本页最容易出事的地方：**列表里出现一行 ≠ 已经生效**。
   *   `POST /uploads/carousel-image` 只把图写进对象存储、把地址填进表单，真正下发到
   *   小程序要靠一次 PUT/POST `/settings`。少了这一步，那一行就只活在内存里：
   *   一刷新、或者切走再回来（useEffect 重新 load）就没了，看着完全就是
   *   「被后台自动删除了」（2026-09-17 用户就是这么报的）。
   *
   * ★ 这一步曾经极其容易漏（历史成因，别再改回去）：那时页面上有个显眼的「保存」按钮，
   *   而运营传完图的第一反应就是去点它 —— 可弹窗此时还开着，点击落在遮罩上被**吃掉**，
   *   既无请求也无报错，于是「点了保存」和「没点保存」在界面上完全无法区分。
   *   现在这一页**没有保存按钮**：唯一的写入时机是弹窗里的「确认」（列表一变即自动落库），
   *   保存这件事不再依赖运营记得点某个按钮。
   *   savedKeyRef 就是这个自动保存的判据，同时**只在失败时**才会出声（见 persist）。
   */
  const savedKeyRef = useRef('')
  /** 自动保存的防抖句柄 */
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** beforeunload 里读的实时状态（那个 handler 只注册一次，读不到新的闭包值） */
  const dirtyRef = useRef(false)

  const load = async () => {
    setLoading(true)
    try {
      const list = await request<Setting[]>({ url: '/settings' })
      const found = list.find((s) => s.groupKey === GROUP_KEY && s.settingKey === SETTING_KEY) ?? null
      const parsed = found ? parseSlides(found.settingVal) : []
      setRow(found)
      setSlides(parsed)
      // ★ 必须在设完 slides 后立刻记下「库里那份长什么样」——自动保存的判据全靠它。
      //   否则重新 load 回来的值会被当成「有改动」，凭空触发一次多余的写库。
      savedKeyRef.current = JSON.stringify(parsed)
      setSaveError('')
      setBroken(!!found && parsed.length === 0 && found.settingVal.trim() !== '[]')
    } catch {
      /* 已 toast */
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const validate = (s: Slide): string => {
    if (!s.image.trim()) return '还没上传图片'
    // 正常情况下地址只可能来自上传接口，这条是防「接口返回了非绝对地址」这类内部错误
    // 静默漏到小程序：那边是 <Image src>，只会白图，且没有任何提示可循。
    if (!/^https?:\/\//i.test(s.image.trim())) return '图片地址不是完整的 http(s) 链接，请重新上传'
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

  /**
   * 打开文件选择框。
   *
   * ★ 为什么用原生 `<input type="file">` 而不是 tdesign 的 `<Upload>`：
   *   本页要的只是「选一张图 → 传掉 → 拿回一个 URL」，而 `<Upload>` 内部自管一套
   *   文件列表状态；把它插进这个**由 React state 完全自管**的表单，就得在
   *   onChange / onSuccess / onError / onRemove 四处手工同步 —— 任何一处漏掉，
   *   表现都是「组件里显示已上传、表单里其实没有」，而且**不会报错**。
   *   本后台已经因为 tdesign 表单组件的隐式注入踩过坑（见 components/Field.tsx 顶部），
   *   对这类「多一份影子状态」的组件保持距离；只要选图 + 上传两个能力，自己写更短也更可控。
   */
  const pickImage = () => fileRef.current?.click()

  const uploadImage = async (file: File) => {
    setUploading(true)
    try {
      const r = await request<{ key: string; url: string }>({
        url: '/uploads/carousel-image',
        method: 'POST',
        // 直接发原始字节（不是 multipart）：服务端只有一个文件、没有别的字段，
        // 而 raw 能让服务端按**文件内容**判断类型。这里带的 Content-Type 只是浏览器
        // 给出的提示 —— 服务端不信它，真正的类型判断靠魔数嗅探。
        data: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        // 实例默认 30s，对「几 MB 的图 + 弱网」偏紧，这一条单独放宽
        timeout: 60_000,
      })
      setForm((f) => ({ ...f, image: r.url }))
      // 明确说出还有一步：只说「已上传」会让运营以为已经生效（图只是进了对象存储，
      // 列表里还没有这一行，库里更没有）
      message.success('图片已上传，点「确认」加入列表')
    } catch {
      /* 已 toast */
    } finally {
      setUploading(false)
    }
  }

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // ★ 先清空 value 再去做上传：input.value 不清空的话，**再选同一个文件不会触发 change**。
    //   典型场景是上传失败后重试同一张图 —— 界面毫无反应，看着像按钮坏了。
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_IMAGE_BYTES) {
      message.warning(`图片不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`)
      return
    }
    void uploadImage(file)
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
    const ok = await confirmDialog('删除这一张', `删除「${slides[idx]?.title || '未命名'}」？删除会自动保存，小程序下次进入首页即不再显示。`)
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

  /**
   * 真正落库，返回是否成功。
   *
   * 抽成独立函数是为了让「自动保存」与失败后的「重试保存」走**同一条**代码路径 ——
   * 各写一遍的话，早晚出现「重试少做了一步校验 / 少刷了一次列表」这类偏差。
   */
  const persist = async (): Promise<boolean> => {
    for (const [i, s] of slides.entries()) {
      const err = validate(s)
      if (err) { message.warning(`第 ${i + 1} 张：${err}`); return false }
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
      setSaveError('')
      setSavedAt(fmtClock(new Date()))
      // 重新读一遍，而不是本地「假装已保存」：POST 新建时要拿到新的行 id，否则
      // 第二次保存会再去 POST 一次，撞上 (groupKey, settingKey) 唯一索引而失败。
      await load()
      return true
    } catch (e) {
      // ★ 失败必须**留在页面上**：只弹一个 2 秒的 toast，运营切走再回来就永远看不到原因了
      setSaveError((e as Error).message || '保存失败')
      return false
    } finally {
      setSaving(false)
    }
  }

  /**
   * 保存失败后的**唯一**重试出路。
   *
   * 页面上平时没有「保存」按钮：这一页的写入时机只有一个 —— 弹窗里的「确认」
   * （列表一变就自动落库）。但失败时必须有地方能重来，否则运营只能靠「再随便改一下
   * 触发一次自动保存」来蒙，那是撞运气。
   */
  const retrySave = () => { void persist() }

  /**
   * ★ 自动保存：列表一变就落库（防抖 500ms）。
   *
   * 为什么不做成「必须手动点保存」——运营的心智模型是「图传完了 = 好了」，
   * 而多出来的这一步只要漏掉，列表里那一行就只是内存里的假象：**刷新即消失**，
   * 看着完全就是「被后台自动删除了」。这一步又特别容易被漏：那时页面上有个「保存」
   * 按钮，而弹窗遮罩会把它静默吃掉（无请求、无报错），点没点过完全看不出来。
   * ⇒ 干脆取消这个按钮（2026-09-18）：让「列表里看到的」永远等于「库里存的」。
   *
   * 依赖里只放 slides / loading：**别把 saving / saveError 放进来**，
   * 否则保存自己触发的状态变化会再跑一遍 effect，变成写库死循环。
   */
  useEffect(() => {
    if (loading) return
    if (JSON.stringify(slides) === savedKeyRef.current) return
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
    // 走 persist（它只在失败时才出声）：保存成功由页面上那行状态文字表达，
    // 每次自动保存都弹一个 toast 反而会盖住真正要看的东西
    autoTimerRef.current = setTimeout(() => { void persist() }, 500)
    return () => { if (autoTimerRef.current) clearTimeout(autoTimerRef.current) }
  }, [slides, loading])

  /** 有改动还没落库（自动保存的 500ms 窗口内也会短暂为 true） */
  const dirty = !loading && JSON.stringify(slides) !== savedKeyRef.current
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  /** 还有改动没落库时拦一下刷新 / 关标签页：别让那个 500ms 窗口变成数据丢失口 */
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  return (
    <div>
      <div className="page-header">
        <h2>首页轮播图</h2>
        <div>
          {/* 这一页唯一的写入时机是弹窗里的「确认」（列表一变即自动落库），
              所以这行状态文字就是运营判断「现在小程序看得到吗」的唯一凭据，必须常驻。 */}
          <span className={saveError ? 'danger-text' : 'muted'} style={{ marginRight: 12 }}>
            {saving
              ? '保存中…'
              : saveError
                ? `保存失败：${saveError}`
                : dirty
                  ? '有改动未保存，正在自动保存…'
                  : savedAt
                    ? `已保存 ${savedAt}`
                    : ''}
          </span>
          {/* 只在失败时出现：正常路径全自动，不需要按钮；但失败总得有条重来的路 */}
          {!!saveError && (
            <Button size="small" variant="text" theme="danger" style={{ marginRight: 12 }} onClick={retrySave}>
              重试保存
            </Button>
          )}
          <Button onClick={addSlide}>新增一张</Button>
        </div>
      </div>

      <div className="page-tip">
        小程序首页顶部的「创作入口」卡片。配 1 张时就是一张静态卡片（不轮播、不显示圆点），
        配 2 张以上才会自动轮播。<br />
        图片<b>直接上传</b>即可 —— 服务端会把它存到对象存储，并返回一条公开直链，不用手填地址。
        建议 750×420（卡片是 3:1.68 的横向比例），支持 jpg / png / webp / gif，单张不超过 5MB。<br />
        清空全部 = 回退到内置那张默认卡片。<b>改完点弹窗里的「确认」即自动保存</b>，
        小程序下次进入首页即可看到。
      </div>

      {broken && (
        <div className="page-tip" style={{ color: '#e1251b', borderColor: '#f5c2c0', background: '#fef2f2' }}>
          库里已存在这一项，但它的值不是合法的 JSON 数组（可能是手工改过）。
          现在列表显示为空 —— <b>列表一旦有改动就会自动覆盖它</b>；想先看一眼原值，去「系统设置」按分组
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
            label="图片"
            required
            help="建议 750×420（卡片是 3:1.68 的横向比例），否则会被裁切；支持 jpg / png / webp / gif，单张不超过 5MB"
          >
            <div className="upload-field">
              {form.image ? (
                <img className="upload-field__preview" src={form.image} alt="" />
              ) : (
                <div className="upload-field__empty muted">未上传</div>
              )}
              <div className="upload-field__actions">
                <Button size="small" loading={uploading} onClick={pickImage}>
                  {form.image ? '更换图片' : '上传图片'}
                </Button>
                <span className="muted">上传后自动托管，点「确认」加入列表即生效</span>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={onFileChange}
            />
          </Field>
          <Field label="上方小字" help="留空则不显示">
            <Input value={form.kicker} onChange={(v) => setForm((f) => ({ ...f, kicker: v as string }))} placeholder="从一道菜开始" />
          </Field>
          <Field label="标题" required help="建议不超过 14 个字；超过两行会被省略">
            <Input value={form.title} onChange={(v) => setForm((f) => ({ ...f, title: v as string }))} placeholder="做一条能带来客人的视频" />
          </Field>
          <Field label="描述" help="留空则不显示">
            <Input value={form.desc} onChange={(v) => setForm((f) => ({ ...f, desc: v as string }))} placeholder="一句话说明卖点，可留空" />
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
            <span className="muted" style={{ marginLeft: 8 }}>落库时会按列表顺序重写，这里一般不用管</span>
          </Field>
        </FieldGroup>
      </Dialog>
    </div>
  )
}
