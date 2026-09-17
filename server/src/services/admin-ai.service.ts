// 管理后台 - AI 通道 / 模型 / 场景 CRUD 与联通性测试
// 通道密钥：写入用 AES-256-GCM 加密；读出仅返回脱敏掩码
//
// ⚠ 序列化铁律：AiModel / AiScene 含 BigInt 主键与外键（id / providerId / defaultModelId / beanPrice），
// 直接 res.json() 会抛 `TypeError: Do not know how to serialize a BigInt`，导致接口 500、后台列表全空。
// 所有对外返回必须经过 modelView() / sceneView() 转换成「BigInt → string、Date → ISO」的纯 JSON 结构。
import type { PrismaClient, Prisma, AiModel, AiScene } from '@prisma/client'
import { encryptSecret, decryptSecret, maskSecret } from '../lib/secret.js'
import { getAdapter } from '../ai/adapters.js'
import { LIVE_SCENE_CODES } from '../ai/scene-codes.js'
import { validateTemplate, SCENE_VARIABLES } from '../ai/prompt-vars.js'

export class AdminAiNotFoundError extends Error {
  constructor(readonly what: string) {
    super(`${what} 不存在`)
    this.name = 'AdminAiNotFoundError'
  }
}

/**
 * 提示词模板里出现了该场景不支持的占位符。
 * 为什么必须拦：网关做的是字符串替换，取不到的变量替换成空串 —— 不报错、提示词那一段
 * 变成空白、这次调用照常扣积分。后台手抖写成 {{dishname}}（大小写）或 {{store.intro}}（点号）
 * 都会命中，用户只看到「生成的文案莫名其妙少了一段」。
 */
export class AdminAiInvalidTemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdminAiInvalidTemplateError'
  }
}

function bigintArray(v: unknown): bigint[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => BigInt(x as number | string)).filter((n) => Number.isFinite(Number(n)))
}

// ──────────────────────── Provider ────────────────────────

export interface AiProviderView {
  id: string
  code: string
  name: string
  providerType: string
  protocol: string
  baseUrl: string
  apiKeyMasked: string | null
  enabled: boolean
  priority: number
  healthStatus: string
  circuitOpenUntil: string | null
  lastTestAt: string | null
  lastTestLatencyMs: number | null
  lastTestStatus: string | null
  lastTestError: string | null
  monthlyBudgetFen: number | null
  usedBudgetFen: number
  budgetResetAt: string | null
  createdAt: string
}

function providerView(p: {
  id: bigint
  code: string
  name: string
  providerType: string
  protocol: string
  baseUrl: string
  apiKeyMasked: string | null
  enabled: boolean
  priority: number
  healthStatus: string
  circuitOpenUntil: Date | null
  lastTestAt: Date | null
  lastTestLatencyMs: number | null
  lastTestStatus: string | null
  lastTestError: string | null
  monthlyBudgetFen: number | null
  usedBudgetFen: number
  budgetResetAt: Date | null
  createdAt: Date
}): AiProviderView {
  return {
    id: p.id.toString(),
    code: p.code,
    name: p.name,
    providerType: p.providerType,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    apiKeyMasked: p.apiKeyMasked,
    enabled: p.enabled,
    priority: p.priority,
    healthStatus: p.healthStatus,
    circuitOpenUntil: p.circuitOpenUntil?.toISOString() ?? null,
    lastTestAt: p.lastTestAt?.toISOString() ?? null,
    lastTestLatencyMs: p.lastTestLatencyMs,
    lastTestStatus: p.lastTestStatus,
    lastTestError: p.lastTestError,
    monthlyBudgetFen: p.monthlyBudgetFen,
    usedBudgetFen: p.usedBudgetFen,
    budgetResetAt: p.budgetResetAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  }
}

const providerSelect = {
  id: true,
  code: true,
  name: true,
  providerType: true,
  protocol: true,
  baseUrl: true,
  apiKeyMasked: true,
  enabled: true,
  priority: true,
  healthStatus: true,
  circuitOpenUntil: true,
  lastTestAt: true,
  lastTestLatencyMs: true,
  lastTestStatus: true,
  lastTestError: true,
  monthlyBudgetFen: true,
  usedBudgetFen: true,
  budgetResetAt: true,
  createdAt: true,
} as const

