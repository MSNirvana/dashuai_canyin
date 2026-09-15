// AI 网关：场景化调用 + 故障转移 + 熔断 + 成本核算
// 业务层只传 sceneCode，永不直接引用具体模型

import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'
import { AiCallError, getAdapter, type AiUsage } from './adapters.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { decryptSecret } from '../lib/secret.js'
import { ceilDiv } from '../lib/decimal.js'

export type SceneRunResult =
  | {
      ok: true
      text: string
      usage: AiUsage
      costFen: number
      providerId: bigint
      modelId: bigint
      modelCode: string
      usedFallback: boolean
      attempts: number
    }
  | {
      ok: false
      reason: 'SCENE_DISABLED' | 'NO_CANDIDATE' | 'ALL_FAILED'
      message: string
      attempts: number
    }

export interface RunSceneParams {
  sceneCode: string
  variables: Record<string, string>
  merchantId?: bigint
  requestId: string
}

/** 模板变量替换：{{key}} */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '')
}

/**
 * 成本（分）= ceil(输入 tokens × 输入分/百万 / 1e6) + ceil(输出 tokens × 输出分/百万 / 1e6)
 *
 * 用 BigInt 做除法再取整。价格字段在库里是 UnsignedInt，tokens 也是整数，
 * 所以当前实现其实是精确的；改 BigInt 是为了防止后续把 tokens 换成估算小数、
 * 或把价格改成小数字段时，`Math.ceil(浮点除法)` 出现「整数边界被舍入到略大 → 多扣 1 分」。
 */
export function computeCostFen(
  promptTokens: number,
  completionTokens: number,
  inputPricePerMtok: number,
  outputPricePerMtok: number,
): number {
  const per = 1_000_000n
  const fen =
    ceilDiv(safeNonNegInt(promptTokens) * safeNonNegInt(inputPricePerMtok), per) +
    ceilDiv(safeNonNegInt(completionTokens) * safeNonNegInt(outputPricePerMtok), per)
  const n = Number(fen)
  if (!Number.isSafeInteger(n)) throw new RangeError(`computeCostFen: 结果溢出 ${fen}`)
  return n
}

/** 把任意入参归一为非负安全整数：NaN / Infinity / 负数 / 小数一律按语义安全处理，绝不抛错 */
function safeNonNegInt(v: number): bigint {
  if (!Number.isFinite(v)) return 0n
  const t = Math.trunc(v)
  if (!Number.isSafeInteger(t) || t <= 0) return 0n
  return BigInt(t)
}

/**
 * 是否属于「通道级」故障 —— 即「换到备用通道才可能成功」的错误。
 *
 * 用于让网关**立即熔断**该通道，而不是干等 record() 的失败率熔断：
 * 后者要求滑动窗口内至少 minSamples(20) 个样本，低频场景几小时都攒不满，
 * 于是每次请求都要先在这个坏通道上耗掉一次超时（ai_scene.timeout_ms 默认 30s）
 * 才轮到备用 —— 「自动切换」名义上有、体验上没有。
 *
 * · TIMEOUT / NETWORK —— 连不上、超时
 * · HTTP 401 / 403    —— 密钥无效或无权
 * · HTTP 429          —— 限流
 * · HTTP 5xx          —— 对端故障
 *
 * 反例：BAD_RESPONSE（报文偶发异常）与其余 4xx（多半是请求本身的问题）——
 * 重试同一通道仍有成功可能，不该熔断。
 */
export function isChannelLevelFailure(err: AiCallError): boolean {
  if (err.code === 'TIMEOUT' || err.code === 'NETWORK') return true
  const s = err.status
  return s === 401 || s === 403 || s === 429 || (typeof s === 'number' && s >= 500)
}

export class AiGateway {
  constructor(
    private prisma: PrismaClient,
    private redis: Redis,
    private circuit: CircuitBreaker,
  ) {}

