// AI 网关：场景化调用 + 故障转移 + 熔断 + 成本核算
// 业务层只传 sceneCode，永不直接引用具体模型

import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'
import { AiCallError, getAdapter, type AiUsage } from './adapters.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { decryptSecret } from '../lib/secret.js'

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

/** 成本（分）= 输入分/百万 * tokens + 输出分/百万 * tokens，整数运算杜绝浮点误差 */
export function computeCostFen(
  promptTokens: number,
  completionTokens: number,
  inputPricePerMtok: number,
  outputPricePerMtok: number,
): number {
  return (
    Math.ceil((promptTokens * inputPricePerMtok) / 1_000_000) +
    Math.ceil((completionTokens * outputPricePerMtok) / 1_000_000)
  )
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
