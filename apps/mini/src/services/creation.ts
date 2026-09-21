// 创作 API：对接 /api/v1/creations
import { http } from './request'

/**
 * 文案款式。
 * ★ 保留 `TRAFFIC`：**存量数据里有它**（含 20 条更早的 `track='NORMAL'`）。
 *   `trackLabel` 之类的展示仍要认得出这些老值，否则老创作在界面上会显示成空标签。
 */
export type CopyTrack = 'TRAFFIC' | 'INTRO' | 'QUALITY' | 'RECOMMEND'
/** 分镜复杂度：简单版 2~3 镜 / 复杂版 5~6 镜 / 精细版 6~9 镜 */
export type Complexity = 'SIMPLE' | 'COMPLEX' | 'FINE'
/**
 * 内容模式：`DISH` = 菜品稿（选门店+菜品）；`TOPIC` = 话题稿（流量款独立功能，不选门店菜品）。
 * 服务端有同名枚举，这里是它的下达形态。
 */
export type ContentMode = 'DISH' | 'TOPIC'

/** 四款的中文名（含流量款）—— **只作展示与兜底**，不要拿它做款式选择器 */
export const COPY_TRACK_OPTIONS: { value: CopyTrack; label: string; desc: string }[] = [
  { value: 'TRAFFIC', label: '流量款', desc: '跟热点 / 话题共鸣' },
  { value: 'INTRO', label: '介绍款', desc: '菜品讲解 / 套餐推广' },
  { value: 'QUALITY', label: '质量款', desc: '食材品质 / 匠心人设' },
  { value: 'RECOMMEND', label: '种草型', desc: '真实体验 / 消费决策' },
]

/**
 * ★ 创作页「文案款式」选择器用这一份：**不含流量款**。
 *
 * 流量款已从「四款文案」拆成独立功能（`mode='TOPIC'`，见 pages/creation/traffic）：
 * 它不选门店、不选菜品，只用节气/节日/时令出稿。还把它挂在创作页的款式里，
 * 用户会选到一条「明明有门店菜品、却生成出一条不提门店的稿子」——而且**不报错**。
 * （服务端也同步把 `track='TRAFFIC'` 排除在菜品稿的枚举外，旧客户端传了会拿到 400。）
 */
export const DISH_TRACK_OPTIONS = COPY_TRACK_OPTIONS.filter((o) => o.value !== 'TRAFFIC')

/**
 * 把「服务端 / 同款配方给来的 track」收敛成**菜品稿可用的三款**；不是这三款就返回 null。
 *
 * 用途：创作页的款式选择器已经不含流量款，但下面两个来源仍可能给出 `'TRAFFIC'`（甚至是更早的 `'NORMAL'`）：
 *   · 存量创作的 `track`（库里 25 条 TRAFFIC + 20 条 NORMAL）
 *   · `excellent_work.recipe_json.track`（优秀作品的款式会被原样带到创作页）
 * 直接 `setTrack(r.track)` 会让选择器**一项都不选中**（用户以为没选款式）；
 * 返回 null 则保持「介绍款」默认态 —— 这也正是服务端对菜品稿的收敛结果，两端一致。
 */
export function toDishTrack(v: unknown): CopyTrack | null {
  return v === 'INTRO' || v === 'QUALITY' || v === 'RECOMMEND' ? v : null
}

export const COMPLEXITY_OPTIONS: { value: Complexity; label: string; desc: string }[] = [
  { value: 'SIMPLE', label: '简单版', desc: '2~3 个分镜' },
  { value: 'COMPLEX', label: '复杂版', desc: '5~6 个分镜' },
  { value: 'FINE', label: '精细版', desc: '6~9 个分镜' },
]

export interface CreationItem {
  id: string
  title: string | null
  storeId: string
  dishId: string | null
  track: string
  /** 内容模式（`DISH` / `TOPIC`）。服务端保证非空；列表据此决定点进去开哪个页面 */
  mode: string
  complexity: string
  trackLabel?: string | null
  /** 「菜品稿」/「话题稿」中文名 */
  modeLabel?: string | null
  complexityLabel?: string | null
  copyText: string | null
  status: string
  createdAt: string
  /** 归档时间（ISO 字符串）。非 null 即在「归档」分类里；默认列表不含它 */
  archivedAt?: string | null
  /** 分镜总数 */
  shotsTotal: number
  /** 已上传素材的分镜数（分段进度里权重最大的一段） */
  shotsReady: number
  /** 最新一条渲染任务的 status；null = 从未发起过合成 */
  renderStatus: string | null
  /**
   * 列表卡片缩略图：**第一个已上传视频**的封面签名 URL。
   * 服务端按分镜顺序找「已上传 + 封面已生成」的那一个，没有则为 null ⇒ 前端退回默认图标。
   */
  coverUrl?: string | null
}

