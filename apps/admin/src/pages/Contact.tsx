import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Button, Input, message } from 'tdesign-react'
import Field, { FieldGroup } from '../components/Field'
// 「已保存 x」的落库时间读数：走统一口径的时分（与其它页面一致）
import { fmtClock } from '../lib/datetime'
import { request } from '../lib/http'

/**
 * 联系我们（小程序「我的」页 → 学习中心下方那块：二维码 + 客服电话）。
 *
 * ── 存哪儿：复用系统配置，不新建表、不新加接口 ──────────────────────────────
 * 落在既有 `system_setting` 里的一行：
 *     groupKey='contact' / settingKey='info' / valueType='JSON' / isPublic=true
 * 于是：
 *   · 后台读写走既有的 `/admin/api/v1/settings`（HomeCarousel / Settings.tsx 用的同一套）；
 *   · 小程序读的是既有的**公开**接口 `GET /api/v1/system/settings`（免登录）。
 * 本页只负责把那段 JSON 编排成人能改的样子，其余链路一行都不动。
 *
 * ★ 为什么是**一条 JSON** 而不是两条 STRING（qrcode / phone）：
 *   `POST|PUT /settings` 的 schema 是 `settingVal: z.string().min(1)` —— **不允许存空串**。
 *   两条 STRING 的方案里，「把电话删掉」只能存空串 ⇒ 400 ⇒ 运营只看到「保存失败」。
 *   一条 JSON 没有这个洞：清空后是 `{"qrcode":"","phone":""}`，长度远大于 1。
 *   （首页轮播图是同一个原因、同一套写法，见 HomeCarousel.tsx 顶部。）
 *
 * ⚠ 服务端对 JSON 类型做了一次「简化」：coerceValue 里 parse 完又 stringify 回去，
 *   所以小程序拿到的是**字符串**、得自己再 parse（见 server/src/routes/system-settings.ts）。
 *   本页存的时候也就存字符串化后的对象。
 *
 * ── 图片：直接上传，地址由服务端生成，运营不填 ─────────────────────────────
 * 与首页轮播图同一条通道（`POST /admin/api/v1/uploads/contact-qrcode`）：服务端按**文件内容**
 * 判断类型（魔数嗅探，不信 Content-Type 也不信文件名），写进 COS 的 `static/admin/contact/`，
 * 只给这一个对象设 `ACL: public-read`，返回 CDN 直链。
 * 完整理由见 `server/src/services/public-asset.service.ts` 顶部。
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

const GROUP_KEY = 'contact'
const SETTING_KEY = 'info'

/**
 * 单张图上限。
 * ⚠ 三处必须一致：这里（前端预校验，纯体验）、
 *   server/src/services/public-asset.service.ts::MAX_PUBLIC_IMAGE_BYTES（服务端权威校验）、
 *   deploy/nginx/dashuai-admin.conf 的 client_max_body_size（生产入口，默认 1MB 会先拦掉）。
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

interface ContactForm {
  qrcode: string
  phone: string
}

const EMPTY_FORM: ContactForm = { qrcode: '', phone: '' }

/**
 * 把库里存的 JSON 收敛成可编辑的表单。
 * ★ 返回值是 `null` 而不是空表单：调用方要靠这个 `null` 区分
 *   「值坏掉了」与「值是 `{}` / 两个空串」—— 前者要亮红条警示，后者是正常的「还没配」。
 *   把两种情况都收敛成空表单，就等于把「数据被人手改坏了」静默成「运营还没配」。
 */
function parseContact(raw: string): ContactForm | null {
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const it = v as Record<string, unknown>
    return {
      qrcode: typeof it.qrcode === 'string' ? it.qrcode.trim() : '',
      phone: typeof it.phone === 'string' ? it.phone.trim() : '',
    }
  } catch {
    return null
  }
}

