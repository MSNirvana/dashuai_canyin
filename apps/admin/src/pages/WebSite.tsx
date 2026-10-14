import { Fragment, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Button, Input, message } from 'tdesign-react'
import Field, { FieldGroup } from '../components/Field'
// 「已保存 x」的落库时间读数：走统一口径的时分（与其它页面一致）
import { fmtClock } from '../lib/datetime'
import { request } from '../lib/http'

/**
 * 官网展示图（`dspcz.top` 首页的主视觉 + 三张案例图）。
 *
 * ── 存哪儿：复用系统配置，不新建表、不新加接口 ──────────────────────────────
 * 落在既有 `system_setting` 里的一行：
 *     groupKey='web' / settingKey='site' / valueType='JSON' / isPublic=true
 * 于是：
 *   · 后台读写走既有的 `/admin/api/v1/settings`（HomeCarousel / Contact 用的同一套）；
 *   · 官网读的是 `GET /api/v1/web/site`（免登录，见 server/src/routes/web.ts）。
 * 本页只负责把那段 JSON 编排成人能改的样子，其余链路一行都不动。
 *
 * ★ 为什么是**一条 JSON** 而不是「四张图四条 STRING」：
 *   ① `POST|PUT /settings` 的 schema 是 `settingVal: z.string().min(1)` —— **不允许存空串**。
 *      四条 STRING 的方案里，「把图删掉」只能存空串 ⇒ 400 ⇒ 运营只看到「保存失败」。
 *      一条 JSON 没这个洞：全空也是 `{"hero":{...},"cases":[...]}`，长度远大于 1。
 *   ② 4 张图是**一次整体下发**的（官网一次请求拿全），拆成 4 条会出现「主视觉换了、
 *      案例图还是旧的」这种半截状态，且没有任何东西能保证它们一起生效。
 *   （首页轮播图与「联系我们」是同一个原因、同一套写法。）
 *
 * ⚠ 服务端对 JSON 类型做了一次「简化」：coerceValue 里 parse 完又 stringify 回去。
 *   本页存的是字符串化的对象 —— 但消费端换成了 `/web/site`（它自己 parse 并校验地址），
 *   所以官网那边**不用**再踩这个坑。
 *
 * ── 留空 = 用官网内置的默认图，不是「显示空白」─────────────────────────────
 * 默认图是官网包里的静态资源。服务端**刻意不知道**这份清单（否则换图要两边同时改），
 * 所以本页也不去回显它，只明确写一句「留空 = 官网用内置默认图」。
 * ★ 因此「删掉自己传的图」与「一次都没配过」在官网那边是**同一件事** ——
 *   这是有意的：运营换图换坏了，清空就能回到出厂状态，不需要我们手工改库。
 *
 * ── 图片：直接上传，地址由服务端生成，运营不填 ─────────────────────────────
 * `POST /admin/api/v1/uploads/web-site-image`：服务端按**文件内容**判断类型
 * （魔数嗅探，不信 Content-Type 也不信文件名），写进 COS 的 `static/admin/web/`，
 * 只给这一个对象设 `ACL: public-read`，返回 CDN 直链。
 * 完整理由（含为什么前缀必须是 `static/`）见 `server/src/services/public-asset.service.ts` 顶部。
 */

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

const GROUP_KEY = 'web'
const SETTING_KEY = 'site'

/**
 * 单张图上限。
 * ⚠ 三处必须一致：这里（前端预校验，纯体验）、
 *   server/src/services/public-asset.service.ts::MAX_PUBLIC_IMAGE_BYTES（服务端权威校验）、
 *   deploy/nginx/dashuai-admin.conf 的 client_max_body_size（生产入口，默认 1MB 会先拦掉）。
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** 案例图固定 3 格 —— 必须与官网 `apps/web/src/Home.tsx` 的 `case-grid` 3 张卡、
 *  以及 server/src/routes/web.ts::CASE_SLOTS 三处对齐。多出来的会被服务端丢掉。 */
const CASE_COUNT = 3

interface HeroForm { image: string; alt: string }
interface CaseForm { image: string; title: string; alt: string }
export interface SiteForm { hero: HeroForm; cases: CaseForm[] }