export async function listAiProviders(prisma: PrismaClient) {
  const rows = await prisma.aiProvider.findMany({ orderBy: [{ enabled: 'desc' }, { priority: 'asc' }] })
  return rows.map(providerView)
}

export async function upsertAiProvider(
  prisma: PrismaClient,
  id: bigint | undefined,
  input: {
    code: string
    name: string
    providerType: string
    protocol?: 'OPENAI_COMPATIBLE' | 'ANTHROPIC_NATIVE'
    baseUrl: string
    apiKey?: string
    enabled?: boolean
    priority?: number
    monthlyBudgetFen?: number | null
  },
) {
  const data: Prisma.AiProviderUncheckedCreateInput | Prisma.AiProviderUncheckedUpdateInput = {
    code: input.code,
    name: input.name,
    providerType: input.providerType,
    protocol: input.protocol ?? 'OPENAI_COMPATIBLE',
    baseUrl: input.baseUrl,
    enabled: input.enabled ?? true,
    priority: input.priority ?? 100,
    monthlyBudgetFen: input.monthlyBudgetFen ?? null,
  }
  if (input.apiKey !== undefined && input.apiKey !== '') {
    const enc = encryptSecret(input.apiKey)
    ;(data as Prisma.AiProviderUncheckedCreateInput).apiKeyEncrypted = enc
    ;(data as Prisma.AiProviderUncheckedCreateInput).apiKeyMasked = maskSecret(input.apiKey)
  }
  if (id) {
    return providerView(await prisma.aiProvider.update({ where: { id }, data, select: providerSelect }))
  }
  return providerView(
    await prisma.aiProvider.create({
      data: data as Prisma.AiProviderUncheckedCreateInput,
      select: providerSelect,
    }),
  )
}

export async function removeAiProvider(prisma: PrismaClient, id: bigint) {
  // 删除前清依赖（model / log）使用事务
  await prisma.$transaction([
    prisma.aiCallLog.deleteMany({ where: { providerId: id } }),
    prisma.aiModel.deleteMany({ where: { providerId: id } }),
    prisma.aiProvider.delete({ where: { id } }),
  ])
  return { id: id.toString(), removed: true }
}

export async function setAiProviderEnabled(
  prisma: PrismaClient,
  id: bigint,
  enabled: boolean,
) {
  return providerView(
    await prisma.aiProvider.update({
      where: { id },
      data: { enabled },
      select: providerSelect,
    }),
  )
}

export interface TestProviderResult {
  ok: boolean
  latencyMs: number
  modelReturned: string | null
  promptTokens: number
  completionTokens: number
  errorCode: string | null
  errorMsg: string | null
}

export async function testAiProvider(
  prisma: PrismaClient,
  id: bigint,
  modelCode: string,
): Promise<TestProviderResult> {
  const provider = await prisma.aiProvider.findUnique({
    where: { id },
    include: { models: { where: { modelCode, enabled: true }, take: 1 } },
  })
  if (!provider) throw new AdminAiNotFoundError('AI 通道')
  const model = provider.models[0]
  if (!model) throw new AdminAiNotFoundError(`模型 ${modelCode}`)

  const apiKey = decryptSecret(provider.apiKeyEncrypted)
  const adapter = getAdapter(provider.protocol)
  const startedAt = Date.now()
  try {
    const { text, usage } = await adapter({
      baseUrl: provider.baseUrl,
      apiKey,
      model: model.modelCode,
      user: 'ping',
      temperature: 0,
      maxOutputTokens: 16,
      timeoutMs: 10_000,
      sceneCode: 'TEST',
    })
    const latencyMs = Date.now() - startedAt
    const result: TestProviderResult = {
      ok: true,
      latencyMs,
      modelReturned: text ? model.modelCode : null,
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      errorCode: null,
      errorMsg: null,
    }
    // 不影响熔断器；仅写回 last_test_* 并写一条 TEST 日志
    await prisma.$transaction([
      prisma.aiProvider.update({
        where: { id },
        data: {
          lastTestAt: new Date(),
          lastTestLatencyMs: latencyMs,
          lastTestStatus: 'SUCCESS',
          lastTestError: null,
        },
      }),
      prisma.aiCallLog.create({
        data: {
          merchantId: null,
          sceneCode: 'TEST',
          requestId: `test:${id}:${Date.now()}`,
          providerId: id,
          modelId: model.id,
          isFallback: false,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.promptTokens + result.completionTokens,
          costFen: 0,
          beanCharged: 0n,
          latencyMs,
          status: 'TEST',
          errorCode: null,
          errorMsg: null,
        },
      }),
    ])
    return result
  } catch (e) {
    const latencyMs = Date.now() - startedAt
    const msg = e instanceof Error ? e.message : String(e)
    await prisma.aiProvider.update({
      where: { id },
      data: {
        lastTestAt: new Date(),
        lastTestLatencyMs: latencyMs,
        lastTestStatus: 'FAILED',
        lastTestError: msg.slice(0, 500),
      },
    })
    return {
      ok: false,
      latencyMs,
      modelReturned: null,
      promptTokens: 0,
      completionTokens: 0,
      errorCode: 'PROVIDER_TEST_FAIL',
      errorMsg: msg.slice(0, 500),
    }
  }
}

