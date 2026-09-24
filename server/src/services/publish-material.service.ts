// 发布素材：把一条创作的口播文案，变成「能直接发出去」的三样东西 —— 标题、封面、文案。
//
// ── 链路（两步 AI，各自独立计费、独立失败）─────────────────────────────
//   ① publish_material（文本场景）：读门店/菜品上下文 + 口播文案
//        → 产出 { title, caption, coverPrompt }   ← coverPrompt 是给图像模型的画面描述
//   ② publish_cover（图像场景）：吃 ① 的 coverPrompt → 出 3:4 竖版封面
//        → 返回图床 URL（或 data URI）→ 本模块下载 → 传对象存储 → 落 cover_key
//
// ── 三个必须这样设计的点 ────────────────────────────────────────────────
//   1. **两步分开计费**：文本按 token 成本结算（沿用既有的 runBilledScene 口径），
//      出图按模型实际单张成本（返回没有 token 用量，费率来自 AiModel.unitPriceMicroFen）。
//      合成一个场景会让两笔账都算不清。
//   2. **封面失败不拖垮文本**：文案与标题是独立可用的产物。封面挂了照样把
//      标题/文案存下来，把失败原因放进 `coverError` 让用户单独重试（part='COVER'），
//      重试不会重复扣文本那笔钱。
//   3. **降级要显式**：文本场景失败时 runBilledScene 会返回兜底模板（不扣积分），
//      那不是「生成成功」。这里把它标成 `degraded`，客户端据此显示「结果不完整，可重新生成」——
//      不标记的话，用户会以为模型就这水平。
//
// ── 绑定粒度：**每个创作一份**（产品口径）─────────────────────────────────
//   所以 creation_id 是唯一键，重新生成 = 覆盖。旧封面对象**不在这里删**：
//   它被新键替换后就不再被任何行引用，交给 scripts/gc-orphan-objects.ts 按保留期回收
//   （这里有意的取舍：删除失败会让「新封面已生效、旧的还在」这种无害状态，而误删就救不回来了）。
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import type { AiGateway } from '../ai/gateway.js'
import { runBilledScene } from '../ai/ai.service.js'
import { SCENE } from '../ai/scene-codes.js'
import { buildVariables } from './creation.service.js'
import { CreationNotFoundError } from './creation.service.js'
import { requireSubscription } from './subscription.service.js'
import { uploadFile, downloadToFile } from '../lib/cos.js'
import { extractCandidateFrames, buildCoverBase } from '../lib/thumbnail.js'
import { getGeneratedPlayUrl } from './media.service.js'
import { probeClipMeta } from '../render/ffmpeg.js'
import {
  fetchImageToFile,
  makeTempDir,
  removeTempDir,
  RemoteImageError,
} from './remote-asset.service.js'

/** 标题列是 VARCHAR(120)：模型偶尔会超，超了直接插库会失败（或按 sql_mode 静默截断） */
const TITLE_MAX = 120
/** 封面提示词的落库上限（TEXT 列，这里只是防模型跑飞写进几万字） */
const COVER_PROMPT_MAX = 2000

/** 场景没建/被停用：属于部署配置问题，不是用户操作问题 */
export class PublishMaterialUnavailableError extends Error {
  constructor(message = '发布素材功能未开通') {
    super(message)
    this.name = 'PublishMaterialUnavailableError'
  }
}

/** 封面这次没生成出来。★ message 是**给用户看的**，不许带图床域名/curl 原文（见下面 catch 处） */
export class PublishCoverFailedError extends Error {
  constructor(message = '封面生成失败，请稍后重试') {
    super(message)
    this.name = 'PublishCoverFailedError'
  }
}

/**
 * 「只重出封面」但这条创作根本没有素材行 ⇒ 用户操作顺序不对，不是服务端故障。
 *
 * ★ 必须与 PublishCoverFailedError 分开：那个是**上游出图失败**（502，可以等一下再试），
 *   这个是**前置条件没满足**（400，得先去生成标题与文案）。
 *   合成一个错误类会给客户端一个无法区分的响应 —— 用户会去反复重试一个永远不会成功的操作。
 */
export class PublishMaterialNotReadyError extends Error {
  constructor(message = '还没有生成过标题与文案，请先生成一次') {
    super(message)
    this.name = 'PublishMaterialNotReadyError'
  }
}

export interface PublishMaterialView {
  creationId: string
  title: string
  caption: string
  /** 现签的封面地址（签名 URL 会过期，所以每次读接口都重签，绝不缓存到客户端）。 */
  coverUrl: string | null
  coverWidth: number | null
  coverHeight: number | null
  updatedAt: string
  /** 文本部分是兜底模板产出的（≠ 真生成）。客户端要据此提示「可重新生成」。 */
  degraded: boolean
  /** 上一次封面没生成出来时的原因（用户可见文案）；null = 没这个问题 */
  coverError: string | null
}

