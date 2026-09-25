// 创作服务：把「门店/菜品上下文」喂给 AI 网关生成文案与分镜，并持久化分镜
// 计费通过 runBilledScene 内部完成（文案 5 积分 / 分镜 10 积分），这里只负责上下文与落库
import type { PrismaClient, Shot } from '@prisma/client'
import type { AiGateway } from '../ai/gateway.js'
import { runBilledScene, ScenePendingError } from '../ai/ai.service.js'
import { BeanNotEnoughError } from '../bean/bean.service.js'
import { requireSubscription } from './subscription.service.js'
import * as mediaSvc from './media.service.js'
import { generateVideoCover, coverKeyForVideoKey } from '../lib/thumbnail.js'
import { isLocalStorage, localPathForKey } from '../lib/local-storage.js'
import { SCENE } from '../ai/scene-codes.js'
// 「今天几号、临近什么节」—— 提示词里唯一的时间来源（见 lib/festival.ts 的文件头）
import { formatDateInfo } from '../lib/festival.js'
// 话题稿专属：把「今天」翻译成几条能直接开口的起头方向（节气/节日/时令/生活共识）
import { formatTopicInfo } from '../lib/topic.js'
// 套餐判断复用同一个常量：`kind === 'COMBO'` 这种字面量散在两处，哪天改了值只会有一处跟着变
import { DISH_KIND_COMBO } from './dish.service.js'

export const SCENE_COPY = SCENE.copy_generate
export const SCENE_STORYBOARD = SCENE.storyboard_generate

/**
 * 文案五款：流量型 + 四款菜品文案（人设型 / 干货型 / 产品型 / 种草型），
 * 各对应一个可在后台配置提示词的 AI 场景。
 *
 * ★ 2026-09-21 四款改型：删掉「介绍款（INTRO）」与「质量款（QUALITY）」，
 *   换成「人设型（PERSONA）/ 干货型（KNOWLEDGE）/ 产品型（PRODUCT）」，
 *   并把 `RECOMMEND` 保留场景码、模板整份重写。
 * ★ 2026-09-24 **只改名**：`RECOMMEND` 的中文名由「真诚推荐型」改为「种草型」，
 *   **标识符与场景码一个都没动**（`RECOMMEND` / `copy_recommend` 仍是原值）。
 *   看到代码里的 `RECOMMEND`、`copy_recommend`，界面上就是「种草型」。
 *   四型的分界线是**内容重点**：人设讲老板真实做事方式／干货讲有依据的行业知识／
 *   产品讲清在售内容／种草型由老板讲一个有依据的推荐理由。
 * ★ 2026-09-24 同日第二次只改名：`TRAFFIC` 的中文名「流量款」→「流量型」，
 *   同样是**只动 label**（`TRAFFIC` / `copy_traffic` 一个都没动）。
 *   它仍然只属于 `mode='TOPIC'` 的话题稿 —— 小程序端已取消独立的「跟热点」页，
 *   把这一款并进创作页的「文案款式」当第一项，选中它就不选菜品、按 `mode='TOPIC'` 创建。
 */
export const COPY_TRACKS = {
  TRAFFIC: { label: '流量型', scene: SCENE.copy_traffic, desc: '跟热点 / 话题共鸣' },
  PERSONA: { label: '人设型', scene: SCENE.copy_persona, desc: '立场 / 经历 / 情绪' },
  KNOWLEDGE: { label: '干货型', scene: SCENE.copy_knowledge, desc: '怎么做 / 怎么挑' },
  PRODUCT: { label: '产品型', scene: SCENE.copy_product, desc: '老板视角 / 真实内在' },
  RECOMMEND: { label: '种草型', scene: SCENE.copy_recommend, desc: '达人素人视角 / 推荐理由' },
} as const
/**
 * ⚠⚠ 上表里的 `desc` 是**死字段**：全仓没有任何读取点，服务端只取 `.label`（下发
 *   `trackLabel`）与 `.scene`（选提示词模板）。**真源在小程序端**
 *   `apps/mini/src/services/creation.ts` 的 `COPY_TRACK_OPTIONS` —— 那份会被创作页
 *   渲染成每个款式下方的小字。
 *
 * 2026-09-24 实测到的跑偏（本次已手工拉齐）：本表写「同城引流 / 话题热度」
 * 而小程序写「跟热点 / 话题共鸣」；本表写「讲一个**有依据的**推荐理由」
 * 而小程序写「讲一个**真实**推荐理由」。**两份定义必然跑偏**，只是这次碰巧被翻出来。
 * ⇒ 下次动这块直接**删掉 `desc`**，只留小程序那一份，不要再手工同步。
 */
export type CopyTrack = keyof typeof COPY_TRACKS

/**
 * ★★ 存量 `track` 的**读取侧**映射（2026-09-21 四款改型）。
 *
 * 为什么必须有这张表：`Creation.track` 是 `String @db.VarChar(24)`，不是数据库枚举
 * —— 改型**不需要迁移**，但库里那些老值会永远留着。它们不在 COPY_TRACKS 里，
 * `isCopyTrack()` 判否之后又会回落到默认值，于是**两条不同的老稿子会被塞进同一个新款式**，
 * 而且不会报错。所以老值必须在**读出来的那一刻**映射到最接近的新款：
 *   · `INTRO`（介绍款：菜品讲解/套餐推广）→ **产品型**（同样是「有什么、多少钱」）
 *   · `QUALITY`（质量款：食材品质/匠心人设）→ **人设型**（同样是「我们是怎么做事的」）
 *   · `NORMAL`（更早的旧值，库里存量 20 条）→ **产品型**（那批都是菜品稿）
 *   · `RECOMMEND` → 不映射，新款沿用同一个键
 * ★ 这是**只读兼容**：绝不回写库里的老值 —— 回写会在「同款配方」二次创作时
 *   把老稿子的款式串到新稿子上，而那条路径本来就允许带任意 track 过来。
 */
export const LEGACY_TRACK_ALIASES: Record<string, CopyTrack> = {
  INTRO: 'PRODUCT',
  QUALITY: 'PERSONA',
  NORMAL: 'PRODUCT',
}

/** 把库里读到的任意 track 值归一到当前款式；归一不了返回 null（调用方决定兜底） */
export function normalizeCopyTrack(v: unknown): CopyTrack | null {
  if (typeof v !== 'string') return null
  if (Object.prototype.hasOwnProperty.call(COPY_TRACKS, v)) return v as CopyTrack
  return LEGACY_TRACK_ALIASES[v] ?? null
}

/**
 * 读出侧统一用的款式中文名。
 * ★ 必须走 normalize：老稿子的 track 是 INTRO/QUALITY/NORMAL，直接查 COPY_TRACKS 会得到 null，
 *   界面上那一栏会**空白**（看起来像"这条稿子没有款式"），而不是显示映射后的新款名。
 */
export function copyTrackLabel(v: unknown): string | null {
  const t = normalizeCopyTrack(v)
  return t ? COPY_TRACKS[t].label : null
}

/**
 * ★ 2026-09-21 从 `INTRO` 改成 `PRODUCT`。
 *
 * 那个默认值原来指向「介绍款」（菜品讲解/套餐推广）—— 改型后它的语义由「产品型」承接，
 * 所以默认值跟着挪到 PRODUCT，语义不变：**没传 track 的创建，仍然出一条菜品稿**。
 * 保留这段注释的原因：这个默认值是**唯一一个既有语义、又必须跟着改型改名**的常量，
 * 忘了改就会让「没传 track」的请求落到一个已经不存在的场景上。
 */
export const DEFAULT_COPY_TRACK: CopyTrack = 'PRODUCT'

/**
 * 内容模式：这条创作是**菜品驱动**还是**话题驱动**。
 *
 * · `DISH`  —— 选门店（+可选菜品），走四款**菜品文案**（人设型 / 干货型 / 产品型 / 种草型）。
 * · `TOPIC` —— 「流量型」：不选门店、不选菜品，只靠节气/节日/时令与生活共识出稿。
 *
 * ★ 为什么不靠「track='TRAFFIC' 且 dishId 为空」推断：那个组合在**存量数据里已经存在**
 *   （老用户建过没选菜品的流量款创作），推断会把它们误判成话题稿；
 *   而两者的提示词完全不同（话题稿不喂门店/菜品）—— 误判的后果是文案里凭空没有门店信息，
 *   且**不会报错**。
 */
export const CONTENT_MODES = {
  DISH: { label: '菜品稿' },
  TOPIC: { label: '话题稿' },
} as const
export type ContentMode = keyof typeof CONTENT_MODES
export const DEFAULT_CONTENT_MODE: ContentMode = 'DISH'

export function isContentMode(v: unknown): v is ContentMode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CONTENT_MODES, v)
}

/** 话题稿只允许这一款（它就是要走「流量型」那份纯话题模板） */
export const TOPIC_TRACK: CopyTrack = 'TRAFFIC'