/** 分镜匹配到的镜头库拍摄手法 */
export interface LibraryShotRef {
  id: string
  code: string
  name: string
  category: string
  tips: string | null
  demoVideoKey: string | null
}

export interface ShotItem {
  id: string
  seq: number
  shotType: string | null
  /** 景别：远景/全景/中景/近景/特写/大特写 */
  shotSize: string | null
  durationSuggest: number | null
  line: string | null
  visualReq: string | null
  libraryShotId: string | null
  libraryShot?: LibraryShotRef | null
  assetId: string | null
  /** 已绑定素材的封面缩略图签名 URL（未生成/不可用时为 null） */
  coverUrl?: string | null
  trimStartMs: number
  trimEndMs: number | null
  /** 素材实际时长（ms）：未设置 trim 时合成按此计价 */
  assetDurationMs?: number | null
  /**
   * 用户主动跳过该分镜（「暂不上传」）。
   * ★ 这是**服务端**字段：跳过会被落库，刷新 / 换设备都在。
   *   本地的乐观标记（曾经的 `_skipped`）一刷新就没了，而合成页按「有没有 assetId」
   *   判断素材是否齐全 ⇒ 跳过等于没跳过，用户被永久挡在合成页外。
   * 不变量：skipped 为 true 时 assetId 必为 null。
   */
  skipped: boolean
  status: string
}

export interface CreationDetail extends CreationItem {
  shots: ShotItem[]
  dish: { id: string; name: string } | null
  store: { id: string; name: string } | null
  /**
   * 话题稿的地域钩子**快照**（创建时服务端从门店档案的位置取一次，省+市+区拼串）。
   * 菜品稿恒为 null。★ **只读** —— 它不是界面上的输入了（那个输入框已删），
   * 所以前端只可能读到它、不该再往上传（传了服务端也会丢掉）。
   */
  topicCity?: string | null
}

export interface Balance {
  balance: number
  grantBalance: number
  available: number
}

/**
 * 创作列表。
 * 不传 archived 就是默认列表 —— 服务端会排除已归档的，「归档后不出现在全部/进行中/已就绪」
 * 由服务端保证。前端**不要**再做一次本地过滤：两边判断不一致时，会出现"刚归档的又冒出来"。
 */
export function listCreations(storeId?: string, opts: { archived?: boolean } = {}) {
  const query: Record<string, string> = {}
  if (storeId) query.storeId = storeId
  if (opts.archived) query.archived = '1'
  return http.get<CreationItem[]>('/creations', Object.keys(query).length ? query : undefined)
}

/** 归档：从「全部 / 进行中 / 已就绪」移出，只在「归档」分类可见 */
export function archiveCreation(id: string) {
  return http.post<{ id: string; archived: boolean }>(`/creations/${id}/archive`)
}

/** 恢复：把归档的创作放回默认列表 */
export function unarchiveCreation(id: string) {
  return http.post<{ id: string; archived: boolean }>(`/creations/${id}/unarchive`)
}

/** 删除（服务端写 deletedAt 软删）。不可恢复，调用前必须先弹确认 */
export function deleteCreation(id: string) {
  return http.del<{ id: string; deleted: boolean }>(`/creations/${id}`)
}

export function getCreation(id: string) {
  return http.get<CreationDetail>(`/creations/${id}`)
}

export function createCreation(input: {
  /**
   * 菜品稿必填；**话题稿必须不传**（`mode: 'TOPIC'` 时另传该字段会 400/2002）。
   * 话题稿的门店由服务端自己挑一家做「宿主」（只为媒体归属，不进提示词）。
   */
  storeId?: string
  dishId?: string
  /** 内容模式；不传 = 菜品稿 */
  mode?: ContentMode
  // ⚠ 这里**没有** topicCity：话题稿的地域钩子由服务端从宿主门店档案的位置直接取，
  //   界面上不再有这个输入（旧包若还传，服务端 schema 会 strip 掉，不报错）。
  title?: string
  track?: CopyTrack
  complexity?: Complexity
  /**
   * 同款作品的分镜骨架：服务端会在创建的同时把它落成初始分镜（同一个事务）。
   * 传了就**不要再调 generateStoryboard** —— 那会整批替换掉它、还白扣一次积分。
   */
  shotSkeleton?: Array<{
    shotType?: string
    shotSize?: string
    durationSuggest?: number
    line?: string
    visualReq?: string
  }>
}) {
  return http.post<CreationDetail>('/creations', input)
}