export interface PublishMaterialEstimate {
  /** 文本场景的单次上限（实际按 token 成本结算，恒不超过它） */
  textBeanCap: number
  /** 封面的固定价（图像场景的 bean_price 就是报价本身） */
  coverBeans: number
  /**
   * 封面选帧的单次上限（视觉场景，按 token 成本结算）。
   *
   * ★ 必须透出去：它**只有候选帧 ≥ 2 张时才会真的发生**，
   *   客户端若按 `textBeanCap + coverBeans` 报价，就会比实际扣费少算这一笔，
   *   用户看到「说好 480、扣了 1080」。
   */
  pickBeans: number
}

export interface GenerateResult {
  material: PublishMaterialView
  /** 本次实际消耗积分（文本按成本 + 封面按固定价）。失败/降级的那部分不计入。 */
  beanCharged: number
  /**
   * 是不是「重放」（同一个 requestId 的同一笔业务请求又打了一次）。
   *
   * ★ 必须透出去：重放时 `beanCharged` 报的是**当初那一次**的金额（来自 ai_call_log 快照），
   *   库里一分钱都没再动。客户端若不看这个标志，就会把「重试」显示成「又扣了一次」。
   *   与 creation.service.ts 的文案生成 / 分镜生成保持同一口径。
   */
  duplicated: boolean
  /** 给用户的一句补充说明（封面失败、或文本降级）。没有就是 null。 */
  notice: string | null
}

// ────────────────────────────── 读 ──────────────────────────────

export async function getPublishMaterial(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
): Promise<{ material: PublishMaterialView | null; estimate: PublishMaterialEstimate }> {
  await assertOwnedCreation(prisma, merchantId, creationId)
  const [row, estimate] = await Promise.all([
    prisma.creationPublishMaterial.findUnique({ where: { creationId } }),
    readEstimate(prisma),
  ])
  return { material: row ? await toView(row) : null, estimate }
}

async function readEstimate(prisma: PrismaClient): Promise<PublishMaterialEstimate> {
  const scenes = await prisma.aiScene.findMany({
    where: {
      code: { in: [SCENE.publish_material, SCENE.publish_cover_pick, SCENE.publish_cover] },
      enabled: true,
    },
    select: { code: true, beanPrice: true },
  })
  const of = (code: string) => Number(scenes.find((s) => s.code === code)?.beanPrice ?? 0)
  return {
    textBeanCap: of(SCENE.publish_material),
    pickBeans: of(SCENE.publish_cover_pick),
    coverBeans: of(SCENE.publish_cover),
  }
}

/** 从调用日志里反查这一次实际命中的模型代号（仅用于落库备注，查不到就是 null） */
async function lastModelCode(
  prisma: PrismaClient,
  merchantId: bigint,
  sceneCode: string,
  requestId: string,
): Promise<string | null> {
  const log = await prisma.aiCallLog.findFirst({
    where: { merchantId, sceneCode, requestId },
    orderBy: { id: 'desc' },
    select: { model: { select: { modelCode: true } } },
  })
  return log?.model?.modelCode ?? null
}

// ────────────────────────────── 生成 ──────────────────────────────

