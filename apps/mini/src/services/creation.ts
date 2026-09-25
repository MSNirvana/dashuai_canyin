// 创作 API：对接 /api/v1/creations
import { http } from './request'

/**
 * 文案款式。
 * ★ 2026-09-21 四款改型：删 `INTRO`（介绍款）/ `QUALITY`（质量款），
 *   换成 `PERSONA`（人设型）/ `KNOWLEDGE`（干货型）/ `PRODUCT`（产品型），
 *   `RECOMMEND`（种草型）保留。
 * ★ 仍要认得出老值：**存量数据里有**（`INTRO`/`QUALITY`，以及更早的 `track='NORMAL'`）。
 *   展示与收敛都必须走下面的 `normalizeTrack`，否则老创作在界面上会显示成空标签。
 * ★ 2026-09-24：「流量型」（`TRAFFIC`）不再是独立页面，它就是创作页款式选择器的**第一项** ——
 *   选中它时不选菜品，创建时按 `mode='TOPIC'` 走话题模板（见创作页的 onCreate 分流）。
 */
export type CopyTrack = 'TRAFFIC' | 'PERSONA' | 'KNOWLEDGE' | 'PRODUCT' | 'RECOMMEND'
/** 分镜复杂度：简单版 2~3 镜 / 复杂版 5~6 镜 / 精细版 6~9 镜 */
export type Complexity = 'SIMPLE' | 'COMPLEX' | 'FINE'
/**
 * 内容模式：`DISH` = 菜品稿（选门店+菜品）；`TOPIC` = 话题稿（流量型，不选门店菜品）。
 * 服务端有同名枚举，这里是它的下达形态。
 */
export type ContentMode = 'DISH' | 'TOPIC'

/**
 * 各款的中文名。★ 创作页「文案款式」的五个选项就是它（`DISH_TRACK_OPTIONS` 是它的四款子集）。
 *
 * ★ 2026-09-24 第二次只改名：`TRAFFIC` 的中文名「流量款」→「流量型」，
 *   **标识符与场景码一个都没动**（`TRAFFIC` / `copy_traffic` 仍是原值），
 *   与同日「真诚推荐型 → 种草型」同一口径。看到代码里的 `TRAFFIC`，界面上就是「流量型」。
 * ★ 2026-09-24 第三次改的是 `desc`（侧重点），**又一次只动文案**：
 *   人设型「讲人：立场 / 经历 / 情绪」→「立场 / 经历 / 情绪」、
 *   干货型「这行的知识：怎么做 / 怎么挑」→「怎么做 / 怎么挑」、
 *   产品型「有什么 / 多少钱 / 值不值」→「老板视角 / 真实内在」、
 *   种草型「老板视角 / 讲一个真实推荐理由」→「达人素人视角 / 推荐理由」。
 *   ⚠ 注意「老板视角」这一次是**换了归属**（原属种草型、现属产品型），不是纯措辞微调。
 * ★★ `desc` 在本端**只有一个消费点**：创作页 `TrackPicker` 把每款渲染成选项下方的侧重点小字
 *   （见 `pages/creation/edit.tsx`）。所以它有一条硬约束 ——
 *   **必须能在半宽格子的一行内放下**：格子内宽约 **267rpx**
 *   （750 − 页 32×2 − 卡 24×2 = 638 ⇒ 卡内容 638rpx，格宽 `calc(50% - 12rpx)` = 307rpx，
 *   再减格内距 20×2），22rpx 字号下 ≈ **12 个全角字**（「 / 」这类半角组合更窄）。
 *   超了就会折成两行、把同排另一格一起顶高 —— 改词条前先按这个账算一遍。
 *   ▲▲ 这里的「页 32 / 卡 24」是**覆写后**的值，不是 `edit.scss` 里 `&__card` 写的 32rpx：
 *     `.cedit__card` 编译出来是**单类名**（`&__card` 是拼接、不是后代选择器），
 *     所以文件末尾那条同权重的 `.cedit__card { padding: 24rpx }` 生效。
 *     按 32rpx 算会得出 622rpx / 格内宽 259rpx —— 差 16rpx，正好是「放得下 / 放不下」的边界。
 *   ★★ 余量已实测，且**不宽裕**：2026-09-24 无头浏览器按同字体同内距重建后量得
 *     最长一条「达人素人视角 / 推荐理由」= **245.7rpx**，对格内宽 266~267rpx
 *     ⇒ 余量约 **20rpx / 7.5%**。**再加两三个字就会折行**，改词条必须重量。
 *     复现件：`outputs/creation-track-desc-fit.html`（+ 同名 `.png`）。
 * ⚠ 服务端 `creation.service.ts` 的 `COPY_TRACKS` **也带一份 `desc`，但全仓无消费点**
 *   （只取 `.label` 与 `.scene`），且早已与本表跑偏（它写「同城引流 / 话题热度」「讲一个有依据的推荐理由」）。
 *   本次已手工同步，但它仍是**重复定义**，建议哪天删掉只留这一份真源。
 */