/** 分镜复杂度：简单版 2~3 镜 / 复杂版 5~6 镜 / 精细版 6~9 镜 */
export const COMPLEXITIES = {
  SIMPLE: { label: '简单版', rule: '2~3 个分镜' },
  COMPLEX: { label: '复杂版', rule: '5~6 个分镜' },
  FINE: { label: '精细版', rule: '6~9 个分镜' },
} as const
export type Complexity = keyof typeof COMPLEXITIES
export const DEFAULT_COMPLEXITY: Complexity = 'COMPLEX'

export function isCopyTrack(v: unknown): v is CopyTrack {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(COPY_TRACKS, v)
}
export function isComplexity(v: unknown): v is Complexity {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(COMPLEXITIES, v)
}

export class CreationNotFoundError extends Error {
  constructor() {
    super('创作不存在')
    this.name = 'CreationNotFoundError'
  }
}

export class ShotNotFoundError extends Error {
  constructor() {
    super('分镜不存在')
    this.name = 'ShotNotFoundError'
  }
}
export class CreationStoreMismatchError extends Error {
  constructor() {
    super('创作不属于该门店或商家')
    this.name = 'CreationStoreMismatchError'
  }
}

export class CreationDishMismatchError extends Error {
  constructor() {
    super('菜品不属于当前商家门店')
    this.name = 'CreationDishMismatchError'
  }
}

export class CreationAssetMismatchError extends Error {
  constructor() {
    super('创作中的素材不属于当前商家门店或已被删除')
    this.name = 'CreationAssetMismatchError'
  }
}

/**
 * 话题稿不允许由调用方指定门店/菜品（界面上没有这两个选择器）。
 * 抛错而不是静默忽略：静默忽略会让「前端以为按门店生成了、实际没有」长期藏着，
 * 而它表现为「文案里没有店名」，没人会往参数被吞上想。
 */
export class TopicCreationStoreForbiddenError extends Error {
  constructor() {
    super('话题稿不需要门店与菜品')
    this.name = 'TopicCreationStoreForbiddenError'
  }
}

/** 商户一家门店都没有，话题稿没有宿主可挂 —— 提示去建店，而不是报一个看不懂的 500 */
export class TopicHostStoreMissingError extends Error {
  constructor() {
    super('请先添加门店，再使用流量型')
    this.name = 'TopicHostStoreMissingError'
  }
}

/**
 * 门店档案里的「所在地区」= 话题稿的同城钩子来源。
 *
 * 省 / 市 / 区**都取**，因为这三个粒度在口播里各有各的用处：省是能拉同乡的身份
 * （「咱河北的」），区县是落点更准的说法（「咱固安的」）。取哪些由模型自己挑
 * （提示词里明写「挑一级来说」），我们只负责把素材原样给它。
 *
 * ★ **一个位置字段都没填 ⇒ 返回 null ⇒ 提示词里整行不出现。**
 *   绝不退化成「用别的门店的位置」或者一个猜出来的城市：那会让一条本该只讲话题的稿子
 *   凭空出现一个用户没填过的地方，而且不报错。
 * ★ 省市同名的（北京市/北京市/朝阳区）去重，否则会拼出「北京市北京市朝阳区」。
 */
export function storeLocationOf(store: {
  province?: string | null
  city?: string | null
  district?: string | null
}): string | null {
  const parts = [store.province, store.city, store.district]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
  const uniq = parts.filter((s, i) => parts.indexOf(s) === i)
  return uniq.length > 0 ? uniq.join('') : null
}

/**
 * 话题稿的「宿主门店」：让媒体归属/拍摄/合成这些下游照旧成立。
 *
 * 取值规则必须是**确定**的：优先 `isDefault=true`，其次 id 最小（= 最早创建的那家）。
 * ★ 不用「前端当前选中的门店」：那样同一份话题稿的结果会随用户切门店而变，
 *   重新生成时也复现不了；服务端自己定规则，前端不需要知道是哪家。
 * ★ 也不能改用 `storeId` 可空：creation.storeId 是媒体归属校验的锚
 *   （素材绑定按 `mediaAsset.storeId === creation.storeId` 过滤），放开可空会牵动整条渲染链路。
 *
 * ★ 宿主门店的**名称/介绍/品类/菜品**仍然一律不进提示词（用户从没选过它，喂进去等于
 *   拿一家他没选的门店做内容）；但它的**所在地区**是例外 —— 那是「同城共鸣」的唯一来源，
 *   见 storeLocationOf。这一条是用户明确要求的：界面上不再让用户手填城市，
 *   位置直接取门店档案，没填就不带这个信息。
 */
