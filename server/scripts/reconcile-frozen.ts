// 「冻结积分」对账工具。
//
// 背景（为什么需要它）：
//   bean_account.frozen 是**增量计数器**（freeze +A / consume -A / unfreeze -A），
//   不是从 bean_reservation 推导出来的。一旦某次 freeze 成功、而配对的 consume/unfreeze
//   因进程崩溃、历史版本 bug 或人工改库而丢失，frozen 就会永久偏高 —— 表现是用户
//   可用余额凭空少一截，且没有任何报错。这是「冻结泄漏」整类风险的兜底手段。
//
// 不变式：
//   frozen == Σ(所有预留的 reserved - consumed - released)
//   终态预留（CONSUMED / RELEASED）该项为 0，只有 ACTIVE 且有未结余额的才贡献冻结量。
//
// 实测发现：本机开发库 merchant 1 存在 frozen=10 的历史脏数据（2026-09-08 开发初期的
//   FREEZE 流水 amount=0 却把 frozen 抬了 5+5），当期代码已不可能产生（create+freeze 同事务）。
//
// 默认只读；加 --fix 才写库。
//
// 跑法：
//   npm run frozen:reconcile          # 只报告
//   npm run frozen:reconcile -- --fix # 报告并修正
import { prisma } from '../src/db.js'

const FIX = process.argv.includes('--fix')

interface Drift {
  merchantId: bigint
  accountFrozen: bigint
  expectedFrozen: bigint
  drift: bigint
  availableBefore: bigint
  availableAfter: bigint
  activeReservations: number
}

async function scan(): Promise<Drift[]> {
  const accounts = await prisma.beanAccount.findMany({
    select: { merchantId: true, balance: true, grantBalance: true, frozen: true },
  })
  // 一次性把全部预留拉进内存聚合：单商家预留量级在万级以内，比 N+1 查询更快
  const reservations = await prisma.beanReservation.findMany({
    select: { merchantId: true, reserved: true, consumed: true, released: true, status: true },
  })

  const outstanding = new Map<string, { sum: bigint; active: number }>()
  for (const r of reservations) {
    const key = r.merchantId.toString()
    const cur = outstanding.get(key) ?? { sum: 0n, active: 0 }
    cur.sum += r.reserved - r.consumed - r.released
    if (r.status === 'ACTIVE') cur.active += 1
    outstanding.set(key, cur)
  }

  const out: Drift[] = []
  for (const a of accounts) {
    const o = outstanding.get(a.merchantId.toString()) ?? { sum: 0n, active: 0 }
    const availableBefore = a.balance + a.grantBalance - a.frozen
    const availableAfter = a.balance + a.grantBalance - o.sum
    if (a.frozen === o.sum) continue // 一致的不报告，输出保持精简
    out.push({
      merchantId: a.merchantId,
      accountFrozen: a.frozen,
      expectedFrozen: o.sum,
      drift: a.frozen - o.sum,
      availableBefore,
      availableAfter,
      activeReservations: o.active,
    })
  }
  return out
}

const drifts = await scan()
const totalAccounts = await prisma.beanAccount.count()

console.log(`[frozen:reconcile] 扫描 ${totalAccounts} 个积分账户（模式：${FIX ? '修正' : '只读'}）`)

if (drifts.length === 0) {
  console.log('[frozen:reconcile] 全部一致，无漂移。')
  await prisma.$disconnect()
  process.exit(0)
}

console.log(`\n发现 ${drifts.length} 个账户存在冻结漂移：`)
for (const d of drifts) {
  const sign = d.drift > 0n ? '冻结偏高（积分被锁死）' : '冻结偏低（积分被提前放行）'
  console.log(`  商户 ${d.merchantId}：frozen=${d.accountFrozen} 应为 ${d.expectedFrozen}  漂移=${d.drift > 0n ? '+' : ''}${d.drift}  ${sign}`)
  console.log(`    可用余额 ${d.availableBefore} → 修正后 ${d.availableAfter}（ACTIVE 预留 ${d.activeReservations} 条）`)
}

if (!FIX) {
  console.log('\n[frozen:reconcile] 只读模式，未改动任何数据。加 --fix 执行修正。')
  await prisma.$disconnect()
  process.exit(0)
}

// 修正：逐商户重新计算并写回；仍然只改 frozen 一个字段，不碰 balance/grantBalance，
// 并做边界校验，避免把账户改到「可用为负」这种更糟的状态。
let fixed = 0
let skipped = 0
for (const d of drifts) {
  const balanceTotal = d.expectedFrozen + d.availableAfter
  if (d.expectedFrozen < 0n || d.availableAfter < 0n) {
    console.log(`  商户 ${d.merchantId}：目标值不合法（frozen=${d.expectedFrozen}，可用=${d.availableAfter}），跳过，需人工核查`)
    skipped += 1
    continue
  }
  if (balanceTotal < 0n) {
    console.log(`  商户 ${d.merchantId}：余额合计异常，跳过`)
    skipped += 1
    continue
  }
  await prisma.beanAccount.update({
    where: { merchantId: d.merchantId },
    data: { frozen: d.expectedFrozen, version: { increment: 1 } },
  })
  console.log(`  商户 ${d.merchantId}：frozen ${d.accountFrozen} → ${d.expectedFrozen} 已修正`)
  fixed += 1
}

console.log(`\n[frozen:reconcile] 完成：修正 ${fixed} 个，跳过 ${skipped} 个。`)
console.log('提示：frozen 变动会让「可用余额」变化，但流水（bean_ledger）不会新增记录，')
console.log('      因为这是账实对齐而非一次业务动作。如需留痕，请人工在备注系统登记。')

await prisma.$disconnect()