/** 保存编辑：标题 / 文案正文 / 款式 / 复杂度（不扣积分）。地域钩子不在可编辑范围内 */
export function updateCreation(
  id: string,
  input: { title?: string; copyText?: string; track?: CopyTrack; complexity?: Complexity },
) {
  return http.patch<CreationDetail>(`/creations/${id}`, input)
}

/**
 * ★ AI 生成类接口必须单独放宽超时，不能吃 `request.ts` 的默认 30 秒。
 *
 * 默认 30 秒对普通读写够用，但**单次 AI 生成实测是 20~72 秒**：
 *   · 主通道（gpt-5.5）健康时，文案 14~16s、分镜 20~26s；
 *   · 主通道不可用退到备用通道（deepseek-v4-flash 是思考模型，completion 动辄上万 token）时，
 *     分镜要 46~72s。
 * 30 秒卡在中间 ⇒ 服务端其实还在跑、最后也确实成功（积分照扣、分镜也落了库），
 * 但**前端先超时**，`runAuto` 走 catch → 用户被弹回编辑页，看到的是「生成文案」「生成分镜」
 * 两个手动按钮 —— 像是刚才那次点击根本没自动生成。2026-09-16 实测就是这个形状
 * （服务端 72.4s 成功落库 6 条分镜，前端 30s 就断了）。
 *
 * 取值算法 = 该场景「候选数 × 单候选超时」，取最坏情况：
 *   · 分镜：候选 [11, 12, 7] 各 90s ⇒ 最坏 270s ⇒ 取 300s
 *   · 文案：候选 [11, 7, 12] 各 30s ⇒ 最坏 90s  ⇒ 取 120s
 * ⚠ 上限而已，正常 15~25 秒就回来；改服务端 `ai_scene.timeout_ms` 或候选数组时要同步重算。
 *
 * 实测（2026-09-16，主通道 gpt-5.5 挂掉期间）：文案 44.9s、分镜 90.1s（三候选全败退兜底）。
 * 都远大于原来的 30 秒默认值 —— 那才是「点了生成却像没生效」的直接原因。
 */
const COPY_TIMEOUT_MS = 120_000
const STORYBOARD_TIMEOUT_MS = 300_000

export function generateCopy(id: string, requestId: string, track?: CopyTrack) {
  return http.post<{
    text: string
    beanCharged: number
    balance: Balance
    duplicated: boolean
    isFallbackTemplate: boolean
    track: CopyTrack
    trackLabel: string
  }>(`/creations/${id}/copy`, { requestId, track }, { timeout: COPY_TIMEOUT_MS })
}

export function generateStoryboard(id: string, requestId: string, complexity?: Complexity) {
  return http.post<{
    shots: ShotItem[]
    raw?: string
    parsed: boolean
    beanCharged: number
    balance: Balance
    duplicated: boolean
    isFallbackTemplate: boolean
    complexity: Complexity
    complexityLabel: string
  }>(`/creations/${id}/storyboard`, { requestId, complexity }, { timeout: STORYBOARD_TIMEOUT_MS })
}

/** 编辑分镜脚本（景别 / 时长 / 台词 / 画面要求），不涉及素材 */
export function updateShotContent(
  id: string,
  shotId: string,
  input: {
    shotType?: string | null
    shotSize?: string | null
    durationSuggest?: number | null
    line?: string | null
    visualReq?: string | null
  },
) {
  return http.put<ShotItem>(`/creations/${id}/shots/${shotId}`, input)
}

export function updateShotAsset(
  id: string,
  shotId: string,
  input: { assetId?: string; trimStartMs?: number; trimEndMs?: number; skipped?: boolean },
) {
  return http.put<ShotItem>(`/creations/${id}/shots/${shotId}`, input)
}

/**
 * 为已上传但缺缩略图的分镜补生成封面（本地存储模式由服务端抽帧）。
 * 返回本次生成数量，前端据此决定是否重新拉取详情。
 */
export function ensureShotCovers(id: string) {
  return http.post<{ generated: number; pending: number }>(`/creations/${id}/ensure-covers`, {})
}

/** 素材播放地址（私有桶临时签名 URL），用于点击缩略图预览原视频 */
export function getAssetPlayUrl(assetId: string) {
  return http.get<{ url: string | null; dev: boolean }>(`/media/${assetId}/play-url`)
}