  async runScene(params: RunSceneParams): Promise<SceneRunResult> {
    const scene = await this.prisma.aiScene.findUnique({ where: { code: params.sceneCode } })
    if (!scene || !scene.enabled) {
      return { ok: false, reason: 'SCENE_DISABLED', message: `scene ${params.sceneCode} disabled`, attempts: 0 }
    }

    const fallbackIds = (Array.isArray(scene.fallbackModelIds) ? (scene.fallbackModelIds as unknown[]) : [])
      .map((v) => BigInt(v as number))
    const candidates = [scene.defaultModelId, ...fallbackIds]

    const prompt = renderTemplate(scene.promptTemplate, params.variables)
    let attempts = 0
    let lastError = ''

    for (let i = 0; i < candidates.length; i++) {
      const modelId = candidates[i]!
      const model = await this.prisma.aiModel.findUnique({
        where: { id: modelId },
        include: { provider: true },
      })
      if (!model || !model.enabled) continue

      const provider = model.provider
      if (!provider.enabled || provider.healthStatus === 'DOWN') continue
      if (await this.circuit.isOpen(provider.id)) continue
      if (
        provider.monthlyBudgetFen !== null &&
        provider.usedBudgetFen >= provider.monthlyBudgetFen
      ) {
        continue
      }

      const adapter = getAdapter(provider.protocol)
      const maxTry = scene.maxRetries + 1

      for (let t = 0; t < maxTry; t++) {
        attempts++
        const startedAt = Date.now()
        try {
          const res = await adapter({
            baseUrl: provider.baseUrl,
            apiKey: decryptSecret(provider.apiKeyEncrypted),
            model: model.modelCode,
            user: prompt,
            temperature: scene.temperature ? Number(scene.temperature) : undefined,
            maxOutputTokens: scene.maxOutputTokens ?? undefined,
            timeoutMs: scene.timeoutMs,
            sceneCode: scene.code,
          })

          const costFen = computeCostFen(
            res.usage.promptTokens,
            res.usage.completionTokens,
            model.inputPricePerMtok,
            model.outputPricePerMtok,
          )
          const latencyMs = Date.now() - startedAt

          await this.circuit.record(provider.id, true)
          await this.prisma.$transaction([
            this.prisma.aiProvider.update({
              where: { id: provider.id },
              data: { usedBudgetFen: { increment: costFen }, healthStatus: 'HEALTHY' },
            }),
            this.prisma.aiCallLog.create({
              data: {
                merchantId: params.merchantId,
                sceneCode: params.sceneCode,
                requestId: params.requestId,
                providerId: provider.id,
                modelId: model.id,
                isFallback: i > 0,
                fallbackFromModelId: i > 0 ? scene.defaultModelId : null,
                promptTokens: res.usage.promptTokens,
                completionTokens: res.usage.completionTokens,
                totalTokens: res.usage.promptTokens + res.usage.completionTokens,
                costFen,
                latencyMs,
                status: i > 0 ? 'FALLBACK_USED' : 'SUCCESS',
                promptSnapshot: prompt.slice(0, 8000),
                responseSnapshot: res.text.slice(0, 8000),
              },
            }),
          ])

          return {
            ok: true,
            text: res.text,
            usage: res.usage,
            costFen,
            providerId: provider.id,
            modelId: model.id,
            modelCode: model.modelCode,
            usedFallback: i > 0,
            attempts,
          }
        } catch (e) {
          const err = e as AiCallError
          lastError = `[${provider.code}/${model.modelCode}] ${err.message}`

          // 通道级硬故障：立即熔断该通道，并**放弃它剩余的重试**，直接换下一个候选。
          // 不能只依赖 record() 的失败率熔断（需 ≥20 样本，低频场景攒不满），
          // 更不能在这里重试 —— 否则主通道挂掉时，每个请求要连等 maxRetries+1 次超时。
          if (isChannelLevelFailure(err)) {
            await this.circuit.open(provider.id)
            await this.circuit.record(provider.id, false)
            break
          }

          await this.circuit.record(provider.id, false)
          if (t < maxTry - 1) await sleep(200 * (t + 1))
        }
      }
    }

    return {
      ok: false,
      reason: 'ALL_FAILED',
      message: lastError || 'no available provider',
      attempts,
    }
  }

  /** 后台通道测试：极短探测请求，不参与毛利统计，也不触发熔断阈值之外的副作用 */
  async testProvider(providerId: bigint, modelCode?: string): Promise<{
    status: 'SUCCESS' | 'FAILED'
    latencyMs: number
    modelReturned?: string
    promptTokens: number
    completionTokens: number
    estimatedCostFen: number
    errorMsg?: string
  }> {
    const provider = await this.prisma.aiProvider.findUnique({
      where: { id: providerId },
      include: { models: { where: { enabled: true }, take: 10 } },
    })
    if (!provider) {
      return { status: 'FAILED', latencyMs: 0, promptTokens: 0, completionTokens: 0, estimatedCostFen: 0, errorMsg: 'provider not found' }
    }
    const model = modelCode
      ? (provider.models.find((m) => m.modelCode === modelCode) ?? provider.models[0])
      : provider.models[0]
    if (!model) {
      return { status: 'FAILED', latencyMs: 0, promptTokens: 0, completionTokens: 0, estimatedCostFen: 0, errorMsg: 'no enabled model' }
    }

    const adapter = getAdapter(provider.protocol)
    const startedAt = Date.now()
    try {
      const res = await adapter({
        baseUrl: provider.baseUrl,
        apiKey: decryptSecret(provider.apiKeyEncrypted),
        model: model.modelCode,
        user: 'ping',
        maxOutputTokens: 16,
        timeoutMs: 10_000,
      })
      const latencyMs = Date.now() - startedAt
      const costFen = computeCostFen(
        res.usage.promptTokens,
        res.usage.completionTokens,
        model.inputPricePerMtok,
        model.outputPricePerMtok,
      )
      await this.prisma.aiProvider.update({
        where: { id: provider.id },
        data: {
          lastTestAt: new Date(),
          lastTestLatencyMs: latencyMs,
          lastTestStatus: 'SUCCESS',
          lastTestError: null,
        },
      })
      await this.prisma.aiCallLog.create({
        data: {
          sceneCode: 'PROVIDER_TEST',
          requestId: `test-${provider.id}-${Date.now()}`,
          providerId: provider.id,
          modelId: model.id,
          promptTokens: res.usage.promptTokens,
          completionTokens: res.usage.completionTokens,
          totalTokens: res.usage.promptTokens + res.usage.completionTokens,
          costFen,
          latencyMs,
          status: 'TEST',
        },
      })
      return {
        status: 'SUCCESS',
        latencyMs,
        modelReturned: res.modelReturned ?? model.modelCode,
        promptTokens: res.usage.promptTokens,
        completionTokens: res.usage.completionTokens,
        estimatedCostFen: costFen,
      }
    } catch (e) {
      const err = e as Error
      const latencyMs = Date.now() - startedAt
      await this.prisma.aiProvider.update({
        where: { id: provider.id },
        data: {
          lastTestAt: new Date(),
          lastTestLatencyMs: latencyMs,
          lastTestStatus: 'FAILED',
          lastTestError: err.message.slice(0, 500),
        },
      })
      return {
        status: 'FAILED',
        latencyMs,
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostFen: 0,
        errorMsg: err.message.slice(0, 500),
      }
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