export async function generatePublishMaterial(
  prisma: PrismaClient,
  gateway: AiGateway,
  opts: { merchantId: bigint; creationId: bigint; requestId: string; part?: 'ALL' | 'COVER' },
): Promise<GenerateResult> {
  const { merchantId, creationId, requestId } = opts
  const part = opts.part ?? 'ALL'
  await assertOwnedCreation(prisma, merchantId, creationId)
  /**
   * ★ 订阅闸门必须在这里，和文案/分镜/合成三处一致。
   *   漏掉它不是「少收一道钱」而是**越权**：出图是真实付费能力，
   *   不订阅的商户只要能凑出一次冻结额就能出图（而冻结额是可以由运营调低的）。
   *   ★ 只在生成路径上卡，读接口 `getPublishMaterial` 不卡 ——
   *     会员到期后用户仍应能看到自己已经生成过的标题/文案/封面。
   */
  await requireSubscription(prisma, merchantId, part === 'COVER' ? '封面重试' : '发布素材生成')

  const existing = await prisma.creationPublishMaterial.findUnique({ where: { creationId } })
  // 幂等：同一个 requestId 已经产出过，直接回那一版（客户端重试/连点不会重复扣费）
  if (existing?.requestId === requestId && existing.coverKey) {
    return { material: await toView(existing), beanCharged: 0, duplicated: true, notice: null }
  }
  if (part === 'COVER' && !existing) {
    throw new PublishMaterialNotReadyError()
  }

  let beanCharged = 0
  let duplicated = false
  let degraded = false
  let notice: string | null = null

  // ── ① 文本：标题 + 文案 + 封面画面描述 ──
  let title = existing?.title ?? ''
  let caption = existing?.caption ?? ''
  let coverPrompt = existing?.coverPrompt ?? ''
  let modelCode = existing?.modelCode ?? null

  if (part === 'ALL') {
    const textScene = await prisma.aiScene.findUnique({ where: { code: SCENE.publish_material } })
    if (!textScene || !textScene.enabled) throw new PublishMaterialUnavailableError()
    const vars = await buildVariables(prisma, creationId)
    const r = await runBilledScene(prisma, gateway, {
      sceneCode: SCENE.publish_material,
      merchantId,
      requestId,
      variables: vars,
      bizId: String(creationId),
    })
    beanCharged += Number(r.beanCharged)
    duplicated = r.duplicated
    /**
     * 记下这次**真正**用的是哪个模型。
     *
     * ★ 不取 `textScene.defaultModelId`：那只是候选链的第一位，失败会往下走，
     *   实际落在哪个模型上只有 `ai_call_log` 知道（它的 `@@unique([merchantId, sceneCode, requestId])`
     *   正好把我们这一次调用唯一定位到一行）。
     * ★ 查询失败不该拖垮「素材已经生成好了」这个事实 —— 这只是备注信息，故 catch 成 null。
     */
    modelCode = await lastModelCode(prisma, merchantId, SCENE.publish_material, requestId).catch(() => null)
    // ★ 兜底模板（AI 全挂）= 不是生成成功。这里显式记账 + 显式告知，
    //   而不是把兜底文案当成模型输出悄悄存下去。
    degraded = r.isFallbackTemplate || r.text.trim() === ''
    const parsed = degraded ? null : parseMaterial(r.text)
    if (!parsed) {
      // 走到这里有两种情况：兜底模板、或模型回了没法解析的内容。两者都退到
      // 「用口播文案自己拼一版」—— 用户至少拿到能用的标题和文案，而不是一个报错。
      degraded = true
      title = localTitle(vars.copyText, vars.dishName)
      caption = localCaption(vars.copyText)
      coverPrompt = ''
    } else {
      title = parsed.title
      caption = parsed.caption || localCaption(vars.copyText)
      coverPrompt = parsed.coverPrompt
    }
    if (degraded) {
      notice = '标题与文案这次是简单拼出来的（AI 没给出可用结果），可以重新生成一次'
    }
  }

  // ── ② 封面（3:4 竖版）──
  const coverScene = await prisma.aiScene.findUnique({ where: { code: SCENE.publish_cover } })
  let coverError: string | null = null
  let coverKey = existing?.coverKey ?? null
  let coverWidth = existing?.coverWidth ?? null
  let coverHeight = existing?.coverHeight ?? null

  if (!coverScene || !coverScene.enabled) {
    // 图像通道没配好：文本成果照样保留，只把封面标为失败，用户能看到完整原因
    coverError = '封面功能未开通'
  } else {
    try {
      /**
       * ★★ 2026-09-24 起：封面底图取自**拍摄素材**，不再让模型凭空画。
       *   抽候选帧 → 视觉模型挑一张 → 以它为参考图做抖音封面设计。
       * ★ 一张候选帧都没抽到时**不报错**，退回「无参考图」的出图路径
       *   （封面模板最后一节已声明这种情形该怎么办）—— 宁可给一张能用的封面，也不要直接失败。
       */
      const frames = await collectCandidateFrames(prisma, merchantId, creationId)
      let refImage: string | undefined
      if (frames.length > 0) {
        const picked = await pickCoverFrame(prisma, gateway, { merchantId, creationId, requestId, frames })
        // ★★ 先把选中的帧在本地裁成 3:4，再把这张**已经是 3:4** 的图交给模型。
        //   少这一步，模型就会自己重新取景（拉远镜头 + 凭空补背景）—— 见 buildCoverBaseDataUri 的说明。
        // ★ 取 `baseDataUri`（高分辨率那一份）而不是给模型看的小图：
        //   出图模型实测输出约 1086×1448，底图只有 640 宽 ⇒ 它得先放大 1.7 倍再重画，
        //   真实素材的细节会被它「重新想象」掉。这一份不参与选帧 ⇒ 不额外花 token。
        refImage = await buildCoverBaseDataUri(picked.frame.baseDataUri ?? picked.frame.dataUri)
        beanCharged += picked.beans
        duplicated = duplicated || picked.duplicated
      }
      // 重出封面时可以复用上一版存下来的画面描述（省一次文本调用）
      const promptForCover = (coverPrompt || existing?.coverPrompt || '').trim() || FALLBACK_COVER_PROMPT
      const r = await runBilledScene(prisma, gateway, {
        sceneCode: SCENE.publish_cover,
        merchantId,
        // 与文本场景用不同的 requestId：两个场景是两笔独立的业务请求，
        // 共用同一个 id 只会在排查时让人误以为是同一次调用。
        requestId: `${requestId}-cover`,
        variables: { coverPrompt: promptForCover, coverTitle: title },
        // 参考图 = 图生图的底图。为空时是 undefined ⇒ 适配器回到纯文生图路径
        // （模板最后一节已说明「没有参考图时该怎么办」）。
        images: refImage ? [refImage] : undefined,
        bizId: String(creationId),
      })
      // ★★ 这里是最容易埋雷的一处：图像场景失败时，runBilledScene 会返回
      //    **兜底模板渲染出来的文字**（一段画面描述），而不是图片地址。
      //    若不加判断就往下走，那个字符串会被当成 URL 交给下载器 ——
      //    报错出现在「下载封面失败」这种离现场十万里的地方。
      //    所以只认「非兜底 + 看起来像地址」的返回。
      if (r.isFallbackTemplate) throw new PublishCoverFailedError('封面生成失败，请稍后重试')
      const materialized = await materializeCover(r.text, merchantId)
      coverKey = materialized.key
      coverWidth = materialized.width
      coverHeight = materialized.height
      // 封面单价是固定价，直接并入本次消耗
      beanCharged += Number(coverScene.beanPrice)
      duplicated = duplicated || r.duplicated
      coverPrompt = promptForCover
    } catch (e) {
      // ★ 用户可见文案与服务端日志必须分开（见 skill user-facing-error-text-layering）：
      //   RemoteImageError 里带 curl 原文与图床域名，那是第三方内部信息，
      //   直接回给用户既不友好也等于泄露上游。原文只进日志。
      const raw = (e as Error).message
      console.error(`[publish-material] 创作 ${creationId} 封面生成失败:`, raw)
      coverError = e instanceof PublishCoverFailedError ? e.message : '封面生成失败，请稍后重试'
      if (!notice) notice = '标题与文案已生成，封面暂时没出来，可以单独重试封面'
    }
  }

  // ── 落库（每个创作一份：upsert 覆盖）──
  const data = {
    merchantId,
    title: sanitizeLine(title).slice(0, TITLE_MAX),
    caption: sanitizeText(caption),
    coverKey,
    coverPrompt: coverPrompt ? coverPrompt.slice(0, COVER_PROMPT_MAX) : null,
    coverWidth,
    coverHeight,
    modelCode,
    requestId,
  }
  const row = await prisma.creationPublishMaterial.upsert({
    where: { creationId },
    create: { creationId, ...data },
    update: data,
  })

  const view = await toView(row)
  // coverError 是**本次调用**的结果，不落库：库里只有「封面在不在」这个事实，
  // 而「上次为什么失败」是一次性信息（下次成功就该消失，不该留在行里骗人）。
  return { material: { ...view, coverError }, beanCharged, duplicated, notice }
}

