import type { Prisma, PrismaClient } from '@prisma/client'

export class DishStoreMismatchError extends Error {
  readonly code = 'DISH_STORE_MISMATCH'
  constructor(message = '菜品不属于该门店') { super(message); this.name = 'DishStoreMismatchError' }
}

/**
 * 菜单资产的两种类型。
 * ★ 套餐复用 dish 表（不是另建一张 combo 表），理由见 schema.prisma 的 `Dish.kind` 注释 ——
 *   核心是 Creation.dishId 已经指向 dish，「创作时选套餐」于是不需要新增任何链路。
 */
export const DISH_KIND_SINGLE = 'SINGLE'
export const DISH_KIND_COMBO = 'COMBO'
export type DishKind = typeof DISH_KIND_SINGLE | typeof DISH_KIND_COMBO

export function isDishKind(v: unknown): v is DishKind {
  return v === DISH_KIND_SINGLE || v === DISH_KIND_COMBO
}

/** 一个套餐最多包含多少样（够「四菜一汤 + 主食」这类组合，又拦住把整本菜单塞进一个套餐） */
const MAX_COMBO_ITEMS = 30
/** 单样最多几份 */
const MAX_COMBO_QUANTITY = 99
/** 价格上限 100 万元（分）。防手抖多敲几位 —— `8888888888` 会让划线价看起来很荒诞 */
const MAX_PRICE_FEN = 100_000_000

export interface DishMediaInput { type: 'IMAGE' | 'VIDEO'; cosKey: string; coverKey?: string; sort?: number }
export interface DishComboItemInput { dishId: bigint; quantity?: number; sort?: number }
export interface DishInput {
  name: string
  intro?: string
  sellingPoints?: string
  coverKey?: string
  videoKey?: string
  sort?: number
  media?: DishMediaInput[]
  kind?: DishKind
  priceFen?: number
  /** `null` = **显式清空**划线价（用户把原价删掉），`undefined` = 没提这件事（沿用库里已有的） */
  originalPriceFen?: number | null
  /** `[]` = 清空明细，`undefined` = 沿用库里的明细。两者语义不同，别用 `?? []` 混掉 */
  comboItems?: DishComboItemInput[]
}

export async function ensureStoreOwned(prisma: PrismaClient, merchantId: bigint, storeId: bigint) {
  const store = await prisma.store.findFirst({ where: { id: storeId, merchantId, deletedAt: null }, select: { id: true } })
  if (!store) throw new DishStoreMismatchError('门店不存在或无权访问')
}

async function validateMedia(prisma: PrismaClient, merchantId: bigint, storeId: bigint, media: DishMediaInput[]) {
  if (media.filter((m) => m.type === 'IMAGE').length > 3 || media.filter((m) => m.type === 'VIDEO').length > 3) throw new DishStoreMismatchError('图片和视频分别最多上传 3 个')
  const keys = [...new Set(media.map((m) => m.cosKey))]
  if (!keys.length) return
  const assets = await prisma.mediaAsset.findMany({ where: { merchantId, storeId, cosKey: { in: keys }, status: 'READY', deletedAt: null }, select: { cosKey: true, type: true } })
  if (assets.length !== keys.length) throw new DishStoreMismatchError('存在无效或不属于当前门店的媒体')
  for (const item of media) if (!assets.some((a) => a.cosKey === item.cosKey && a.type === item.type)) throw new DishStoreMismatchError('媒体类型或归属无效')
}

/**
 * 校验并归一化「套餐」这一侧的入参：价格 + 明细。
 *
 * 为什么单菜要**清空**价格与明细而不是原样保存：
 *   `kind` 是唯一事实来源。若允许单菜带着一组价格躺在库里，那是**没有任何读取方**的死数据 ——
 *   用户填了、界面也认了，但 AI 变量与菜单展示都不会用它，属于「看起来生效、实际无效」的静默失效。
 *   所以切回单菜时由服务端兜底清干净；前端切类型时也会同步清空本地表单（避免用户白填一遍）。
 *
 * ★ 明细不存菜名快照：菜名改了，套餐里跟着改（见 schema.prisma 的注释）。
 */
