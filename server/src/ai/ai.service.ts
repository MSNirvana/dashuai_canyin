// AI 场景编排：把「AI 网关调用」和「AI豆账务」串起来
// 计费时序：预冻结（标价 × buffer）→ 调用 → 成功按实际成本结算 / 失败全额解冻
// 铁律：AI 失败或超时一律不扣豆，返回兜底模板

import type { PrismaClient } from '@prisma/client'
import { AiGateway } from './gateway.js'
import * as bean from '../bean/bean.service.js'
import { BeanNotEnoughError, type BeanBucket } from '../bean/bean.service.js'
import { getNumber } from '../lib/settings.js'
import { claimBusinessRequest, completeBusinessRequest, failBusinessRequest } from '../domain/request.js'

export interface BilledSceneResult {
  text: string
  beanCharged: bigint
  bucket: BeanBucket | null
  usedFallbackChannel: boolean
  isFallbackTemplate: boolean
  balance: { balance: bigint; grantBalance: bigint; available: bigint }
  duplicated: boolean
}

export interface BilledSceneParams {
  sceneCode: string
  merchantId: bigint
  requestId: string
  variables: Record<string, string>
  bizId?: string
}

/**
 * 豆 ← 成本 换算：
 *   costFen 是「分」，beansPerYuan 是「1 元 = 多少豆」
 *   beans = ceil(costFen / 100 * beansPerYuan * costMultiplier)
 *   默认 1 元 = 100 豆时，1 分 = 1 豆，即 beans = ceil(costFen * multiplier)
 */
function beansFromCost(costFen: number, beansPerYuan: number, multiplier: number): bigint {
  return BigInt(Math.ceil(((costFen / 100) * beansPerYuan * multiplier)))
}

