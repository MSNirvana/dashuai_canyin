/**
 * 一次性数据订正：补释放「任务已失败、但积分预留仍冻结」的悬空额度。
 *
 * 背景（这是一个已修掉的代码缺陷留下的存量）：
 *   worker 曾把任务 status 先写成 `FAILED`（`storeChatCutState`），随后 `failRender` 一看到
 *   `task.status === 'FAILED'` 就直接早退 —— `unfreeze` 从未执行。结果是：用户界面上任务是
 *   「合成失败」，但预留在 `bean_reservation` 里仍是 ACTIVE，账户 `frozen` 一直挂着这笔额度，
 *   用户的可用积分凭空少了，且没有任何调度会去捞它（stuck-sweeper 只扫活跃态与 SETTLEMENT_PENDING）。
 *
 * 判据（两个条件同时成立才算泄漏）：
 *   ① render_task.status = 'FAILED' 且 bean_charged > 0
 *   ② 对应 bean_reservation（merchantId + RENDER + requestId）仍有 reserved - consumed - released > 0
 *      —— 只看任务行是不够的：任务失败并不代表预留没释放，必须先算预留余额再决定动手。
 *
 * 处置：按**预留实际剩余额**释放（不是按 bean_charged —— 部分释放过的行按计划额释放会超释放）。
 * ⚠ `unfreeze` 以 (merchantId, bizType, requestId, type='UNFREEZE') 幂等：已有 UNFREEZE 流水时
 *   它会直接返回 duplicated，本脚本会把这种行单独列出来提示人工核对，而不是假装修好了。
 *
 * 跑法：npx tsx scripts/fix-failed-reservation-leak.ts          # 预演，只打印
 *       npx tsx scripts/fix-failed-reservation-leak.ts --write  # 落盘
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { unfreeze } from '../src/bean/bean.service.js'

const prisma = new PrismaClient()
const WRITE = process.argv.includes('--write')

interface Leak {
  taskId: bigint
  merchantId: bigint
  requestId: string
  beanCharged: bigint
  reserved: bigint
  consumed: bigint
  released: bigint
  remaining: bigint
  reservationStatus: string
  errorCode: string | null
}

async function main() {
  const tasks = await prisma.renderTask.findMany({
    where: { status: 'FAILED', beanCharged: { gt: 0n } },
    select: { id: true, merchantId: true, requestId: true, beanCharged: true, errorCode: true },
    orderBy: { id: 'asc' },
  })
  console.log(`[fix-reservation-leak] 扫描到 ${tasks.length} 条「失败且有计划扣费」的任务`)

  const leaks: Leak[] = []
  for (const t of tasks) {
    const requestId = t.requestId ?? t.id.toString()
    const res = await prisma.beanReservation.findFirst({
      where: { merchantId: t.merchantId, bizType: 'RENDER', requestId },
      select: { reserved: true, consumed: true, released: true, status: true },
    })
    if (!res) continue
    const remaining = res.reserved - res.consumed - res.released
    if (remaining <= 0n) continue
    leaks.push({
      taskId: t.id,
      merchantId: t.merchantId,
      requestId,
      beanCharged: t.beanCharged,
      reserved: res.reserved,
      consumed: res.consumed,
      released: res.released,
      remaining,
      reservationStatus: res.status,
      errorCode: t.errorCode,
    })
  }

  if (leaks.length === 0) {
    console.log('[fix-reservation-leak] 没有发现悬空冻结。')
    return
  }

  const total = leaks.reduce((acc, l) => acc + l.remaining, 0n)
  console.log(
    `[fix-reservation-leak] 发现 ${leaks.length} 条悬空冻结，合计 ${total.toString()} 积分` +
      `${WRITE ? '（--write 落盘）' : '（预演，加 --write 才写库）'}`,
  )
  for (const l of leaks) {
    console.log(
      `  任务 ${l.taskId} 商户 ${l.merchantId} 计划 ${l.beanCharged} 预留 ${l.reserved} ` +
        `已扣 ${l.consumed} 已释放 ${l.released} ⇒ 待释放 ${l.remaining}（预留状态 ${l.reservationStatus}，错误码 ${l.errorCode ?? '-'}）`,
    )
  }

  if (!WRITE) {
    console.log('[fix-reservation-leak] 预演结束，未改动任何数据。')
    return
  }

  let fixed = 0
  let manual = 0
  for (const l of leaks) {
    try {
      const r = await prisma.$transaction((tx) =>
        unfreeze(tx, {
          merchantId: l.merchantId,
          requestId: l.requestId,
          amount: l.remaining,
          bizType: 'RENDER',
          bizId: l.taskId.toString(),
          remark: '订正：失败任务遗留的预留冻结，补释放',
        }),
      )
      if (r.duplicated) {
        // 已有 UNFREEZE 流水 → unfreeze 幂等早退，这笔需要人工看账，不能当成修好了
        manual += 1
        console.warn(`  任务 ${l.taskId}：已存在 UNFREEZE 流水但仍显示待释放，跳过，需人工核对`)
      } else {
        fixed += 1
        console.log(`  任务 ${l.taskId}：已释放 ${l.remaining} 积分`)
      }
    } catch (e) {
      manual += 1
      console.error(`  任务 ${l.taskId}：释放失败 —— ${(e as Error).message}（需人工核对）`)
    }
  }
  console.log(`[fix-reservation-leak] 完成：补释放 ${fixed} 条，需人工核对 ${manual} 条。`)
}

main()
  .catch((e) => {
    console.error('[fix-reservation-leak] 执行失败:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