async function normalizeCombo(
  prisma: PrismaClient,
  storeId: bigint,
  kind: DishKind,
  priceFen: number | undefined,
  originalPriceFen: number | null | undefined,
  items: DishComboItemInput[] | undefined,
): Promise<{ priceFen: number | null; originalPriceFen: number | null; items: Array<{ dishId: bigint; quantity: number; sort: number }> }> {
  if (kind !== DISH_KIND_COMBO) return { priceFen: null, originalPriceFen: null, items: [] }

  if (priceFen === undefined || priceFen === null || !Number.isInteger(priceFen) || priceFen <= 0) throw new DishStoreMismatchError('套餐需要填写套餐价')
  if (priceFen > MAX_PRICE_FEN) throw new DishStoreMismatchError('套餐价超出允许范围')
  if (originalPriceFen !== undefined && originalPriceFen !== null) {
    if (!Number.isInteger(originalPriceFen) || originalPriceFen > MAX_PRICE_FEN) throw new DishStoreMismatchError('原价超出允许范围')
    // 原价必须**严格大于**套餐价：相等或更低就不是优惠，划一条假线比不划线更伤信任
    if (originalPriceFen <= priceFen) throw new DishStoreMismatchError('原价需要高于套餐价，否则划线价没有意义')
  }

  const raw = items ?? []
  if (raw.length === 0) throw new DishStoreMismatchError('套餐至少要包含 1 道菜')
  if (raw.length > MAX_COMBO_ITEMS) throw new DishStoreMismatchError(`套餐最多包含 ${MAX_COMBO_ITEMS} 道菜`)

  // 同一道菜只留一行：要两份写 quantity=2。
  // ★ 这不是「顺便优化」—— 表上有 (combo_id, dish_id) 唯一索引，拆成两行会直接撞索引报 500。
  //   选「合并」而不是「报错」：把同一道菜点两次是很常见的误操作，
  //   用户从报错里读不出「哪两行重复了」，合并成 2 份才是他真正想表达的意思。
  const merged = new Map<string, { dishId: bigint; quantity: number }>()
  for (const it of raw) {
    const q = it.quantity ?? 1
    if (!Number.isInteger(q) || q < 1 || q > MAX_COMBO_QUANTITY) throw new DishStoreMismatchError(`份数只能是 1~${MAX_COMBO_QUANTITY} 之间的整数`)
    const key = String(it.dishId)
    const prev = merged.get(key)
    merged.set(key, { dishId: it.dishId, quantity: Math.min(MAX_COMBO_QUANTITY, (prev?.quantity ?? 0) + q) })
  }

  // 明细只能指向**本门店、未删除的单菜**。三条件缺一都会造出坏数据：
  //   ① 少了 storeId ⇒ 能把别家店的菜塞进自家套餐（越权引用）；
  //   ② 少了 kind=SINGLE ⇒ 套餐里套套餐，展示时会出现「套餐 A 包含 套餐 B」且换算不出总份数；
  //   ③ 少了 deletedAt=null ⇒ 引用一道已删的菜，用户看到套餐里少一样却查不出为什么。
  const ids = [...merged.values()].map((v) => v.dishId)
  const rows = await prisma.dish.findMany({
    where: { id: { in: ids }, storeId, deletedAt: null, kind: DISH_KIND_SINGLE },
    select: { id: true },
  })
  const found = new Set(rows.map((r) => String(r.id)))
  if (ids.some((id) => !found.has(String(id)))) throw new DishStoreMismatchError('套餐里只能选本门店的菜品（不能选套餐本身，也不能选已删除的菜）')

  return {
    priceFen,
    originalPriceFen: originalPriceFen ?? null,
    items: [...merged.values()].map((v, i) => ({ dishId: v.dishId, quantity: v.quantity, sort: i })),
  }
}

/**
 * 读菜品时统一带上媒体与套餐明细。
 * 写成函数而不是共享常量：Prisma 的 include 字面量需要**上下文类型**才能把 'asc' 收窄成枚举，
 * 共享一个常量反而要到处补 `as const`，还容易漏。
 * 明细里的 `dish.deletedAt: null` 过滤是刻意的兜底：即便有历史数据指向了后来被软删的菜，
 * 展示层也不该把它算进套餐内容（否则套餐会凭空少一样东西，且前端无法解释）。
 */
function dishInclude(): Prisma.DishInclude {
  return {
    media: { orderBy: [{ type: 'asc' }, { sort: 'asc' }] },
    comboItems: {
      where: { dish: { deletedAt: null } },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      include: { dish: { select: { name: true, coverKey: true } } },
    },
  }
}

