import { useEffect, useRef, useState } from 'react'
import { Button, Input, InputNumber, message } from 'tdesign-react'
import { AddIcon, DeleteIcon } from 'tdesign-icons-react'
import Field, { FieldGroup } from '../components/Field'
import { confirmDialog } from '../lib/confirm'
import { fmtClock, fmtMinute } from '../lib/datetime'
import { request } from '../lib/http'

/**
 * 演示账号（试用账号）：**多端可登录**，但整个账号只有一段**全局一次性**的可用窗口。
 *
 * ── 这一页在干什么 ─────────────────────────────────────────────────────────
 * 把服务端 `lib/demo-account.ts` 用的两行系统配置编排成人能改的样子。**不新建接口、不新建表。**
 *
 *   demo.config        （本页主体）  一条 JSON：`{ phones: string[], window_hours: number }`
 *   demo.activated_at  （只读 + 三个动作）  一行 STRING：窗口启用时刻（ISO）
 *
 * 服务端判据的**唯一出处**是 `server/src/lib/demo-account.ts`，本页只是它的一个编辑器 +
 * 状态显示。★ 本页所有解析都按那边**逐条镜像**（白名单只认 11 位号、window_hours 非正数
 * 回落 24、启用时刻解析不出来按「早已过期」）。镜像一旦漂移，就会出现「后台显示在生效、
 * 小程序里登不进」这种最难查的问题 —— 改那边时务必回来改这里。
 *
 * ── ★★ 为什么必须是**一条 JSON** 而不是两条 STRING ──────────────────────────
 * 与「首页轮播图」「联系我们」同一个理由（详见 apps/admin/src/pages/Contact.tsx 顶部）：
 * 后台写配置走 `POST|PUT /admin/api/v1/settings`，schema 是 `settingVal: z.string().min(1)`
 * —— **不允许存空串**。若 phones 单独一行，运营想「关掉演示」就只能存空串 ⇒ 400 ⇒
 * 页面上只显示「保存失败」而看不出原因。一条 JSON 没有这个洞：
 * 清空后是 `{"phones":[],"window_hours":24}`，长度远大于 1。
 *
 * ── ★★ 为什么这一页**有保存按钮**（而「联系我们」没有）──────────────────────
 * 「联系我们」的自动保存建立在「运营的心智模型是『图传完了 = 好了』」之上。
 * 这一页相反：`phones` 是一个**正在被逐字敲的列表**，自动保存会在你把
 * `13800138000` 敲到第 3 位时就落库。而服务端 `parseDemoPhones` 只认 11 位号
 * （非法片段一律丢弃，见那边的注释）⇒ 存进去的是 `["138"]`，解析后是**空集合**，
 * 效果等于「把演示功能整个关掉」，而页面上没有任何异常 —— 最典型的静默失效。
 * 所以这里刻意改成**显式保存 + 保存前逐条校验**，并把「有改动未保存」常驻在标题行。
 *
 * ── ★★ 状态卡读的是**已保存**的配置，不是页面上的草稿 ────────────────────────
 * 这是本项目反复踩过的一条：「页面上看到的值 ≠ 已经生效」。
 * 状态卡上标的「当前生效」必须真的是库里那份；草稿与已保存不一致时，
 * 单独给一条「有未保存的改动」提示，别把两者混成一个数字。
 *
 * ── ★★ 固定登录验证码（`login_code`）：演示号**不需要点「获取验证码」**────────
 * 演示账号是当场给客户试的，让他去等一条短信（签名没过审时甚至根本发不出来）是纯粹的阻力。
 * 配了这个 6 位码之后，白名单号直接用这枚码登录，服务端对该号**不发短信、也不落记录**。
 *
 * ★ 它与短信验证码的语义**相反**，这是本页最要紧的一条：
 *   短信码是**一次性**的（用掉即废、5 分钟过期、同一条错 5 次作废），
 *   而这是一枚**可重复使用的共享码**（同一个码发给多个试用者、整段窗口内反复用）。
 *   ⇒ 它**不进** `smsCode` 表。别有人「顺手」把它接进短信流程 ——
 *     那样第一次登录就把记录消费掉了，第二次又得去点「获取验证码」，回到原来那个问题。
 * ★ 正因为它可重复使用，服务端给它配了**失败限速**（见 `lib/login-throttle.ts`）。
 *   这一页不需要关心限速，但要知道：**码能被猜** ⇒ 只发给真正要试用的人。
 *
 * ⚠ 三件事这一页必须说清（都已**逐条镜像**服务端 `parseDemoLoginCode` / `demoLoginCode`）：
 *   ① 留空 = **没有**固定码（该号回到正常短信验证码），**绝不是**「任何码都行」；
 *   ② 只有**白名单里**的号才走固定码 —— 白名单解析后为空时整块功能关闭；
 *   ③ 码必须**恰好 6 位数字**。`1234567` / `abcdef` / 带空格 服务端一律当没配。
 *   ①②③ 合起来就是「配了却登不进、且毫无提示」的全部来源，所以在保存前就拦下来。
 *
 * ── 「不会干扰其他账号」是怎么保证的（这一页要在文案里讲清楚）──────────────────
 *   ① `phones` 解析后为空 ⇒ **功能整体关闭**（不是「所有号都算演示账号」）；
 *   ② 只有白名单里的号过闸门，`dst`（绝对截止）只写进**该账号自己**签发的 token；
 *   ③ 非演示账号 `dst` 为 undefined ⇒ 中间件里 `demoDeadlinePassed` 恒 false ⇒ **零行为变化**。
 *   守护脚本 `npm run demo-account:verify`（server 包）有断言钉住这三条。
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

const GROUP_KEY = 'demo'
const CONFIG_KEY = 'config'
const ACTIVATED_KEY = 'activated_at'

/** 与服务端 `DEMO_DEFAULT_WINDOW_HOURS` 一致 */
const DEFAULT_WINDOW_HOURS = 24