// ──────────────────────── Model ────────────────────────

export interface AiModelView {
  id: string
  providerId: string
  modelCode: string
  displayName: string
  capability: string
  maxContextTokens: number | null
  maxOutputTokens: number | null
  inputPricePerMtok: number
  outputPricePerMtok: number
  enabled: boolean
  createdAt: string
  updatedAt: string
  provider?: { code: string; name: string }
}

/** 把 Prisma AiModel（含 BigInt / Date）转成可 JSON 序列化的视图对象 */
export function modelView(m: AiModel & { provider?: { code: string; name: string } }): AiModelView {
  return {
    id: m.id.toString(),
    providerId: m.providerId.toString(),
    modelCode: m.modelCode,
    displayName: m.displayName,
    capability: m.capability,
    maxContextTokens: m.maxContextTokens,
    maxOutputTokens: m.maxOutputTokens,
    inputPricePerMtok: m.inputPricePerMtok,
    outputPricePerMtok: m.outputPricePerMtok,
    enabled: m.enabled,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    ...(m.provider ? { provider: { code: m.provider.code, name: m.provider.name } } : {}),
  }
}

export async function listAiModels(prisma: PrismaClient, providerId?: bigint) {
  const rows = await prisma.aiModel.findMany({
    where: providerId ? { providerId } : undefined,
    orderBy: [{ providerId: 'asc' }, { modelCode: 'asc' }],
    include: { provider: { select: { code: true, name: true } } },
  })
  return rows.map(modelView)
}

export async function upsertAiModel(
  prisma: PrismaClient,
  id: bigint | undefined,
  input: {
    providerId: bigint
    modelCode: string
    displayName: string
    capability?: string
    maxContextTokens?: number | null
    maxOutputTokens?: number | null
    inputPricePerMtok: number
    outputPricePerMtok: number
    enabled?: boolean
  },
) {
  const data = {
    providerId: input.providerId,
    modelCode: input.modelCode,
    displayName: input.displayName,
    capability: input.capability ?? 'TEXT',
    maxContextTokens: input.maxContextTokens ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    inputPricePerMtok: input.inputPricePerMtok,
    outputPricePerMtok: input.outputPricePerMtok,
    enabled: input.enabled ?? true,
  }
  const include = { provider: { select: { code: true, name: true } } } as const
  if (id) {
    return modelView(await prisma.aiModel.update({ where: { id }, data, include }))
  }
  return modelView(await prisma.aiModel.create({ data, include }))
}

export async function removeAiModel(prisma: PrismaClient, id: bigint) {
  await prisma.$transaction([
    prisma.aiCallLog.deleteMany({ where: { modelId: id } }),
    prisma.aiModel.delete({ where: { id } }),
  ])
  return { id: id.toString(), removed: true }
}

// ──────────────────────── Scene ────────────────────────