async function resolveTopicHostStore(
  prisma: PrismaClient,
  merchantId: bigint,
): Promise<{ id: bigint; location: string | null }> {
  const store = await prisma.store.findFirst({
    where: { merchantId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
    select: { id: true, province: true, city: true, district: true },
  })
  if (!store) throw new TopicHostStoreMissingError()
  return { id: store.id, location: storeLocationOf(store) }
}

export interface CreateCreationInput {
  /**
   * ★ 话题稿（`mode='TOPIC'`，界面上就是「流量型」）**不需要**传它 —— 这一款刻意不选门店，
   *   由服务端解析一家「宿主门店」只为让媒体归属/拍摄/合成这些下游照旧成立（见 resolveTopicHostStore）。
   *   菜品稿（`DISH`）则必填。
   */
  storeId?: bigint
  dishId?: bigint
  title?: string
  track?: CopyTrack
  complexity?: Complexity
  /** 内容模式。不传 = `DISH`（保持所有既有调用方的语义不变） */
  mode?: ContentMode
  /**
   * ⚠ 这里**没有** `topicCity`：话题稿的地域钩子由服务端从宿主门店档案直接取
   *   （见 resolveTopicHostStore / storeLocationOf），前端不填、也传不进来。
   *
   *   上一版它是调用方的入参（页面上有个「同城落点（选填）」输入框）。为什么改：
   *   用户要的是「直接获取店铺位置，没有填写位置就不要这个信息」—— 让用户为了
   *   一条不谈门店的稿子再手打一遍城市，本身就是多余的一步。
   *
   *   `creation.topic_city` 这一列**保留**，但语义变成「创建当时从门店档案取到的快照」：
   *   快照仍然必要 —— 门店档案的位置随时可改，改成每次实时读会让同一条稿
   *   「今天生成」和「下周重新生成」落到不同地方，用户会以为是玄学。
   */
  /**
   * 同款作品的分镜骨架（来自 excellent_work.recipe_json 的 shotSkeleton）。
   *
   * 有值时**在创建同一个事务里落成初始分镜** —— 这是「本地导入的作品，基本配置参数一并导入」
   * 那件事的落点：用户从优秀作品进创作页，拿到的不只是款式/复杂度，而是**已经拆好的镜头结构**，
   * 可以直接去拍摄页拍，不用先买一次 AI 分镜。
   *
   * 为什么放在创建里而不是另开一个「导入分镜」接口：
   *   两步会有中间态 —— 创建成功、导入失败时页面上是一条**没有任何分镜**的创作，
   *   而前端已经把「已预置」的提示打出去了。放进同一个事务就不存在这个状态。
   *
   * 用户不满意可以点「重新生成」，那条路走 generateShots：它会**整批替换**（deleteMany 后重建），
   * 预置的分镜不会和数据混在一起。
   */
  shotSkeleton?: RecipeShotSkeleton[]
}

/** 同款配方里的镜头骨架条目（与 work.service 的 WorkRecipe.shotSkeleton 同形） */
export interface RecipeShotSkeleton {
  shotType?: string
  shotSize?: string
  durationSuggest?: number
  line?: string
  visualReq?: string
}

export interface CopyResult {
  text: string
  beanCharged: bigint
  balance: { balance: bigint; grantBalance: bigint; available: bigint }
  duplicated: boolean
  isFallbackTemplate: boolean
  track: CopyTrack
  trackLabel: string
}

export interface StoryboardResult {
  shots: Shot[]
  raw?: string
  parsed: boolean
  beanCharged: bigint
  balance: { balance: bigint; grantBalance: bigint; available: bigint }
  duplicated: boolean
  isFallbackTemplate: boolean
  complexity: Complexity
  complexityLabel: string
}

/**
 * 从创作记录里摘掉 `user_idea` 再往外送。
 *
 * 「你想拍什么风格？」那个输入框已于 2026-09-20 从整条链路删除，数据库列 `creation.user_idea`
 * **保留但不读不写**（见 schema.prisma 上该列的说明）—— 与门店「联系电话」整链移除同一口径。
 * ★ 关键：这里的「不读不写」**包含「不往响应里带」**。留着它有两个坏处：
 *   ① 前端看到响应里有这字段，会以为还存在一个可用的「风格」输入；
 *   ② 形态不一致 —— 改动后新建的记录永远是 `null`，改动前的老记录却带着旧文本。
 *
 * 用解构而不是 `delete`：解构是纯函数式、不碰入参；`_drop` 只起占位作用
 * （本仓 tsconfig 未开 noUnusedLocals，下划线前缀表明「故意不要」）。
 *
 * ★ 泛型**不能**加 `extends { userIdea?: unknown }` —— 见函数体内的说明，
 *   那会把调用方记录的整个类型窄化掉，属于「修一个类型错、炸出十四条」那种坑。
 */
function withoutUserIdea<T extends object>(row: T): Omit<T, 'userIdea'> {
  // 断言而不是约束：`T` 必须保持**原样**。若写成 `T extends { userIdea?: unknown }`，
  // 因为该类型里字段全可选，TS 的「弱类型检测」会要求实参至少有一个同名属性 ——
  // 而列表查询走 select、记录里根本没有 userIdea ⇒ 实参被拒，T 退化成那个字面量类型，
  // 于是返回值只剩几个计算字段、`.map((s) => …)` 的参数变成 any（实测报 14 条）。
  const { userIdea: _drop, ...rest } = row as T & { userIdea?: unknown }
  return rest
}

export async function listCreations(
  prisma: PrismaClient,
  merchantId: bigint,
  storeId?: bigint,
  opts: { archived?: boolean; mediaBaseUrl?: string } = {},
) {
  const rows = await prisma.creation.findMany({
    where: {
      merchantId,
      storeId: storeId ?? undefined,
      deletedAt: null,
      // 归档与默认列表**互斥**：归档分类只要已归档的，其余分类（全部/进行中/已就绪）
      // 一律排除已归档 —— 这就是「归档后不出现在那三个分类」的实现点。
      archivedAt: opts.archived ? { not: null } : null,
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      storeId: true,
      dishId: true,
      track: true,
      // 列表要据此决定卡片的标记（「话题稿」），并让前端知道这条不能用菜品稿的那套款式
      mode: true,
      complexity: true,
      copyText: true,
      status: true,
      createdAt: true,
      archivedAt: true,
      // 列表页要显示**分段进度**（文案 / 分镜 / 素材 / 合成），这里把算进度所需的最小信息
      // 一次带齐，避免前端为每张卡片再打一次接口（N+1）：
      //   · 每个分镜的 assetId —— 算「素材传了几个」（非空即已上传）
      //   · 最新一条渲染任务的 status —— 判断「是否已合成 / 合成中」
      // 只 select 需要的列、不整行拉；一个创作通常几个到几十个分镜，量可控。
      //
      // seq + 显式 orderBy 是给**列表封面**用的：封面要认「第一个已上传的视频」，
      // 不能依赖数组的默认顺序（DB 不保证稳定序，排错会让封面在两次刷新之间跳来跳去）。
      shots: { select: { assetId: true, seq: true, skipped: true }, orderBy: { seq: 'asc' } },
      renderTasks: { select: { status: true }, orderBy: { id: 'desc' }, take: 1 },
    },
  })

  // 列表封面用的素材：**跨所有创作一次性批量查 + 批量签名**，
  // 不是「每个创作各查一次」（那才是本段注释一直在防的 N+1）。
  const coverAssetIds = new Set<bigint>()
  for (const r of rows) {
    for (const s of r.shots) if (s.assetId !== null) coverAssetIds.add(s.assetId)
  }
  const coverAssets = coverAssetIds.size
    ? await prisma.mediaAsset.findMany({
        where: { id: { in: [...coverAssetIds] }, merchantId, deletedAt: null },
        select: { id: true, storeId: true, type: true, coverKey: true },
      })
    : []
  const coverUrlMap = await signAssetCovers(merchantId, coverAssets, opts.mediaBaseUrl)
  const coverAssetMap = new Map(coverAssets.map((a) => [a.id, a]))

  /**
   * 卡片缩略图 = **第一个已上传的、带封面的视频**。
   *
   * 两条判据都是刻意的：
   * · 按 seq 顺序找**已上传**的那个，而不是直接取 seq=1 —— 第一个分镜常常还是空的，
   *   取 seq=1 会让「传了视频却仍显示默认图」。
   * · 第一个视频若封面还没生成出来（异步抽帧有延迟），继续往后找**有封面的**，
   *   而不是就此返回 null —— 宁可显示第二段的缩略图，也比退回默认图标好。
   * 一个都没有（没传素材 / 全是图 / 素材已被删）才返回 null，前端据此保留默认图标。
   */
  const pickCover = (creationStoreId: bigint, shots: { assetId: bigint | null }[]): string | null => {
    for (const shot of shots) {
      if (shot.assetId === null) continue
      const asset = coverAssetMap.get(shot.assetId)
      // 素材必须属于**本创作的门店**：跨店/越权的 assetId 绝不能被签成封面
      // （与 getCreation 的归属不变量一致；列表这里不抛错，静默跳过）
      if (!asset || asset.storeId !== creationStoreId) continue
      // ⚠ 库里 type 存的是**大写** `VIDEO` / `IMAGE`（实测 media_asset 全表只有这两个值）。
      //   用小写字面量比会把所有视频都漏掉，表现为「明明传了视频却仍显示默认图标」。
      //   这里做成大小写不敏感，免得日后写入方改约定又要再修一次。
      if (asset.type.toLowerCase() !== 'video') continue
      const url = coverUrlMap.get(asset.id)
      if (url) return url
    }
    return null
  }

  // 附带中文标签与**服务端算好的进度字段**；原始 shots / renderTasks 数组不下发
  return rows.map((r) => {
    const { shots, renderTasks, ...rest } = withoutUserIdea(r)
    return {
      ...rest,
      shotsTotal: shots.length,
      // ★ 「已就绪」= 传了素材 **或** 用户明确跳过。跳过的分镜不该继续算作「缺素材」：
      //   列表卡片上的分段进度会一直停在「3/5」，用户以为还有活没干完 —— 而那个分镜他本来就不打算拍。
      shotsReady: shots.filter((s) => s.assetId !== null || s.skipped).length,
      renderStatus: renderTasks[0]?.status ?? null,
      // 卡片缩略图：第一个已上传视频的封面（没有则为 null，前端退回默认图标）
      coverUrl: pickCover(r.storeId, shots),
      trackLabel: copyTrackLabel(r.track),
      modeLabel: isContentMode(r.mode) ? CONTENT_MODES[r.mode].label : null,
      complexityLabel: isComplexity(r.complexity) ? COMPLEXITIES[r.complexity].label : null,
    }
  })
}

/**
 * 归档 / 恢复：先校验归属（不存在、越权、已删一律 4046，不泄露他人数据的存在性），再写时间戳。
 *
 * 幂等：已经处于目标状态就直接返回、不重复写 —— 否则「连点两次归档」会把归档时间
 * 刷成第二次的时间，日后按归档时间做排序/清理的逻辑会被带偏。
 */
async function setArchived(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
  archived: boolean,
): Promise<{ id: bigint; archived: boolean }> {
  const row = await prisma.creation.findFirst({
    where: { id: creationId, merchantId, deletedAt: null },
    select: { id: true, archivedAt: true },
  })
  if (!row) throw new CreationNotFoundError()
  if (archived === (row.archivedAt !== null)) return { id: creationId, archived }
  await prisma.creation.update({
    where: { id: creationId },
    data: { archivedAt: archived ? new Date() : null },
  })
  return { id: creationId, archived }
}

/** 归档：从「全部 / 进行中 / 已就绪」移出，只在「归档」分类可见 */
export function archiveCreation(prisma: PrismaClient, merchantId: bigint, creationId: bigint) {
  return setArchived(prisma, merchantId, creationId, true)
}

/** 恢复：把归档的创作放回默认列表 */
export function unarchiveCreation(prisma: PrismaClient, merchantId: bigint, creationId: bigint) {
  return setArchived(prisma, merchantId, creationId, false)
}

/**
 * 删除 = **软删**（写 deletedAt），不是物理删除。
 *
 * 为什么软删：① 本项目既有的删除语义就是它 —— `listCreations` / `getCreation` 一直在过滤
 * `deletedAt: null`，`deleted_at` 列与复合索引也早就建好了，另造一套物理删除会让"已删"
 * 出现两种状态；② 创作下挂着 shot / render_task 与素材对象，物理删除要处理级联与存储回收，
 * 且误删不可救。软删后两个分类都查不到，用户侧效果与真删一致。
 *
 * 用 updateMany + count 一次完成归属校验与幂等：count=0 涵盖「不存在 / 越权 / 已删」，
 * 统一抛 4046 —— 刻意不区分，避免泄露他人创作的存在性。
 */
export async function deleteCreation(prisma: PrismaClient, merchantId: bigint, creationId: bigint) {
  const r = await prisma.creation.updateMany({
    where: { id: creationId, merchantId, deletedAt: null },
    data: { deletedAt: new Date() },
  })
  if (r.count === 0) throw new CreationNotFoundError()
  return { id: creationId, deleted: true }
}

export async function createCreation(
  prisma: PrismaClient,
  merchantId: bigint,
  input: CreateCreationInput,
) {
  const mode: ContentMode = input.mode ?? DEFAULT_CONTENT_MODE
  // ★ 话题稿：门店与菜品都不该由调用方给（界面上根本没有这两个选择器）。
  //   传了就报错而不是静默忽略 —— 静默忽略会让「前端以为按门店生成了、实际没有」这种
  //   不一致一直藏着，而它表现为「文案里没有店名」，没人会想到是参数被吞了。
  if (mode === 'TOPIC' && (input.storeId !== undefined || input.dishId !== undefined)) {
    throw new TopicCreationStoreForbiddenError()
  }
  const host = mode === 'TOPIC' ? await resolveTopicHostStore(prisma, merchantId) : null
  const storeId = host ? host.id : input.storeId
  if (storeId === undefined) throw new CreationStoreMismatchError()

  const store = await prisma.store.findFirst({
    where: { id: storeId, merchantId, deletedAt: null },
  })
  if (!store) throw new CreationStoreMismatchError()
  let dishName: string | undefined
  if (mode === 'DISH' && input.dishId !== undefined) {
    const dish = await prisma.dish.findFirst({
      where: { id: input.dishId, storeId, store: { merchantId, deletedAt: null }, deletedAt: null },
      select: { id: true, name: true },
    })
    if (!dish) throw new CreationDishMismatchError()
    dishName = dish.name
  }
  const skeleton = input.shotSkeleton ?? []
  // 事务：创作行与预置分镜必须同生共死。见 CreateCreationInput.shotSkeleton 的说明
  // —— 只建成一半的状态（有创作、没分镜）在前端看起来就是「预置失败了」，
  // 而用户手里已经拿到「已预置 N 个分镜」的提示，只会以为是自己点错了。
  return prisma.$transaction(async (tx) => {
    const created = await tx.creation.create({
      data: {
        merchantId,
        storeId,
        // 话题稿永远没有菜品（上面已经拒绝传入），显式写 undefined 而不是 input.dishId
        dishId: mode === 'TOPIC' ? undefined : input.dishId,
        // 菜品创作默认使用稳定、可读的标题；保留旧调用方传入标题的兼容性。
        /**
         * ★ 2026-09-25：菜品改成可选项 ⇒「菜品稿 + 一道菜都没选」成了一条**正常**路径。
         *   这时标题退回**门店名**，不能留 undefined：前端有 4 处 `title || '未命名创作'`
         *   兜底（首页近期作品 / 创作列表 / 创作编辑页 / 合成页），落 undefined 就会全部显示
         *   「未命名创作」—— 看起来像「这条创作坏了」，而用户只是没选菜。
         *   （话题稿那一侧不走这里，它由文案模型顺便取名，见 generateCopy 的 parseTopicCopy。）
         */
        title: input.title?.trim() || (
          mode === 'DISH'
            ? (dishName ? `${store.name}+${dishName}` : store.name)
            : undefined
        ),
        // ★ 话题稿**强制**用流量款：它是唯一一份不喂门店/菜品的文案模板。
        //   允许调用方传别的款式，会让「话题稿却走介绍款模板」这种组合悄悄生效 ——
        //   介绍款要求讲清菜名与卖点，而话题稿手里一个字都没有，模型只能编。
        track: mode === 'TOPIC' ? TOPIC_TRACK : (input.track ?? DEFAULT_COPY_TRACK),
        mode,
        // 地域钩子 = 创建**当时**宿主门店档案里的所在地区快照（门店没填位置 ⇒ null）。
        // 不是入参：页面上没有这个输入框了，理由见 CreateCreationInput 里那段说明。
        topicCity: host ? host.location : null,
        complexity: input.complexity ?? DEFAULT_COMPLEXITY,
      },
    })
    if (skeleton.length) {
      await tx.shot.createMany({
        data: skeleton.map((s, i) => ({
          creationId: created.id,
          seq: i + 1,
          // 空串一律落 null：库里「没填」只留一种形态（与 routes 的 optionalText 同口径）
          shotType: str(s.shotType),
          shotSize: str(s.shotSize),
          durationSuggest: s.durationSuggest ?? null,
          line: str(s.line),
          visualReq: str(s.visualReq),
          // 与 AI 生成的分镜同一个起始状态：素材还没绑
          status: 'PENDING',
        })),
      })
    }
    return withoutUserIdea(created)
  })
}

/** 轻量归属校验：确认创作属于当前商家且未软删。不加载 shots/素材，不签 URL。 */
export async function assertCreationOwned(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
): Promise<void> {
  const c = await prisma.creation.findFirst({
    where: { id: creationId, merchantId, deletedAt: null },
    select: { id: true },
  })
  if (!c) throw new CreationNotFoundError()
}

/**
 * 带归属校验地读取单个分镜。
 * shot 必须属于「当前商户的 creation」，否则抛 CreationNotFoundError（→ 404），
 * 信息不区分「创作不存在」与「不属于你」，避免通过 404/403 差异枚举他人资源。
 */
export async function readShotOwned(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
  shotId: bigint,
): Promise<Shot> {
  await assertCreationOwned(prisma, merchantId, creationId)
  const s = await prisma.shot.findFirst({ where: { id: shotId, creationId } })
  if (!s) throw new ShotNotFoundError()
  return s
}

export async function getCreation(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
  mediaBaseUrl?: string,
) {
  const c = await prisma.creation.findFirst({
    where: { id: creationId, merchantId, deletedAt: null },
    include: {
      shots: { orderBy: { seq: 'asc' } },
      dish: { select: { id: true, name: true } },
      store: { select: { id: true, name: true } },
    },
  })
  if (!c) throw new CreationNotFoundError()
  // 附加素材时长：合成页前端预估积分需要（未 trim 的分镜按素材实际时长计价）
  // 注意：多个分镜可绑定同一个素材，必须先按 id 去重再比对数量，否则会误判为素材越权
  const assetIdSet = new Set(c.shots.map((s) => s.assetId).filter((v): v is bigint => v !== null))
  const assetIds = [...assetIdSet]
  const assets = assetIds.length
    ? await prisma.mediaAsset.findMany({ where: { id: { in: assetIds }, merchantId, storeId: c.storeId, deletedAt: null } })
    : []
  if (assets.length !== assetIds.length) throw new CreationAssetMismatchError()
  const durMap = new Map(assets.map((a) => [a.id, a.durationMs]))
  // 附加封面缩略图签名 URL：拍摄页要在「已上传」处展示视频缩略图
  const coverMap = await signAssetCovers(merchantId, assets, mediaBaseUrl)
  // 附加匹配到的镜头库拍摄手法：拍摄页要按分镜展示「怎么拍」
  const libIds = c.shots.map((s) => s.libraryShotId).filter((v): v is bigint => v !== null)
  const libs = libIds.length
    ? await prisma.shotLibrary.findMany({
        where: { id: { in: libIds } },
        select: { id: true, code: true, name: true, category: true, tips: true, demoVideoKey: true },
      })
    : []
  const libMap = new Map(libs.map((l) => [l.id, l]))
  return {
    ...withoutUserIdea(c),
    trackLabel: copyTrackLabel(c.track),
    modeLabel: isContentMode(c.mode) ? CONTENT_MODES[c.mode].label : null,
    complexityLabel: isComplexity(c.complexity) ? COMPLEXITIES[c.complexity].label : null,
    shots: c.shots.map((s) => ({
      ...s,
      assetDurationMs: s.assetId ? (durMap.get(s.assetId) ?? null) : null,
      coverUrl: s.assetId ? (coverMap.get(s.assetId) ?? null) : null,
      libraryShot: s.libraryShotId ? (libMap.get(s.libraryShotId) ?? null) : null,
    })),
  }
}

/**
 * 批量签发素材封面 URL：只对有 coverKey 的素材签名，单个失败不影响其他分镜。
 * 返回 assetId → url 的映射（无封面 / 签名失败的不在映射中）。
 */
async function signAssetCovers(
  merchantId: bigint,
  assets: { id: bigint; coverKey: string | null }[],
  mediaBaseUrl?: string,
): Promise<Map<bigint, string>> {
  const withCover = assets.filter((a): a is { id: bigint; coverKey: string } => !!a.coverKey)
  const map = new Map<bigint, string>()
  await Promise.all(
    withCover.map(async (a) => {
      try {
        const r = await mediaSvc.getPlayUrlByKey(merchantId, a.coverKey, mediaBaseUrl)
        if (r.url) map.set(a.id, r.url)
      } catch {
        // 封面不可用则留空，前端展示占位图
      }
    }),
  )
  return map
}

/**
 * 为创作中「已绑定素材但缺封面」的分镜补生成缩略图。
 * 仅本地存储模式可做（服务端能直接读到视频文件）；COS 模式需客户端在上传时上报 coverKey。
 * 返回实际生成成功的数量，供前端决定是否刷新。
 */
export async function ensureCreationCovers(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
): Promise<{ generated: number; pending: number }> {
  // 只需校验归属 + 拿到分镜绑定的素材，不必走完整的 getCreation（避免多余的签名开销）
  const c = await prisma.creation.findFirst({
    where: { id: creationId, merchantId, deletedAt: null },
    select: { id: true, storeId: true, shots: { select: { assetId: true } } },
  })
  if (!c) throw new CreationNotFoundError()
  const assetIdSet = new Set(c.shots.map((s) => s.assetId).filter((v): v is bigint => v !== null))
  if (assetIdSet.size === 0) return { generated: 0, pending: 0 }

  const assets = await prisma.mediaAsset.findMany({
    where: {
      id: { in: [...assetIdSet] },
      merchantId,
      storeId: c.storeId,
      deletedAt: null,
      coverKey: null,
    },
  })
  const videos = assets.filter((a) => a.type === 'VIDEO')
  if (videos.length === 0) return { generated: 0, pending: 0 }
  // 非本地模式读不到视频文件，只能等客户端上报封面
  if (!isLocalStorage()) return { generated: 0, pending: videos.length }

  let generated = 0
  let pending = 0
  for (const a of videos) {
    const coverKey = coverKeyForVideoKey(a.cosKey)
    let srcPath: string
    let outPath: string
    try {
      srcPath = localPathForKey(a.cosKey)
      outPath = localPathForKey(coverKey)
    } catch {
      pending++
      continue
    }
    const { ok: coverOk } = await generateVideoCover(srcPath, outPath)
    if (!coverOk) {
      pending++
      continue
    }
    await prisma.mediaAsset.update({ where: { id: a.id }, data: { coverKey } })
    generated++
  }
  return { generated, pending }
}

/**
 * 拼装人设变量：带标签、逐字段判断，两个字段都空则返回空串。
 *
 * 为什么不做 `${bossTags} ${activity}` 式裸拼：两个字段语义完全不同（前者是「老板是什么样的人」，
 * 后者是「最近想让顾客知道什么」），拼成一串后模型只能看到一坨无标号的文字，容易把
 * 「开业 8 折」当成老板的性格去写。带上标签后模型能分别归位。
 * 全空时返回空串而不是留着空标签，避免提示词里出现「老板人设标签：」这种噪声行。
 */
export function formatPersona(p: { bossTags?: string | null; activity?: string | null } | null): string {
  if (!p) return ''
  const parts: string[] = []
  const tags = (p.bossTags ?? '').trim()
  const activity = (p.activity ?? '').trim()
  if (tags) parts.push(`老板人设标签：${tags}`)
  if (activity) parts.push(`最近想重点告诉顾客：${activity}`)
  return parts.join('；')
}

/**
 * 分 → 元。与小程序 `utils/money.ts::fenToYuan` 同一口径（两端没有共享包，各留一份小实现）。
 * `Math.round` 那一步这里不做 —— 这个函数只用于**展示**，不参与任何金额计算。
 */
function fenText(fen: number): string {
  return (fen / 100).toFixed(fen % 100 === 0 ? 0 : 2)
}

/** formatComboInfo 需要的最小形状（`dish` 的 include 结果里挑出来的几个字段） */
export interface ComboInfoDish {
  kind?: string | null
  priceFen?: number | null
  originalPriceFen?: number | null
  comboItems?: Array<{ quantity: number; dish: { name: string; deletedAt: Date | null } }>
}

/**
 * 套餐信息 —— 喂给 AI 的一个变量。
 *
 * 为什么必须有它：套餐与单菜在库里是**同一张表**，而 `{{dishName}}/{{dishIntro}}/{{sellingPoints}}`
 * 这套变量只能表达「它叫什么、一句话介绍」，**说不出「含哪些菜、多少钱」**——
 * 可这两件事恰好是套餐推广的全部卖点。缺了它，模型要么凭空编几道店里没有的菜，
 * 要么写出一条对套餐毫无作用的文案（用户花了积分，看不出这是一份套餐）。
 *
 * 单菜返回**空串**（同 formatPersona 的约定），模板那一段自己写着「空 = 单道菜」。
 * ★ 不要在这里塞「（本菜品不是套餐）」之类占位文字 —— 那会让模型在一道炒菜上讨论「套餐」。
 */
export function formatComboInfo(dish: ComboInfoDish | null | undefined): string {
  if (!dish || dish.kind !== DISH_KIND_COMBO) return ''
  const segs: string[] = []
  const price = dish.priceFen ?? null
  if (price !== null && price > 0) {
    const original = dish.originalPriceFen ?? null
    // ★ 只有**原价确实更高**时才算优惠：服务端有「原价必须高于套餐价」的硬约束，
    //   但历史数据/后台直改都可能违反。宁可少算一笔省的钱，也不要让文案里出现「省 ¥-8」。
    const discounted = original !== null && original > price
    segs.push(
      discounted
        ? `套餐价 ¥${fenText(price)}（原价 ¥${fenText(original)}，省 ¥${fenText(original - price)}）`
        : `套餐价 ¥${fenText(price)}`,
    )
  }
  // ★ 明细为空时刻意说「还没填」而不是让这一段消失：套餐没有内容是**异常状态**，
  //   空着的话模型会自己决定「包含什么」，多半编出几道店里根本没有的菜。
  const rows = (dish.comboItems ?? []).filter((it) => it.dish.deletedAt === null)
  segs.push(
    rows.length
      ? `包含：${rows.map((it) => (it.quantity > 1 ? `${it.dish.name}×${it.quantity}` : it.dish.name)).join('、')}`
      : '包含：（门店还没有填具体菜品）',
  )
  return segs.join('｜')
}

/**
 * 拼装 AI 提示词变量：门店（含门店介绍）+ 菜品 + 门店人设 + 已生成文案 + 款式/复杂度 + 镜头库
 * （人设跟随门店）。导出仅供 scripts/verify-prompt-vars.ts 做变量契约测试，
 * 业务调用请走 generateCopy / generateShots。
 */
export async function buildVariables(
  prisma: PrismaClient,
  creationId: bigint,
  opts: { track?: CopyTrack; complexity?: Complexity } = {},
) {
  const c = await prisma.creation.findUnique({
    where: { id: creationId },
    include: {
      store: { include: { persona: true } },
      dish: {
        include: {
          /**
           * ★ 套餐明细必须一起读出来，否则「选了套餐」与「选了一道同名的单菜」对模型完全一样。
           * · orderBy 与 dish.service.ts 保持一致（sort → id）：不然「包含」那一串的顺序
           *   会随数据库返回顺序漂移，同一份套餐生成两次可能给出不同的菜序。
           * · 这里不按 `dish.deletedAt` 过滤，改由 formatComboInfo 过滤 ——
           *   过滤放在**拼装函数**里，契约测试才能不连库、直接喂一条假数据把这个分支测了。
           */
          comboItems: {
            orderBy: [{ sort: 'asc' }, { id: 'asc' }],
            select: { quantity: true, sort: true, dish: { select: { name: true, deletedAt: true } } },
          },
        },
      },
    },
  })
  if (!c) throw new CreationNotFoundError()
  const track = opts.track ?? normalizeCopyTrack(c.track) ?? DEFAULT_COPY_TRACK
  const complexity = opts.complexity ?? (isComplexity(c.complexity) ? c.complexity : DEFAULT_COMPLEXITY)
  const mode: ContentMode = isContentMode(c.mode) ? c.mode : DEFAULT_CONTENT_MODE

  /**
   * ★ 话题稿：门店与菜品相关变量**一律给空串**。
   *
   * 为什么不是「反正模板不引用、给了也无所谓」：那样一旦有人把 {{storeName}} 加回流量款模板，
   * 就会当场渲染出真店名 —— 而这条稿子的产品定义就是「不涉及门店」。
   * 何况 c.store 只是**宿主门店**（服务端为了媒体归属挑的），把它喂进提示词等于
   * 拿一个用户根本没选过的门店去做内容，用户会莫名其妙。
   *
   * ⚠ 城市的来源变了（2026-09-21）：走 c.topicCity，它现在是**创建时从宿主门店档案取的快照**
   *   （见 storeLocationOf），而不是用户手填的自由文本。
   *   仍然**不实时读宿主门店的 city** —— 门店改了位置不该让同一条稿重新生成跑出另一个地方，
   *   而且那样「今天生成」和「下周重新生成」结果不一致，用户只会觉得是玄学。
   *   快照为 null = 门店一个位置字段都没填 ⇒ topicInfo 里整行不出现（纯话题稿，不提地方）。
   */
  const topic = mode === 'TOPIC'
  return {
    storeName: topic ? '' : c.store.name,
    storeIntro: topic ? '' : (c.store.intro ?? ''),
    category: topic ? '' : (c.store.category ?? ''),
    city: topic ? '' : (c.store.city ?? ''),
    dishName: topic ? '' : (c.dish?.name ?? ''),
    dishIntro: topic ? '' : (c.dish?.intro ?? ''),
    sellingPoints: topic ? '' : (c.dish?.sellingPoints ?? ''),
    comboInfo: topic ? '' : formatComboInfo(c.dish),
    persona: topic ? '' : formatPersona(c.store.persona),
    // ★ 每次生成都现算：创作可能存了一周才生成，缓存住「今天」会让节日提示过期。
    //   代价只是一次 Intl 格式化 + 几十条候选过滤，可忽略。
    //   ⚠ 话题稿也要算它：分镜模板引用 {{dateInfo}}（话题稿同样要分镜）。
    dateInfo: formatDateInfo(),
    // 话题稿专属：今天是什么日子 + 几条可直接开口的起头方向（见 lib/topic.ts）。
    // 菜品稿拿到的是空串 —— 它由门店/菜品驱动，不需要话题方向，也（在白名单层面）引用不到。
    topicInfo: topic ? formatTopicInfo(new Date(), c.topicCity ?? '') : '',
    copyText: c.copyText ?? '',
    track,
    trackLabel: COPY_TRACKS[track].label,
    mode,
    complexity,
    complexityLabel: COMPLEXITIES[complexity].label,
    shotCountRule: COMPLEXITIES[complexity].rule,
    shotLibrary: await buildShotLibraryHint(prisma),
  }
}

/** 镜头库压缩成一行一条，供分镜提示词挑选 libraryCode */
async function buildShotLibraryHint(prisma: PrismaClient): Promise<string> {
  const lib = await prisma.shotLibrary.findMany({
    where: { enabled: true },
    orderBy: [{ category: 'asc' }, { sort: 'asc' }, { id: 'asc' }],
    select: { code: true, name: true, category: true },
  })
  if (lib.length === 0) return '（镜头库为空，libraryCode 可留空）'
  return lib.map((it) => `${it.code}｜${it.name}（${it.category}）`).join('\n')
}

/** 校验款式对应的场景是否存在且启用，不存在则回退通用文案场景（避免新增款式未配置时直接报错） */
async function resolveCopyScene(prisma: PrismaClient, track: CopyTrack): Promise<string> {
  const scene = COPY_TRACKS[track].scene
  const hit = await prisma.aiScene.findFirst({ where: { code: scene, enabled: true }, select: { id: true } })
  return hit ? scene : SCENE_COPY
}

export async function generateCopy(
  prisma: PrismaClient,
  gateway: AiGateway,
  merchantId: bigint,
  creationId: bigint,
  requestId: string,
  track?: CopyTrack,
): Promise<CopyResult> {
  // v5：订阅是使用文案生成的硬前提（在扣积分之前拦截，避免白冻结）
  await requireSubscription(prisma, merchantId, '文案生成')
  await getCreation(prisma, merchantId, creationId) // 校验归属

  // 未指定款式时沿用创作上已保存的款式（默认产品型）
  // ★ 走 normalizeCopyTrack 而不是 isCopyTrack：库里的老值（INTRO/QUALITY/NORMAL）
  //   必须映射到最接近的新款，否则它们会绕过"沿用已保存款式"直接掉到默认值，
  //   把一条质量款老稿重新生成成产品型 —— 而且不报错。
  const current = await prisma.creation.findUnique({
    where: { id: creationId },
    // ★ title 也要读：话题稿回写标题前要判「现在有没有名字」（用户手改过的不能被覆盖）
    select: { track: true, mode: true, title: true },
  })
  /**
   * ★ 话题稿的款式**不可协商**：它只有一份不喂门店/菜品的模板（copy_traffic）。
   *   允许调用方传 track，就会出现「话题稿却按产品型模板生成」——产品型要求讲清菜名与卖点，
   *   而话题稿手里一个字都没有，模型只能编；而且这个组合不报错，只是文案悄悄变了味。
   *   所以这里直接覆盖掉入参，而不是"以入参为准再兜底"。
   */
  const mode: ContentMode = isContentMode(current?.mode) ? current.mode : DEFAULT_CONTENT_MODE
  const finalTrack: CopyTrack =
    mode === 'TOPIC'
      ? TOPIC_TRACK
      : (() => {
          const want = track ?? normalizeCopyTrack(current?.track) ?? DEFAULT_COPY_TRACK
          /**
           * ★★ 菜品稿**永远不许**走「流量型」（`TRAFFIC`）。
           *
           * 流量型的模板已经改成纯话题版：不喂门店、不喂菜品，而且明确要求「不要报店名」。
           * 但菜品稿挂着 TRAFFIC 这件事在**存量数据里是真实存在的**：
           *   · 25 条 `track='TRAFFIC'` 的创作（都是 mode='DISH'）
           *   · 前端「同款配方」会把优秀作品的款式原样带过来，其中就可能带 TRAFFIC
           * 不兜这一下，用户点「重新生成」会拿到一条**既不提门店也不提菜品**的稿子，
           * 而且全程不报错 —— 看起来就像 AI 突然变笨了。
           * 所以这里把它改回默认款式，而不是「尊重传入的款式」。
           */
          return want === TOPIC_TRACK ? DEFAULT_COPY_TRACK : want
        })()
  const sceneCode = mode === 'TOPIC' ? SCENE.copy_traffic : await resolveCopyScene(prisma, finalTrack)
  if (current?.track !== finalTrack || (current && !isContentMode(current.mode))) {
    await prisma.creation.update({ where: { id: creationId }, data: { track: finalTrack, mode } })
  }

  const vars = await buildVariables(prisma, creationId, { track: finalTrack })
  const r = await runBilledScene(prisma, gateway, {
    sceneCode,
    merchantId,
    requestId,
    variables: vars,
    bizId: String(creationId),
  })
  /**
   * ★ 话题稿的返回是 `{"title":"…","copy":"…"}`，但**所有调用方要的都是正文**：
   *   前端拿 `text` 直接填进文案编辑框，分镜提示词又把它当 `{{copyText}}` 喂进去。
   *   所以在最前面解析一次，落库与返回统一用解析后的正文
   *   （解析失败时 `picked` 为 null，`copyText` 就是原文本，行为与改造前一致）。
   */
  const picked = mode === 'TOPIC' && r.text ? parseTopicCopy(r.text) : null
  // ★ 收窄成 string：`r.text` 在类型上是 `string | undefined`，而落库字段不接受 undefined
  const copyText: string = picked ? picked.copy : (r.text ?? '')
  /**
   * ★「有结构、没正文」时**不写库**（见 `parseTopicCopy` 的最后一个分支）：
   *   写一条空文案等于把用户原来那份稿子清掉，比什么都不做更糟。
   *   正常返回永远是 `copy` 有内容，这里只兜住损坏输出。
   */
  const brokenTopic = picked !== null && !copyText
  if (!r.isFallbackTemplate && r.text && !brokenTopic) {
    const data: { copyText: string; title?: string | null } = { copyText }
    /**
     * ★ 话题稿没有门店/菜品可拼名字（见 `createCreation` 的 title 兜底），所以让这次文案调用
     *   顺便取一个 ≤8 字标题（模板见 `COPY_TRAFFIC_PROMPT` 的【输出格式】）。
     * ★ 只在当前没有标题时才写 —— 用户手动改过的名字不能被一次「重新生成」抹掉。
     */
    if (picked && !current?.title?.trim()) data.title = picked.title || null
    await prisma.creation.update({ where: { id: creationId }, data })
  }
  return {
    // 损坏输出时回原文本：让问题在编辑框里**可见**，而不是静默给一个空文案
    text: copyText || r.text,
    beanCharged: r.beanCharged,
    balance: r.balance,
    duplicated: r.duplicated,
    isFallbackTemplate: r.isFallbackTemplate,
    track: finalTrack,
    trackLabel: COPY_TRACKS[finalTrack].label,
  }
}

/** 保存用户手动编辑的文案 / 标题（编辑不扣积分，也不走 AI） */
export async function updateCreation(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
  input: { copyText?: string; title?: string; track?: CopyTrack; complexity?: Complexity },
) {
  await getCreation(prisma, merchantId, creationId)
  /**
   * ★ 话题稿不允许被改成别的款式（也不允许别人把它改成话题稿）。
   *   `mode` 是创建时定下的**内容形态**，不是可切换的显示选项：
   *   话题稿必须走流量款模板，而流量款模板不喂门店/菜品 —— 一旦款式被改成介绍款，
   *   下一次生成就会用「要讲清菜名卖点」的模板去写一条没有菜的稿子，模型只能编，
   *   而且**不报错**。所以这里直接丢弃 track，而不是写库。
   *   ⚠ 这是「静默忽略」而不是抛错，是刻意的：前端换款式是本地即时生效的高频操作，
   *     为一个不该出现的入参把整次编辑请求打失败，得不偿失；丢弃后返回的是库里的真实值。
   */
  const row = await prisma.creation.findUnique({
    where: { id: creationId },
    select: { mode: true, storeId: true, topicCity: true },
  })
  const isTopicRow = isContentMode(row?.mode) && row.mode === 'TOPIC'

  const data: {
    copyText?: string
    title?: string
    track?: string
    complexity?: string
    topicCity?: string | null
  } = {}
  if (input.copyText !== undefined) data.copyText = input.copyText
  if (input.title !== undefined) data.title = input.title
  if (input.track !== undefined && !isTopicRow) data.track = input.track
  if (input.complexity !== undefined) data.complexity = input.complexity
  /**
   * ★ 给存量话题稿**补**地域快照。
   *
   * 2026-09-21 之前，话题稿的城市是用户在页面上手填的，不填就落 null；现在改成从门店档案取。
   * 那些老稿子的 `topic_city` 会一直是 null ⇒ 提示词里永远少一行地域钩子，**而且不报错**
   * （模型只是写得没那么接地气，没人会想到是少了一行）。
   *
   * 补的时机选在「保存设置」这一步是刻意的：前端每次点「生成」都会先调本接口
   * （已有创作走这一支），所以老稿子在**下一次生成时自动补齐**，不需要另写一个迁移脚本，
   * 也不会在只读的详情/列表接口里偷偷写库。
   * 只在快照为 null 时补 —— 已经取过的一律不动（门店改位置不该改历史稿）。
   */
  if (isTopicRow && row?.topicCity === null && row.storeId !== null) {
    const store = await prisma.store.findFirst({
      where: { id: row.storeId, merchantId },
      select: { province: true, city: true, district: true },
    })
    const loc = store ? storeLocationOf(store) : null
    if (loc) data.topicCity = loc
  }
  if (Object.keys(data).length === 0) return getCreation(prisma, merchantId, creationId)
  await prisma.creation.update({ where: { id: creationId }, data })
  return getCreation(prisma, merchantId, creationId)
}

/** 从 AI 返回的散文中尽量抠出 JSON 数组/对象 */
function extractJson(text: string): string {
  const arrS = text.indexOf('[')
  const arrE = text.lastIndexOf(']')
  if (arrS >= 0 && arrE > arrS) return text.slice(arrS, arrE + 1)
  const objS = text.indexOf('{')
  const objE = text.lastIndexOf('}')
  if (objS >= 0 && objE > objS) return text.slice(objS, objE + 1)
  return text
}

/**
 * 话题稿短标题的字数上限。
 * 提示词里写的是「最多 8 个字」，但那只是**请求**不是保证 —— 模型偶尔会写长，
 * 所以这里再截一刀。（这个 8 与 `COPY_TRAFFIC_PROMPT` 的【输出格式】必须同值。）
 */
const TOPIC_TITLE_MAX = 8

/** 去掉空白与模型自作主张加的包裹引号，再截到上限 */
function clipTopicTitle(raw: string): string {
  return raw
    .replace(/\s+/g, '')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .slice(0, TOPIC_TITLE_MAX)
}

/**
 * 没有可用的模型标题时，用正文开头的短句拼一个标题 —— 生硬也好过一个「未命名创作」。
 *
 * ★ 只取「第一句」是不够的：话题稿常以很短的句子开头（真实输出是「中秋了，咱福建的，你老家那口吃的…」），
 *   只取第一句会得到「中秋了」这种 3 字标题。所以按句读切分后**贪心往里拼**，
 *   拼到「再加一句就超上限」为止（与字幕切分的思路一致，见 `packSubtitleLines`）。
 * ★ 分隔符必须含中文逗号：口播稿几乎句句用逗号，不切它就会把一整串逗号连读进标题。
 * ★ 导出是给 `scripts/backfill-traffic-title.ts` 用的：存量回填要在**脚本里**用同一条规则，
 *   复制一份过去迟早会与服务端漂移（改了这里、忘了那里）。
 */
export function localTopicTitle(copyText: string): string {
  const segs = copyText
    .split(/[。！？!?；;，,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!segs.length) return ''
  let out = ''
  for (const s of segs) {
    if ((out + s).length > TOPIC_TITLE_MAX) break
    out += s
    if (out.length >= TOPIC_TITLE_MAX) break
  }
  // 第一句本身就超长（整段没有逗号的长句）⇒ 退回截断它
  // ★ `segs[0] ?? ''`：本仓开了 noUncheckedIndexedAccess，上面的 length 检查**不能**让 TS 收窄下标访问
  const head = segs[0] ?? ''
  return clipTopicTitle(out || head)
}

/**
 * 解析话题稿（流量型）的模型返回：期望 `{"title":"≤8字","copy":"正文"}`。
 *
 * ★ 这个函数**绝不抛错**。模型没守 JSON 格式是常事，此时退化成
 *   「整段当正文 + 标题取正文第一句」—— 用户拿到的是一条有名字、能念的稿子，
 *   而不是一个报错，也不是「未命名创作」。与 `publish-material` 的 `parseMaterial`
 *   同一策略（那边解析不出来也是走 `localTitle` / `localCaption`）。
 *
 * ★ 不复用上面的 `extractJson`：它**优先抠 `[]`**（那是为分镜数组写的），
 *   而这里的正文一旦出现方括号（例如 `[话题]`）就会被切错位置。
 *   本函数只要对象，就只找最外层的一对花括号。
 */
export function parseTopicCopy(raw: string): { title: string; copy: string } {
  const s = raw.trim()
  const objS = s.indexOf('{')
  const objE = s.lastIndexOf('}')
  const candidates = objS >= 0 && objE > objS ? [s, s.slice(objS, objE + 1)] : [s]
  /** 见过「是 JSON、但 copy 是空的」—— 见下面的分支，它**不能**退化成「把 JSON 壳当正文」 */
  let sawJsonWithoutCopy = false
  for (const c of candidates) {
    let o: Record<string, unknown>
    try {
      o = JSON.parse(c) as Record<string, unknown>
    } catch {
      continue // 换下一个候选
    }
    const copy = typeof o.copy === 'string' ? o.copy.trim() : ''
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    if (copy) return { title: title ? clipTopicTitle(title) : localTopicTitle(copy), copy }
    sawJsonWithoutCopy = true
  }
  /**
   * ★ 结构对、正文缺（模型回了 `{"title":…,"copy":""}`）⇒ 返回**空正文**，
   *   交给 `generateCopy` 走「不写库」的分支。若这里退回 `copy: s`，
   *   落进库的就是那串 JSON 壳 —— 用户会在文案编辑框里看到 `{"title":…}`，比留空更糟。
   */
  if (sawJsonWithoutCopy) return { title: '', copy: '' }
  // 整段就不是 JSON（模型没守格式）⇒ 当纯文本用，标题从它开头取
  return { title: localTopicTitle(s), copy: s }
}

export async function generateShots(
  prisma: PrismaClient,
  gateway: AiGateway,
  merchantId: bigint,
  creationId: bigint,
  requestId: string,
  complexity?: Complexity,
): Promise<StoryboardResult> {
  // v5：订阅是使用分镜生成的硬前提
  await requireSubscription(prisma, merchantId, '分镜生成')
  await getCreation(prisma, merchantId, creationId)

  const current = await prisma.creation.findUnique({ where: { id: creationId }, select: { complexity: true } })
  const finalComplexity: Complexity =
    complexity ?? (isComplexity(current?.complexity) ? current!.complexity : DEFAULT_COMPLEXITY)
  if (current?.complexity !== finalComplexity) {
    await prisma.creation.update({ where: { id: creationId }, data: { complexity: finalComplexity } })
  }

  const vars = await buildVariables(prisma, creationId, { complexity: finalComplexity })
  const r = await runBilledScene(prisma, gateway, {
    sceneCode: SCENE_STORYBOARD,
    merchantId,
    requestId,
    variables: vars,
    bizId: String(creationId),
  })

  let parsed = false
  let shots: Shot[] = []
  let raw: string | undefined
  if (r.text) {
    raw = r.text
    try {
      const parsedBody = JSON.parse(extractJson(r.text))
      const arr: unknown[] = Array.isArray(parsedBody)
        ? parsedBody
        : Array.isArray((parsedBody as { shots?: unknown[] }).shots)
          ? (parsedBody as { shots: unknown[] }).shots
          : []
      // 镜头库 code → id，用于把 AI 选中的拍摄手法落库
      // ★ 解析出空数组 ≠ 生成成功。
      //
      // 模型完全可能返回合法 JSON 却没有分镜（`{}`、`{"shots":[]}`，
      // 或只写了一段解释而没给数组）。旧写法对这种输入照样往下走：先
      // `deleteMany` 清空库里已有分镜，再循环 0 次，最后**仍然 `parsed = true`**
      // ⇒ 前端 `!br.parsed || br.shots.length === 0` 判定「分镜没生成」，
      // 而那条创作**原本好好的分镜已经被清空**：一次白扣积分 + 静默丢数据。
      // 现在：空数组直接判失败，并且**在删之前**就退出，库里已有分镜原样保留。
      if (arr.length === 0) throw new Error('分镜数组为空')

      const libs = await prisma.shotLibrary.findMany({
        where: { enabled: true },
        select: { id: true, code: true },
      })
      const libMap = new Map(libs.map((l) => [l.code, l.id]))
      // ★★ 「AI 结果的首次应用」必须是**一次且仅一次**的，并且与分镜删建同事务。
      //
      //   反面教材（原实现）：只要走到这里就无条件 `deleteMany` + 重建。
      //   AI 账务层对同一 requestId 会正确返回**缓存结果**（不重复扣费），
      //   但调用方照样重建 —— 于是「首次成功后用户改了分镜、绑了素材，
      //   再由于网络重试等原因重放同一个 requestId」会把用户的所有编辑**静默清空**。
      //   更糟的是它看起来完全成功：返回了 shots、扣费也是幂等的。
      //
      //   判据 = creation 上的两列标记，用「AI 请求的认领时刻」做单调排序键：
      //     · applied_at 为空              → 从没应用过（含崩溃恢复）  ⇒ 应用
      //     · applied_at < 本次认领时刻     → 本次结果更新            ⇒ 应用（重新生成）
      //     · applied_at >= 本次认领时刻    → 就是同一次结果的重放     ⇒ 跳过，原样返回现有分镜
      //   同一 requestId 的认领时刻恒定不变，所以重放永远命中第三条；
      //   而「迟到的旧 requestId 重放」因为认领时刻早于最新一次应用，同样会跳过 ——
      //   顺带把「旧结果覆盖新分镜」这条竞态也一并堵上。
      const applyShots = (force: boolean) =>
        prisma.$transaction(async (tx) => {
          if (!force) {
            const claim = await tx.creation.updateMany({
              where: {
                id: creationId,
                OR: [{ storyboardAppliedAt: null }, { storyboardAppliedAt: { lt: r.requestClaimedAt } }],
              },
              data: { storyboardAppliedRequestId: requestId, storyboardAppliedAt: r.requestClaimedAt },
            })
            if (claim.count === 0) return false
          } else {
            await tx.creation.update({
              where: { id: creationId },
              data: { storyboardAppliedRequestId: requestId, storyboardAppliedAt: r.requestClaimedAt },
            })
          }

          await tx.shot.deleteMany({ where: { creationId } })
          let seq = 0
          for (const item of arr) {
            seq++
            const it = item as Record<string, unknown>
            const libCode = typeof it.libraryCode === 'string' ? it.libraryCode.trim() : ''
            const libId =
              libMap.get(libCode) ??
              (it.libraryShotId !== undefined && it.libraryShotId !== null ? BigInt(String(it.libraryShotId)) : null)
            await tx.shot.create({
              data: {
                creationId,
                seq: typeof it.seq === 'number' && it.seq > 0 ? it.seq : seq,
                shotType: str(it.shotType),
                shotSize: str(it.shotSize),
                durationSuggest: num(it.durationSuggest),
                line: str(it.line),
                visualReq: str(it.visualReq),
                libraryShotId: libId,
                status: 'PENDING',
              },
            })
          }
          return true
        })
      const applied = await applyShots(false)
      if (!applied) {
        console.log(
          `[storyboard] requestId=${requestId} 的结果此前已应用过（或已有更新的一次生成），` +
            `保留现有分镜不做重建 creation=${creationId}`,
        )
        // 例外：标记说「已应用」，但库里一条分镜都没有（历史脏数据 / 被清过）。
        // 此时没有任何用户编辑需要保护，而返回 0 条分镜会让前端认定「分镜没生成」、
        // 用户卡在这一步走不动。所以补建一次。
        const existing = await prisma.shot.count({ where: { creationId } })
        if (existing === 0) {
          console.warn(`[storyboard] creation=${creationId} 已标记应用但分镜为空，补建一次`)
          await applyShots(true)
        }
      }
      // 无论是否重建，都返回**当前**的分镜：跳过重建时这正是用户的编辑结果
      parsed = true
      shots = await prisma.shot.findMany({ where: { creationId }, orderBy: { seq: 'asc' } })
    } catch {
      parsed = false
      // 失败时把库里**现有**的分镜一并返回（而不是空数组）：
      // 一是调用方能区分「这次没生成出新分镜」与「这条创作一条分镜都没有」；
      // 二是前端提示可以据此说清「原有分镜未受影响」，不让用户以为全丢了。
      shots = await prisma.shot
        .findMany({ where: { creationId }, orderBy: { seq: 'asc' } })
        .catch(() => [])
    }
  }
  return {
    shots,
    raw,
    parsed,
    beanCharged: r.beanCharged,
    balance: r.balance,
    duplicated: r.duplicated,
    isFallbackTemplate: r.isFallbackTemplate,
    complexity: finalComplexity,
    complexityLabel: COMPLEXITIES[finalComplexity].label,
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}

/** 编辑单个分镜的脚本内容（景别/时长/台词/画面要求），不改素材绑定 */
export async function updateShotContent(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
  shotId: bigint,
  input: {
    shotType?: string | null
    shotSize?: string | null
    durationSuggest?: number | null
    line?: string | null
    visualReq?: string | null
  },
) {
  await getCreation(prisma, merchantId, creationId)
  const data: {
    shotType?: string | null
    shotSize?: string | null
    durationSuggest?: number | null
    line?: string | null
    visualReq?: string | null
  } = {}
  if (input.shotType !== undefined) data.shotType = input.shotType
  if (input.shotSize !== undefined) data.shotSize = input.shotSize
  if (input.durationSuggest !== undefined) data.durationSuggest = input.durationSuggest
  if (input.line !== undefined) data.line = input.line
  if (input.visualReq !== undefined) data.visualReq = input.visualReq
  if (Object.keys(data).length === 0) {
    const s = await prisma.shot.findFirst({ where: { id: shotId, creationId } })
    if (!s) throw new ShotNotFoundError()
    return s
  }
  const upd = await prisma.shot.updateMany({ where: { id: shotId, creationId }, data })
  if (upd.count === 0) throw new ShotNotFoundError()
  return prisma.shot.findUnique({ where: { id: shotId } })
}

export async function updateShotAsset(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
  shotId: bigint,
  input: { assetId?: bigint; trimStartMs?: number; trimEndMs?: number; skipped?: boolean },
) {
  const creation = await getCreation(prisma, merchantId, creationId)
  // 越权防护：shot 必须属于当前 creation（否则可改到他人创作的分镜）
  if (input.assetId !== undefined) {
    const asset = await prisma.mediaAsset.findFirst({ where: { id: input.assetId, merchantId, storeId: creation.storeId, deletedAt: null } })
    if (!asset) throw new CreationAssetMismatchError()
  }
  /**
   * `assetId` 与 `skipped` 是**互斥**的两态：一个分镜要么有素材，要么被明确跳过，不该同时成立。
   * 两个方向都要在这里收口，否则会出现「传完素材却发现它还挂着跳过标记」——
   * 那时合成页会把这个分镜当成已跳过而**静默丢掉**，用户传了素材却看不到它出现在成片里。
   */
  const data: {
    assetId?: bigint | null
    trimStartMs?: number
    trimEndMs?: number | null
    skipped?: boolean
  } = {}
  if (input.skipped === true) {
    // 跳过 = 放弃该分镜的素材：清空素材与裁剪区间，并把互斥位立起来
    data.assetId = null
    data.trimStartMs = 0
    data.trimEndMs = null
    data.skipped = true
  } else {
    if (input.skipped === false) data.skipped = false
    if (input.assetId !== undefined) {
      data.assetId = input.assetId
      data.trimStartMs = input.trimStartMs ?? 0
      data.trimEndMs = input.trimEndMs ?? null
      // 传了新素材 ⇒ 这个分镜不再算跳过（用户改主意了）
      data.skipped = false
    } else if (input.trimStartMs !== undefined || input.trimEndMs !== undefined) {
      // 只调裁剪区间时不动 assetId（原实现无条件写 assetId，会把素材抹掉）
      if (input.trimStartMs !== undefined) data.trimStartMs = input.trimStartMs
      if (input.trimEndMs !== undefined) data.trimEndMs = input.trimEndMs
    }
  }
  if (Object.keys(data).length === 0) {
    // 空 patch：只做归属校验后回读，语义与原实现一致（不写库）
    const cur = await prisma.shot.findFirst({ where: { id: shotId, creationId } })
    if (!cur) throw new ShotNotFoundError()
    return cur
  }
  const upd = await prisma.shot.updateMany({
    where: { id: shotId, creationId },
    data,
  })
  if (upd.count === 0) throw new ShotNotFoundError()
  const shot = await prisma.shot.findUnique({ where: { id: shotId } })
  if (!shot) throw new ShotNotFoundError()
  return shot
}
