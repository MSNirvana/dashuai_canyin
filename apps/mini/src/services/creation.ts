// 创作 API：对接 /api/v1/creations
import { http } from './request'

/** 文案四款：流量款 / 介绍款 / 质量款 / 种草型 */
export type CopyTrack = 'TRAFFIC' | 'INTRO' | 'QUALITY' | 'RECOMMEND'
/** 分镜复杂度：简单版 2~3 镜 / 复杂版 5~6 镜 / 精细版 6~9 镜 */
export type Complexity = 'SIMPLE' | 'COMPLEX' | 'FINE'

export const COPY_TRACK_OPTIONS: { value: CopyTrack; label: string; desc: string }[] = [
  { value: 'TRAFFIC', label: '流量款', desc: '同城引流 / 话题热度' },
  { value: 'INTRO', label: '介绍款', desc: '菜品讲解 / 套餐推广' },
  { value: 'QUALITY', label: '质量款', desc: '食材品质 / 匠心人设' },
  { value: 'RECOMMEND', label: '种草型', desc: '真实体验 / 消费决策' },
]

export const COMPLEXITY_OPTIONS: { value: Complexity; label: string; desc: string }[] = [
  { value: 'SIMPLE', label: '简单版', desc: '2~3 个分镜' },
  { value: 'COMPLEX', label: '复杂版', desc: '5~6 个分镜' },
  { value: 'FINE', label: '精细版', desc: '6~9 个分镜' },
]

export interface CreationItem {
  id: string
  title: string | null
  /**
   * 「你想拍什么风格？」用户自填的一句话（≤200 字，未填为 null）。
   * 详情接口（getCreation）会带回来用于回填；列表接口不一定返回，所以是可选的。
   */
  userIdea?: string | null
  storeId: string
  dishId: string | null
  track: string
  complexity: string
  trackLabel?: string | null
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
  status: string
}

export interface CreationDetail extends CreationItem {
  shots: ShotItem[]
  dish: { id: string; name: string } | null
  store: { id: string; name: string } | null
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
  storeId: string
  dishId?: string
  title?: string
  /** 「你想拍什么风格？」选填，≤200 字。会作为最高优先级要求喂给模型 */
  userIdea?: string
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

/** 保存编辑：标题 / 文案正文 / 款式 / 复杂度 / 「你想拍什么风格？」（不扣积分） */
export function updateCreation(
  id: string,
  input: { title?: string; copyText?: string; userIdea?: string; track?: CopyTrack; complexity?: Complexity },
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
  input: { assetId?: string; trimStartMs?: number; trimEndMs?: number },
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
