// AI 场景编排：把「AI 网关调用」和「积分账务」串起来
// 计费时序：预冻结（标价 × buffer）→ 调用 → 成功按实际成本结算 / 失败全额解冻
// 铁律：AI 失败或超时一律不扣积分，返回兜底模板

import type { PrismaClient } from '@prisma/client'
import { AiGateway } from './gateway.js'
import * as bean from '../bean/bean.service.js'
import { BeanNotEnoughError, type BeanBucket } from '../bean/bean.service.js'
import { getDecimal } from '../lib/settings.js'
import { claimBusinessRequest, completeBusinessRequest, failBusinessRequest } from '../domain/request.js'
import { decFromNumber, decMulCeil, type Dec } from '../lib/decimal.js'

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
 * 积分 ← 成本 换算（纯整数，无浮点）：
 *   costFen 是「分」，beansPerYuan 是「1 元 = 多少积分」
 *   beans = ceil(costFen × beansPerYuan × costMultiplier / 100)
 *   默认 1 元 = 100 积分、乘数 4 时，beans = ceil(costFen × 4)
 *
 * 旧实现 `BigInt(Math.ceil((costFen / 100) * beansPerYuan * multiplier))` 有浮点误差：
 * IEEE754 下 7/100×100×4 = 28.000000000000004 → ceil = 29，凭空多扣 1 积分。
 * 实测成本 1~20000 分里有 1148 个取值（5.74%）被多扣 1 积分，且只会多扣不会少扣。
 */
function beansFromCost(costFen: number, beansPerYuan: Dec, multiplier: Dec): bigint {
  if (!Number.isSafeInteger(costFen) || costFen < 0) {
    throw new RangeError(`beansFromCost: costFen 必须是非负安全整数，实际 ${costFen}`)
  }
  if (costFen === 0) return 0n
  const costDec = decFromNumber(costFen)
  if (!costDec) throw new RangeError(`beansFromCost: costFen 无法解析，实际 ${costFen}`)
  return decMulCeil([costDec, beansPerYuan, multiplier], 100n)
}

export async function runBilledScene(
  prisma: PrismaClient,
  gateway: AiGateway,
  params: BilledSceneParams,
): Promise<BilledSceneResult> {
  const scene = await prisma.aiScene.findUnique({ where: { code: params.sceneCode } })
  if (!scene || !scene.enabled) throw new Error(`scene ${params.sceneCode} not available`)

  // 计费系数一律用精确十进制读取（getDecimal 直接解析库里的原始字符串，不经 Number()）
  const [beansPerYuan, multiplier] = await Promise.all([
    getDecimal(prisma, 'bean', 'points_per_yuan', 100),
    getDecimal(prisma, 'bean', 'cost_multiplier', 4),
  ])

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
    // 被场景单次上限截断的部分由平台承担。必须落库 + 告警，否则「上限是安全网还是
    // 常态折扣」在账上完全看不出来（实测 copy 系场景 10/10 次调用都被截掉 3 积分）。
    const absorbed = wantCharge > frozenAmount ? wantCharge - frozenAmount : 0n
    if (absorbed > 0n) {
      console.warn(
        `[ai-billing] 场景 ${params.sceneCode} 成本 ${costFen} 分应付 ${wantCharge} 积分，` +
          `被单次上限 ${frozenAmount} 积分截断，平台承担 ${absorbed} 积分（requestId=${params.requestId}）`,
      )
    }
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
        data: { beanCharged: cr.charged, absorbedBeans: absorbed, beanBucket: cr.bucket },
      })
      await completeBusinessRequest(tx, params.merchantId, operation, params.requestId, params.requestId)
      return cr
    })
  }

  // 请求占用与积分预留必须原子完成，进程退出时不会留下无预留的 PENDING 请求。
  // ★ isolationLevel 必须显式设为 READ COMMITTED：REPEATABLE READ 下并发同 requestId 时，
  //   claimBusinessRequest 命中 P2002 后的同事务重读会因旧快照返回 null 并重抛 P2002 → 5xx。
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
  }, { isolationLevel: 'ReadCommitted' })

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

  // 3) 失败 / 超时：全额解冻，返回兜底模板，不扣积分
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
