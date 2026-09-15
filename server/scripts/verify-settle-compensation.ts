// P1-2 结算悬空补偿验证（确定性版本：显式推进 now，不依赖真实等待）
import { prisma } from '../src/db.js'
import { sweepSettlementPending, compensateSettlementPending } from '../src/services/render.service.js'

const M = 1n
const MIN = 60_000
const base = new Date()

async function snapshot(label: string) {
  const acc = await prisma.beanAccount.findUnique({ where: { merchantId: M } })
  const tasks = await prisma.renderTask.findMany({
    where: { id: { gte: 990001n, lte: 990004n } },
    select: { id: true, status: true, retryCount: true, errorCode: true },
    orderBy: { id: 'asc' },
  })
  const unfreeze = await prisma.beanLedger.count({
    where: { merchantId: M, type: 'UNFREEZE', requestId: { startsWith: 'test-settle' } },
  })
  console.log(`\n【${label}】balance=${acc?.balance} frozen=${acc?.frozen}  相关 UNFREEZE 流水=${unfreeze}`)
  for (const t of tasks) {
    console.log(`  task ${t.id}  status=${String(t.status).padEnd(19)} retryCount=${t.retryCount}  errorCode=${t.errorCode}`)
  }
}

await snapshot('执行前')

// 990001 有预留 → 应恢复；990002 无预留 → 应重试；990003 已达上限 → 应放弃；990004 未过 grace → 不扫描
for (let round = 1; round <= 7; round++) {
  const now = new Date(base.getTime() + round * 10 * MIN)
  const r = await sweepSettlementPending(prisma, now)
  console.log(
    `\n>>> 第 ${round} 轮（now=+${round * 10}min）  扫描 ${r.scanned} / 恢复 ${r.recovered} / 仍待处理 ${r.stillPending} / 已放弃 ${r.gaveUp}`,
  )
  if (round === 1 || round === 6) await snapshot(`第 ${round} 轮后`)
}

console.log('\n>>> 幂等性：对已恢复的 990001 再补偿一次')
const direct = await compensateSettlementPending(prisma, 990001n)
console.log(`  返回 ${direct}（应为 SKIPPED，证明不会重复释放）`)
await snapshot('幂等复验后')

await prisma.$disconnect()