export async function runBilledScene(
  prisma: PrismaClient,
  gateway: AiGateway,
  params: BilledSceneParams,
): Promise<BilledSceneResult> {
  const scene = await prisma.aiScene.findUnique({ where: { code: params.sceneCode } })
  if (!scene || !scene.enabled) throw new Error(`scene ${params.sceneCode} not available`)

  const [beansPerYuan, multiplierRaw] = await Promise.all([
    getNumber(prisma, 'bean', 'points_per_yuan', 100),
    getNumber(prisma, 'bean', 'cost_multiplier', 4),
  ])
  const multiplier = multiplierRaw

  // 冻结额 = 场景「单次上限」（财务安全网）。实际按成本×系数结算，恒不超过该上限
  const price = scene.beanPrice
  const frozenAmount = price
  const bizType = `AI_${params.sceneCode}`
  const operation = params.sceneCode === 'copy_generate'
    ? 'AI_COPY'
    : params.sceneCode === 'storyboard_generate'
      ? 'AI_STORYBOARD'
      : `AI_${params.sceneCode.toUpperCase()}`
  const bizId = params.bizId ?? null

  const balanceAfter = async () => bean.getBalance(prisma, params.merchantId)

  const settle = async (costFen: number, usedFallback: boolean) => {
    const wantCharge = beansFromCost(costFen, beansPerYuan, multiplier)
    const charged = wantCharge > frozenAmount ? frozenAmount : wantCharge
    return prisma.$transaction(async (tx) => {
      let cr: { charged: bigint; bucket: BeanBucket | null }
      if (charged > 0n) {
        const consumed = await bean.consume(tx, {
          merchantId: params.merchantId,
          requestId: params.requestId,
          amount: charged,
          bizType,
          bizId: bizId ?? undefined,
          remark: usedFallback ? `${scene.name}（备用通道）` : scene.name,
        })
        cr = { charged: consumed.charged, bucket: consumed.bucket }
        if (frozenAmount > charged) {
          await bean.unfreeze(tx, {
            merchantId: params.merchantId,
            requestId: params.requestId,
            amount: frozenAmount - charged,
            bizType,
            bizId: bizId ?? undefined,
            remark: '结算后差额释放',
          })
        }
      } else {
        await bean.unfreeze(tx, {
          merchantId: params.merchantId,
          requestId: params.requestId,
          amount: frozenAmount,
          bizType,
          bizId: bizId ?? undefined,
          remark: '零成本调用，全额释放',
        })
        cr = { charged: 0n, bucket: null }
      }
      await tx.aiCallLog.updateMany({
        where: { merchantId: params.merchantId, sceneCode: params.sceneCode, requestId: params.requestId },
        data: { beanCharged: cr.charged, beanBucket: cr.bucket },
      })
      await completeBusinessRequest(tx, params.merchantId, operation, params.requestId, params.requestId)
      return cr
    })
  }

  // 请求占用与积分预留必须原子完成，进程退出时不会留下无预留的 PENDING 请求。
  const claim = await prisma.$transaction(async (tx) => {
    const result = await claimBusinessRequest(tx, {
      merchantId: params.merchantId,
      operation,
      requestId: params.requestId,
      payload: { sceneCode: params.sceneCode, variables: params.variables, bizId },
      resourceType: 'CREATION',
      resourceId: params.bizId ? BigInt(params.bizId) : undefined,
    })
    if (result.created) {
      await bean.freeze(tx, {
        merchantId: params.merchantId,
        requestId: params.requestId,
        amount: frozenAmount,
        bizType,
        bizId: bizId ?? undefined,
        remark: `${scene.name} 预留`,
      })
    }
    return result
  })

  // 已有相同业务请求时先返回结果或报告进行中，不能再次创建冻结。
  if (!claim.created) {
    const log = await prisma.aiCallLog.findFirst({ where: { merchantId: params.merchantId, sceneCode: params.sceneCode, requestId: params.requestId } })
    if (log) {
      const settled = claim.row.status === 'COMPLETED'
        ? {
            charged: log.beanCharged ?? 0n,
            bucket: log.beanBucket === 'GRANT' ? 'GRANT' as const : log.beanBucket === 'RECHARGE' ? 'RECHARGE' as const : null,
          }
        : await settle(log.costFen, log.isFallback)
      const b = await balanceAfter()
      return {
        text: log.responseSnapshot ?? '',
        beanCharged: settled.charged,
        bucket: settled.bucket,
        usedFallbackChannel: log.isFallback ?? false,
        isFallbackTemplate: false,
        balance: { balance: b.balance, grantBalance: b.grantBalance, available: b.available },
        duplicated: true,
      }
    }
    if (claim.row.status === 'FAILED') {
      const b = await balanceAfter()
      return {
        text: renderFallback(scene.fallbackTemplate, params.variables),
        beanCharged: 0n,
        bucket: null,
        usedFallbackChannel: false,
        isFallbackTemplate: true,
        balance: { balance: b.balance, grantBalance: b.grantBalance, available: b.available },
        duplicated: true,
      }
    }
    throw new ScenePendingError()
  }

  // 2) 调用 AI 网关（含故障转移与熔断）
  const r = await gateway.runScene({
    sceneCode: params.sceneCode,
    variables: params.variables,
    merchantId: params.merchantId,
    requestId: params.requestId,
  })

  // 3) 失败 / 超时：全额解冻，返回兜底模板，不扣豆
  if (!r.ok) {
    await prisma.$transaction(async (tx) => {
      await bean.unfreeze(tx, {
        merchantId: params.merchantId,
        requestId: params.requestId,
        amount: frozenAmount,
        bizType,
        bizId: bizId ?? undefined,
        remark: 'AI 调用失败，全额释放',
      })
      await failBusinessRequest(tx, params.merchantId, operation, params.requestId, 'AI_FAILED', r.message)
    })
    const b = await balanceAfter()
    return {
      text: renderFallback(scene.fallbackTemplate, params.variables),
      beanCharged: 0n,
      bucket: null,
      usedFallbackChannel: false,
      isFallbackTemplate: true,
      balance: { balance: b.balance, grantBalance: b.grantBalance, available: b.available },
      duplicated: false,
    }
  }

  // 4) 成功：按实际成本结算，并与业务请求完成状态同事务提交。
  const res = await settle(r.costFen, r.usedFallback)

  const b = await balanceAfter()
  return {
    text: r.text,
    beanCharged: res.charged,
    bucket: res.bucket,
    usedFallbackChannel: r.usedFallback,
    isFallbackTemplate: false,
    balance: { balance: b.balance, grantBalance: b.grantBalance, available: b.available },
    duplicated: false,
  }
}

function renderFallback(tpl: string | null, vars: Record<string, string>): string {
  if (!tpl) return ''
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '')
}

export { BeanNotEnoughError }

/**
 * 幂等未完成信号：同一 requestId 已冻结但无完成记录（进行中或先前失败已释放）。
 * 调用方应改用「新的 requestId」重试，不要把它当成成功返回。
 */
export class ScenePendingError extends Error {
  readonly code = 'SCENE_PENDING'
  constructor(message = 'request in progress or previously failed; retry with a new requestId') {
    super(message)
    this.name = 'ScenePendingError'
  }
}