/**
 * 出参归一化。
 * ★ `String(...)` 不是为了好看：BigInt 不能被 JSON.stringify 序列化（会抛
 *   `TypeError: Do not know how to serialize a BigInt`），而这里每个 id 都要进响应体。
 *   套餐明细是**嵌套**的 BigInt，所以它得单独走一遍 —— 只转最外层 id 会漏。
 */
function normalizeDish(d: any) {
  const media = d.media?.length ? d.media : [
    ...(d.coverKey ? [{ type: 'IMAGE', cosKey: d.coverKey, coverKey: null, sort: 0 }] : []),
    ...(d.videoKey ? [{ type: 'VIDEO', cosKey: d.videoKey, coverKey: null, sort: 0 }] : []),
  ]
  const comboItems = (d.comboItems ?? []).map((it: any) => ({
    id: String(it.id),
    dishId: String(it.dishId),
    quantity: it.quantity,
    sort: it.sort,
    // 带上菜名/封面，小程序才能直接渲染「套餐包含：宫保鸡丁 ×1」而不用再查一次
    name: it.dish?.name ?? '',
    coverKey: it.dish?.coverKey ?? null,
  }))
  return {
    ...d,
    id: String(d.id),
    kind: d.kind ?? DISH_KIND_SINGLE,
    priceFen: d.priceFen ?? null,
    originalPriceFen: d.originalPriceFen ?? null,
    comboItems,
    media: media.map((m: any) => ({ ...m, id: m.id ? String(m.id) : undefined })),
  }
}

export async function listDishes(prisma: PrismaClient, merchantId: bigint, storeId: bigint) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const rows = await prisma.dish.findMany({ where: { storeId, deletedAt: null }, orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }], include: dishInclude() })
  return rows.map(normalizeDish)
}

export async function getDish(prisma: PrismaClient, merchantId: bigint, storeId: bigint, dishId: bigint) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const row = await prisma.dish.findFirst({ where: { id: dishId, storeId, deletedAt: null }, include: dishInclude() })
  return row ? normalizeDish(row) : null
}

async function replaceMedia(prisma: PrismaClient, dishId: bigint, media: DishMediaInput[]) {
  await prisma.dishMedia.deleteMany({ where: { dishId } })
  if (media.length) await prisma.dishMedia.createMany({ data: media.map((m, i) => ({ dishId, type: m.type, cosKey: m.cosKey, coverKey: m.coverKey, sort: m.sort ?? i })) })
}

async function replaceComboItems(prisma: PrismaClient, comboId: bigint, items: Array<{ dishId: bigint; quantity: number; sort: number }>) {
  // 整体替换（先删后插）而不是逐条 diff：明细是无标识的从属数据，
  // diff 要处理「删了哪条、加了哪条、改了份数」，而用户关心的是最终组合是什么。
  await prisma.dishComboItem.deleteMany({ where: { comboId } })
  if (items.length) await prisma.dishComboItem.createMany({ data: items.map((it, i) => ({ comboId, dishId: it.dishId, quantity: it.quantity, sort: it.sort ?? i })) })
}

export async function createDish(prisma: PrismaClient, merchantId: bigint, storeId: bigint, input: DishInput) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const media = input.media ?? []
  await validateMedia(prisma, merchantId, storeId, media)
  const kind: DishKind = input.kind ?? DISH_KIND_SINGLE
  const combo = await normalizeCombo(prisma, storeId, kind, input.priceFen, input.originalPriceFen, input.comboItems)
  const images = media.filter((m) => m.type === 'IMAGE').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const videos = media.filter((m) => m.type === 'VIDEO').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const dish = await prisma.dish.create({
    data: {
      storeId, name: input.name, intro: input.intro, sellingPoints: input.sellingPoints,
      coverKey: images[0]?.cosKey ?? input.coverKey, videoKey: videos[0]?.cosKey ?? input.videoKey,
      sort: input.sort ?? 0, kind, priceFen: combo.priceFen, originalPriceFen: combo.originalPriceFen,
    },
  })
  await replaceMedia(prisma, dish.id, media)
  await replaceComboItems(prisma, dish.id, combo.items)
  // 回读而不是把上面那点数据拼回去：只有走一次带 dishInclude() 的查询，
  // 响应里的 comboItems 才与「下次读它」得到的结果完全一致（否则保存后前端会看到明细是空的）。
  const saved = await prisma.dish.findUnique({ where: { id: dish.id }, include: dishInclude() })
  return normalizeDish(saved!)
}

