import { api } from './api'

/**
 * 创作链路的数据层。
 *
 * ★ 与小程序共用 `/api/v1/creations` 这一套接口，字段名一律以**服务端 zod schema**
 *   和 service 的返回为准，不在这里另造一层命名（`copyText` / `shotsReady` / `renderStatus`）。
 * ★ 所有 id 都是 BigInt 在服务端 `app.set('json replacer')` 里转成的**字符串**，
 *   所以类型写 `string`，不要当数字算。
 */

export type ContentMode = 'DISH' | 'TOPIC' | 'STYLE'
export type CopyTrack = 'PERSONA' | 'KNOWLEDGE' | 'PRODUCT' | 'RECOMMEND'
export type Complexity = 'SIMPLE' | 'COMPLEX' | 'FINE'

/** 列表项：服务端已经算好 `shotsTotal` / `shotsReady` / `renderStatus`，前端不再 N+1 */
export interface CreationItem {
  id: string
  title: string | null
  storeId: string
  dishId: string | null
  track: string
  mode: string
  complexity: string
  copyText: string | null
  status: string
  createdAt: string
  archivedAt: string | null
  shotsTotal: number
  shotsReady: number
  renderStatus: string | null
  coverUrl: string | null
  trackLabel: string | null
  modeLabel: string | null
  complexityLabel: string | null
}

export interface Shot {
  id: string
  seq: number
  shotType: string | null
  shotSize: string | null
  durationSuggest: number | null
  line: string | null
  visualReq: string | null
  assetId: string | null
  skipped: boolean
  coverUrl: string | null
  assetDurationMs: number | null
  libraryShot: { code: string; name: string; category: string; tips: string | null } | null
}

export interface CreationDetail extends Omit<CreationItem, 'coverUrl'> {
  shots: Shot[]
  dish: { id: string; name: string } | null
  store: { id: string; name: string } | null
  topicCity: string | null
}

export interface CopyResult {
  text: string
  beanCharged: string | number
  duplicated: boolean
  isFallbackTemplate: boolean
  track: string
  trackLabel: string
}

export interface StoryboardResult {
  shots: Shot[]
  parsed: boolean
  beanCharged: string | number
  duplicated: boolean
  isFallbackTemplate: boolean
  complexity: string
  complexityLabel: string
}

export const CONTENT_MODE_LABELS: Record<ContentMode, string> = {
  DISH: '菜品稿',
  TOPIC: '话题稿',
  STYLE: '款式稿',
}

/**
 * 四款文案（`TRAFFIC` 流量型不在这里：它属话题稿专用，传进菜品稿会被服务端改回默认款）。
 * ★ 小字说明**就是**给用户看的判据 —— 他靠这行字决定选哪款，写虚了等于让他乱选。
 */
export const COPY_TRACK_OPTIONS: { value: CopyTrack; label: string; desc: string }[] = [
  { value: 'PERSONA', label: '人设型', desc: '讲你这个人和你的讲究，适合树立老板形象' },
  { value: 'KNOWLEDGE', label: '知识型', desc: '教人怎么做、怎么挑，靠有用换关注' },
  { value: 'PRODUCT', label: '产品型', desc: '讲这道菜有什么、多少钱，最直接' },
  { value: 'RECOMMEND', label: '种草型', desc: '像顾客说话，一句话把人喊住' },
]

/** 「款式稿」（不选菜品）只允许这两款，与 `STYLE_TRACKS` 一致 */
export const STYLE_TRACK_OPTIONS = COPY_TRACK_OPTIONS.filter(
  (item) => item.value === 'PERSONA' || item.value === 'KNOWLEDGE',
)

export const COMPLEXITY_OPTIONS: { value: Complexity; label: string; desc: string }[] = [
  { value: 'SIMPLE', label: '简单版', desc: '2~3 个分镜，约 5~10 秒' },
  { value: 'COMPLEX', label: '复杂版', desc: '5~6 个分镜，约 11~20 秒' },
  { value: 'FINE', label: '精细版', desc: '6~9 个分镜，约 18~29 秒' },
]

export const listCreations = (opts: { storeId?: string; archived?: boolean } = {}) => {
  const query = new URLSearchParams()
  if (opts.storeId) query.set('storeId', opts.storeId)
  if (opts.archived) query.set('archived', '1')
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return api<CreationItem[]>(`/creations${suffix}`)
}

export const getCreation = (id: string) => api<CreationDetail>(`/creations/${id}`)

export interface CreateCreationInput {
  mode: ContentMode
  storeId?: string
  dishId?: string
  track?: CopyTrack
  complexity?: Complexity
}

export const createCreation = (body: CreateCreationInput) =>
  api<{ id: string }>('/creations', { method: 'POST', body })

export const patchCreation = (id: string, body: { title?: string; copyText?: string }) =>
  api<CreationDetail>(`/creations/${id}`, { method: 'PATCH', body })

