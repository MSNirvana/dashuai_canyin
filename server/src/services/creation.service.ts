// 创作服务：把「门店/菜品上下文」喂给 AI 网关生成文案与分镜，并持久化分镜
// 计费通过 runBilledScene 内部完成（文案 5 豆 / 分镜 10 豆），这里只负责上下文与落库
import type { PrismaClient, Shot } from '@prisma/client'
import type { AiGateway } from '../ai/gateway.js'
import { runBilledScene, ScenePendingError } from '../ai/ai.service.js'
import { BeanNotEnoughError } from '../bean/bean.service.js'
import { requireSubscription } from './subscription.service.js'
import * as mediaSvc from './media.service.js'
import { generateVideoCover, coverKeyForVideoKey } from '../lib/thumbnail.js'
import { isLocalStorage, localPathForKey } from '../lib/local-storage.js'
import { SCENE } from '../ai/scene-codes.js'

export const SCENE_COPY = SCENE.copy_generate
export const SCENE_STORYBOARD = SCENE.storyboard_generate

/** 文案四款：流量款 / 介绍款 / 质量款 / 种草型，各自对应一个可在后台配置提示词的 AI 场景 */
export const COPY_TRACKS = {
  TRAFFIC: { label: '流量款', scene: SCENE.copy_traffic, desc: '同城引流 / 话题热度' },
  INTRO: { label: '介绍款', scene: SCENE.copy_intro, desc: '菜品讲解 / 套餐推广' },
  QUALITY: { label: '质量款', scene: SCENE.copy_quality, desc: '食材品质 / 匠心人设' },
  RECOMMEND: { label: '种草型', scene: SCENE.copy_recommend, desc: '真实体验 / 消费决策' },
} as const
export type CopyTrack = keyof typeof COPY_TRACKS
export const DEFAULT_COPY_TRACK: CopyTrack = 'TRAFFIC'

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

export interface CreateCreationInput {
  storeId: bigint
  dishId?: bigint
  title?: string
  track?: CopyTrack
  complexity?: Complexity
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

export async function listCreations(
  prisma: PrismaClient,
  merchantId: bigint,
  storeId?: bigint,
  opts: { archived?: boolean } = {},
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
      shots: { select: { assetId: true } },
      renderTasks: { select: { status: true }, orderBy: { id: 'desc' }, take: 1 },
    },
  })
  // 附带中文标签与**服务端算好的进度字段**；原始 shots / renderTasks 数组不下发
  return rows.map((r) => {
    const { shots, renderTasks, ...rest } = r
    return {
      ...rest,
      shotsTotal: shots.length,
      shotsReady: shots.filter((s) => s.assetId !== null).length,
      renderStatus: renderTasks[0]?.status ?? null,
      trackLabel: isCopyTrack(r.track) ? COPY_TRACKS[r.track].label : null,
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
  const store = await prisma.store.findFirst({
    where: { id: input.storeId, merchantId, deletedAt: null },
  })
  if (!store) throw new CreationStoreMismatchError()
  if (input.dishId !== undefined) {
    const dish = await prisma.dish.findFirst({
      where: { id: input.dishId, storeId: input.storeId, store: { merchantId, deletedAt: null }, deletedAt: null },
      select: { id: true },
    })
    if (!dish) throw new CreationDishMismatchError()
  }
  return prisma.creation.create({
    data: {
      merchantId,
      storeId: input.storeId,
      dishId: input.dishId,
      title: input.title,
      track: input.track ?? DEFAULT_COPY_TRACK,
      complexity: input.complexity ?? DEFAULT_COMPLEXITY,
    },
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
    ...c,
    trackLabel: isCopyTrack(c.track) ? COPY_TRACKS[c.track].label : null,
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
      dish: true,
    },
  })
  if (!c) throw new CreationNotFoundError()
  const track = opts.track ?? (isCopyTrack(c.track) ? c.track : DEFAULT_COPY_TRACK)
  const complexity = opts.complexity ?? (isComplexity(c.complexity) ? c.complexity : DEFAULT_COMPLEXITY)
  return {
    storeName: c.store.name,
    storeIntro: c.store.intro ?? '',
    category: c.store.category ?? '',
    city: c.store.city ?? '',
    dishName: c.dish?.name ?? '',
    dishIntro: c.dish?.intro ?? '',
    sellingPoints: c.dish?.sellingPoints ?? '',
    persona: formatPersona(c.store.persona),
    copyText: c.copyText ?? '',
    track,
    trackLabel: COPY_TRACKS[track].label,
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

  // 未指定款式时沿用创作上已保存的款式（默认流量款）
  const current = await prisma.creation.findUnique({ where: { id: creationId }, select: { track: true } })
  const finalTrack: CopyTrack = track ?? (isCopyTrack(current?.track) ? current!.track : DEFAULT_COPY_TRACK)
  const sceneCode = await resolveCopyScene(prisma, finalTrack)
  if (current?.track !== finalTrack) {
    await prisma.creation.update({ where: { id: creationId }, data: { track: finalTrack } })
  }

  const vars = await buildVariables(prisma, creationId, { track: finalTrack })
  const r = await runBilledScene(prisma, gateway, {
    sceneCode,
    merchantId,
    requestId,
    variables: vars,
    bizId: String(creationId),
  })
  if (!r.isFallbackTemplate && r.text) {
    await prisma.creation.update({ where: { id: creationId }, data: { copyText: r.text } })
  }
  return {
    text: r.text,
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
  const data: { copyText?: string; title?: string; track?: string; complexity?: string } = {}
  if (input.copyText !== undefined) data.copyText = input.copyText
  if (input.title !== undefined) data.title = input.title
  if (input.track !== undefined) data.track = input.track
  if (input.complexity !== undefined) data.complexity = input.complexity
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
      const libs = await prisma.shotLibrary.findMany({
        where: { enabled: true },
        select: { id: true, code: true },
      })
      const libMap = new Map(libs.map((l) => [l.code, l.id]))
      await prisma.$transaction(async (tx) => {
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
      })
      parsed = true
      shots = await prisma.shot.findMany({ where: { creationId }, orderBy: { seq: 'asc' } })
    } catch {
      parsed = false
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
  input: { assetId?: bigint; trimStartMs?: number; trimEndMs?: number },
) {
  const creation = await getCreation(prisma, merchantId, creationId)
  // 越权防护：shot 必须属于当前 creation（否则可改到他人创作的分镜）
  if (input.assetId !== undefined) {
    const asset = await prisma.mediaAsset.findFirst({ where: { id: input.assetId, merchantId, storeId: creation.storeId, deletedAt: null } })
    if (!asset) throw new CreationAssetMismatchError()
  }
  const upd = await prisma.shot.updateMany({
    where: { id: shotId, creationId },
    data: {
      assetId: input.assetId,
      trimStartMs: input.trimStartMs ?? 0,
      trimEndMs: input.trimEndMs,
    },
  })
  if (upd.count === 0) throw new ShotNotFoundError()
  const shot = await prisma.shot.findUnique({ where: { id: shotId } })
  if (!shot) throw new ShotNotFoundError()
  return shot
}