// ──────────────────────── 封面：抽帧 → 选帧（2026-09-24 新增） ────────────────────────
//
// 封面底图必须**来自拍摄素材**，不能由模型凭空画。这条路走三步：
//   ① 从创作的分镜里挑几个「最可能拍到主体」的镜头 → 下载素材 → 等分抽帧
//   ② 让视觉模型从候选帧里挑一张（出图模型不会比较，这一步只能它来）
//   ③ 把选中的帧作为**参考图**交给出图场景（图生图，见 adapters.ts 的 openaiImage）
//
// ★ 三步各自独立失败、独立记账：
//   抽帧失败/一张没抽到 → 跳过①②，退回「无参考图」的出图路径（模板已声明这种情形）；
//   选帧失败 → 兜底选第 0 张，绝不让整条封面链失败。
//   这与本文件开头「封面失败不拖垮文本」是同一条原则的延伸。

/**
 * 候选帧的**来源镜头上限**。
 *
 * ★ 为什么要限：每个来源镜头都要把整段素材从对象存储下载到本机再抽帧，
 *   镜头越多这一步越慢（单素材几 MB~几十 MB）。封面的目标是「挑一张好画面」，
 *   3 个镜头 × 2 帧 = 6 张候选已经够挑，再多只是让下载更慢，判断力不会更好。
 */
const MAX_SOURCE_SHOTS = 3

/** 每个来源镜头抽几帧。★ 2 而不是 1：同一镜头里也有「正好眨眼」「正好糊」的运气成分。 */
const FRAMES_PER_SHOT = 2

/**
 * 交付给视觉模型的候选帧总数上限。
 *
 * ★ 这个数字直接决定选帧那一笔的 token 成本。实测（2026-09-24，tokenbox/gpt-5.5）：
 *   · 4 张 640px 真实帧 → in=6381 token，5.6s，costFen=21
 *   · 6 张 640px 帧     → in=9991 token，19.5s，costFen=30
 *   ⇒ 单张图的固定开销约 **1.3k token**（与图大小关系不大，是中转站侧的开销）。
 *   ⚠ 早期按「单张 4,400 token」估的把 6 张算成 3 万 token，是**高估**（实测不到 1 万），
 *     所以 `ai_scene.publish_cover_pick.beanPrice` 也从 600 下调到了 300。
 */
const MAX_PICK_FRAMES = 6

/**
 * 候选帧的压缩宽度。视觉模型按图计费，640 宽足够判断「清不清晰、主体在不在」；
 * 给原图（1080+）换不来更好的判断，只会让 token 与请求体一起膨胀。
 */
const FRAME_WIDTH = 640

/**
 * 镜头类型的封面优先级：越靠前，越可能拍到「能当封面的主体画面」。
 *
 * ★ 为什么要先按镜头类型排一遍：抽帧是**等分取点**，单个镜头里抽到的往往不是精彩瞬间；
 *   而不同类型镜头的命中率差得很远 —— 特写/制作/试吃基本一定有主体，
 *   开场与收尾则常是门头、LOGO、字幕板这类根本不能当封面的画面。
 *   先按类型排序再抽帧，等于用**拍摄时就定好的意图**（`shot.shot_type`，来自分镜）
 *   先筛一遍候选：比让视觉模型从一堆空镜里硬挑可靠得多，而且不额外花钱。
 * ★ 未登记的 shotType 给中间优先级（5）：不因为「这是个新类型」就被排到最后。
 */