/** 内置默认图的**文案**只用来当输入框的 placeholder（图本身不在这里回显，见文件头说明） */
const HERO_ALT_HINT = '门店经营者用手机拍摄刚出锅的菜品'
const CASE_TITLE_HINTS = ['后厨出锅', '餐桌摆盘', '备菜备料']
const CASE_ALT_HINTS = [
  '厨师端着刚出锅的菜品装盘',
  '店主用手机三脚架拍摄摆好盘的菜品',
  '厨师低头看着手机屏幕拍摄案台上的食材',
]

const emptyCase = (): CaseForm => ({ image: '', title: '', alt: '' })
const EMPTY_FORM: SiteForm = {
  hero: { image: '', alt: '' },
  cases: Array.from({ length: CASE_COUNT }, emptyCase),
}

/**
 * 把库里存的 JSON 收敛成可编辑的表单。
 *
 * ★ 返回值是 `null` 而不是空表单：调用方要靠这个 `null` 区分
 *   「值坏掉了」与「值是全空的对象」—— 前者要亮红条警示，后者是正常的「还没配」。
 *   把两种情况都收敛成空表单，就等于把「数据被人手改坏了」静默成「运营还没配」。
 * ★ `cases` 一律补齐到 CASE_COUNT 格：库里存了 2 格（或被人手工删了一格）时，
 *   界面不能少一行 —— 少一行就等于运营**看不到、也改不了**那一格，
 *   而它对应的是官网上一张真实的卡片。
 */
function parseSite(raw: string): SiteForm | null {
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const it = v as Record<string, unknown>
    const heroRaw = it.hero && typeof it.hero === 'object' && !Array.isArray(it.hero)
      ? (it.hero as Record<string, unknown>) : {}
    const casesRaw = Array.isArray(it.cases) ? it.cases : []
    const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')
    return {
      hero: { image: str(heroRaw.image), alt: str(heroRaw.alt) },
      cases: Array.from({ length: CASE_COUNT }, (_, i) => {
        const c = casesRaw[i]
        const o = c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
        return { image: str(o.image), title: str(o.title), alt: str(o.alt) }
      }),
    }
  } catch {
    return null
  }
}

/** 哪一格正在上传。用 ref 而不是 state：它只在「点了按钮」到「change 事件」之间活着，
 *  放 state 会多一次渲染，而且 onChange 读到的是旧值。 */
type UploadTarget = { kind: 'hero' } | { kind: 'case'; index: number }

