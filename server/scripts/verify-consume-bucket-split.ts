/**
 * P2-1 验证：混合消费（赠豆 + 充值豆）时流水必须记下赠豆的实际用量。
 *
 * 背景：bean_ledger 唯一索引是 (merchant_id, biz_type, request_id, type)，同一 requestId
 * 只能有一条 CONSUME 行，所以混合消费不可能拆成两条流水。原实现只把 bucket 记成 'RECHARGE'，
 * 「这次消耗里有多少赠豆」永久丢失 → 用户账单明细与赠豆统计双向失真。
 * 修法：新增 grant_amount 列，记录本行 amount 中来自赠豆桶的绝对数量。
 *
 * 用例：
 *   ① 纯赠豆消费      → bucket=GRANT    grantAmount=全额
 *   ② 纯充值豆消费    → bucket=RECHARGE grantAmount=0
 *   ③ 混合消费（跨桶）→ bucket=RECHARGE grantAmount=赠豆余额
 *   ④ 赠豆到期清零    → EXPIRE 行 grantAmount=清零额
 *   ⑤ 幂等重放        → 返回的 grantUsed 与首次一致
 * 全部用商户 3（dev 测试账号），跑完恢复账户原值。
 *
 * 跑法：npx tsx scripts/verify-consume-bucket-split.ts
 */
import { PrismaClient } from '@prisma/client'
import { freeze, consume, expireGrant } from '../src/bean/bean.service.js'

const prisma = new PrismaClient()
const M = 3n
const OP = 'VERIFY_BUCKET_SPLIT'

