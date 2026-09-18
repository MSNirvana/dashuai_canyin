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
import type { Prisma } from '@prisma/client'
import { lockMerchantAccount } from '../src/bean/bean.service.js'
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

/**
 * 未结余额求和 —— **口径的唯一来源**。
 *
 * 把所有预留的 reserved−consumed−released 相加（终态预留该项天然为 0，
 * 所以不必再按 status 过滤）。
 *
 * ★ 只读扫描与 --fix 两条路必须共用这**一个**函数：口径一旦分叉，--fix 就会把账户
 *   改成一个「只读模式认为漂移、修正模式认为已对齐」的值，下次跑又反过来报漂移。
 */
function outstandingOf(rs: { reserved: bigint; consumed: bigint; released: bigint }[]): bigint {
  return rs.reduce((sum, r) => sum + r.reserved - r.consumed - r.released, 0n)
}

/** 锁内重算某商户应有的 frozen（只查这一家，用于修正路径） */
async function expectedFrozenOf(tx: Prisma.TransactionClient, merchantId: bigint): Promise<bigint> {
  const rs = await tx.beanReservation.findMany({
    where: { merchantId },
    select: { reserved: true, consumed: true, released: true },
  })
  return outstandingOf(rs)
}

async function scan(): Promise<Drift[]> {
  const accounts = await prisma.beanAccount.findMany({
    select: { merchantId: true, balance: true, grantBalance: true, frozen: true },
  })
  // 一次性把全部预留拉进内存聚合：单商家预留量级在万级以内，比 N+1 查询更快
  const reservations = await prisma.beanReservation.findMany({
    select: { merchantId: true, reserved: true, consumed: true, released: true, status: true },
  })

  const byMerchant = new Map<string, { rs: { reserved: bigint; consumed: bigint; released: bigint }[]; active: number }>()
  for (const r of reservations) {
    const key = r.merchantId.toString()
    const cur = byMerchant.get(key) ?? { rs: [], active: 0 }
    cur.rs.push(r)
    if (r.status === 'ACTIVE') cur.active += 1
    byMerchant.set(key, cur)
  }

  const out: Drift[] = []
  for (const a of accounts) {
    const bucket = byMerchant.get(a.merchantId.toString()) ?? { rs: [], active: 0 }
    const expected = outstandingOf(bucket.rs)
    if (a.frozen === expected) continue // 一致的不报告，输出保持精简
    out.push({
      merchantId: a.merchantId,
      accountFrozen: a.frozen,
      expectedFrozen: expected,
      drift: a.frozen - expected,
      availableBefore: a.balance + a.grantBalance - a.frozen,
      availableAfter: a.balance + a.grantBalance - expected,
      activeReservations: bucket.active,
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

// ──────────────────────── 修正 ────────────────────────
//
// 仍然只改 frozen 一个字段，不碰 balance/grantBalance，并做边界校验，
// 避免把账户改到「可用为负」这种更糟的状态。
//
// ★ 关键：**不能在事务外拿扫描阶段的旧快照去写**。
//   原实现是 `scan()` 里算好 expectedFrozen，然后循环里直接
//   `update({ data: { frozen: d.expectedFrozen } })`。而 `scan()` 与写入之间隔着
//   整个报告输出（以及报告与人工敲下回车之间的任意时长），期间用户完全可能刚好
//   完成一次生成 —— 那次 freeze/consume 对 frozen 的增量会被这个**旧绝对值**整体覆盖掉，
//   把一个本来正确的账户改错：账实对齐的工具自己制造出了新的账实不符。
//   所以：开事务 → 抢该商户的账户行锁 → **在锁内重算** → 只在仍漂移时才写。
//   扫描结果降级为「候选名单」：它只决定去检查谁，不再决定写什么值。
let fixed = 0
let skipped = 0
let alreadyOk = 0
for (const d of drifts) {
  const outcome = await prisma.$transaction(
    async (tx) => {
      await lockMerchantAccount(tx, d.merchantId)
      const acct = await tx.beanAccount.findUnique({ where: { merchantId: d.merchantId } })
      if (!acct) return { kind: 'missing' as const }
      const expected = await expectedFrozenOf(tx, d.merchantId)
      // 期间业务已经自己对齐（或本次扫描的判断已过期）⇒ 什么都不做
      if (acct.frozen === expected) return { kind: 'ok' as const, frozen: acct.frozen }
      const available = acct.balance + acct.grantBalance - expected
      if (expected < 0n || available < 0n) {
        return { kind: 'invalid' as const, expected, available, accountFrozen: acct.frozen }
      }
      await tx.beanAccount.update({
        where: { merchantId: d.merchantId },
        data: { frozen: expected, version: { increment: 1 } },
      })
      return { kind: 'fixed' as const, from: acct.frozen, to: expected }
    },
    // 幂等类事务必须显式 READ COMMITTED：MySQL 默认 RR 会把读视图定死在事务内第一条
    // 一致性读上，锁内那次重读就拿不到对手刚提交的行（见 bean.service 的同款说明）。
    { isolationLevel: 'ReadCommitted' },
  )

  if (outcome.kind === 'fixed') {
    console.log(`  商户 ${d.merchantId}：frozen ${outcome.from} → ${outcome.to} 已修正（写前重算）`)
    fixed += 1
  } else if (outcome.kind === 'ok') {
    console.log(`  商户 ${d.merchantId}：写前重算已对齐（frozen=${outcome.frozen}），无需修正`)
    alreadyOk += 1
  } else if (outcome.kind === 'invalid') {
    console.log(
      `  商户 ${d.merchantId}：目标值不合法（frozen=${outcome.expected}，可用=${outcome.available}，当前 frozen=${outcome.accountFrozen}），跳过，需人工核查`,
    )
    skipped += 1
  } else {
    console.log(`  商户 ${d.merchantId}：账户不存在，跳过`)
    skipped += 1
  }
}

console.log(
  `\n[frozen:reconcile] 完成：修正 ${fixed} 个，写前已对齐 ${alreadyOk} 个，跳过 ${skipped} 个。`,
)
console.log('提示：frozen 变动会让「可用余额」变化，但流水（bean_ledger）不会新增记录，')
console.log('      因为这是账实对齐而非一次业务动作。如需留痕，请人工在备注系统登记。')

await prisma.$disconnect()