export const COPY_TRACK_OPTIONS: { value: CopyTrack; label: string; desc: string }[] = [
  { value: 'TRAFFIC', label: '流量型', desc: '跟热点 / 话题共鸣' },
  { value: 'PERSONA', label: '人设型', desc: '立场 / 经历 / 情绪' },
  { value: 'KNOWLEDGE', label: '干货型', desc: '怎么做 / 怎么挑' },
  { value: 'PRODUCT', label: '产品型', desc: '老板视角 / 真实内在' },
  { value: 'RECOMMEND', label: '种草型', desc: '达人素人视角 / 推荐理由' },
]

/**
 * 创作页「文案款式」选择器的**默认款式**。
 * ★ 必须与服务端 `DEFAULT_COPY_TRACK` 指向同一款（那边是 PRODUCT），
 *   两端不一致会出现「用户没动过选择器，服务端却按另一款生成」这种无从排查的错配。
 */
export const DEFAULT_DISH_TRACK: CopyTrack = 'PRODUCT'

/**
 * ★★ 存量 `track` 的映射（2026-09-21 四款改型）。**读出来的老值必须在客户端先归一**。
 *
 * 与服务端 `LEGACY_TRACK_ALIASES` 一一对应，映射规则也必须一致：
 *   · `INTRO`（介绍款：菜品讲解/套餐推广）→ **产品型**（同样是「有什么、多少钱」）
 *   · `QUALITY`（质量款：食材品质/匠心人设）→ **人设型**（同样是「我们是怎么做事的」）
 *   · `NORMAL`（更早的旧值）→ **产品型**
 * ★ 客户端这份**不能省**：服务端返回的 `track` 是库里的原值（`trackLabel` 是另一列），
 *   而前端直接拿它去 `COPY_TRACK_OPTIONS.find(...)` 会得到 undefined
 *   ⇒ 款式那一栏**空白**、选择器**一项都不选中**，用户以为没选款式。
 */
const LEGACY_TRACK_ALIASES: Record<string, CopyTrack> = {
  INTRO: 'PRODUCT',
  QUALITY: 'PERSONA',
  NORMAL: 'PRODUCT',
}

/** 把服务端 / 同款配方给来的任意 track 归一到当前款式；认不出返回 null */
export function normalizeTrack(v: unknown): CopyTrack | null {
  if (typeof v !== 'string') return null
  if (COPY_TRACK_OPTIONS.some((o) => o.value === v)) return v as CopyTrack
  return LEGACY_TRACK_ALIASES[v] ?? null
}

/**
 * 创作页「文案款式」里的四款**菜品文案**（不含流量型）。
 *
 * 流量型（`TRAFFIC`）现在也在同一张选择器里，但它**不是**菜品稿的一款：
 * 选中它就不选菜品，创建时走 `mode='TOPIC'`（见 `TRAFFIC_TRACK`）。
 * 所以「五选一」与「四款菜品文案」必须是**两份常量**：编辑态「换一款」只换这四款
 * —— 话题稿的款式服务端不许改（`updateCreation` 对 TOPIC 行直接丢弃 track），
 * 把它列出来就是一个点了没反应的选项。
 * （服务端同样把 `track='TRAFFIC'` 排除在**菜品稿**的入参枚举外：`mode='DISH'` 传它会 400。）
 */
export const DISH_TRACK_OPTIONS = COPY_TRACK_OPTIONS.filter((o) => o.value !== 'TRAFFIC')

/**
 * 「流量型」这一款。创作页拿它做三件事，全部是**判值**而不是判位置：
 *   ① 款式网格里独占第一行；
 *   ② 选中时把「菜品」那一行置灰（它不拍菜）；
 *   ③ `onCreate` 据此分流成 `mode='TOPIC'` 的创建请求。
 *
 * ★ 不要退回字面量 `'TRAFFIC'`：这几处一旦有一处拼错，表现是「选项选不中」或
 *   「菜品悄悄没被提交」—— 两种都不报错。
 */
export const TRAFFIC_TRACK: CopyTrack = 'TRAFFIC'

