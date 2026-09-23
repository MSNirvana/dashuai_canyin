// 合成服务：把分镜素材按自动规划结果生成 9:16 成片
// 三档产品档位（grade）：BASIC=纯粗剪 / AI=本地自动剪辑（配音+字幕+质量筛选）/ PREMIUM=人工精剪（不进 FFmpeg 队列）
// 计费（v5）：时长(秒) × point_per_sec × 档位系数 ×（RECOLOR 再乘 recolor_ratio）
// 扣积分两阶段：freeze（提交时预留）→ consume（合成成功结算）；失败/unfreeze 退款由 worker / sweeper 负责
// 演示环境（FFMPEG_WORKER≠true，无 ffmpeg）下，BASIC/AI 任务会在同一事务内模拟「成功」完成，打通最小闭环；
// PREMIUM 任务无论何种环境都进入人工队列（MANUAL_PENDING），由管理后台剪辑工作台交付
// 真实环境（FFMPEG_WORKER=true）：submitRender 仅 freeze 预留 + 建 QUEUED 任务，
//   由 render/worker.ts 拉取执行 FFmpeg，成功 consume 结算、失败 unfreeze 全额释放
import { randomUUID } from 'crypto'
import type { PrismaClient, Prisma } from '@prisma/client'
import { freeze, consume, unfreeze, availableOf, type Db } from '../bean/bean.service.js'
import { getCreation, CreationNotFoundError } from './creation.service.js'
import { requireSubscription } from './subscription.service.js'
import { getNumber, getDecimal } from '../lib/settings.js'
import { decFromNumber, decFromString, decMulCeil } from '../lib/decimal.js'
import { claimBusinessRequest, completeBusinessRequest, failBusinessRequest } from '../domain/request.js'
import { ChatCutOptionsSchema, DEFAULT_CHATCUT_OPTIONS, chatCutConfigured, type ChatCutOptions } from '../render/chatcut.js'
import type { AutoEditProfile } from '../render/auto-edit.js'
import { userFacingRenderError } from '../render/user-errors.js'

// 计费点数（后台可配置化见 docs/05，此处为默认值）
export const RENDER_BEAN_FULL = 30n
export const RENDER_BEAN_RECOLOR = 10n

export type RenderMode = 'FULL' | 'RECOLOR'

/**
 * 合成输出规格。**唯一源**：提交合成（写进 paramsJson）、worker 兜底、调色预览都用它。
 * 调色预览必须与成片同分辨率 —— 锐化是像素半径卷积，换分辨率会让预览看起来比成片更锐/更糊。
 */
export const RENDER_OUTPUT = { width: 1080, height: 1920, fps: 30 } as const

/** 产品档位：BASIC 粗剪 / AI 全自动 / PREMIUM 人工精剪 */
export type RenderGrade = 'BASIC' | 'AI' | 'PREMIUM'

/**
 * worker 执行权凭证（fencing token）。
 *
 * ★ 为什么收尾必须带它：一个任务可能先后被多个执行者持有（旧进程死掉 → 孤儿回收 → 新进程认领，
 *   或两个 worker 同时滚动轮询）。如果收尾只按 `id` 写入，迟到的旧执行者会把
 *   **已经被别人推进/已成功/已退款**的任务覆盖回旧状态 —— 实测能把 `SUCCESS` 改回 `RUNNING`，
 *   也会让已退款的任务继续下载上传。
 *
 * 语义：`leaseVersion` 在每次认领与每次回收时自增。旧执行者手里的 version 一旦落后，
 *   其所有写入的 `WHERE` 条件都不再匹配（0 行）⇒ 天然失权，不需要额外的锁表。
 */
export interface RenderFence {
  owner: string
  version: number
}

export function parseGrade(v: unknown): RenderGrade {
  return v === 'BASIC' || v === 'PREMIUM' ? v : 'AI'
}

/** 档位计费系数的兜底默认值（实际以后台 render.grade_ratio_* 配置为准） */
export const GRADE_RATIO_DEFAULT: Record<RenderGrade, number> = {
  BASIC: 1,
  AI: 1.5,
  PREMIUM: 3,
}

/**
 * 档位的用户可见名称。**服务端唯一源** —— 报错文案里必须说清是「哪一档」被占住了，
 * 否则三档并行之后「已有任务进行中」这句会让用户以为整页都不能提交。
 * 客户端卡片上的名字是另一套展示文案，两边不必强求字面一致（那边是营销语，这边是提示语）。
 */
export const GRADE_LABEL: Record<RenderGrade, string> = {
  BASIC: '基础生成',
  AI: 'AI 生成',
  PREMIUM: '精品生成',
}

export class RenderNoAssetError extends Error {
  constructor() {
    super('请先为至少一个分镜上传素材')
    this.name = 'RenderNoAssetError'
  }
}
/**
 * 同一创作、**同一档位**已有一个未收敛的任务。
 *
 * ★ 为什么必须带档位：三档互不干扰是产品约定 —— AI 档在跑不该挡住基础档提交。
 *   `where` 里漏掉 grade 就会退化成「整条创作只能有一个任务」，而这条错误文案会把人
 *   引到「等一等」上，用户永远想不到真正的原因是「另一个档位占着」。
 *   所以 message 里既说清是哪一档、也明说其他档位不受影响。
 */