export default function WebSitePage() {
  const [row, setRow] = useState<Setting | null>(null)
  const [form, setForm] = useState<SiteForm>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  /** 库里已有这一项、但 settingVal 不是合法 JSON 对象 —— 保存会覆盖它，先警示 */
  const [broken, setBroken] = useState(false)
  /** 隐藏的文件选择框。用原生 input 而不是 tdesign 的 <Upload>：理由同 HomeCarousel
   *  （后者自管一套文件列表状态，插进这个由 React state 完全自管的表单就得手工同步
   *   四处，漏一处就是「组件里显示已上传、表单里其实没有」且不报错）。 */
  const fileRef = useRef<HTMLInputElement>(null)
  const targetRef = useRef<UploadTarget | null>(null)
  /** 最近一次**确认落库**的时间：给运营一个「确实存进去了」的凭据 */
  const [savedAt, setSavedAt] = useState('')
  const [saveError, setSaveError] = useState('')
  /**
   * 已落库那份表单的序列化值。与当前 form 不一致 = 有改动还没落库。
   *
   * ★★ **初始值必须是「空表单的序列化值」，不能是 `''`。**
   *   自动保存的判据是 `JSON.stringify(form) !== savedKeyRef.current`。这个 ref 只在
   *   `load()` 的**成功分支**里被赋值 ⇒ 一旦 `GET /settings` 失败，它仍是初始值。
   *   若初始值是 `''`，那么 `'{"hero":...}' !== ''` 恒成立 ⇒ `dirty` 为真 ⇒
   *   500ms 后自动落库**凭空发一次 POST**（`row` 还是 null），撞上
   *   `(groupKey, settingKey)` 唯一索引报错，运营会看到一个莫名其妙的「保存失败」，
   *   而他什么都没改。（这条是 Contact.tsx 那边实测抓到的，HomeCarousel 尚未修。）
   */
  const savedKeyRef = useRef(JSON.stringify(EMPTY_FORM))
  /** 自动保存的防抖句柄 */
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** beforeunload 里读的实时状态（那个 handler 只注册一次，读不到新的闭包值） */
  const dirtyRef = useRef(false)

  const load = async () => {
    setLoading(true)
    try {
      const list = await request<Setting[]>({ url: '/settings' })
      const found = list.find((s) => s.groupKey === GROUP_KEY && s.settingKey === SETTING_KEY) ?? null
      const parsed = found ? parseSite(found.settingVal) : null
      const safe = parsed ?? { hero: { ...EMPTY_FORM.hero }, cases: EMPTY_FORM.cases.map((c) => ({ ...c })) }
      setRow(found)
      setForm(safe)
      // ★ 必须在设完 form 后立刻记下「库里那份长什么样」——自动保存的判据全靠它。
      //   否则重新 load 回来的值会被当成「有改动」，凭空触发一次多余的写库。
      savedKeyRef.current = JSON.stringify(safe)
      setSaveError('')
      setBroken(!!found && parsed === null)
    } catch {
      /* 已 toast */
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  /**
   * 打开文件选择框。
   * ★ 用原生 `<input type="file">` 而不是 tdesign 的 `<Upload>`，理由同 HomeCarousel。
   * ★ 先把「要传进哪一格」记下来再去点：一个 input 同时服务 4 个槽位，
   *   不记这一笔就分不清 change 回来的是主视觉还是第 2 张案例图。
   */
  const pickImage = (target: UploadTarget) => {
    targetRef.current = target
    fileRef.current?.click()
  }

  const uploadImage = async (file: File) => {
    const target = targetRef.current
    if (!target) return
    setUploading(true)
    try {
      const r = await request<{ key: string; url: string }>({
        url: '/uploads/web-site-image',
        method: 'POST',
        // 直接发原始字节（不是 multipart）：服务端只有一个文件、没有别的字段，
        // 而 raw 能让服务端按**文件内容**判断类型。这里带的 Content-Type 只是浏览器
        // 给出的提示 —— 服务端不信它，真正的类型判断靠魔数嗅探。
        data: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        // 实例默认 30s，对「几 MB 的图 + 弱网」偏紧，这一条单独放宽
        timeout: 60_000,
      })
      setForm((f) => target.kind === 'hero'
        ? { ...f, hero: { ...f.hero, image: r.url } }
        : { ...f, cases: f.cases.map((c, i) => (i === target.index ? { ...c, image: r.url } : c)) })
      // 说清还有一步：只说「已上传」会让运营以为已经生效（图只是进了对象存储）
      message.success('图片已上传，正在保存…')
    } catch {
      /* 已 toast */
    } finally {
      setUploading(false)
    }
  }

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // ★ 先清空 value 再去做上传：input.value 不清空的话，**再选同一个文件不会触发 change**
    //   （上传失败后重试同一张图时按钮像坏了，且完全没有报错可循）
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_IMAGE_BYTES) {
      message.warning(`图片不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`)
      return
    }
    void uploadImage(file)
  }

  /** 清空某一格的图（= 回退到官网内置默认图） */
  const clearImage = (target: UploadTarget) => {
    setForm((f) => target.kind === 'hero'
      ? { ...f, hero: { ...f.hero, image: '' } }
      : { ...f, cases: f.cases.map((c, i) => (i === target.index ? { ...c, image: '' } : c)) })
  }

  /**
   * 真正落库，返回是否成功。
   * 抽成独立函数是为了让「自动保存」与失败后的「重试保存」走**同一条**代码路径。
   */
  const persist = async (): Promise<boolean> => {
    const payloadForm: SiteForm = {
      hero: { image: form.hero.image.trim(), alt: form.hero.alt.trim() },
      cases: form.cases.map((c) => ({
        image: c.image.trim(),
        title: c.title.trim(),
        alt: c.alt.trim(),
      })),
    }
    // 地址只可能来自上传接口；这条是防「接口返回了非绝对地址」这类内部错误静默漏到官网：
    // 那边是 <img src>，只会裂图，而且没有任何提示可循。
    const bad = [payloadForm.hero, ...payloadForm.cases]
      .find((s) => s.image && !/^https?:\/\//i.test(s.image))
    if (bad) {
      setSaveError('有一张图的地址不是完整的 http(s) 链接，请重新上传')
      return false
    }
    const payload = {
      groupKey: GROUP_KEY,
      settingKey: SETTING_KEY,
      settingVal: JSON.stringify(payloadForm),
      valueType: 'JSON' as const,
      displayName: '官网展示图',
      description: '官网首页的主视觉与三张案例图。留空则用官网内置的默认图。',
      sort: 0,
      isPublic: true, // 必须公开：官网是免登录拉取的
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

  /** 保存失败后的**唯一**重试出路 */
  const retrySave = () => { void persist() }

  /**
   * ★ 自动保存：表单一变就落库（防抖 500ms）。这一页**没有保存按钮**，理由同
   *   HomeCarousel / Contact：运营的心智模型是「图传完了 = 好了」，多出来的那一步
   *   只要漏掉，页面上看到的值就只是内存里的假象 —— 刷新即消失。
   *
   * 依赖里只放 form / loading：**别把 saving / saveError 放进来**，
   * 否则保存自己触发的状态变化会再跑一遍 effect，变成写库死循环。
   */
  useEffect(() => {
    if (loading) return
    if (JSON.stringify(form) === savedKeyRef.current) return
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
    autoTimerRef.current = setTimeout(() => { void persist() }, 500)
    return () => { if (autoTimerRef.current) clearTimeout(autoTimerRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, loading])

  /** 有改动还没落库（自动保存的 500ms 窗口内也会短暂为 true） */
  const dirty = !loading && JSON.stringify(form) !== savedKeyRef.current
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

  const configured = !!form.hero.image || form.cases.some((c) => c.image)

  /**
   * 一个图片槽位：预览 + 上传/更换 + 清除。
   * ★ 预览尺寸按**官网真实展示比例**给：主视觉 4:3 横图、案例图 2:3 竖图。
   *   ⚠ 官网主视觉是**响应式**的（手机 4:3 / ≥778px 16:10 / ≥809px 3:2，见 apps/web 的
   *     `.hero-media img`）。一个预览只能取一档，取**裁得最狠的手机档 4:3** ——
   *     受众是门店经营者、主要在手机上看；而且「在最坏比例下还看不看得过去」才是这张
   *     预览要回答的问题。取桌面档会让手机上被切掉的部分永远看不到。
   *   套公共的 `.upload-field__preview`（固定 300×112 + cover，是给 16:6 的轮播图用的）
   *   会把竖图裁成一条 —— 运营在后台看到的东西和官网上根本不是同一张。
   */
  const renderSlot = (target: UploadTarget, value: string, size: 'hero' | 'case', hint: string) => {
    const box = size === 'hero' ? { width: 240, height: 180 } : { width: 96, height: 144 }
    return (
    <div className="upload-field">
      {value ? (
        <img className="upload-field__preview" src={value} alt="" style={{ ...box, objectFit: 'cover' }} />
      ) : (
        <div className="upload-field__empty muted" style={box}>用内置图</div>
      )}
      <div className="upload-field__actions">
        <div>
          <Button size="small" loading={uploading} onClick={() => pickImage(target)}>
            {value ? '更换图片' : '上传图片'}
          </Button>
          {value ? (
            <Button
              size="small"
              variant="text"
              disabled={uploading}
              style={{ marginLeft: 4 }}
              onClick={() => clearImage(target)}
            >
              清除
            </Button>
          ) : null}
        </div>
        <span className="muted">{hint}</span>
      </div>
    </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <h2>官网图片</h2>
        <div>
          {/* 这一页没有保存按钮（表单一变即自动落库），所以这行状态文字就是运营判断
              「现在官网上是什么」的唯一凭据，必须常驻。 */}
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
          {/* 只在失败时出现：正常路径全自动，但失败总得有条重来的路 */}
          {!!saveError && (
            <Button size="small" variant="text" theme="danger" onClick={retrySave}>
              重试保存
            </Button>
          )}
        </div>
      </div>

      <div className="page-tip">
        显示在<b>官网首页（dspcz.top）</b>：顶部主视觉 1 张 +「店里能拍的场景」3 张。<br />
        图片<b>直接上传</b>即可 —— 服务端会把它存到对象存储并返回一条公开直链，不用手填地址。<br />
        <b>留空 = 官网用内置的默认图</b>，所以想回到出厂状态，点「清除」即可，不用找我们改数据。<br />
        主视觉建议 <b>1536×1152（4:3 横图）</b>，案例图建议 <b>1024×1456（约 2:3 竖图）</b>；
        支持 jpg / png / webp / gif，单张不超过 5MB。<b>改完即自动保存</b>，刷新官网即可看到。
      </div>

      {broken && (
        <div className="page-tip" style={{ color: '#e1251b', borderColor: '#f5c2c0', background: '#fef2f2' }}>
          库里已存在这一项，但它的值不是合法的 JSON 对象（可能是手工改过）。
          现在表单显示为空 —— <b>表单一旦有改动就会自动覆盖它</b>；想先看一眼原值，去「系统设置」按分组
          <code>web</code> 找 <code>site</code>。
        </div>
      )}

      <div className="web-image-editor">
        {/* 效果示意：把官网首页那两块按同样的版式画一遍。
            ⚠ 只是版式示意，不是像素级预览 —— 留空的格子画成虚线框并注明「用内置图」。
            ⚠ 主视觉按**手机端 4:3** 画（官网主视觉是响应式的，手机 4:3 / 桌面 16:10、3:2）。
              取手机档是因为它裁得最狠，也是绝大多数访客看到的那一档；标题里写明，
              免得运营拿一张按桌面档做的图来问「为什么预览里被切了」。 */}
        <div className="web-preview">
          <div className="web-preview__caption">官网首页 效果示意（主视觉按手机端 4:3）</div>
          <div className="web-preview__hero">
            {form.hero.image ? (
              <img src={form.hero.image} alt="" />
            ) : (
              <div className="web-preview__slot">主视觉 · 用内置图</div>
            )}
          </div>
          <div className="web-preview__cases">
            {form.cases.map((c, i) => (
              <div className="web-preview__case" key={i}>
                {c.image ? (
                  <img src={c.image} alt="" />
                ) : (
                  <div className="web-preview__slot">案例 {i + 1} · 用内置图</div>
                )}
                <span>{c.title || CASE_TITLE_HINTS[i]}</span>
              </div>
            ))}
          </div>
          <div className="web-preview__note">
            {configured
              ? '实线框里的图 = 你上传的；虚线框 = 官网内置默认图。'
              : '当前全部留空 ⇒ 官网显示四张内置默认图。'}
          </div>
        </div>

        <div className="web-image-editor__form">
          <FieldGroup labelWidth={96}>
            {/* 分节标题用既有的 .section-heading（与其它页面的小标题同款），
                而不是把 FieldGroup 嵌套一层 —— 嵌套只是把同一个 CSS 变量重设一遍，
                看着有分组、实际没有，反倒让「哪几行属于同一组」更难读。 */}
            <div className="section-heading"><h3>主视觉</h3></div>
            <Field label="图片" help="官网首屏右边那张横图。留空则用内置默认图">
              {renderSlot({ kind: 'hero' }, form.hero.image, 'hero', '官网首屏右侧，4:3 横图（按手机端）')}
            </Field>
            <Field label="图片说明" help="给搜索引擎和读屏软件看的，不显示在页面上；换图后请顺带改这里">
              <Input
                value={form.hero.alt}
                onChange={(v) => setForm((f) => ({ ...f, hero: { ...f.hero, alt: v as string } }))}
                placeholder={HERO_ALT_HINT}
                style={{ maxWidth: 420 }}
              />
            </Field>

            {form.cases.map((c, i) => (
              <Fragment key={i}>
                <div className="section-heading"><h3>案例图 {i + 1}</h3></div>
                <Field label="图片" help="官网「店里能拍的场景」里的第 1/2/3 张竖图。留空则用内置默认图">
                  {renderSlot({ kind: 'case', index: i }, c.image, 'case', '2:3 竖图')}
                </Field>
                <Field label="卡片标题" help="显示在图片下方，建议 4–6 个字；过长官网会折行">
                  <Input
                    value={c.title}
                    onChange={(v) => setForm((f) => ({
                      ...f,
                      cases: f.cases.map((x, j) => (j === i ? { ...x, title: v as string } : x)),
                    }))}
                    placeholder={CASE_TITLE_HINTS[i]}
                    style={{ maxWidth: 260 }}
                  />
                </Field>
                <Field label="图片说明" help="给搜索引擎和读屏软件看的，不显示在页面上；换图后请顺带改这里">
                  <Input
                    value={c.alt}
                    onChange={(v) => setForm((f) => ({
                      ...f,
                      cases: f.cases.map((x, j) => (j === i ? { ...x, alt: v as string } : x)),
                    }))}
                    placeholder={CASE_ALT_HINTS[i]}
                    style={{ maxWidth: 420 }}
                  />
                </Field>
              </Fragment>
            ))}
          </FieldGroup>

          {/* 4 个槽位共用这一个隐藏 input：靠 targetRef 记住是哪一格 */}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            style={{ display: 'none' }}
            onChange={onFileChange}
          />
        </div>
      </div>
    </div>
  )
}