const COVER_SHOT_PRIORITY: Record<string, number> = {
  特写: 0,
  制作: 1,
  试吃: 2,
  卖点: 3,
  口播: 4,
  原料: 5,
  环境: 6,
  开场: 7,
  收尾: 8,
}

/** 一个候选帧：既要给视觉模型看（dataUri），也要能在提示词里说明它从哪来（label）。 */
interface CandidateFrame {
  /** 编号 —— 必须与传给视觉模型的 images 顺序严格一致（模板让模型按编号回答） */
  index: number
  /** 来源镜头在创作里的序号（1 起），只用于提示词描述 */
  shotSeq: number
  /** 该帧在**素材内**的时间点（秒） */
  atSeconds: number
  /** 压缩后的小图 data URI，直接作为 images 传给适配器（**只给模型看**，不做封面底图） */
  dataUri: string
  /**
   * **当封面底图用**的那一份 data URI：同一时间点但按 `BASE_FRAME_WIDTH` 抽的高分辨率帧。
   * ★ 它**不进选帧请求**（模型永远看不到它）⇒ 不产生任何 token 成本。
   * 读不出来时为 undefined，调用方退回 `dataUri`（等同旧行为）。
   */
  baseDataUri?: string
  /** 给模型看的一句话说明（来自分镜：这个镜头本来打算拍什么） */
  label: string
}

/**
 * 从这条创作的拍摄素材里抽出候选帧。
 *
 * 三个取舍（都是「为什么不是把所有帧都抽出来」的答案）：
 *   · 只取 `MAX_SOURCE_SHOTS` 个镜头 —— 每镜头都要下载整段素材，抽多了纯粹是慢。
 *   · 按 `COVER_SHOT_PRIORITY` 排序后取 —— 用拍摄意图先筛一遍，比让模型从空镜里硬挑可靠。
 *   · 每帧压到 `FRAME_WIDTH` —— 视觉模型的图片开销是**按张**的，压小只赚不亏。
 *
 * ★ 全程 best-effort：某个素材下载失败、某帧抽不出来都只是**少一张候选**，直接跳过。
 *   只有一张都没抽到时才返回空数组，由调用方决定降级（见 generatePublishMaterial）。
 */
async function collectCandidateFrames(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
): Promise<CandidateFrame[]> {
  const shots = await prisma.shot.findMany({
    where: { creationId, assetId: { not: null } },
    orderBy: { seq: 'asc' },
    select: { seq: true, shotType: true, assetId: true, visualReq: true },
  })
  if (shots.length === 0) return []

  const assetIds = [...new Set(shots.map((s) => s.assetId!).filter(Boolean))]
  const assets = await prisma.mediaAsset.findMany({
    // type 在库里**存大写**（见记忆里的 media_asset 约定），过滤时别再写小写
    where: { id: { in: assetIds }, merchantId, deletedAt: null, type: 'VIDEO' },
    select: { id: true, cosKey: true, durationMs: true },
  })
  const byId = new Map(assets.map((a) => [a.id, a]))

  const ranked = rankShotsForCover(shots).slice(0, MAX_SOURCE_SHOTS)

  const dir = await makeTempDir()
  const out: CandidateFrame[] = []
  try {
    for (const shot of ranked) {
      if (out.length >= MAX_PICK_FRAMES) break
      const asset = byId.get(shot.assetId!)
      if (!asset) continue
      const localVideo = join(dir, `src-${shot.seq}.mp4`)
      try {
        await downloadToFile(asset.cosKey, localVideo)
      } catch {
        continue // 单个素材读不到就跳过它，其它候选照抽
      }
      const frames = await extractCandidateFrames(localVideo, join(dir, `f-${shot.seq}`), {
        count: FRAMES_PER_SHOT,
        width: FRAME_WIDTH,
        durationMs: asset.durationMs ?? undefined,
      })
      // 同一时间点再抽一份**高分辨率**的，只留给封面底图用（见 BASE_FRAME_WIDTH）
      const baseFrames = await extractCandidateFrames(localVideo, join(dir, `b-${shot.seq}`), {
        count: FRAMES_PER_SHOT,
        width: BASE_FRAME_WIDTH,
        durationMs: asset.durationMs ?? undefined,
      })
      // ★ 按 `atSeconds` 配对，**不能按下标**：取点只由「时长 + 张数」决定，两次调用必然同点，
      //   但万一某一份少成功一张，下标配对就会整体错位 —— 那等于拿另一帧当底图，且完全不报错。
      const baseByAt = new Map(baseFrames.map((f) => [f.atSeconds, f.path]))
      for (const f of frames) {
        if (out.length >= MAX_PICK_FRAMES) break
        const dataUri = await readFrameDataUri(f.path)
        if (!dataUri) continue // 读不出图就跳过这一帧
        out.push({
          index: out.length,
          shotSeq: shot.seq,
          atSeconds: f.atSeconds,
          dataUri,
          baseDataUri: await readFrameDataUri(baseByAt.get(f.atSeconds)),
          label: describeShotForPick(shot.seq, shot.shotType, shot.visualReq),
        })
      }
    }
    return out
  } finally {
    // 临时目录里躺着下载下来的**整段素材**（几十 MB），必须删
    await removeTempDir(dir)
  }
}