/**
 * 可拨号码的判据。**必须与小程序端 apps/mini/src/services/contact.ts::toDialable 同规则**
 * （只留数字与开头的 +，且数字 ≥ 5 位）—— 两边不一致会出现「后台显示配好了、
 * 小程序里电话那一行却不显示」这种最难查的一类问题。
 *
 * ★ 这里只用来给**提示**，不用来拦保存：运营输入过程中必然经过「位数不够」的中间态，
 *   用它拦保存就等于每敲一个键报一次错。
 */
function toDialable(raw: string): string {
  const plus = raw.startsWith('+') ? '+' : ''
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 5 ? plus + digits : ''
}

export default function ContactPage() {
  const [row, setRow] = useState<Setting | null>(null)
  const [form, setForm] = useState<ContactForm>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  /** 库里已有这一项、但 settingVal 不是合法 JSON 对象 —— 保存会覆盖它，先警示 */
  const [broken, setBroken] = useState(false)
  /** 隐藏的文件选择框。用原生 input 而不是 tdesign 的 <Upload>：理由同 HomeCarousel */
  const fileRef = useRef<HTMLInputElement>(null)
  /** 最近一次**确认落库**的时间：给运营一个「确实存进去了」的凭据 */
  const [savedAt, setSavedAt] = useState('')
  const [saveError, setSaveError] = useState('')
  /**
   * 已落库那份表单的序列化值。与当前 form 不一致 = 有改动还没落库。
   *
   * ★ 与 HomeCarousel 同一条教训：**页面上看到的值 ≠ 已经生效**。
   *   `POST /uploads/contact-qrcode` 只把图写进对象存储、把地址填进表单，
   *   真正下发到小程序要靠一次 PUT/POST `/settings`。少了这一步，刷新就没了，
   *   看着完全就是「被后台自动删除了」。
   *
   * ★★ **初始值必须是「空表单的序列化值」，不能是 `''`。**
   *   自动保存的判据是 `JSON.stringify(form) !== savedKeyRef.current`。
   *   这个 ref 只在 `load()` 的**成功分支**里被赋值 ⇒ 一旦 `GET /settings` 失败，
   *   它仍是初始值。若初始值是 `''`，那么 `'{"qrcode":"","phone":""}' !== ''` 恒成立
   *   ⇒ `dirty` 为真 ⇒ 500ms 后自动落库**凭空发一次 POST**（`row` 还是 null），
   *   撞上 `(groupKey, settingKey)` 唯一索引报错，运营会看到一个莫名其妙的「保存失败」，
   *   而他什么都没改。
   *   ⇒ 写成空表单的序列化值后，「加载失败」与「表单确实是空的」在判据上等价，
   *     不会产生任何多余的写。（本轮的验收就抓到了这一条：桩没命中时状态行卡在
   *     「有改动未保存，正在自动保存…」，同时桩日志里冒出一条 `POST /settings`。）
   *   ⚠ `HomeCarousel.tsx` 是同一个写法（`useRef('')`），尚未修。
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
      const parsed = found ? parseContact(found.settingVal) : null
      const safe = parsed ?? { ...EMPTY_FORM }
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
   * ★ 用原生 `<input type="file">` 而不是 tdesign 的 `<Upload>`：后者内部自管一套文件列表
   *   状态，插进这个由 React state 完全自管的表单就得在四处手工同步，漏一处就是
   *   「组件里显示已上传、表单里其实没有」且不报错（理由同 HomeCarousel）。
   */
  const pickImage = () => fileRef.current?.click()

  const uploadImage = async (file: File) => {
    setUploading(true)
    try {
      const r = await request<{ key: string; url: string }>({
        url: '/uploads/contact-qrcode',
        method: 'POST',
        // 直接发原始字节（不是 multipart）：服务端只有一个文件、没有别的字段，
        // 而 raw 能让服务端按**文件内容**判断类型。这里带的 Content-Type 只是浏览器
        // 给出的提示 —— 服务端不信它，真正的类型判断靠魔数嗅探。
        data: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        // 实例默认 30s，对「几 MB 的图 + 弱网」偏紧，这一条单独放宽
        timeout: 60_000,
      })
      setForm((f) => ({ ...f, qrcode: r.url }))
      // 说清还有一步：只说「已上传」会让运营以为已经生效（图只是进了对象存储）
      message.success('二维码已上传，正在保存…')
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

  /**
   * 真正落库，返回是否成功。
   * 抽成独立函数是为了让「自动保存」与失败后的「重试保存」走**同一条**代码路径。
   */
  const persist = async (): Promise<boolean> => {
    const payloadForm: ContactForm = { qrcode: form.qrcode.trim(), phone: form.phone.trim() }
    // 二维码地址只可能来自上传接口；这条是防「接口返回了非绝对地址」这类内部错误静默漏到
    // 小程序：那边是 <Image src>，只会白图，且没有任何提示可循。
    if (payloadForm.qrcode && !/^https?:\/\//i.test(payloadForm.qrcode)) {
      setSaveError('二维码地址不是完整的 http(s) 链接，请重新上传')
      return false
    }
    const payload = {
      groupKey: GROUP_KEY,
      settingKey: SETTING_KEY,
      settingVal: JSON.stringify(payloadForm),
      valueType: 'JSON' as const,
      displayName: '联系我们',
      description: '小程序「我的」页最下方「联系我们」的二维码与客服电话。两项都为空时整块不显示。',
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

  /** 保存失败后的**唯一**重试出路 */
  const retrySave = () => { void persist() }

  /**
   * ★ 自动保存：表单一变就落库（防抖 500ms）。
   *
   * 这一页**没有保存按钮**，与 HomeCarousel 同一个理由：运营的心智模型是
   * 「图传完了 = 好了」，多出来的那一步只要漏掉，页面上看到的值就只是内存里的假象 ——
   * 刷新即消失，看着完全就是「被后台自动删除了」。让「页面上看到的」永远等于「库里存的」。
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

  const dial = toDialable(form.phone)
  /** 非空但拨不出去 —— 只提示，不拦保存（见 toDialable 的说明） */
  const phoneLooksUncallable = form.phone.trim() !== '' && dial === ''
  const nothingConfigured = !form.qrcode.trim() && !form.phone.trim()

  return (
    <div>
      <div className="page-header">
        <h2>联系我们</h2>
        <div>
          {/* 这一页没有保存按钮（表单一变即自动落库），所以这行状态文字就是运营判断
              「现在小程序上是什么」的唯一凭据，必须常驻。 */}
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
        显示在<b>小程序「我的」页 → 学习中心下方</b>的「联系我们」里。改完即自动保存，
        用户下次进入「我的」页就能看到。<br />
        <b>二维码</b>：直接上传即可，服务端会存到对象存储并返回一条公开直链，不用手填地址。
        用户在图上<b>长按</b>就能调起微信的「识别图中二维码」（也可以点开大图再识别）。
        建议上传正方形、纯底色的客服/公众号二维码，边长 ≥ 500px，单张不超过 5MB。<br />
        <b>客服电话</b>：用户点一下就直接拨打，所以请只填号码本身（可带 <code>-</code> 或空格），
        不要写「电话：xxx」这类说明文字。<br />
        ★ <b>两项都留空 ⇒ 小程序上整块不显示</b>（不是显示一个空卡片）。
      </div>

      {broken && (
        <div className="page-tip" style={{ color: '#e1251b', borderColor: '#f5c2c0', background: '#fef2f2' }}>
          库里已存在这一项，但它的值不是合法的 JSON 对象（可能是手工改过）。
          现在表单显示为空 —— <b>表单一旦有改动就会自动覆盖它</b>；想先看一眼原值，去「系统设置」按分组
          <code>contact</code> 找 <code>info</code>。
        </div>
      )}

      <div className="contact-editor">
        <div className="contact-editor__form">
          <FieldGroup labelWidth={96}>
            <Field
              label="二维码"
              help="留空则小程序上不显示二维码那一行"
            >
              <div className="qr-field">
                {form.qrcode ? (
                  // ⚠ object-fit 必须是 contain：二维码被裁掉一角就扫不出来了，
                  //   而这里只是预览 —— 宁可留白也不能裁（公共的 .upload-field__preview 是
                  //   给 16:6 的横版轮播图用的 `cover`，套在方图上会直接切边）。
                  <img className="qr-field__preview" src={form.qrcode} alt="" />
                ) : (
                  <div className="qr-field__preview qr-field__preview--empty muted">未上传</div>
                )}
                <div className="qr-field__actions">
                  <Button size="small" loading={uploading} onClick={pickImage}>
                    {form.qrcode ? '更换二维码' : '上传二维码'}
                  </Button>
                  {form.qrcode ? (
                    <Button
                      size="small"
                      variant="text"
                      disabled={uploading}
                      onClick={() => setForm((f) => ({ ...f, qrcode: '' }))}
                    >
                      清除
                    </Button>
                  ) : null}
                  <span className="muted">上传后自动托管，并立即保存</span>
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

            <Field
              label="客服电话"
              status={phoneLooksUncallable ? 'warning' : undefined}
              help={
                phoneLooksUncallable
                  ? undefined
                  : '用户点击即拨打。可带 - 或空格（如 400-123-4567），小程序会自动清洗成可拨号码'
              }
            >
              <Input
                value={form.phone}
                onChange={(v) => setForm((f) => ({ ...f, phone: v as string }))}
                placeholder="如 13800138000 或 400-123-4567"
                style={{ maxWidth: 320 }}
              />
              {phoneLooksUncallable ? (
                <div className="form-row__help" style={{ color: '#c4892c' }}>
                  这串号码在手机系统里拨不出去（数字不足 5 位），小程序里<b>不会显示电话那一行</b>。
                  请填号码本身，不要带「电话」等说明文字。
                </div>
              ) : null}
            </Field>
          </FieldGroup>
        </div>

        {/* ── 效果预览：把小程序里那一块按同样的结构画出来 ──
            运营配完最想知道的是「用户看到什么样」，与其让他去真机上找，不如就地画一遍。
            ⚠ 这里**只是版式示意**，不是真实渲染（字号/间距按小程序 750rpx 折算到约 390px 宽，
              颜色取的是小程序主题里的品牌红与文字灰）—— 别把它当成「像素级预览」去验收。 */}
        <div className="contact-preview">
          <div className="contact-preview__caption">小程序「我的」页 效果示意</div>
          <div className="contact-preview__label">联系我们</div>
          {/* ★ 两张卡片必须包在同一个 __list 里：小程序那边它们是**同一张白卡片**、
              两行之间只隔一条发丝线。圆角与描边加在 __list 上、行内只画分隔线，
              这样即使以后多一个可选元素（比如下面那条 __note），也不会把
              `:last-child` 那类选择器指错元素。 */}
          <div className="contact-preview__list">
            <div className="contact-preview__card">
              {form.qrcode ? (
                <img className="contact-preview__qr" src={form.qrcode} alt="" />
              ) : (
                <div className="contact-preview__qr contact-preview__qr--empty">无</div>
              )}
              <div className="contact-preview__copy">
                <div className="contact-preview__title">微信客服</div>
                <div className="contact-preview__hint">长按识别二维码，添加客服微信</div>
              </div>
            </div>
            <div className="contact-preview__card">
              <div className="contact-preview__icon">☎</div>
              <div className="contact-preview__copy">
                <div className="contact-preview__title">电话咨询</div>
                <div className="contact-preview__num">{form.phone.trim() || '—'}</div>
              </div>
              <div className="contact-preview__dial">拨打</div>
            </div>
          </div>
          {nothingConfigured ? (
            <div className="contact-preview__note">
              两项都为空 ⇒ 小程序上<b>连「联系我们」这个小标题都不会出现</b>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