export async function updateDish(prisma: PrismaClient, merchantId: bigint, storeId: bigint, dishId: bigint, input: DishInput) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const existing = await prisma.dish.findFirst({ where: { id: dishId, storeId, deletedAt: null } })
  if (!existing) return null
  const media = input.media ?? []
  await validateMedia(prisma, merchantId, storeId, media)
  // ★ 不传 kind 就沿用库里的类型，而不是默认成 SINGLE ——
  //   否则「只想改个名字」的老客户端（或不带 kind 的调用方）会把一个套餐**静默降级成单菜**，
  //   连带价格和明细一起被清掉。
  const kind: DishKind = input.kind ?? (isDishKind(existing.kind) ? existing.kind : DISH_KIND_SINGLE)

  /**
   * 「没提这件事」与「要求清空」必须分开处理，否则两件事都做不了：
   *   · `priceFen` / `comboItems` 用 `undefined` 表示**没提** ⇒ 沿用库里已有的。
   *     若把「没提」直接判失败（套餐价必填），一个只想改菜名的调用方会收到
   *     「套餐需要填写套餐价」——它根本不知道自己在提交价格；若把「没提」当成空数组，
   *     那一次改名就会把整个套餐的组成抹掉。
   *   · `originalPriceFen` 的 `null` 表示**显式清空**划线价（用户在编辑页把原价删掉了）。
   *     没有这个出口的话，原价一旦填过就永远删不掉（`undefined` 会沿用旧值）。
   * 注意 fallback 只在「库里本来就是套餐」时生效：从单菜升级成套餐时没有可沿用的东西，
   * 该报「套餐需要填写套餐价」就报。
   */
  const wasCombo = existing.kind === DISH_KIND_COMBO
  const priceInput = input.priceFen ?? (wasCombo ? existing.priceFen ?? undefined : undefined)
  const originalInput = input.originalPriceFen === undefined ? (wasCombo ? existing.originalPriceFen ?? null : null) : input.originalPriceFen
  const itemsInput = input.comboItems === undefined
    ? (wasCombo
      ? (await prisma.dishComboItem.findMany({
        where: { comboId: dishId },
        orderBy: [{ sort: 'asc' }, { id: 'asc' }],
        select: { dishId: true, quantity: true, sort: true },
      })).map((i) => ({ dishId: i.dishId, quantity: i.quantity, sort: i.sort }))
      : undefined)
    : input.comboItems

  const combo = await normalizeCombo(prisma, storeId, kind, priceInput, originalInput, itemsInput)
  const images = media.filter((m) => m.type === 'IMAGE').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const videos = media.filter((m) => m.type === 'VIDEO').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const dish = await prisma.dish.update({
    where: { id: dishId },
    data: {
      name: input.name, intro: input.intro, sellingPoints: input.sellingPoints,
      coverKey: images[0]?.cosKey ?? input.coverKey ?? null, videoKey: videos[0]?.cosKey ?? input.videoKey ?? null,
      sort: input.sort ?? existing.sort, kind, priceFen: combo.priceFen, originalPriceFen: combo.originalPriceFen,
    },
  })
  await replaceMedia(prisma, dishId, media)
  await replaceComboItems(prisma, dishId, combo.items)
  const saved = await prisma.dish.findUnique({ where: { id: dish.id }, include: dishInclude() })
  return normalizeDish(saved!)
}

export async function deleteDish(prisma: PrismaClient, merchantId: bigint, storeId: bigint, dishId: bigint) {
  await ensureStoreOwned(prisma, merchantId, storeId)
  const dish = await prisma.dish.findFirst({ where: { id: dishId, storeId, deletedAt: null } })
  if (!dish) return false
  /**
   * ★ 被套餐引用的菜**不许直接删**，必须先把它从套餐里摘掉。
   *
   * 删掉是一句话的事，但套餐那边是**静默**受损的：明细行还在（软删不触发级联），
   * 读取时被 `dish.deletedAt: null` 过滤掉 → 用户看到套餐里少了一样东西，
   * 却没有任何提示告诉他「因为你把某道菜删了」。
   * 提示里直接给出数量，是因为用户下一步必然要问「哪个套餐」。
   */
  const usedBy = await prisma.dishComboItem.count({ where: { dishId, combo: { deletedAt: null } } })
  if (usedBy > 0) throw new DishStoreMismatchError(`该菜品已被 ${usedBy} 个套餐引用，请先从套餐里移除`)
  await prisma.dish.update({ where: { id: dishId }, data: { deletedAt: new Date() } })
  return true
}