export interface AiSceneView {
  id: string
  code: string
  name: string
  promptTemplate: string
  fallbackTemplate: string | null
  defaultModelId: string
  fallbackModelIds: string[]
  beanPrice: string
  timeoutMs: number
  maxRetries: number
  temperature: number | null
  maxOutputTokens: number | null
  enabled: boolean
  createdAt: string
  updatedAt: string
  /** 代码里是否有业务调用方（true=已接入，false=待接入）；列表接口返回 */
  hasCaller?: boolean
  /** 该场景支持的提示词变量白名单（保存时按它校验；空数组=未登记，不校验）；列表接口返回 */
  variables?: string[]
  /** 历史上被调用的次数（来自 ai_call_log）；列表接口返回 */
  callCount?: number
  /** 附带的模型展示信息，避免前端拿裸 ID 展示（列表接口返回） */
  defaultModel?: AiModelView | null
  fallbackModels?: AiModelView[]
}

/** 把 Prisma AiScene（含 BigInt / Decimal / Json）转成可 JSON 序列化的视图对象 */
export function sceneView(s: AiScene): AiSceneView {
  return {
    id: s.id.toString(),
    code: s.code,
    name: s.name,
    promptTemplate: s.promptTemplate,
    fallbackTemplate: s.fallbackTemplate,
    defaultModelId: s.defaultModelId.toString(),
    fallbackModelIds: Array.isArray(s.fallbackModelIds)
      ? (s.fallbackModelIds as unknown[]).map((v) => String(v))
      : [],
    beanPrice: s.beanPrice.toString(),
    timeoutMs: s.timeoutMs,
    maxRetries: s.maxRetries,
    temperature: s.temperature === null || s.temperature === undefined ? null : Number(s.temperature),
    maxOutputTokens: s.maxOutputTokens,
    enabled: s.enabled,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}

/** 安全地把 Json 字段里的一项转成 BigInt（非法值返回 null） */
function toBigIntOrNull(v: unknown): bigint | null {
  try {
    return BigInt(v as string | number)
  } catch {
    return null
  }
}

export async function listAiScenes(prisma: PrismaClient) {
  const rows = await prisma.aiScene.findMany({ orderBy: { code: 'asc' } })
  // 收集所有被引用的模型 id（默认 + 备用），一次查询补齐展示信息
  const ids = new Set<bigint>()
  for (const s of rows) {
    ids.add(s.defaultModelId)
    if (Array.isArray(s.fallbackModelIds)) {
      for (const v of s.fallbackModelIds as unknown[]) {
        const id = toBigIntOrNull(v)
        if (id !== null) ids.add(id)
      }
    }
  }
  const [models, callStats] = await Promise.all([
    ids.size
      ? prisma.aiModel.findMany({
          where: { id: { in: [...ids] } },
          include: { provider: { select: { code: true, name: true } } },
        })
      : Promise.resolve([]),
    prisma.aiCallLog.groupBy({
      by: ['sceneCode'],
      _count: { sceneCode: true },
    }),
  ])
  const modelMap = new Map(models.map((m) => [m.id.toString(), modelView(m)]))
  const callMap = new Map(callStats.map((c) => [c.sceneCode, c._count.sceneCode]))
  return rows.map((s) => {
    const v = sceneView(s)
    return {
      ...v,
      hasCaller: (LIVE_SCENE_CODES as readonly string[]).includes(s.code),
      variables: [...(SCENE_VARIABLES[s.code] ?? [])],
      callCount: callMap.get(s.code) ?? 0,
      defaultModel: modelMap.get(v.defaultModelId) ?? null,
      fallbackModels: v.fallbackModelIds
        .map((id) => modelMap.get(id))
        .filter((m): m is AiModelView => m !== undefined),
    }
  })
}

export async function upsertAiScene(
  prisma: PrismaClient,
  id: bigint | undefined,
  input: {
    code: string
    name: string
    promptTemplate: string
    fallbackTemplate?: string | null
    defaultModelId: bigint
    fallbackModelIds: bigint[]
    beanPrice: bigint
    timeoutMs?: number
    maxRetries?: number
    temperature?: number | null
    maxOutputTokens?: number | null
    enabled?: boolean
  },
) {
  // 保存前按变量契约校验模板：未支持的变量运行时会被静默替换成空串（不报错但照常扣积分），
  // 写法不合法的占位符则会原样留在提示词里。两者都属于「不报错、只错内容」，必须在这里拦死。
  const problems = validateTemplate(input.code, input.promptTemplate)
  if (problems.length) {
    throw new AdminAiInvalidTemplateError(
      `提示词模板校验不通过：${problems.join('；')}。` +
        `未支持的变量在生成时会被替换成空串，不报错但这次调用照常扣积分。`,
    )
  }
  const data = {
    code: input.code,
    name: input.name,
    promptTemplate: input.promptTemplate,
    fallbackTemplate: input.fallbackTemplate ?? null,
    defaultModelId: input.defaultModelId,
    fallbackModelIds: input.fallbackModelIds as unknown as Prisma.InputJsonValue,
    beanPrice: input.beanPrice,
    timeoutMs: input.timeoutMs ?? 30_000,
    maxRetries: input.maxRetries ?? 2,
    temperature: input.temperature ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    enabled: input.enabled ?? true,
  }
  if (id) return sceneView(await prisma.aiScene.update({ where: { id }, data }))
  return sceneView(await prisma.aiScene.create({ data }))
}

export async function removeAiScene(prisma: PrismaClient, id: bigint) {
  const r = await prisma.aiScene.deleteMany({ where: { id } })
  if (r.count === 0) throw new AdminAiNotFoundError('AI 场景')
  return { id: id.toString(), removed: true }
}

export { bigintArray }

// ──────────────────────── Call Log ────────────────────────

export async function adminListAiCallLogs(
  prisma: PrismaClient,
  q: {
    providerId?: bigint
    merchantId?: bigint
    sceneCode?: string
    status?: string
    page?: number
    pageSize?: number
  },
) {
  const page = q.page ?? 1
  const pageSize = Math.min(q.pageSize ?? 20, 100)
  const where: Prisma.AiCallLogWhereInput = {
    ...(q.providerId ? { providerId: q.providerId } : {}),
    ...(q.merchantId ? { merchantId: q.merchantId } : {}),
    ...(q.sceneCode ? { sceneCode: q.sceneCode } : {}),
    ...(q.status ? { status: q.status } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.aiCallLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        merchant: { select: { phone: true, nickname: true } },
        provider: { select: { code: true, name: true } },
        model: { select: { modelCode: true, displayName: true } },
      },
    }),
    prisma.aiCallLog.count({ where }),
  ])
  return { list: rows.map(callLogView), total, page, pageSize }
}