export class RenderAlreadyRunningError extends Error {
  constructor(grade?: RenderGrade) {
    super(
      grade
        ? `${GRADE_LABEL[grade]}已有任务在进行中，请等它完成后再提交这一档（其他档位不受影响）`
        : '已有合成任务进行中',
    )
    this.name = 'RenderAlreadyRunningError'
  }
}
export class RenderDurationUnknownError extends Error {
  constructor() {
    super('素材缺少时长信息，无法计价，请重新上传素材')
    this.name = 'RenderDurationUnknownError'
  }
}

/**
 * 档位当前不可用（提交前拦截，不冻结不扣费）。
 *
 * 为什么要在提交前拦：AI 档依赖外部剪辑通道 ChatCut。通道没配好时，
 * 旧行为是「照常冻结 1.5 倍费用 → worker 抛错 → 再全额退款」。
 * 用户看到的是「提交成功 → 等半天 → 失败」，账上资金还被锁一会儿；
 * 对平台则是白跑一轮调度。正确做法是提交时就说清楚，一个字都不扣。
 */
export class RenderGradeUnavailableError extends Error {
  constructor(
    readonly grade: string,
    reason: string,
  ) {
    super(reason)
    this.name = 'RenderGradeUnavailableError'
  }
}

export interface ColorGrade {
  brightness: number // -100 ~ 100，默认 0
  contrast: number
  saturation: number
  sharpen: number
}

export const DEFAULT_COLOR: ColorGrade = { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }

export interface RenderClip {
  shotId: string
  assetId: string
  cosKey: string
  coverKey: string | null
  trimStartMs: number
  trimEndMs: number | null
  /** 素材自身时长（上传确认时上报）；未设置 trim 时作为计费时长依据（与 FFmpeg 未裁剪=用全片的行为一致） */
  durationMs: number | null
  /** 该分镜的口播文案（Shot.line），AI 合成用于配音与字幕 */
  line: string | null
  /** 用于自动剪辑规划的分镜语义元数据 */
  shotType?: string | null
  shotSize?: string | null
  visualReq?: string | null
}

export type RenderEngine = 'LOCAL' | 'CHATCUT'
export type SubtitleMode = 'OFF' | 'VOICE' | 'SOURCE_AUDIO' | 'VOICE_AND_SOURCE'

export interface SubmitRenderInput {
  mode: RenderMode
  color?: ColorGrade
  requestId?: string
  /** 是否启用 AI 合成（AI 配音 + 字幕 + 智能节奏）；默认 true（旧客户端兼容字段） */
  aiMode?: boolean
  /** 产品档位；未传时按 aiMode 推导（false→BASIC，true/缺省→AI） */
  grade?: RenderGrade
  /** AI 档 ChatCut 编辑选项；BASIC/PREMIUM 忽略 */
  chatcut?: Partial<ChatCutOptions>
  /** AI 引擎；默认 LOCAL，CHATCUT 仅作为兼容/实验通道 */
  engine?: RenderEngine
  /** 自动识别也可由用户指定剪辑风格 */
  profile?: AutoEditProfile
  /** 用户上传的自定义配音对象键（仅本地自动剪辑引擎使用） */
  customVoiceKey?: string
  customVoiceDurationMs?: number
}

export interface RenderTaskView {
  id: string
  creationId: string
  status: string
  progress: number
  mode: RenderMode
  grade: RenderGrade
  aiMode: boolean
  color: ColorGrade
  clips: RenderClip[]
  beanCharged: string
  cacheHit: boolean
  resultKey: string | null
  previewKey: string | null
  resultSize: string | null
  durationMs: number | null
  errorCode: string | null
  /**
   * **用户可见**的失败文案（已脱敏）。
   *
   * ★ 这里刻意不叫 errorMsg、也不回传原文：`render_task.error_msg` 是**运维字段**，
   *   里面会有第三方产品名、服务端本机绝对路径、HTTP 报文；而本接口是**小程序**读的，
   *   那条文案会被 `pages/render/compose.tsx` 原样渲染给商户。
   *   分流规则见 `src/render/user-errors.ts`（后台走 admin-extra 的裸查询，不受影响）。
   */
  errorText: string | null
  createdAt: string
  finishAt: string | null
  assignedAt: string | null
  deadlineAt: string | null
  chatcut?: ChatCutOptions
  chatcutJob?: { externalJobId?: string; projectId?: string; editorUrl?: string }
  engine?: RenderEngine
  profile?: AutoEditProfile
  customVoiceKey?: string
  customVoiceDurationMs?: number
}