/**
 * 把「服务端 / 同款配方给来的 track」收敛成**菜品稿可用的四款**；不是这四款（含流量型、认不出的值）就返回 null。
 *
 * ★ 用途在 2026-09-24 收窄了：**话题稿的款式改由 `mode` 判定**，不再经过这里
 *   （见创作页 loadDetail：`mode === 'TOPIC'` ⇒ 恒为 `TRAFFIC_TRACK`）。
 *   反过来，「库里是菜品稿、track 却是 `'TRAFFIC'`」在**存量数据里真实存在**
 *   （25 条），而服务端对它们一律改回默认款式（`generateCopy` 的兜底）。所以这里必须继续收敛：
 *   不收敛就会对着一条菜品稿把「流量型」显示成选中，而实际生成的是产品型 —— 不报错，只是错配。
 * 其余来源仍可能给出认不出的值（更早的 `'NORMAL'`、改型前的 `'INTRO'` / `'QUALITY'`）：
 *   · 存量菜品稿的 `track`
 *   · `excellent_work.recipe_json.track`（优秀作品的款式会被原样带到创作页）
 * 直接 `setTrack(r.track)` 会让选择器**一项都不选中**（用户以为没选款式）；
 * 返回 null 则保持默认款式态（见 `DEFAULT_DISH_TRACK`）—— 这也正是服务端对菜品稿的收敛结果，两端一致。
 */
export function toDishTrack(v: unknown): CopyTrack | null {
  const t = normalizeTrack(v)
  return t && t !== 'TRAFFIC' ? t : null
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
  /** 归档时间（ISO 字符串）。非 null 即在「垃圾桶」分类里；默认列表不含它。字段名保持 archivedAt 不变 */
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
 * 不传 archived 就是默认列表 —— 服务端会排除已归档的，「扔掉后不出现在全部/进行中/已完成」
 * 由服务端保证。前端**不要**再做一次本地过滤：两边判断不一致时，会出现"刚扔掉的又冒出来"。
 * ★ 对外文案 2026-09-25 起把「归档」叫「垃圾桶」，但**接口一律不动**：
 *   `?archived=1`、`/archive`、`/unarchive`、字段 `archivedAt` 全部保持原名。
 */
export function listCreations(storeId?: string, opts: { archived?: boolean } = {}) {
  const query: Record<string, string> = {}
  if (storeId) query.storeId = storeId
  if (opts.archived) query.archived = '1'
  return http.get<CreationItem[]>('/creations', Object.keys(query).length ? query : undefined)
}

/** 扔进垃圾桶：从「全部 / 进行中 / 已完成」移出，只在「垃圾桶」分类可见（可逆） */
export function archiveCreation(id: string) {
  return http.post<{ id: string; archived: boolean }>(`/creations/${id}/archive`)
}

/** 恢复：把垃圾桶里的创作放回默认列表 */
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
 * 取值算法 = 该场景「候选数 × 单候选超时 × (maxRetries+1)」，取最坏情况：
 *   · 分镜：候选 [deepseek, claude] 各 150s、不重试 ⇒ 最坏 300s ⇒ 取 340s
 *   · 文案：候选 [deepseek, gpt] 各 45s、不重试 ⇒ 最坏 90s ⇒ 取 120s
 *     ★ 2026-09-22 重算：五个文案款的主候选换成 deepseek、Claude 移出、
 *       timeout 抬到 45s、maxRetries 归 0（依据见 setup-ai-channels.ts 的
 *       SCENE_OVERRIDES 与 ai/scene-codes.ts 的 LOW_REASONING_SCENES）。
 *       正常路径实测 **8~13 秒**出稿，90s 只是「两个候选都病着」时的上限。
 * ⚠ 上限而已，正常 60~100 秒就回来；改服务端 `ai_scene.timeout_ms` / 候选数组 /
 *   `max_retries` 时**必须同步重算**，否则前端会比服务端先放弃：
 *   服务端最坏耗时一旦超过本值，用户等到的就是「前端超时」，而服务端其实成功落库了。
 *
 * ★ 2026-09-21 重算依据（分镜场景改配置）：`max_retries` 从 1 调成 0、
 *   `timeout_ms` 从 90s 抬到 150s、主候选换成 deepseek-v4-flash、移除 gpt-5.5。
 *   DeepSeek 对分镜 prompt 的实测耗时在 **60~130+ 秒**之间波动
 *   （62.2s / 91.2s / 95.8s / 100.1s / >130s），所以 150s 上限 + 340s 前端兜底。
 *
 * 实测（2026-09-16，主通道 gpt-5.5 挂掉期间）：文案 44.9s、分镜 90.1s（三候选全败退兜底）。
 * 都远大于原来的 30 秒默认值 —— 那才是「点了生成却像没生效」的直接原因。
 */
const COPY_TIMEOUT_MS = 120_000
const STORYBOARD_TIMEOUT_MS = 340_000

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
