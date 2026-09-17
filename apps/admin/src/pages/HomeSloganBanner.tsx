import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Button, Tag, message } from 'tdesign-react'
import Field, { FieldGroup } from '../components/Field'
import { confirmDialog } from '../lib/confirm'
import { request } from '../lib/http'

/**
 * 首页口号图（小程序首页最上面那张口号海报）。
 *
 * ── 存哪儿：与「首页轮播图」同一套路，复用系统配置 ──────────────────────────
 * 落在既有 `system_setting` 里的一行：
 *     groupKey='home' / settingKey='sloganBanner' / valueType='STRING' / isPublic=true
 * 于是后台读写走既有的 `/admin/api/v1/settings`，小程序读既有的**公开**接口
 * `GET /api/v1/system/settings`（免登录）。本页只负责「传图 → 存一条地址」。
 *
 * ★ 没配时用**小程序内置**的那张海报（代码合成的红白黑三色图），不是本页的兜底逻辑 ——
 *   本页只管把运营上传的地址存下来；「取不到就用内置图」的判断在小程序
 *   `apps/mini/src/services/home.ts::getHomeLayout()` 里做，只有一处。
 *
 * ── 为什么「恢复默认」是删掉这行配置，而不是把值存成空串 ────────────────────
 * 服务端 `/admin/api/v1/settings` 的入参校验是 `settingVal: z.string().min(1)`，
 * **存不了空值**。而「空 = 用内置图」这个语义又必须能表达，所以用「整行删除」来表示：
 * 行不存在 ⇒ 小程序那边取不到 ⇒ 回退内置图。改回自定义则重新上传保存即可（会重新建行）。
 *
 * ── 图片：直接上传，地址由服务端生成，运营不填 ─────────────────────────────
 * 理由与轮播图完全一致（小程序 `<Image src>` 不签名、不认对象键，只能用长期公开直链；
 * 服务端按魔数判类型、只给单个对象设 `ACL: public-read`），见
 * `server/src/services/public-asset.service.ts` 顶部。
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

const GROUP_KEY = 'home'
const SETTING_KEY = 'sloganBanner'

/**
 * 单张图上限。
 * ⚠ 三处必须一致：这里（前端预校验，纯体验）、
 *   server/src/services/public-asset.service.ts::MAX_PUBLIC_IMAGE_BYTES（服务端权威校验）、
 *   deploy/nginx/dashuai-admin.conf 的 client_max_body_size（生产入口，默认 1MB 会先拦掉）。
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * 小程序**内置**的那张口号图。
 *
 * ⚠ 与 `apps/mini/src/constants/static-assets.ts::HOME_SLOGAN_BANNER_V3` 必须一致
 *   （那个文件由 `npm run assets:upload` 生成，小程序里引用的是生成的常量）。
 *   这里只是为了让运营看到「不配的话线上长什么样」，不参与任何写入。
 *   小程序重新生成这张图会换文件名（缓存击穿），届时这里也要跟着改。
 */
const BUILTIN_IMAGE =
  'https://dashuai-1485028436.cos.ap-beijing.myqcloud.com/static/mini/home/slogan-banner-v3.png'

/** 内置图的画布比例（1125×411）。小程序那边卡片高度是按它钉死的（248rpx）。 */
const TARGET_RATIO = 1125 / 411

/** 比例偏差超过这个比例就提醒（不拦截）：只是裁切/留白的观感问题，不该挡住运营发布 */
const RATIO_WARN_TOLERANCE = 0.08

/** 小程序卡片在小屏上的实际观感：宽 678rpx÷2、高 248rpx÷2、圆角 36rpx÷2 */
const PREVIEW_W = 339
const PREVIEW_H = 124