function toView(row: {
  id: bigint
  creationId: bigint
  status: string
  progress: number
  grade?: string | null
  paramsJson: unknown
  beanCharged: bigint
  cacheHit: boolean
  resultKey: string | null
  previewKey: string | null
  resultSize: bigint | null
  durationMs: number | null
  errorCode: string | null
  errorMsg: string | null
  createdAt: Date
  finishAt: Date | null
  assignedAt?: Date | null
  deadlineAt?: Date | null
}): RenderTaskView {
  const p = (row.paramsJson ?? {}) as {
    mode?: RenderMode
    aiMode?: boolean
    color?: ColorGrade
    clips?: RenderClip[]
    chatcut?: ChatCutOptions
    chatcutJob?: { externalJobId?: string; projectId?: string; editorUrl?: string }
    engine?: RenderEngine
    profile?: AutoEditProfile
    customVoiceKey?: string
    customVoiceDurationMs?: number
  }
  return {
    id: row.id.toString(),
    creationId: row.creationId.toString(),
    status: row.status,
    progress: row.progress,
    mode: p.mode ?? 'FULL',
    grade: parseGrade(row.grade),
    aiMode: p.aiMode ?? true,
    color: p.color ?? DEFAULT_COLOR,
    clips: p.clips ?? [],
    beanCharged: row.beanCharged.toString(),
    cacheHit: row.cacheHit,
    resultKey: row.resultKey,
    previewKey: row.previewKey,
    resultSize: row.resultSize?.toString() ?? null,
    durationMs: row.durationMs,
    errorCode: row.errorCode,
    errorText: userFacingRenderError(row.errorMsg),
    createdAt: row.createdAt.toISOString(),
    finishAt: row.finishAt?.toISOString() ?? null,
    assignedAt: row.assignedAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    chatcut: p.chatcut,
    chatcutJob: p.chatcutJob,
    engine: p.engine ?? 'LOCAL',
    profile: p.profile,
    customVoiceKey: p.customVoiceKey,
    customVoiceDurationMs: p.customVoiceDurationMs,
  }
}

/** 是否启用真实 FFmpeg worker（true=真实合成；false=演示环境模拟成功） */
function simulateWorkerEnabled(): boolean {
  return process.env.FFMPEG_WORKER === 'true'
}

export async function getRender(prisma: PrismaClient, merchantId: bigint, taskId: bigint): Promise<RenderTaskView> {
  const row = await prisma.renderTask.findFirst({
    where: { id: taskId, merchantId },
  })
  if (!row) throw new RenderNotFoundError()
  return toView(row)
}

export class RenderNotFoundError extends Error {
  constructor() {
    super('合成任务不存在')
    this.name = 'RenderNotFoundError'
  }
}

export async function listRenders(prisma: PrismaClient, merchantId: bigint, creationId: bigint): Promise<RenderTaskView[]> {
  const rows = await prisma.renderTask.findMany({
    where: { merchantId, creationId },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map(toView)
}

/**
 * 单分镜有效时长（ms）：
 * - 设置了 trim（end > start）：用 trim 区间（与 FFmpeg 裁剪行为一致）
 * - 未设置 trim：用素材自身时长减去 trimStart（与 FFmpeg「未裁剪=全片」行为一致）
 * - 两者都缺：返回 null（无法计价，调用方应拒绝提交）
 */
export function clipDurationMs(clip: RenderClip): number | null {
  if (clip.trimEndMs && clip.trimEndMs > clip.trimStartMs) {
    return clip.trimEndMs - clip.trimStartMs
  }
  if (clip.durationMs && clip.durationMs > clip.trimStartMs) {
    return clip.durationMs - clip.trimStartMs
  }
  return null
}

/** 提交合成：校验 → 组装 clips → 创建任务 → 两阶段扣积分 → (演示)模拟完成 */
/**
 * 取「本次合成要用的片段集合」（按分镜顺序）。
 *
 * ★ 为什么必须抽成一个函数：调色预览（render/preview.ts）要用**完全相同**的片段集合与顺序，
 *   否则两侧算出的归一化缓存键不同 ⇒ 预览每次都判定缓存未命中 ⇒ 现场把素材全量归一化。
 *   这就是「预览偶尔莫名很慢」的根因，而且不报任何错、只是慢。
 */
export async function buildRenderClips(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
  storeId: bigint,
): Promise<RenderClip[]> {
  const shots = await prisma.shot.findMany({
    // `skipped: false` 在正常的库状态下是冗余条件（跳过时 assetId 已被清空，本来就被下面滤掉），
    // 但它把**不变量**写进了查询：库里一旦出现「既标了跳过、又留着 assetId」的脏数据
    // （例如将来有人绕过 updateShotAsset 直接写库），用户以为跳过的那一段不会偷偷出现在成片里。
    where: { creationId, assetId: { not: null }, skipped: false },
    orderBy: { seq: 'asc' },
  })
  if (shots.length === 0) throw new RenderNoAssetError()

  // 多个分镜可复用同一段素材，按 id 去重后再校验归属，避免重复计数导致误判越权
  const assetIds = [...new Set(shots.map((s) => s.assetId!))]
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: assetIds }, merchantId, storeId, deletedAt: null },
  })
  if (assets.length !== assetIds.length) throw new Error('创作中的素材不属于当前商家门店或已被删除')
  const assetMap = new Map(assets.map((a) => [a.id, a]))

  const clips: RenderClip[] = shots
    .map((s): RenderClip | null => {
      const a = s.assetId ? assetMap.get(s.assetId) : undefined
      if (!a) return null
      return {
        shotId: s.id.toString(),
        assetId: s.assetId!.toString(),
        cosKey: a.cosKey,
        coverKey: a.coverKey,
        trimStartMs: s.trimStartMs,
        trimEndMs: s.trimEndMs,
        durationMs: a.durationMs ?? null,
        line: s.line,
        shotType: s.shotType,
        shotSize: s.shotSize,
        visualReq: s.visualReq,
      }
    })
    .filter((c): c is RenderClip => c !== null)
  if (clips.length === 0) throw new RenderNoAssetError()
  return clips
}