/** AiCallLog 含多个 BigInt 字段，必须转成 string 才能被 res.json() 序列化 */
function callLogView(l: {
  id: bigint
  merchantId: bigint | null
  sceneCode: string
  requestId: string
  providerId: bigint
  modelId: bigint
  isFallback: boolean
  fallbackFromModelId: bigint | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costFen: number
  beanCharged: bigint
  beanBucket: string | null
  latencyMs: number
  status: string
  errorCode: string | null
  errorMsg: string | null
  promptSnapshot: string | null
  responseSnapshot: string | null
  createdAt: Date
  merchant?: { phone: string; nickname: string | null } | null
  provider?: { code: string; name: string }
  model?: { modelCode: string; displayName: string }
}) {
  return {
    id: l.id.toString(),
    merchantId: l.merchantId?.toString() ?? null,
    sceneCode: l.sceneCode,
    requestId: l.requestId,
    providerId: l.providerId.toString(),
    modelId: l.modelId.toString(),
    isFallback: l.isFallback,
    fallbackFromModelId: l.fallbackFromModelId?.toString() ?? null,
    promptTokens: l.promptTokens,
    completionTokens: l.completionTokens,
    totalTokens: l.totalTokens,
    costFen: l.costFen,
    beanCharged: l.beanCharged.toString(),
    beanBucket: l.beanBucket,
    latencyMs: l.latencyMs,
    status: l.status,
    errorCode: l.errorCode,
    errorMsg: l.errorMsg,
    promptSnapshot: l.promptSnapshot,
    responseSnapshot: l.responseSnapshot,
    createdAt: l.createdAt.toISOString(),
    merchant: l.merchant ?? null,
    provider: l.provider ?? null,
    model: l.model ?? null,
  }
}