export const deleteCreation = (id: string) =>
  api<{ id: string }>(`/creations/${id}`, { method: 'DELETE' })

export const archiveCreation = (id: string) =>
  api<{ id: string; archived: boolean }>(`/creations/${id}/archive`, { method: 'POST' })

export const unarchiveCreation = (id: string) =>
  api<{ id: string; archived: boolean }>(`/creations/${id}/unarchive`, { method: 'POST' })

/**
 * 生成文案 / 分镜。
 *
 * ★★★ `requestId` 必须由**调用方**生成并按「一次用户点击」固定：服务端的幂等是按
 *   requestId 建的，同一个 requestId 重放会返回同一条结果（不重复扣积分）。
 *   所以每次**新的**点击要用新的 id —— 写死一个常量会让第二次点击永远拿到第一次的结果，
 *   用户看到「点了没反应」；反过来，网络重试要复用同一个 id，否则会扣两次。
 *   这里统一 `crypto.randomUUID()`，并在调用点保证「点一次只调一次」。
 */
export const generateCopy = (id: string, body: { track?: CopyTrack } = {}) =>
  api<CopyResult>(`/creations/${id}/copy`, { method: 'POST', body: { ...body, requestId: crypto.randomUUID() } })

export const generateStoryboard = (id: string, body: { complexity?: Complexity } = {}) =>
  api<StoryboardResult>(`/creations/${id}/storyboard`, {
    method: 'POST',
    body: { ...body, requestId: crypto.randomUUID() },
  })

export const updateShot = (
  creationId: string,
  shotId: string,
  body: { shotType?: string | null; shotSize?: string | null; durationSuggest?: number | null; line?: string | null; visualReq?: string | null },
) => api<Shot>(`/creations/${creationId}/shots/${shotId}`, { method: 'PUT', body })

/**
 * 创作进度。
 *
 * ★★ 权重与小程序 `pages/creation/list.tsx` 的 `progressOf` **必须一致**：
 *  同一个创作在两端的进度条长度不同，用户会以为其中一端坏了。
 *  文案 30 / 分镜 20 / 素材 40 / 合成 10，每段都 ≥10 ⇒ 0~100 里的 5 的倍数都可达。
 * ★ `renderReady` 是「进行中 / 已完成」的分类边界 = 文案与分镜都已生成（可去传素材）。
 *  刻意不跟 pct 走：否则老创作会集体从「已完成」掉进「进行中」。
 */
export interface Progress {
  pct: number
  label: string
  renderReady: boolean
}

const W_COPY = 30
const W_SHOTS = 20
const W_ASSET = 40
const W_RENDER = 10

const RENDER_STEP: Record<string, number> = {
  PENDING_RESERVATION: 2,
  QUEUED: 3,
  SETTLEMENT_PENDING: 3,
  MANUAL_PENDING: 4,
  RUNNING: 6,
  MANUAL_DOING: 6,
  SUCCESS: W_RENDER,
}

export function renderStatusLabel(status: string | null): string {
  switch (status) {
    case null: return '待合成'
    case 'SUCCESS': return '已合成成片'
    case 'RUNNING': return '成片合成中'
    case 'MANUAL_DOING': return '剪辑师制作中'
    case 'MANUAL_PENDING': return '等待剪辑师接单'
    case 'QUEUED': return '合成排队中'
    case 'SETTLEMENT_PENDING': return '退款确认中'
    case 'PENDING_RESERVATION': return '合成准备中'
    default: return '合成未完成，可重试'
  }
}

export function progressOf(c: Pick<CreationItem, 'copyText' | 'shotsTotal' | 'shotsReady' | 'renderStatus'>): Progress {
  const total = c.shotsTotal
  // 已上传数不可能超过总数，但服务端字段一旦漂移就会算出 >100% 的进度条
  const done = Math.max(0, Math.min(c.shotsReady, total))
  let pct = 0
  if (c.copyText) pct += W_COPY
  // total = 0 时不做除法：0/0 是 NaN，会把进度条整个打回 0
  if (total > 0) {
    pct += W_SHOTS
    pct += Math.round((done / total) * W_ASSET)
  }
  pct += RENDER_STEP[c.renderStatus ?? ''] ?? 0
  pct = Math.max(0, Math.min(100, pct))

  // 文案跟**进度条走到的那一步**对齐，不能出现「条已经 47% 却写着待生成文案」
  let label: string
  if (total === 0) label = c.copyText ? '待生成分镜' : '待生成文案'
  else if (done < total) label = `素材 ${done}/${total}`
  else label = renderStatusLabel(c.renderStatus)

  return { pct, label, renderReady: Boolean(c.copyText) && total > 0 }
}

/** 列表时间：近 7 天用相对时间，更早给 `YYYY-MM-DD HH:mm`（跨年也分得清） */
export function formatCreationTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Math.max(0, Date.now() - then)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  const d = new Date(then)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