export async function submitRender(
  prisma: PrismaClient,
  merchantId: bigint,
  creationId: bigint,
  input: SubmitRenderInput,
): Promise<{ task: RenderTaskView; duplicated: boolean }> {
  const reqId = input.requestId ?? randomUUID()

  // v5：订阅是使用合成出片的硬前提（在冻结积分之前拦截）
  await requireSubscription(prisma, merchantId, '合成出片')

  const creation = await getCreation(prisma, merchantId, creationId) // 校验归属
  const clips = await buildRenderClips(prisma, merchantId, creationId, creation.storeId)

  const mode: RenderMode = input.mode === 'RECOLOR' ? 'RECOLOR' : 'FULL'
  const color = input.color ?? DEFAULT_COLOR
  // 档位：新客户端传 grade；旧客户端只传 aiMode → 推导（false→BASIC，其余→AI）
  const grade: RenderGrade = input.grade ?? (input.aiMode === false ? 'BASIC' : 'AI')
  const aiMode = grade !== 'BASIC' // BASIC 纯粗剪；AI/PREMIUM 含配音字幕管线（PREMIUM 由人工执行）
  const chatcut = ChatCutOptionsSchema.parse({ ...DEFAULT_CHATCUT_OPTIONS, ...(input.chatcut ?? {}) })

  const requestedEngine = input.engine ?? (process.env.RENDER_ENGINE?.trim().toUpperCase() === 'CHATCUT' ? 'CHATCUT' : 'LOCAL')
  // ChatCut 没有配置时自动回到本地引擎，第三方服务不可用不应阻断用户出片。
  // 自定义配音需要本地直接合成，不能交给 ChatCut 的预设音色通道。
  const engine: RenderEngine = input.customVoiceKey
    ? 'LOCAL'
    : requestedEngine === 'CHATCUT' && chatCutConfigured() ? 'CHATCUT' : 'LOCAL'

  let customVoiceDurationMs: number | undefined
  if (input.customVoiceKey) {
    const customVoice = await prisma.mediaAsset.findFirst({
      where: {
        merchantId,
        storeId: creation.storeId,
        cosKey: input.customVoiceKey,
        type: 'AUDIO',
        deletedAt: null,
        status: 'READY',
      },
      select: { durationMs: true },
    })
    if (!customVoice) throw new Error('自定义配音素材不存在或不属于当前门店')
    customVoiceDurationMs = input.customVoiceDurationMs ?? customVoice.durationMs ?? undefined
  }

  // 计费时长 = 各分镜有效时长之和；任一分镜时长未知则拒绝（无法正确计价会少扣积分）
  let totalMs = 0
  for (const cl of clips) {
    const dur = clipDurationMs(cl)
    if (dur === null) throw new RenderDurationUnknownError()
    totalMs += dur
  }

  const requestPayload = {
    creationId: creationId.toString(), mode, color, grade, aiMode, clips, chatcut,
    engine, profile: input.profile, customVoiceKey: input.customVoiceKey, customVoiceDurationMs,
  }
  // 创建任务 + 并发拦截 + 业务请求占用 + freeze 放在同一事务并对创作行加锁：
  // 防止两个并发请求同时通过「无进行中任务」检查、创建出两个任务双重扣积分
  // 计价系数一律用精确十进制读取（getDecimal 解析库里原始字符串，不经 Number()）
  const pointPerSec = await getDecimal(prisma, 'render', 'point_per_sec', 1)
  // 档位系数（后台 render.grade_ratio_basic/ai/premium 可配）—— 默认值 1 / 1.5 / 3 本身就是小数
  const gradeRatio = await getDecimal(prisma, 'render', `grade_ratio_${grade.toLowerCase()}`, GRADE_RATIO_DEFAULT[grade])
  // RECOLOR 复用归一化缓存（省掉源解码+缩放），按折扣系数计价，默认 5 折（后台 render.recolor_ratio 可配）
  const recolorRatio = mode === 'RECOLOR'
    ? await getDecimal(prisma, 'render', 'recolor_ratio', 0.5)
    : decFromString('1')!
  // 原实现 `Math.max(1, Math.ceil(totalSec * pointPerSec * gradeRatio * recolorRatio))` 有浮点误差：
  // totalSec = totalMs/1000 本身多数情况下不是精确二进制小数，再连乘 1.5 / 0.5 会放大误差。
  // 改成：amount = ceil(totalMs × pointPerSec × gradeRatio × recolorRatio / 1000)，全程整数，最低收 1 积分。
  const amountRaw = decMulCeil([decFromNumber(totalMs)!, pointPerSec, gradeRatio, recolorRatio], 1000n)
  const amount = amountRaw < 1n ? 1n : amountRaw

  // PREMIUM：SLA 截止时间（超时由 sweeper 自动退款）
  const premiumSlaHours = grade === 'PREMIUM' ? await getNumber(prisma, 'render', 'premium_sla_hours', 48) : 0
  const deadlineAt = grade === 'PREMIUM' ? new Date(Date.now() + premiumSlaHours * 3600_000) : null

  // ★ 事务隔离级别必须是 READ COMMITTED（不能用 MySQL 默认的 REPEATABLE READ）：
  //   并发同 requestId 时，赢家的事务在我们读完之后才提交。REPEATABLE READ 下本事务的
  //   一致读全部沿用旧快照 —— claimBusinessRequest 的 P2002 重读、以及下面按 requestId
  //   找 prior 任务的 findFirst 都会返回 null，结果是「数据正确但 7/8 个请求报错」。
  //   实测：REPEATABLE READ → 1×200 + 7×500「提交合成失败」；READ COMMITTED → 全部拿到同一任务。
  const txResult = await prisma.$transaction(async (tx: Db) => {
    const claim = await claimBusinessRequest(tx, {
      merchantId,
      operation: 'RENDER',
      requestId: reqId,
      payload: requestPayload,
      resourceType: 'CREATION',
      resourceId: creationId,
    })
    if (!claim.created) {
      const prior = await tx.renderTask.findFirst({ where: { merchantId, requestId: reqId } })
      if (prior) return { task: prior, duplicated: true }
      throw new RenderAlreadyRunningError()
    }
    // 锁创作行，序列化同一创作的并发提交（MySQL InnoDB 行锁）
    await tx.$queryRaw`SELECT id FROM creation WHERE id = ${creationId} FOR UPDATE`
    // ★ 只在**同一档位**内去重（三档互不干扰）：
    //   基础/智能/精品是三条独立管线（本地 ffmpeg 粗剪 / 云端智能剪辑 / 人工队列），
    //   互相之间不共用中间产物、也不共用队列容量，所以 AI 档在跑没有理由挡住基础档提交。
    //   PREMIUM 任务在人工队列里同样只占住 PREMIUM 这一个位置。
    //   ⚠ 这里漏写 grade 就会退回旧行为：整条创作只能有一个活跃任务 —— 表现为
    //   「AI 生成中的时候基础生成点不动」（服务端 409 4001），而错误文案又会把用户引向「等一等」。
    //   行锁仍保留：它保证「同一档位并发提交两个请求」不会同时通过这道检查（双重扣积分）。
    const running = await tx.renderTask.findFirst({
      where: {
        creationId,
        grade,
        status: { in: ['QUEUED', 'RUNNING', 'MANUAL_PENDING', 'MANUAL_DOING'] },
      },
    })
    if (running) throw new RenderAlreadyRunningError(grade)
    const task = await tx.renderTask.create({
      data: {
        merchantId,
        creationId,
        status: 'PENDING_RESERVATION',
        grade,
        beanCharged: amount, // 计划扣积分额：演示模式立即结算，真实模式由 worker / 人工交付结算
        deadlineAt,
        paramsJson: {
          mode,
          aiMode,
          color,
          chatcut,
          engine,
          profile: input.profile,
          customVoiceKey: input.customVoiceKey,
          customVoiceDurationMs,
          creationId: creationId.toString(),
          title: creation.title ?? `大帅餐饮成片-${creationId.toString()}`,
          output: RENDER_OUTPUT,
          clips,
        } as unknown as Prisma.InputJsonValue,
        requestId: reqId,
      },
    })
    const fr = await freeze(tx, {
      merchantId,
      requestId: reqId,
      amount,
      bizType: 'RENDER',
      bizId: task.id.toString(),
      remark: `${mode === 'RECOLOR' ? '重调色合成' : '合成成片'}(${grade}) 预留 ${amount} 积分`,
    })
    const status = grade === 'PREMIUM' ? 'MANUAL_PENDING' : 'QUEUED'
    const updated = await tx.renderTask.update({
      where: { id: task.id },
      data: { status, reservationId: fr.reservationId },
    })
    await tx.businessRequest.updateMany({
      where: { merchantId, operation: 'RENDER', requestId: reqId },
      data: { resourceId: task.id, resultRef: task.id.toString() },
    })
    return { task: updated, duplicated: false }
  }, { isolationLevel: 'ReadCommitted' })
  const task = txResult.task
  // 演示环境保留同步完成；任务创建与预留已原子完成，结算再以终态 CAS 收口。
  if (!txResult.duplicated && simulateWorkerEnabled() === false && grade !== 'PREMIUM') {
    await prisma.$transaction(async (tx: Db) => {
      await consume(tx, {
        merchantId,
        requestId: reqId,
        amount,
        bizType: 'RENDER',
        bizId: task.id.toString(),
        remark: `${mode === 'RECOLOR' ? '重调色合成' : '合成成片'} 消耗 ${amount} 积分`,
      })
      await tx.renderTask.updateMany({
        where: { id: task.id, status: 'QUEUED' },
        data: {
          status: 'SUCCESS', progress: 100, beanCharged: amount, cacheHit: mode === 'RECOLOR',
          resultKey: clips[0]?.cosKey ?? null, previewKey: clips[0]?.coverKey ?? null,
          durationMs: totalMs || null, finishAt: new Date(), costMs: Math.max(1, Math.round(totalMs / 1000) || 1),
        },
      })
      await completeBusinessRequest(tx, merchantId, 'RENDER', reqId, task.id.toString())
    })
  }
  const view = await getRender(prisma, merchantId, task.id)
  return { task: view, duplicated: txResult.duplicated }
}