/**
 * 按镜头类型的「封面命中率」重排镜头，取前 N 个。
 *
 * ★ 抽出来是为了能被守护脚本直接断言（`rankShotsForCover` 是纯函数，不碰库也不花 token）。
 *   这段排序是「选帧质量」的第一道保障，坏掉不会报错、只会让封面变差 —— 正是最需要守护的那类逻辑。
 *
 * 排序规则：
 *   · 按 `COVER_SHOT_PRIORITY`，未登记的类型给 **5（中间值）**，不因为「是个新类型」就被排到最后；
 *   · 同优先级保持**原顺序**（稳定排序）⇒ 同一批素材每次跑出来的候选完全一致，结果可复现。
 */
export function rankShotsForCover<T extends { seq: number; shotType: string | null }>(shots: T[]): T[] {
  return shots
    .map((s, i) => ({ s, i, rank: COVER_SHOT_PRIORITY[s.shotType ?? ''] ?? 5 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.s)
}

/**
 * 把一帧读成 data URI。
 * ★ 读不出来返回 undefined 而不是抛错：少一份候选/少一份高清底图都不该让封面挂掉
 *   （调用方对 `baseDataUri` 缺失有明确的退回路径）。
 */
async function readFrameDataUri(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined
  try {
    const buf = await readFile(path)
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}

/** 候选帧的说明文字：让模型知道这一帧来自哪个镜头、那个镜头原本打算拍什么 */
function describeShotForPick(seq: number, shotType: string | null, visualReq: string | null): string {
  const type = shotType?.trim() || '未标注类型'
  const req = (visualReq ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  return req ? `第${seq}个镜头（${type}）：${req}` : `第${seq}个镜头（${type}）`
}

/**
 * 让视觉模型从候选帧里挑一张当封面底图。
 *
 * ★ 为什么必须单独一次调用：出图模型**只看得到给它的那一张图**，它不会比较；
 *   而「同一批候选里哪张最好」正是最需要判断力的一步。
 * ★ 返回值**保证是一个合法下标**：模型可能回越界数字、回非数字、回一整段解释 ——
 *   任何一种都退到第 0 张（提示词里也写了「拿不准选第一张」）。
 *   选帧失败绝不能让整条封面链失败。
 * ★ 只有 1 张候选时**不发这次调用**：没有可比的对象，白花一笔钱。
 */
async function pickCoverFrame(
  prisma: PrismaClient,
  gateway: AiGateway,
  args: { merchantId: bigint; creationId: bigint; requestId: string; frames: CandidateFrame[] },
): Promise<{ frame: CandidateFrame; beans: number; duplicated: boolean }> {
  const { frames } = args
  if (frames.length <= 1) return { frame: frames[0]!, beans: 0, duplicated: false }

  const pickContext = [
    `本次共 ${frames.length} 张候选画面，编号从 0 到 ${frames.length - 1}：`,
    ...frames.map((f) => `· 编号 ${f.index}：${f.label}`),
  ].join('\n')

  const r = await runBilledScene(prisma, gateway, {
    sceneCode: SCENE.publish_cover_pick,
    merchantId: args.merchantId,
    // 与文本、出图两个场景各自用不同的 requestId：这是**第三笔**独立业务请求
    requestId: `${args.requestId}-pick`,
    variables: { pickContext },
    bizId: String(args.creationId),
    // 候选帧按编号顺序传入。★ 模板让模型「按编号回答」，这里顺序一错位就会**静默挑错帧**
    images: frames.map((f) => f.dataUri),
  })

  const picked = r.isFallbackTemplate ? null : parsePickedIndex(r.text, frames.length)
  return {
    frame: frames[picked ?? 0]!,
    beans: Number(r.beanCharged),
    duplicated: r.duplicated,
  }
}

/** 封面底图的目标尺寸（3:4）。★ 与 `AI_IMAGE_SIZE` 量级对齐，避免出图模型再放大一轮。 */
const COVER_BASE_WIDTH = 1080
const COVER_BASE_HEIGHT = 1440

/**
 * **当封面底图**的那一份抽帧宽度 = 底图目标宽。
 *
 * ★ 为什么不复用 `FRAME_WIDTH`（640）：640 只是「给模型看清楚构图」够用，
 *   但底图最终要交给一个**输出约 1086×1448** 的出图模型 —— 用 640 打底，
 *   它必须先放大 1.7 倍再重画，真实拍摄的纹理/细节就全变成它「想象」出来的了，
 *   与「封面必须来自真实画面」的初衷相反。
 * ★ 为什么不干脆把候选帧也提到 1080：候选帧是**要发给模型**的，6 张的原图会让
 *   请求体膨胀、上传变慢；而判断「清不清晰、主体在不在」根本不需要 1080。
 *   ⇒ 两份分开抽：模型看小的，底图用大的。底图那一份不花 token。
 * ★ 代价：每个来源镜头多 2 次 ffmpeg（本地，百毫秒级）+ 临时目录多几 MB。
 */
export const BASE_FRAME_WIDTH = COVER_BASE_WIDTH

/**
 * 把选中的帧**在本地裁成 3:4**，产出真正的封面底图。
 *
 * ★★ 为什么不能把原帧直接交给出图模型（2026-09-24 实测）：
 *   9:16 的原帧直接给模型、让它自己变 3:4，结果是它**拉远了镜头 + 凭空补出背景** ——
 *   因为那一帧没有留白，而提示词同时要求「主体完整」和「标题放在留白处」，
 *   模型只能靠缩主体、编背景来腾地方（用户的原话：「为什么感觉还是有拉扯感」）。
 *   定量验证：把成品与源帧做「缩放比 × 偏移」二维搜索，**最佳匹配只有约 13 dB**
 *   （同一张图应为 ∞，视觉相近 25~35）⇒ 成品像素**不是**从源帧变换来的。
 *
 * ⇒ 比例换算是几何问题，交给 ffmpeg。模型的职责只剩「在给定画面上设计标题」。
 *
 * ★ best-effort：本地裁切失败就**退回原帧**（等同于回到旧行为），
 *   绝不因为这一步让整张封面生成失败。
 *
 * ★ 导出是给 `scripts/probe-publish-cover.ts` 用的：真机体检必须走**同一段几何逻辑**，
 *   否则体检脚本自己拼一套、产品又是另一套，验的是脚本而不是产品。
 */
export async function buildCoverBaseDataUri(frameDataUri: string): Promise<string> {
  const dir = await makeTempDir('dashuai-coverbase-')
  try {
    const srcPath = join(dir, 'src.jpg')
    const outPath = join(dir, 'base.jpg')
    // dataUri 形如 data:image/jpeg;base64,xxx（见 collectCandidateFrames 的构造）
    // ★ 调用方传进来的应当是 `BaseFrameWidth` 那一份（见 BASE_FRAME_WIDTH）；
    //   传 640 的小图也能跑，只是底图会先被放大，成品细节会变糊、靠模型补。
    const comma = frameDataUri.indexOf(',')
    if (comma < 0) return frameDataUri
    await writeFile(srcPath, Buffer.from(frameDataUri.slice(comma + 1), 'base64'))
    const ok = await buildCoverBase(srcPath, outPath, {
      width: COVER_BASE_WIDTH,
      height: COVER_BASE_HEIGHT,
    })
    if (!ok) return frameDataUri
    const buf = await readFile(outPath)
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  } catch {
    return frameDataUri
  } finally {
    await removeTempDir(dir)
  }
}

/**
 * 从模型返回里抠出合法下标；抠不出或越界都返回 null（调用方退到第 0 张）。
 *
 * ★ 导出是为了被守护脚本断言。三种返回形态都要认：
 *   · 标准 JSON `{"index":2,…}`         · 被 ``` 或解释文字包住的 JSON      · 光秃秃一个 `3`
 *   越界（负数 / ≥ total / 小数）一律 null ⇒ 回落第 0 张，**绝不返回一个会取到 undefined 的下标**。
 */
export function parsePickedIndex(text: string, total: number): number | null {
  const cleaned = text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  // 先试整段 JSON，再试其中被解释文字包住的那个对象
  const chunks = start >= 0 && end > start ? [cleaned.slice(start, end + 1), cleaned] : [cleaned]
  /** ★ 只要模型**表达了 index 这个字段**，就再也不许走「抓第一个数字」那条兜底 */
  let sawIndexField = false
  for (const raw of chunks) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && 'index' in parsed) sawIndexField = true
      const n = Number(parsed?.index)
      if (Number.isInteger(n) && n >= 0 && n < total) return n
    } catch {
      // 换下一个候选片段
    }
  }
  /**
   * 连 JSON 都不是：退一步抓第一个数字（模型有时只回一个「3」）。
   *
   * ★★ 必须加 `sawIndexField` 这道闸 —— 否则 `{"index":-1}` 会被这条正则
   *   **从 `-1` 里抠出 `1`**、`{"index":1.5}` 会被抠出 `1`：
   *   模型明确说「没有合适的 / 我不确定」时，我们却当成「选第 1 张」，**静默挑错帧**。
   *   模型已经说了 index，就该只认那个 index，越界就老实回 null（调用方退第 0 张）。
   */
  if (sawIndexField) return null
  const m = cleaned.match(/\d+/)
  if (m) {
    const n = Number(m[0])
    if (Number.isInteger(n) && n >= 0 && n < total) return n
  }
  return null
}

// ────────────────────────────── 封面落地 ──────────────────────────────

/**
 * 把图像场景的返回变成对象存储里的一个键。
 *
 * 输入是 adapters.ts::openaiImage 的 `text`，它只有两种合法形态：
 *   · https://…                图床地址
 *   · data:image/png;base64,…  上游只回 b64
 * 别的一律判失败（**尤其**不能把兜底提示词当成地址）。
 */
async function materializeCover(
  source: string,
  merchantId: bigint,
): Promise<{ key: string; width: number | null; height: number | null }> {
  const raw = source.trim()
  if (!/^https:\/\//i.test(raw) && !/^data:image\//i.test(raw)) {
    throw new PublishCoverFailedError('封面生成失败：返回的不是图片地址')
  }

  const dir = await makeTempDir()
  try {
    const tmpPath = `${dir}/cover.bin`
    const fetched = await fetchImageToFile(raw, tmpPath)
    // 尺寸只是元数据：探不到不该让整次生成失败（封面本身是好的）
    const probe = await probeClipMeta(tmpPath).catch(() => null)
    const width = probe?.ok ? (probe.width ?? null) : null
    const height = probe?.ok ? (probe.height ?? null) : null
    if (width && height && Math.abs(height / width - 4 / 3) > 0.02) {
      // 承诺是 3:4。上传了别的比例不该报错（图是能看的），但**必须留痕**：
      // 这条日志是「模型/中转站换了出图策略」的唯一信号（AI_IMAGE_SIZE 是唯一的旋钮）。
      console.warn(
        `[publish-material] 封面比例不是 3:4（实际 ${width}x${height}），` +
          `检查 AI_IMAGE_SIZE=${process.env.AI_IMAGE_SIZE ?? '(默认 1024x1365)'}`,
      )
    }

    // 键：uploads/{merchantId}/publish/{yyyymmdd}/{随机}.ext
    // ★ 复用 uploads/ 前缀（已是既有白名单内的前缀）：新增前缀要同步 5 处
    //   （ALLOWED_PREFIXES / GC 扫描 / GC 删除白名单 / collectReferencedKeys / 签名守卫），
    //   少改一处就是一个静默失效点。这里只多了一件事：把本表的 cover_key 登记进
    //   collectReferencedKeys（已做）。
    // ★ 文件名带随机段：CDN/微信按 URL 缓存，固定键覆盖会出现「换过封面但用户仍看旧图」。
    const key = `uploads/${merchantId}/publish/${dateSegment()}/${randomBytes(8).toString('hex')}${fetched.ext}`
    await uploadFile(tmpPath, key, fetched.contentType)
    return { key, width, height }
  } finally {
    // 临时目录必须删：里面是 1~2MB 的图片，不删就等着把磁盘吃满
    await removeTempDir(dir)
  }
}

function dateSegment(): string {
  const d = new Date()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}${m}${day}`
}

// ────────────────────────────── 解析与兜底 ──────────────────────────────

/** 文本场景的兜底画面描述（与 prisma/prompts.ts 的 PUBLISH_COVER_FALLBACK 同一份语义） */
const FALLBACK_COVER_PROMPT =
  '中餐招牌菜特写，刚出锅冒着热气，暖色调侧逆光，背景虚化的暖堂食环境。' +
  '竖版 3:4 构图，主体居中偏上、四周留白，画面中不要出现任何文字、水印与 logo'

/**
 * 从模型返回里抠出 JSON。
 *
 * 只取**第一个 `{` 到最后一个 `}`**：推理模型常见的输出是
 * 「先解释一段，再给 JSON」或者「JSON + 一句总结」，严格 parse 会直接失败 ——
 * 而那段 JSON 其实是完全可用的。所以这里只做「定位 + 解析」，不做字段严格校验
 * （字段缺失由调用方按空值兜底）。
 */
function parseMaterial(text: string): { title: string; caption: string; coverPrompt: string } | null {
  const cleaned = text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj: unknown
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const title = str(o.title)
  const caption = str(o.caption)
  const coverPrompt = str(o.coverPrompt)
  // 三样全空 = 这次返回没有任何可用内容，按失败处理（交给 localTitle/localCaption 兜底）
  if (!title && !caption && !coverPrompt) return null
  return { title, caption, coverPrompt }
}

/** AI 全挂时的标题：取口播文案的第一句，截到 20 字以内 */
function localTitle(copyText: string, dishName: string): string {
  const first = copyText.split(/[。！？!?；;\n]/).map((s) => s.trim()).filter(Boolean)[0] ?? ''
  const base = first || (dishName ? `${dishName}，现做现卖` : '今天这道菜，值得专门来一趟')
  return base.slice(0, 20)
}

/** AI 全挂时的文案：口播文案本身就是最好的发布文案（它已经被用户确认过） */
function localCaption(copyText: string): string {
  return copyText.trim() || '今天店里现做现卖，欢迎来尝尝。'
}

/** 单行字段：把换行/制表符压成空格（标题列只有一行，留着换行会让后台列表变形） */
function sanitizeLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 多行字段：去掉控制字符（\u0000 之类会让某些 JSON 序列化直接失败），保留换行 */
function sanitizeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
}

// ────────────────────────────── 视图 ──────────────────────────────

async function toView(row: {
  creationId: bigint
  title: string
  caption: string
  coverKey: string | null
  coverWidth: number | null
  coverHeight: number | null
  updatedAt: Date
}): Promise<PublishMaterialView> {
  // 封面是私有对象 ⇒ 每次读都重签（签名 URL 会过期，存到客户端就是「昨天还能看今天白了」）
  const coverUrl = row.coverKey ? (await getGeneratedPlayUrl(row.coverKey)).url : null
  return {
    creationId: String(row.creationId),
    title: row.title,
    caption: row.caption,
    coverUrl,
    coverWidth: row.coverWidth,
    coverHeight: row.coverHeight,
    updatedAt: row.updatedAt.toISOString(),
    degraded: false,
    coverError: null,
  }
}

/** 归属校验：创作不是这个商户的就当不存在（不要回 403 —— 那等于确认了「这条创作存在」） */
async function assertOwnedCreation(
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

export { RemoteImageError }