export default function HomeSloganBannerPage() {
  const [row, setRow] = useState<Setting | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  /** 已保存的值（库里那份）；空串 = 没配 = 用内置图 */
  const [saved, setSaved] = useState('')
  /** 表单里的值（点保存前的草稿） */
  const [draft, setDraft] = useState('')
  /** 隐藏的文件选择框。用原生 input 而不是 tdesign 的 <Upload>，理由同首页轮播图页 */
  const fileRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    setLoading(true)
    try {
      const list = await request<Setting[]>({ url: '/settings' })
      const found = list.find((s) => s.groupKey === GROUP_KEY && s.settingKey === SETTING_KEY) ?? null
      const value = found?.settingVal?.trim() ?? ''
      setRow(found)
      setSaved(value)
      setDraft(value)
    } catch {
      /* 已 toast */
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const pickImage = () => fileRef.current?.click()

  const uploadImage = async (file: File) => {
    setUploading(true)
    try {
      const r = await request<{ key: string; url: string }>({
        url: '/uploads/slogan-banner-image',
        method: 'POST',
        // 直接发原始字节（不是 multipart）：服务端按**文件内容**判类型，
        // 这里带的 Content-Type 只是浏览器给的提示，服务端不信它。
        data: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        timeout: 60_000, // 实例默认 30s，对「几 MB 的图 + 弱网」偏紧
      })
      setDraft(r.url)
      message.success('图片已上传，记得点「保存」')
    } catch {
      /* 已 toast */
    } finally {
      setUploading(false)
    }
  }

  /** 上传前量一下比例，偏得多就提醒（不拦）—— 传错比例不会报错，只会默默留白或被压窄 */
  const warnIfRatioOff = (file: File) => {
    const url = URL.createObjectURL(file)
    const probe = new Image()
    probe.onload = () => {
      URL.revokeObjectURL(url)
      const ratio = probe.naturalWidth / probe.naturalHeight
      const off = Math.abs(ratio - TARGET_RATIO) / TARGET_RATIO
      if (off > RATIO_WARN_TOLERANCE) {
        message.warning(
          `这张图是 ${probe.naturalWidth}×${probe.naturalHeight}（比例 ${ratio.toFixed(2)}:1），` +
            `建议 ${1125}×${411}（${TARGET_RATIO.toFixed(2)}:1）。比例差得多的话，` +
            '卡片里会上下留白，或者两边被压窄。',
        )
      }
    }
    // 读不出来就算了：这只是个提醒，不能因此挡住上传
    probe.onerror = () => URL.revokeObjectURL(url)
    probe.src = url
  }

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // ★ 先清空 value 再上传：不清空的话，**再选同一个文件不会触发 change**，
    //   典型场景是上传失败后重试同一张图 —— 界面毫无反应，看着像按钮坏了。
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_IMAGE_BYTES) {
      message.warning(`图片不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`)
      return
    }
    warnIfRatioOff(file)
    void uploadImage(file)
  }

  const save = async () => {
    // 服务端是 `z.string().min(1)`，空值会被拒；「恢复默认」走删除，不该从这里存空
    if (!draft.trim()) {
      message.warning('还没有上传图片。想回到内置那张，请点「恢复默认」')
      return
    }
    if (!/^https?:\/\//i.test(draft.trim())) {
      message.warning('图片地址不是完整的 http(s) 链接，请重新上传')
      return
    }
    const payload = {
      groupKey: GROUP_KEY,
      settingKey: SETTING_KEY,
      settingVal: draft.trim(),
      valueType: 'STRING' as const,
      displayName: '首页口号图',
      description:
        '小程序首页顶部的口号海报（默认是代码生成的红白黑三色图）。留空/删除本项 = 用内置默认图；上传后小程序下次进入首页生效。建议 1125×411（约 2.74:1）。',
      sort: 1,
      isPublic: true, // 必须公开：小程序是免登录拉取的
    }
    setSaving(true)
    try {
      if (row) await request({ url: `/settings/${row.id}`, method: 'PUT', data: payload })
      else await request({ url: '/settings', method: 'POST', data: payload })
      message.success('已保存，小程序下次进入首页就会看到')
      await load()
    } catch {
      /* 已 toast */
    } finally {
      setSaving(false)
    }
  }

  const restoreDefault = async () => {
    const ok = await confirmDialog(
      '恢复内置口号图',
      '会删掉这条运营配置，小程序回到内置那张（红白黑三色海报）。已上传的图片对象留在对象存储里，不会被删。',
    )
    if (!ok) return
    setSaving(true)
    try {
      if (row) await request({ url: `/settings/${row.id}`, method: 'DELETE' })
      message.success('已恢复内置图')
      await load()
    } catch {
      /* 已 toast */
    } finally {
      setSaving(false)
    }
  }

  const dirty = draft.trim() !== saved
  // 预览里显示的图：草稿优先（运营点上传后立刻能看到效果）
  const previewSrc = draft.trim() || BUILTIN_IMAGE
  const usingBuiltin = !previewSrc || previewSrc === BUILTIN_IMAGE

  return (
    <div>
      <div className="page-header">
        <h2>首页口号图</h2>
        <div>
          {/* 没东西可恢复时禁用：库里没有这一行、或这一行本来就是空的（seed 建的默认值） */}
          <Button
            style={{ marginRight: 12 }}
            disabled={loading || saving || !row || !saved}
            onClick={restoreDefault}
          >
            恢复默认
          </Button>
          <Button theme="primary" loading={saving} disabled={loading || !dirty} onClick={save}>
            保存
          </Button>
        </div>
      </div>

      <div className="page-tip">
        小程序首页最上面那张口号海报。<b>不上传就一直用内置那张</b>（红白黑三色，
        源码在 <code>apps/mini/scripts/slogan-banner.html</code>，用 <code>npm run assets:slogan</code> 生成）。<br />
        建议尺寸 <b>{1125}×{411}</b>（约 {TARGET_RATIO.toFixed(2)}:1）—— 卡片高度是按这个比例钉死的，
        比例不对会上下留白（底色是白的）或两边被压窄。支持 jpg / png / webp / gif，单张不超过 5MB。<br />
        图片<b>直接上传</b>即可，服务端会存到对象存储并返回一条公开直链，不用手填地址。
        改动<b>保存后生效</b>，小程序下次进入首页即可看到。
      </div>

      <FieldGroup labelWidth={110}>
        <Field
          label="口号图"
          help={`建议 ${1125}×${411}（${TARGET_RATIO.toFixed(2)}:1）；只影响小程序首页那一条卡片，其余页面不受影响`}
        >
          <div className="upload-field">
            <img
              className="upload-field__preview"
              src={previewSrc}
              alt=""
              style={{ width: PREVIEW_W, height: PREVIEW_H, objectFit: 'contain', background: '#fff' }}
            />
            <div className="upload-field__actions">
              <Button size="small" loading={uploading} onClick={pickImage}>
                上传图片
              </Button>
              <span className="muted">
                当前生效：{usingBuiltin ? '内置默认图' : '运营上传的图'}
              </span>
            </div>
          </div>
        </Field>

        <Field label="实际效果" help="按小程序卡片里的真实比例（678×248rpx、圆角 36rpx、白底）模拟；比例不对时的留白会在这里现形">
          <div
            style={{
              width: PREVIEW_W,
              height: PREVIEW_H,
              borderRadius: 18,
              overflow: 'hidden',
              background: '#fff',
              border: '1px solid #eee',
            }}
          >
            <img
              src={previewSrc}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
          </div>
        </Field>

        <Field label="当前状态">
          {usingBuiltin ? (
            <Tag>内置默认图（未配置）</Tag>
          ) : (
            <Tag theme="primary">已配置自定义图</Tag>
          )}
          {dirty && <span className="muted" style={{ marginLeft: 8 }}>有未保存的改动</span>}
          <div className="muted" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {row ? `配置行：home.${SETTING_KEY}（id ${row.id}）` : `还没有这条配置（保存时会自动建：home.${SETTING_KEY}）`}
          </div>
        </Field>
      </FieldGroup>

      {/* 原生文件选择框：只做「选图」这一件事，状态全在 React 里，避免影子状态 */}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={onFileChange}
      />
    </div>
  )
}