let pass = 0
let fail = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? `  ${extra}` : ''}`)
  }
}

await prisma.$executeRaw`INSERT IGNORE INTO bean_account (merchant_id) VALUES (${M})`
const snapshot = await prisma.beanAccount.findUniqueOrThrow({ where: { merchantId: M } })
console.log(
  `商户 ${M} 基线：balance=${snapshot.balance} grant=${snapshot.grantBalance} frozen=${snapshot.frozen}\n`,
)

/** 把账户设成指定状态，便于构造用例 */
async function setAccount(balance: bigint, grantBalance: bigint) {
  await prisma.beanAccount.update({
    where: { merchantId: M },
    data: { balance, grantBalance, frozen: 0n },
  })
}

async function cleanup(reqId: string) {
  await prisma.beanLedger.deleteMany({ where: { merchantId: M, requestId: reqId, bizType: OP } })
  await prisma.beanReservation.deleteMany({ where: { merchantId: M, requestId: reqId, bizType: OP } })
}

/** 跑一轮 freeze + consume，返回落库的 CONSUME 行 */
async function runConsume(amount: bigint, tag: string) {
  const reqId = `${OP}-${tag}-${Date.now().toString(36)}`
  await cleanup(reqId)
  const result = await prisma.$transaction(async (tx) => {
    await freeze(tx, { merchantId: M, requestId: reqId, amount, bizType: OP, bizId: tag })
    return consume(tx, { merchantId: M, requestId: reqId, amount, bizType: OP, bizId: tag })
  })
  const row = await prisma.beanLedger.findFirstOrThrow({
    where: { merchantId: M, requestId: reqId, bizType: OP, type: 'CONSUME' },
  })
  // 幂等重放
  const replay = await prisma.$transaction((tx) =>
    consume(tx, { merchantId: M, requestId: reqId, amount, bizType: OP, bizId: tag }),
  )
  const dupCount = await prisma.beanLedger.count({
    where: { merchantId: M, requestId: reqId, bizType: OP, type: 'CONSUME' },
  })
  return { reqId, result, row, replay, dupCount }
}

console.log('=== ① 纯赠豆消费（余额 100 / 赠豆 40，消耗 25）===')
{
  await setAccount(100n, 40n)
  const { reqId, row, replay, dupCount } = await runConsume(25n, 'grant-only')
  check(row.bucket === 'GRANT', 'bucket=GRANT', `actual=${row.bucket}`)
  check(row.grantAmount === 25n, 'grantAmount=25（全额来自赠豆）', `actual=${row.grantAmount}`)
  check(replay.grantUsed === 25n, '幂等重放 grantUsed 一致', `actual=${replay.grantUsed}`)
  check(dupCount === 1, '幂等重放不新增流水', `rows=${dupCount}`)
  await cleanup(reqId)
}

console.log('\n=== ② 纯充值豆消费（余额 100 / 赠豆 0，消耗 30）===')
{
  await setAccount(100n, 0n)
  const { reqId, row, replay, dupCount } = await runConsume(30n, 'recharge-only')
  check(row.bucket === 'RECHARGE', 'bucket=RECHARGE', `actual=${row.bucket}`)
  check(row.grantAmount === 0n, 'grantAmount=0（未动赠豆）', `actual=${row.grantAmount}`)
  check(replay.grantUsed === 0n, '幂等重放 grantUsed 一致', `actual=${replay.grantUsed}`)
  check(dupCount === 1, '幂等重放不新增流水', `rows=${dupCount}`)
  await cleanup(reqId)
}

console.log('\n=== ③ 混合消费（余额 100 / 赠豆 12，消耗 40）← 本修复的核心用例 ===')
{
  await setAccount(100n, 12n)
  const { reqId, row, replay, dupCount } = await runConsume(40n, 'mixed')
  check(row.bucket === 'RECHARGE', 'bucket 主桶仍为 RECHARGE（向后兼容）', `actual=${row.bucket}`)
  check(row.grantAmount === 12n, 'grantAmount=12（赠豆被吃干，剩余 28 走充值豆）', `actual=${row.grantAmount}`)
  check(row.grantAfter === 0n, 'grantAfter=0', `actual=${row.grantAfter}`)
  check(replay.grantUsed === 12n, '幂等重放 grantUsed 一致', `actual=${replay.grantUsed}`)
  check(dupCount === 1, '幂等重放不新增流水', `rows=${dupCount}`)
  // 对账：本条流水能自证「消耗 40 = 赠豆 12 + 充值豆 28」
  const rechargePart = -row.amount - row.grantAmount
  check(rechargePart === 28n, '可由流水反推充值豆部分=28', `recharge=${rechargePart}`)
  await cleanup(reqId)
}

console.log('\n=== ④ 赠豆到期清零（余额 60 / 赠豆 18）===')
{
  await setAccount(60n, 18n)
  const reqId = `${OP}-expire-${Date.now().toString(36)}`
  await prisma.beanLedger.deleteMany({ where: { merchantId: M, bizType: 'MEMBER_EXPIRE' } })
  await prisma.$transaction((tx) => expireGrant(tx, { merchantId: M, remark: `${OP} 测试清零` }))
  const row = await prisma.beanLedger.findFirstOrThrow({
    where: { merchantId: M, bizType: 'MEMBER_EXPIRE', type: 'EXPIRE' },
    orderBy: { id: 'desc' },
  })
  check(row.grantAmount === 18n, 'EXPIRE 行 grantAmount=18', `actual=${row.grantAmount}`)
  check(row.amount === -18n, 'amount=-18', `actual=${row.amount}`)
  await prisma.beanLedger.delete({ where: { id: row.id } })
  void reqId
}

console.log('\n=== ⑤ 防御：writeLedger 的取值守卫必须留在 service 层 ===')
{
  // 数据库层没有约束，所以守卫只能靠 writeLedger 自己拦。这里用源码断言防止守卫被误删。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/bean/bean.service.ts', import.meta.url), 'utf8')
  check(src.includes('grantAmount 必须为非负数'), 'writeLedger 保留负数守卫')
  check(src.includes('超过 amount'), 'writeLedger 保留越界守卫')
}

// 恢复基线
await prisma.beanAccount.update({
  where: { merchantId: M },
  data: { balance: snapshot.balance, grantBalance: snapshot.grantBalance, frozen: snapshot.frozen },
})
await prisma.beanLedger.deleteMany({ where: { merchantId: M, bizType: OP } })
await prisma.beanReservation.deleteMany({ where: { merchantId: M, bizType: OP } })
const restored = await prisma.beanAccount.findUniqueOrThrow({ where: { merchantId: M } })
console.log(
  `\n已恢复商户 ${M} 基线：balance=${restored.balance} grant=${restored.grantBalance} frozen=${restored.frozen}`,
)
console.log(`★ ${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
