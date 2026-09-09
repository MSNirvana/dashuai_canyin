// AI 场景编排：把「AI 网关调用」和「AI豆账务」串起来
// 计费时序：预冻结（标价 × buffer）→ 调用 → 成功按实际成本结算 / 失败全额解冻
// 铁律：AI 失败或超时一律不扣豆，返回兜底模板

import type { PrismaClient } from '@prisma/client'
import { AiGateway } from './gateway.js'
import * as bean from '../bean/bean.service.js'
import { BeanNotEnoughError, type BeanBucket } from '../bean/bean.service.js'
import { getNumber } from '../lib/settings.js'

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
  const bizId = params.bizId ?? null

  // 1) 预冻结（余额不足直接抛 BEAN_NOT_ENOUGH，前端弹充值）
  const fr = await prisma.$transaction((tx) =>
    bean.freeze(tx, {
      merchantId: params.merchantId,
      requestId: params.requestId,
      amount: frozenAmount,
      bizType,
      bizId: bizId ?? undefined,
      remark: `${scene.name} 预留`,
    }),
  )

  const balanceAfter = async () => bean.getBalance(prisma, params.merchantId)

  // 幂等命中：已冻结的 requestId。
  //  - 若已完成（存在 aiCallLog）→ 返回首次结果，不重复扣豆
  //  - 否则（进行中或先前失败已释放）→ 抛 SCENE_PENDING，要求调用方换新的 requestId 重试
  //    绝不可返回空 text 的「伪成功」
  if (fr.duplicated) {
    const log = await prisma.aiCallLog.findFirst({ where: { requestId: params.requestId } })
    if (log) {
      const b = await balanceAfter()
      return {
        text: log.responseSnapshot ?? '',
        beanCharged: log.beanCharged ?? 0n,
        bucket: log.beanBucket === 'GRANT' ? 'GRANT' : log.beanBucket === 'RECHARGE' ? 'RECHARGE' : null,
        usedFallbackChannel: log.isFallback ?? false,
        isFallbackTemplate: false,
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
    await prisma.$transaction((tx) =>
      bean.unfreeze(tx, {
        merchantId: params.merchantId,
        requestId: params.requestId,
        amount: frozenAmount,
        bizType,
        bizId: bizId ?? undefined,
        remark: 'AI 调用失败，全额释放',
      }),
    )
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

  // 4) 成功：按「实际成本 × 系数」结算（v5 已废除固定标价），且不超过冻结上限
  const wantCharge = beansFromCost(r.costFen, beansPerYuan, multiplier)
  const charged = wantCharge > frozenAmount ? frozenAmount : wantCharge

  const res = await prisma.$transaction(async (tx) => {
    let cr: { charged: bigint; bucket: BeanBucket | null }
    if (charged > 0n) {
      const c = await bean.consume(tx, {
        merchantId: params.merchantId,
        requestId: params.requestId,
        amount: charged,
        bizType,
        bizId: bizId ?? undefined,
        remark: r.usedFallback ? `${scene.name}（备用通道）` : scene.name,
      })
      cr = { charged: c.charged, bucket: c.bucket }
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
      // 零成本调用（mock / 免费模型）：不扣费，冻结全额释放。
      // bean.consume 不接受 0 金额，跳过并记 0 费用流水
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
      where: { requestId: params.requestId },
      data: { beanCharged: cr.charged, beanBucket: cr.bucket },
    })
    return cr
  })

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
