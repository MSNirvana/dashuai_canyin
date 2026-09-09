// 管理后台 - AI 通道 / 模型 / 场景 CRUD 与联通性测试
// 通道密钥：写入用 AES-256-GCM 加密；读出仅返回脱敏掩码
import type { PrismaClient, Prisma } from '@prisma/client'
import { encryptSecret, decryptSecret, maskSecret } from '../lib/secret.js'
import { getAdapter } from '../ai/adapters.js'

export class AdminAiNotFoundError extends Error {
  constructor(readonly what: string) {
    super(`${what} 不存在`)
    this.name = 'AdminAiNotFoundError'
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

export async function listAiModels(prisma: PrismaClient, providerId?: bigint) {
  return prisma.aiModel.findMany({
    where: providerId ? { providerId } : undefined,
    orderBy: [{ providerId: 'asc' }, { modelCode: 'asc' }],
    include: { provider: { select: { code: true, name: true } } },
  })
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
  if (id) {
    return prisma.aiModel.update({
      where: { id },
      data: {
        providerId: input.providerId,
        modelCode: input.modelCode,
        displayName: input.displayName,
        capability: input.capability ?? 'TEXT',
        maxContextTokens: input.maxContextTokens ?? null,
        maxOutputTokens: input.maxOutputTokens ?? null,
        inputPricePerMtok: input.inputPricePerMtok,
        outputPricePerMtok: input.outputPricePerMtok,
        enabled: input.enabled ?? true,
      },
    })
  }
  return prisma.aiModel.create({
    data: {
      providerId: input.providerId,
      modelCode: input.modelCode,
      displayName: input.displayName,
      capability: input.capability ?? 'TEXT',
      maxContextTokens: input.maxContextTokens ?? null,
      maxOutputTokens: input.maxOutputTokens ?? null,
      inputPricePerMtok: input.inputPricePerMtok,
      outputPricePerMtok: input.outputPricePerMtok,
      enabled: input.enabled ?? true,
    },
  })
}

export async function removeAiModel(prisma: PrismaClient, id: bigint) {
  await prisma.$transaction([
    prisma.aiCallLog.deleteMany({ where: { modelId: id } }),
    prisma.aiModel.delete({ where: { id } }),
  ])
  return { id: id.toString(), removed: true }
}

// ──────────────────────── Scene ────────────────────────

export async function listAiScenes(prisma: PrismaClient) {
  return prisma.aiScene.findMany({ orderBy: { code: 'asc' } })
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
  if (id) return prisma.aiScene.update({ where: { id }, data })
  return prisma.aiScene.create({ data })
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
  const [list, total] = await Promise.all([
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
  return { list, total, page, pageSize }
}
