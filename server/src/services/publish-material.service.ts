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
import type { PrismaClient } from '@prisma/client'
import type { AiGateway } from '../ai/gateway.js'
import { runBilledScene } from '../ai/ai.service.js'
import { SCENE } from '../ai/scene-codes.js'
import { buildVariables } from './creation.service.js'
import { CreationNotFoundError } from './creation.service.js'
import { requireSubscription } from './subscription.service.js'
import { uploadFile } from '../lib/cos.js'
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
    where: { code: { in: [SCENE.publish_material, SCENE.publish_cover] }, enabled: true },
    select: { code: true, beanPrice: true },
  })
  const of = (code: string) => Number(scenes.find((s) => s.code === code)?.beanPrice ?? 0)
  return { textBeanCap: of(SCENE.publish_material), coverBeans: of(SCENE.publish_cover) }
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
      // 重出封面时可以复用上一版存下来的画面描述（省一次文本调用）
      const promptForCover = (coverPrompt || existing?.coverPrompt || '').trim() || FALLBACK_COVER_PROMPT
      const r = await runBilledScene(prisma, gateway, {
        sceneCode: SCENE.publish_cover,
        merchantId,
        // 与文本场景用不同的 requestId：两个场景是两笔独立的业务请求，
        // 共用同一个 id 只会在排查时让人误以为是同一次调用。
        requestId: `${requestId}-cover`,
        variables: { coverPrompt: promptForCover },
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