/** 任务的「仍可被推进」状态集（成功/失败终态不在其中） */
const RENDER_ACTIVE_STATES: string[] = [
  'PENDING_RESERVATION',
  'QUEUED',
  'RUNNING',
  'MANUAL_PENDING',
  'MANUAL_DOING',
  'SETTLEMENT_PENDING',
]
/**
 * 可被结算的状态集：与改动前的行为保持一致（RUNNING / 人工档两态 / QUEUED），
 * 额外加上 SETTLEMENT_PENDING —— 那只表示上一次释放预留失败，任务本身仍应允许成功结算。
 */
const RENDER_SETTLEABLE_STATES: string[] = ['QUEUED', 'RUNNING', 'MANUAL_DOING', 'MANUAL_PENDING', 'SETTLEMENT_PENDING']

/**
 * 执行权已丢失。抛出后事务回滚 —— 这是关键：失权的执行者**绝不能**留下副作用，
 * 包括已经发生的 consume（否则就是「扣了积分、任务却没被更新」的悬空账）。
 */
export class FenceLostError extends Error {
  constructor(taskId: bigint) {
    super(`render task ${taskId.toString()} 的执行权已转移（租约版本落后），本次收尾已放弃`)
    this.name = 'FenceLostError'
  }
}

/** 当前行是否仍由该 fence 持有 */
function holdsFence(
  task: { leaseOwner: string | null; leaseVersion: number },
  fence: RenderFence,
): boolean {
  return task.leaseOwner === fence.owner && task.leaseVersion === fence.version
}