/**
 * 手机号判据。**必须与服务端 `parseDemoPhones` 里的正则逐字一致**（`/^1\d{10}$/`）。
 * 两边不一致会出现「后台显示白名单有 1 个号、服务端解析后是 0 个 ⇒ 演示静默关闭」。
 */
const PHONE_RE = /^1\d{10}$/

/**
 * 固定登录码判据。**必须与服务端 `parseDemoLoginCode` 逐字一致**（`/^\d{6}$/`）。
 *
 * ★ 镜像一旦漂移，两个方向都是静默的：
 *   · 这边放宽（例如允许 4 位）⇒ 后台显示「已配置」，服务端解析成 null ⇒
 *     该号回到短信验证码，而运营以为固定码在生效，试用者一路「验证码错误」；
 *   · 这边收紧 ⇒ 运营被拦住不让保存，但配置本来是服务端认的。
 */
const CODE_RE = /^\d{6}$/

/** 单个手机号输入行。带 id 是为了让 React 的 key 稳定 —— */
type PhoneRow = { id: string; value: string }

/** 落库形状（= 存进 settingVal 的 JSON 的对象形状） */
type DemoValues = { phones: string[]; windowHours: number; loginCode: string }
/** 编辑态（phones 多一层行包装） */
type DemoDraft = { rows: PhoneRow[]; windowHours: number; loginCode: string }

/**
 * 一份「什么都没配」的值。★ 做成函数而不是共享常量：`phones` 是数组，
 * 共享同一个引用迟早会被某处就地改动，而那种 bug 只会在特定操作顺序下出现。
 */
const emptyValues = (): DemoValues => ({ phones: [], windowHours: DEFAULT_WINDOW_HOURS, loginCode: '' })

let seq = 0
const nextRowId = () => `p${++seq}`

/** 至少留一个空行：一个都没有时页面会显示成「什么都没配」，运营不知道点哪儿 */
function draftFromValues(v: DemoValues): DemoDraft {
  const rows = v.phones.length ? v.phones.map((value) => ({ id: nextRowId(), value })) : [{ id: nextRowId(), value: '' }]
  return { rows, windowHours: v.windowHours, loginCode: v.loginCode }
}