/** 把 fence 转成 where 条件（不传则不限制，供 API 侧/演示模式复用） */
function fenceWhere(fence?: RenderFence): { leaseOwner?: string; leaseVersion?: number } {
  return fence ? { leaseOwner: fence.owner, leaseVersion: fence.version } : {}
}

/** 真实环境 worker 收尾调用：结算扣积分 + 写产物（freeze 已在 submit 阶段完成） */
export async function completeRender(
  tx: Db,
  merchantId: bigint,
  taskId: bigint,
  result: {
    resultKey: string
    previewKey?: string | null
    resultSize?: bigint
    durationMs?: number | null
    /** 是否命中中间产物缓存（重调色复用归一化产物，对应 10 积分计费） */
    cacheHit?: boolean
  },
  fence?: RenderFence,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM render_task WHERE id = ${taskId} FOR UPDATE`
  const task = await tx.renderTask.findUnique({ where: { id: taskId } })
  if (!task) return
  if (task.status === 'SUCCESS') return
  if (!RENDER_SETTLEABLE_STATES.includes(task.status as (typeof RENDER_SETTLEABLE_STATES)[number])) return
  // ★ 失权判定必须在 consume **之前**：放到之后就只能靠抛错回滚兜底，
  //   而回滚路径一旦被吞（比如 catch 里再写库），就变成扣了积分没人更新任务的悬空账。
  if (fence && !holdsFence(task, fence)) throw new FenceLostError(taskId)
  const amount = task.beanCharged > 0n ? task.beanCharged : RENDER_BEAN_FULL
  await consume(tx, {
    merchantId,
    requestId: task.requestId ?? taskId.toString(),
    amount,
    bizType: 'RENDER',
    bizId: taskId.toString(),
  })
  const updated = await tx.renderTask.updateMany({
    where: { id: taskId, status: { in: [...RENDER_SETTLEABLE_STATES] }, ...fenceWhere(fence) },
    data: {
      status: 'SUCCESS',
      progress: 100,
      beanCharged: amount,
      cacheHit: result.cacheHit ?? false,
      resultKey: result.resultKey,
      previewKey: result.previewKey ?? null,
      resultSize: result.resultSize,
      durationMs: result.durationMs,
      finishAt: new Date(),
      // 收尾即交还租约，避免行上残留一个指向早已结束的执行者的 owner
      leaseOwner: null,
      leaseExpireAt: null,
    },
  })
  if (updated.count === 0) {
    // 走到这里说明状态或租约在锁内被改掉了：回滚整个事务（含 consume），别留下半成品
    throw new FenceLostError(taskId)
  }
  if (task.requestId) {
    await completeBusinessRequest(tx, merchantId, 'RENDER', task.requestId, taskId.toString())
  }
}

/**
 * 失败终态：先释放本任务预留；释放失败则显式进入待结算，避免假称已退款。
 *
 * ★ 两个必须守住的点（都踩过）：
 *   ① **预留释放不能因「任务已是 FAILED」而跳过**。历史缺陷是调用方先把 status 写成 FAILED
 *      再进来收尾，这里一句早退就让 `unfreeze` 从未执行 —— 任务显示失败、积分却永久冻结，
 *      而且 errorCode/finishAt 也没写，运维看不出发生过什么。`unfreeze` 自身按流水幂等，
 *      重复调用是空操作，所以这里可以无条件尝试释放。
 *   ② 带 `fence` 时先验执行权：失权者不写任何东西，把终态留给真正持有任务的那个执行者。
 */
export async function failRender(
  prisma: PrismaClient,
  taskId: bigint,
  errorCode: string,
  errorMsg: string,
  fence?: RenderFence,
): Promise<'FAILED' | 'SUCCESS' | 'SETTLEMENT_PENDING' | 'SUPERSEDED'> {
  try {
    return await prisma.$transaction(async (tx: Db) => {
      await tx.$queryRaw`SELECT id FROM render_task WHERE id = ${taskId} FOR UPDATE`
      const task = await tx.renderTask.findUnique({ where: { id: taskId } })
      if (!task) return 'FAILED'
      if (task.status === 'SUCCESS') return 'SUCCESS'
      if (fence && !holdsFence(task, fence)) return 'SUPERSEDED'
      const alreadyFailed = task.status === 'FAILED'
      if (!alreadyFailed && !RENDER_ACTIVE_STATES.includes(task.status)) return 'FAILED'
      if (task.beanCharged > 0n) {
        await unfreeze(tx, {
          merchantId: task.merchantId,
          requestId: task.requestId ?? task.id.toString(),
          amount: task.beanCharged,
          bizType: 'RENDER',
          bizId: task.id.toString(),
          remark: '合成失败，释放本任务预留积分',
        })
      }
      // 已是失败终态：上面的补释放就是全部目的，不覆盖既有错误原因与完成时间
      if (alreadyFailed) return 'FAILED'
      const updated = await tx.renderTask.updateMany({
        where: { id: task.id, status: { in: RENDER_ACTIVE_STATES }, ...fenceWhere(fence) },
        data: {
          status: 'FAILED',
          errorCode,
          errorMsg: errorMsg.slice(0, 500),
          finishAt: new Date(),
          leaseOwner: null,
          leaseExpireAt: null,
        },
      })
      if (updated.count === 0) return 'SUPERSEDED'
      if (task.requestId) {
        await failBusinessRequest(tx, task.merchantId, 'RENDER', task.requestId, errorCode, errorMsg)
      }
      return 'FAILED'
    })
  } catch (e) {
    await prisma.renderTask.updateMany({
      where: {
        id: taskId,
        status: { in: ['PENDING_RESERVATION', 'QUEUED', 'RUNNING', 'MANUAL_PENDING', 'MANUAL_DOING', 'SETTLEMENT_PENDING'] },
      },
      data: {
        status: 'SETTLEMENT_PENDING',
        errorCode: 'REFUND_PENDING',
        errorMsg: `积分释放失败：${(e as Error).message}`.slice(0, 500),
        // 记录「本次进入待结算」的时刻。补偿调度用它做两件事：
        //   ① 判断是否已过 grace（给原事务一点自愈时间）；
        //   ② 作为重试退避锚点 —— 每次补偿失败都会刷新它，所以重试间隔≈grace，不会每轮猛敲。
        // 注意：RenderTask 没有 updatedAt，所以只能借用 finishAt。
        finishAt: new Date(),
      },
      // 不要在这里重置 retryCount：补偿次数由 sweepSettlementPending 独占管理，
      // 在这里清零会把「已重试 N 次」抹掉，导致 5 次上限永远不触发、无限重试。
    })
    return 'SETTLEMENT_PENDING'
  }
}

/** 当前可用积分（供前端预估展示） */
export async function getAvailable(prisma: PrismaClient, merchantId: bigint) {
  const acc = await prisma.beanAccount.upsert({
    where: { merchantId },
    create: { merchantId },
    update: {},
  })
  return availableOf(acc)
}

// ──────────────────────── SETTLEMENT_PENDING 补偿 ────────────────────────
//
// 问题：failRender 的 unfreeze 抛错时，任务落到 SETTLEMENT_PENDING（前端显示「退款确认中」），
// 但**没有任何出口** —— 原 stuck-sweeper 只扫 RUNNING / QUEUED，所以预留额度被永久占用，
// 用户账上的冻结积分永远解不开。
//
// 补偿方向的选择（重要）：
//   docs/审计-架构与业务逻辑.md 写了 SETTLEMENT_PENDING → SUCCESS/FAILED 两条路。
//   本实现只走 **→ FAILED（释放）**，不去「确认交付」。理由：
//   SETTLEMENT_PENDING 是「账务写入失败」留下的态，通常发生在 RUNNING/MANUAL_DOING 阶段；
//   此态下我们没有可靠的方式确认成片真的存在且可用（要校验就得下载/探测远端对象），
//   而猜错的代价不对等：错判 FAILED 只是少收一次钱（用户白拿），
//   错判 SUCCESS 是收了钱给了坏文件（用户投诉 + 退款）。宁可把钱退回去。

/** 单次补偿尝试的上限；超过则不再自动重试，只告警等人工介入 */
const SETTLE_MAX_ATTEMPTS = 5
/** 只有停留超过这个时长的 SETTLEMENT_PENDING 才值得补偿（给原事务一点自愈时间） */
const SETTLE_GRACE_MS = Math.max(60_000, Number(process.env.RENDER_SETTLE_GRACE_MS ?? 300_000))

export interface SettlementCompensationResult {
  scanned: number
  recovered: number
  stillPending: number
  gaveUp: number
}

/**
 * 补偿一次指定任务。返回 'RECOVERED'（已成功释放并转 FAILED）
 * 或 'PENDING'（仍失败，留在待补偿态）/ 'SKIPPED'（状态已不是待补偿）。
 */
export async function compensateSettlementPending(
  prisma: PrismaClient,
  taskId: bigint,
): Promise<'RECOVERED' | 'PENDING' | 'SKIPPED'> {
  const task = await prisma.renderTask.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'SETTLEMENT_PENDING') return 'SKIPPED'

  // 直接复用 failRender：它的事务里会重新尝试 unfreeze，
  // 且 unfreeze 自身按 (requestId, UNFREEZE) 幂等，重复调用不会重复释放。
  const state = await failRender(prisma, taskId, 'REFUND_RECOVERED', '退款补偿成功：预留积分已释放')
  return state === 'FAILED' || state === 'SUCCESS' ? 'RECOVERED' : 'PENDING'
}

/**
 * 扫描并补偿所有卡在 SETTLEMENT_PENDING 的任务。由 stuck-sweeper 每轮调用。
 * 用 `retryCount` 计次（该列在 schema 中存在但全项目原本零使用），有上限地重试，
 * 避免某条数据因账务不一致而无限重试刷日志。
 */
export async function sweepSettlementPending(
  prisma: PrismaClient,
  now = new Date(),
): Promise<SettlementCompensationResult> {
  const deadline = new Date(now.getTime() - SETTLE_GRACE_MS)
  const candidates = await prisma.renderTask.findMany({
    where: {
      status: 'SETTLEMENT_PENDING',
      // 进入待结算的时刻（failRender 兜底分支写入）；历史数据可能没有，用 createdAt 兜底
      OR: [{ finishAt: { lt: deadline } }, { finishAt: null, createdAt: { lt: deadline } }],
      retryCount: { lt: SETTLE_MAX_ATTEMPTS },
    },
    select: { id: true, errorMsg: true, merchantId: true, beanCharged: true, retryCount: true },
    orderBy: { finishAt: 'asc' },
    take: 50,
  })

  // 已达上限的单独统计（不参与重试，只在首次越线时告警）
  const exhausted = await prisma.renderTask.count({
    where: { status: 'SETTLEMENT_PENDING', retryCount: { gte: SETTLE_MAX_ATTEMPTS } },
  })

  const result: SettlementCompensationResult = {
    scanned: candidates.length,
    recovered: 0,
    stillPending: 0,
    gaveUp: exhausted,
  }

  for (const task of candidates) {
    try {
      const state = await compensateSettlementPending(prisma, task.id)
      if (state === 'RECOVERED') {
        result.recovered += 1
        console.log(`[settle-compensate] 任务 ${task.id} 补偿成功，已释放冻结 ${task.beanCharged} 积分`)
        continue
      }
      // 仍失败：计一次并保留给下一轮
      result.stillPending += 1
      const next = task.retryCount + 1
      await prisma.renderTask.updateMany({
        where: { id: task.id, status: 'SETTLEMENT_PENDING' },
        data: { retryCount: next },
      })
      if (next >= SETTLE_MAX_ATTEMPTS) {
        console.error(
          `[settle-compensate] ★ 任务 ${task.id}（商户 ${task.merchantId}，冻结 ${task.beanCharged} 积分）` +
            `连续 ${next} 次补偿失败，已停止自动重试，需要人工对账。原因：${task.errorMsg ?? '-'}`,
        )
      } else {
        console.warn(`[settle-compensate] 任务 ${task.id} 第 ${next} 次补偿失败，将重试`)
      }
    } catch (e) {
      result.stillPending += 1
      console.error(`[settle-compensate] 任务 ${task.id} 补偿异常:`, (e as Error).message)
    }
  }
  return result
}