function valuesFromDraft(d: DemoDraft): DemoValues {
  return {
    phones: dedupe(d.rows.map((r) => r.value.trim()).filter(Boolean)),
    windowHours: d.windowHours,
    // ★ 存**原文**、不在这里过滤：填错的码要能在保存前被指出来（见 codeInvalid）。
    //   真落库的形态由服务端 `parseDemoLoginCode` 决定，这边只做「提前拦」。
    loginCode: d.loginCode.trim(),
  }
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)]
}

/**
 * 把一个「可能写成任何样子」的 phones 字段收敛成字符串数组。
 * 镜像服务端：数组先 join，再按 中英文逗号/分号/空白 切。
 * ★ 保留非法片段（不像手机号的也留着）—— 运营要能**看见**自己填错的那一条，
 *   直接吃掉就等于把「配了却不生效」静默掉。
 */
function splitPhones(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.join(',') : String(raw ?? '')
  return text.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
}

/** 是否是一个 JSON 对象（用来提示「有人手工改过」）—— 只做提示，不做拦截 */
function isPlainObjectJson(raw: string): boolean {
  try {
    const v = JSON.parse(raw) as unknown
    return !!v && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

/**
 * 解析 `demo.config` —— 镜像服务端 `parseDemoConfig`，因此**永不返回 null**。
 * 服务端对整串非 JSON 的容错是「整串当手机号列表」，这里照做，
 * 免得把一份「其实服务端认」的配置在后台显示成坏值。
 */
function parseConfigValues(raw: string): DemoValues {
  let obj: unknown = null
  let parsed = false
  try {
    obj = JSON.parse(raw)
    parsed = true
  } catch {
    // 整串不是 JSON ⇒ 服务端把它当手机号列表、且**没有**固定码（login_code 无从谈起）
    return { phones: splitPhones(raw), windowHours: DEFAULT_WINDOW_HOURS, loginCode: '' }
  }
  const rec =
    parsed && obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {}
  const hours = Number(rec.window_hours)
  return {
    phones: splitPhones(rec.phones),
    windowHours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_WINDOW_HOURS,
    // ★ 原样读出（留空 ⇒ ''）。形态是否合法由 `codeInvalid` 与服务端各自判 —— 这里不替它判，
    //   否则「后台显示空、服务端却读到值」这类镜像漂移就看不出来了。
    loginCode: String(rec.login_code ?? '').trim(),
  }
}

/** 镜像服务端 `lib/demo-account.ts::parseIso` */
function parseIso(raw: string): Date | null {
  if (!raw || !raw.trim()) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t) : null
}

function humanDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分钟`
  return `${m} 分钟`
}

/** 允许的窗口区间。上限 30 天：再长就不像「演示」了，多半是手滑多按了个 0 */
const MAX_WINDOW_HOURS = 720

export default function DemoAccountPage() {
  const [row, setRow] = useState<Setting | null>(null)
  const [actRow, setActRow] = useState<Setting | null>(null)
  const [draft, setDraft] = useState<DemoDraft>(() => draftFromValues(emptyValues()))
  /** 库里那份（已保存）。状态卡与 dirty 判据都读它，**不读 draft** */
  const [saved, setSaved] = useState<DemoValues>(emptyValues)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  /** 三个窗口动作共用一个 busy，避免连点重开两次 */
  const [acting, setActing] = useState(false)
  const [savedAt, setSavedAt] = useState('')
  const [saveError, setSaveError] = useState('')
  /** 库里那一行存在，但值不是 JSON 对象（有人手工改过）—— 只提示，不拦保存 */
  const [rawShapeOther, setRawShapeOther] = useState(false)

  const busy = saving || acting

  const load = async () => {
    setLoading(true)
    try {
      const list = await request<Setting[]>({ url: '/settings' })
      const cfg = list.find((s) => s.groupKey === GROUP_KEY && s.settingKey === CONFIG_KEY) ?? null
      const act = list.find((s) => s.groupKey === GROUP_KEY && s.settingKey === ACTIVATED_KEY) ?? null
      const values = cfg ? parseConfigValues(cfg.settingVal) : emptyValues()
      setRow(cfg)
      setActRow(act)
      setDraft(draftFromValues(values))
      setSaved(values)
      setRawShapeOther(!!cfg && !isPlainObjectJson(cfg.settingVal))
      setSaveError('')
    } catch {
      /* 已 toast */
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const draftValues = valuesFromDraft(draft)
  const dirty = JSON.stringify(draftValues) !== JSON.stringify(saved)
  const dirtyRef = useRef(false)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  /** 还没落库时拦一下刷新 / 关标签页 */
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // ── 校验 ────────────────────────────────────────────────────────────────
  /** 填了、但不像 11 位手机号的条目。它们会被服务端**静默丢弃** ⇒ 必须拦在保存之前 */
  const badEntries = draftValues.phones.filter((p) => !PHONE_RE.test(p))
  const windowInvalid = !(Number.isFinite(draft.windowHours) && draft.windowHours > 0)
  const windowTooLarge = !windowInvalid && draft.windowHours > MAX_WINDOW_HOURS
  /**
   * 填了码、但不是**恰好 6 位数字**。服务端 `parseDemoLoginCode` 会把它当成「没配」——
   * 该号于是回到短信验证码，而运营以为固定码在生效 ⇒ 试用者一路「验证码错误」。
   * 这是本页最容易产生「配了却不生效」的一处，所以**拦在保存之前**。
   */
  const codeInvalid = draftValues.loginCode !== '' && !CODE_RE.test(draftValues.loginCode)

  /** 输入过程中必然经过「位数不够」的中间态，所以**只在保存时**报错，不边敲边红 */
  const canSave = dirty && !windowInvalid && !windowTooLarge && badEntries.length === 0 && !codeInvalid && !busy

  // ── 当前生效（读**已保存**那份 + 已保存的启用时刻）────────────────────────
  const effPhones = saved.phones.filter((p) => PHONE_RE.test(p))
  const effWindow = saved.windowHours > 0 ? saved.windowHours : DEFAULT_WINDOW_HOURS
  const activatedRaw = actRow?.settingVal ?? ''
  const activatedUnparsable = !!actRow && activatedRaw.trim() !== '' && parseIso(activatedRaw) === null
  // 镜像服务端：值填坏了（非空但解析不出）⇒ 当作**早已过期**，而不是「未激活」
  const activatedAt = actRow ? (parseIso(activatedRaw) ?? new Date(0)) : null
  const deadlineMs = activatedAt ? activatedAt.getTime() + effWindow * 3600_000 : null
  const now = Date.now()
  const remainingMs = deadlineMs === null ? null : deadlineMs - now
  const demoOn = effPhones.length > 0
  /**
   * ★★ 镜像服务端 `demoLoginCode()`：**两条同时成立**才算「这个号会用固定码」——
   *   ① 白名单非空（`demoOn`）；② 已保存的码是恰好 6 位数字。
   *   这里读的是 `saved`（库里那份），与状态卡其余各行同一口径：
   *   草稿里刚敲进去的码**不算生效**，避免「看着配好了、其实还没保存」。
   */
  const effCode = demoOn && CODE_RE.test(saved.loginCode) ? saved.loginCode : null
  const expired = remainingMs !== null && remainingMs <= 0

  // ── 写配置 ──────────────────────────────────────────────────────────────
  const persist = async (): Promise<boolean> => {
    const values = valuesFromDraft(draft)
    const payload = {
      groupKey: GROUP_KEY,
      settingKey: CONFIG_KEY,
      // ★ 一条 JSON 里同时带 phones / window_hours / login_code。
      //   登录码**不能**单独一行：`settingVal` 是 `z.string().min(1)`（不许空串），
      //   想「清掉固定码」就得存空串 ⇒ 400 ⇒ 页面上只显示「保存失败」而看不出原因。
      //   放进同一条 JSON 后，「清空码」就是 `login_code: ''`，长度远大于 1。
      settingVal: JSON.stringify({
        phones: values.phones,
        window_hours: values.windowHours,
        login_code: values.loginCode,
      }),
      valueType: 'JSON' as const,
      displayName: '演示账号',
      description:
        '演示账号白名单手机号、可用窗口（小时）与固定登录码。phones 解析后为空即整个功能关闭；' +
        '窗口从首次使用算、全局一次性；login_code 是 6 位数字，配了它白名单号不必获取短信验证码。',
      sort: 0,
      isPublic: false, // ★ 必须 false：公开接口 /api/v1/system/settings 只回 isPublic=1 的项
    }
    setSaving(true)
    try {
      if (row) await request({ url: `/settings/${row.id}`, method: 'PUT', data: payload })
      else await request({ url: '/settings', method: 'POST', data: payload })
      setSaveError('')
      setSavedAt(fmtClock(new Date()))
      // 重新读一遍而不是本地「假装已保存」：POST 新建时要拿到行 id，
      // 否则第二次保存会再 POST 一次，撞上 (groupKey, settingKey) 唯一索引而失败。
      await load()
      return true
    } catch (e) {
      // 失败必须**留在页面上**：只弹 2 秒 toast 的话，切走再回来就永远看不到原因了
      setSaveError((e as Error).message || '保存失败')
      return false
    } finally {
      setSaving(false)
    }
  }

  // ── 写启用时刻（三个动作共用）────────────────────────────────────────────
  const writeActivatedAt = async (iso: string) => {
    const payload = {
      groupKey: GROUP_KEY,
      settingKey: ACTIVATED_KEY,
      settingVal: iso,
      valueType: 'STRING' as const,
      displayName: '演示窗口启用时刻',
      description:
        '运行时状态：首次登录演示账号时自动写入，请勿手工维护。改成当前时间＝重开一段窗口；删掉这一行＝下次登录重新激活',
      sort: 0,
      isPublic: false,
    }
    setActing(true)
    try {
      if (actRow) await request({ url: `/settings/${actRow.id}`, method: 'PUT', data: payload })
      else await request({ url: '/settings', method: 'POST', data: payload })
      message.success('已更新启用时刻')
      await load()
    } catch {
      /* 已 toast */
    } finally {
      setActing(false)
    }
  }

  const reopenWindow = async () => {
    const ok = await confirmDialog(
      '重开窗口',
      `把启用时刻设为「现在」，从此刻起重新计算 ${effWindow} 小时。\n\n` +
        '⚠ 已经登录着的端不会被延长 —— 它们手里的登录凭证写的是旧截止时间，仍按旧时间退出；' +
        '只有重新登录的端才拿到新的截止时间。',
    )
    if (ok) void writeActivatedAt(new Date().toISOString())
  }

  const expireNow = async () => {
    const ok = await confirmDialog(
      '立即收回',
      '把启用时刻改成一个很早的时间，让窗口立刻过期。\n\n' +
        '效果：演示账号此后再登录一律被拒；已经登录着的端也会在下一个请求被赶出去，' +
        '且它想重新登录同样被拒 —— 这就是「当场收回」。\n' +
        '白名单手机号仍保留，随时可以再点「重开窗口」。',
    )
    // ★ 1970-01-01 是**故意**的：服务端把「非空但解析得出」的值算成 deadline = 0 + 窗口，
    //   必然早于现在 ⇒ 立刻过期。这与「值填坏了」的兜底语义刚好一致，不是巧合。
    if (ok) void writeActivatedAt(new Date(0).toISOString())
  }

  const clearActivated = async () => {
    if (!actRow) return
    const ok = await confirmDialog(
      '清除启用记录',
      '删掉「启用时刻」这一行。\n\n' +
        '与「重开窗口」的区别：删掉不会立刻开始计时 —— 下一次有人登录演示账号时才自动激活，' +
        '从那台设备的登录时刻起算窗口。适合「这个演示号我还没打算给出去」。\n\n' +
        '⚠ 但「已经登录着的端」会立刻被赶出去（等同于一次收回）—— 因为服务端每个请求都会' +
        '复核实时窗口，而删掉这一行等于窗口不再有效。',
    )
    if (!ok) return
    setActing(true)
    try {
      await request({ url: `/settings/${actRow.id}`, method: 'DELETE' })
      message.success('已清除启用记录')
      await load()
    } catch {
      /* 已 toast */
    } finally {
      setActing(false)
    }
  }

  const setPhone = (id: string, value: string) =>
    setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, value } : r)) }))
  const addPhone = () => setDraft((d) => ({ ...d, rows: [...d.rows, { id: nextRowId(), value: '' }] }))
  const removePhone = (id: string) => setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.id !== id) }))

  return (
    <div>
      <div className="page-header">
        <h2>演示账号</h2>
        <div>
          <span className={saveError ? 'danger-text' : 'muted'} style={{ marginRight: 12 }}>
            {saving
              ? '保存中…'
              : saveError
                ? `保存失败：${saveError}`
                : dirty
                  ? '有改动未保存'
                  : savedAt
                    ? `已保存 ${savedAt}`
                    : // ★ 刚加载完、还没动过时也要给一句话：否则状态位置是空的，
                      //   而「保存」按钮此时是禁用的 —— 运营会以为按钮坏了。
                      loading
                      ? ''
                      : '与库里一致'}
          </span>
          <Button
            className="demo-save"
            theme="primary"
            disabled={!canSave}
            loading={saving}
            onClick={() => void persist()}
          >
            保存
          </Button>
        </div>
      </div>

      {/* ★ 这一段是给「会不会影响别的账号」这个担心的正面回答，写在最显眼处 */}
      <div className="page-tip">
        <b>这一页只影响下面白名单里的手机号，对其他任何账号零影响。</b>
        手机号留空（一个都不填）时，<b>整个演示功能是关闭的</b> —— 不是「所有账号都变成演示账号」。<br />
        演示账号的能力：<b>可以多端同时登录</b>（本项目的登录是无状态的，不需要额外开）。
        区别只在于它带着一段<b>全局一次性</b>的可用窗口：从<b>第一次使用</b>算起（不是每次登录都重置），
        窗口一过，<b>任何设备都无法再登录</b>，必须回这一页重开。<br />
        配了下面<b>「登录验证码」</b>的号，登录时<b>直接输入那枚 6 位码</b>即可，
        <b>不需要点「获取验证码」</b>，系统也<b>不会</b>给它发短信。
        ⚠ 这枚码可以<b>反复使用</b>、且是给多个试用者<b>共用</b>的 —— 请只发给真正要试用的人。<br />
        ⚠ 到点退出靠的是<b>登录凭证里写死的绝对截止时间</b>，并且<b>每个请求都会复核一次实时窗口</b>。
        所以：<b>收回／清空会立刻把已经登录的端赶出去</b>（下一个请求即被拒）；
        而<b>重开窗口只对此后新登录的端生效</b>，当时已经登录着的端仍按原来的时间退出，<b>不会被延长</b>。
      </div>

      {!row && !loading ? (
        <div className="page-tip demo-tip--info">
          库里还没有 <code>demo.{CONFIG_KEY}</code> 这一行 —— <b>现在演示功能是关闭的</b>。
          填好手机号点「保存」即会创建。
        </div>
      ) : null}

      {rawShapeOther ? (
        <div className="page-tip demo-tip--warn">
          库里已存在这一项，但值不是 JSON 对象（可能是手工改过）。下面的表单是<b>按服务端规则解析出来的</b>
          —— 点「保存」会用表单覆盖写回去。想先看原值，去「系统设置」按分组 <code>demo</code> 找{' '}
          <code>{CONFIG_KEY}</code>。
        </div>
      ) : null}

      <div className="demo-editor">
        <div className="demo-editor__form">
          <FieldGroup labelWidth={104}>
            <Field
              label="演示手机号"
              required
              status={badEntries.length ? 'error' : undefined}
              help="填 11 位手机号。可以加多个（多端登录用的是同一个号，一般一个就够）"
            >
              <div className="demo-phones">
                {draft.rows.map((r, i) => {
                  const v = r.value.trim()
                  const bad = v !== '' && !PHONE_RE.test(v)
                  return (
                    <div className="demo-phones__row" key={r.id}>
                      <Input
                        value={r.value}
                        status={bad ? 'error' : undefined}
                        placeholder="如 13800138000"
                        onChange={(val) => setPhone(r.id, val as string)}
                        style={{ maxWidth: 240 }}
                      />
                      <Button
                        size="small"
                        variant="text"
                        theme="danger"
                        disabled={busy || draft.rows.length <= 1}
                        title={draft.rows.length <= 1 ? '至少保留一行' : '删除这一行'}
                        onClick={() => removePhone(r.id)}
                      >
                        <DeleteIcon />
                      </Button>
                      {/* ★ 必须写成**一整个**模板串：写成 `第 {i+1} 个` 时 JSX 会插出
                          「第 」/「1」/「 个」三个文本节点，两个字间的空格成了可换行点，
                          窄一点就把「第 1」和「个」折成两行。 */}
                      <span className="demo-phones__index">{`第 ${i + 1} 个`}</span>
                    </div>
                  )
                })}
                <Button size="small" variant="outline" disabled={busy} onClick={addPhone}>
                  <AddIcon style={{ marginRight: 4 }} />
                  添加一个手机号
                </Button>
              </div>
            </Field>

            <Field
              label="可用窗口"
              status={windowInvalid || windowTooLarge ? 'warning' : undefined}
              help={`从「第一次使用」那一刻开始算，单位小时。默认 ${DEFAULT_WINDOW_HOURS}`}
            >
              <div className="demo-window">
                <InputNumber
                  value={draft.windowHours}
                  min={1}
                  max={MAX_WINDOW_HOURS}
                  onChange={(v) => setDraft((d) => ({ ...d, windowHours: Number(v) }))}
                />
                <span className="muted">小时</span>
              </div>
              {windowInvalid ? (
                <div className="form-row__help demo-help--warn">必须大于 0</div>
              ) : windowTooLarge ? (
                <div className="form-row__help demo-help--warn">
                  超过 {MAX_WINDOW_HOURS} 小时（30 天）了，确认不是多按了一个 0？
                </div>
              ) : null}
            </Field>

            <Field
              label="登录验证码"
              status={codeInvalid ? 'error' : undefined}
              help="6 位数字。配上它，上面的号登录时不必再点「获取验证码」"
            >
              <div className="demo-code">
                <Input
                  value={draft.loginCode}
                  status={codeInvalid ? 'error' : undefined}
                  placeholder="留空 = 不启用"
                  onChange={(val) => setDraft((d) => ({ ...d, loginCode: val as string }))}
                  style={{ maxWidth: 240 }}
                />
                <Button
                  size="small"
                  variant="text"
                  disabled={busy || draft.loginCode === ''}
                  title="留空即让这个号回到正常的短信验证码"
                  onClick={() => setDraft((d) => ({ ...d, loginCode: '' }))}
                >
                  清空
                </Button>
              </div>
              {codeInvalid ? (
                <div className="form-row__help demo-help--warn">
                  必须是 <b>恰好 6 位数字</b>。照现在这样存下去，服务端会当成「没配」——
                  该号会回到短信验证码，而不是「任何码都能登」。
                </div>
              ) : null}
            </Field>
          </FieldGroup>

          {badEntries.length ? (
            <div className="page-tip demo-tip--warn" style={{ marginBottom: 0 }}>
              有 {badEntries.length} 个条目不是 11 位手机号（{badEntries.slice(0, 3).join('、')}
              {badEntries.length > 3 ? ' 等' : ''}）：
              <b>服务端会把它们直接丢掉</b>，填成这样等于没填。请补全或删掉后再保存。
            </div>
          ) : null}
        </div>

        {/* ── 当前生效 ──────────────────────────────────────────────────
            ★ 这一块读的是**库里那份**（saved + actRow），不是页面上的草稿。
              草稿与库里不一致时，另给一条提示。 */}
        <div className="demo-status">
          <div className="demo-status__caption">当前生效（库里已保存的那份）</div>

          <div className="demo-status__row">
            <span className="demo-status__key">白名单</span>
            <span className="demo-status__val">
              {demoOn ? (
                <>
                  {effPhones.length} 个号：{effPhones.join('、')}
                </>
              ) : (
                <b className="danger-text">未配置 ⇒ 演示功能整体关闭</b>
              )}
            </span>
          </div>

          <div className="demo-status__row">
            <span className="demo-status__key">登录验证码</span>
            <span className="demo-status__val">
              {/* ★ 写成**一整个**模板串：`已配置 <b>{code}</b>，…` 会插出三个文本节点，
                  码前面的空格成了可换行点，窄屏上会折在难看的字缝里。 */}
              {!demoOn
                ? '—（先配好白名单手机号）'
                : effCode
                  ? `已配置 ${effCode}，登录时不用点「获取验证码」`
                  : '未配置 ⇒ 这些号仍走短信验证码'}
            </span>
          </div>

          <div className="demo-status__row">
            <span className="demo-status__key">窗口</span>
            <span className="demo-status__val">{effWindow} 小时（从首次使用算，全局一次性）</span>
          </div>

          <div className="demo-status__row">
            <span className="demo-status__key">启用时刻</span>
            <span className="demo-status__val">
              {activatedAt ? fmtMinute(activatedAt) : '尚未启用（第一台设备登录时自动写入）'}
            </span>
          </div>

          <div className="demo-status__row">
            <span className="demo-status__key">截止时刻</span>
            <span className="demo-status__val">{deadlineMs === null ? '—' : fmtMinute(new Date(deadlineMs))}</span>
          </div>

          <div className="demo-status__row">
            <span className="demo-status__key">状态</span>
            <span className="demo-status__val">
              {!demoOn ? (
                <span className="muted">功能关闭，任何账号都不受影响</span>
              ) : remainingMs === null ? (
                <span className="muted">等待首次登录（登录那一刻才开始计时）</span>
              ) : expired ? (
                <b className="danger-text">已过期 {humanDuration(-remainingMs)} —— 现在登录会被拒</b>
              ) : (
                <b className="success-text">剩余 {humanDuration(remainingMs)}</b>
              )}
            </span>
          </div>

          {activatedUnparsable ? (
            <div className="page-tip demo-tip--warn" style={{ margin: '4px 0 12px' }}>
              「启用时刻」这一行存的值解析不出时间。服务端会按
              <b>「早已过期」</b>处理（演示账号现在登录会被拒）。
              想恢复正常：点「重开窗口」，或「清除启用记录」。
            </div>
          ) : null}

          <div className="demo-status__actions">
            <Button
              size="small"
              theme="primary"
              variant="outline"
              disabled={busy || !demoOn}
              title={demoOn ? '' : '先配好白名单手机号'}
              onClick={() => void reopenWindow()}
            >
              重开窗口
            </Button>
            <Button
              size="small"
              theme="danger"
              variant="outline"
              disabled={busy || !demoOn || !activatedAt}
              onClick={() => void expireNow()}
            >
              立即收回
            </Button>
            <Button size="small" variant="text" disabled={busy || !actRow} onClick={() => void clearActivated()}>
              清除启用记录
            </Button>
          </div>
          <div className="demo-status__note">
            · <b>重开窗口</b>：从现在起重新计时。已登录的端<b>不会</b>被延长。<br />
            · <b>立即收回</b>：窗口立刻过期。此后登录一律被拒，<b>已登录的端下一个请求就会被赶出</b>。<br />
            · <b>清除启用记录</b>：删掉启用时刻那一行，下次登录时自动重新激活（不会立刻开始计时）；
            <b>但已登录的端同样会立刻被赶出</b>（视同一次收回）。
          </div>
        </div>
      </div>

      {dirty ? (
        <div className="page-tip demo-tip--info" style={{ marginTop: 18, marginBottom: 0 }}>
          页面上有<b>未保存</b>的改动（上一步的「当前生效」显示的是库里那份，还没变）。
          点右上角「保存」才会生效。
        </div>
      ) : null}
    </div>
  )
}
