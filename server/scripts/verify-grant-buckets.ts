/**
 * 赠豆分桶验证：注册赠豆必须独立于会员赠豆，**不随会员到期被清零**。
 *
 * 背景（第一批遗留问题，本轮修复）：
 *   bean_account 原先只有一个 grant_balance，注册赠豆（新用户一次性发 30）与会员赠豆
 *   （买会员送，到期清零）都往这里进，grant() 又把 bizType 硬编码成 'MEMBERSHIP'，
 *   账务上无法区分来源。会员到期时 expireGrant() 清空整个池子 → 把注册赠豆一起清掉。
 *
 * 为什么必须靠「分桶」而不是「改清零算法」：
 *   消耗是池化的（grant 桶整体扣减，没有批次概念），所以「账上还剩多少注册赠豆」
 *   无法从历史流水反推。只有独立成桶才能精确表达。
 *
 * 用例：
 *   ① 注册赠豆进注册桶，会员桶不动
 *   ② 会员赠豆进会员桶，注册桶不动
 *   ③ 消耗顺序：会员桶 → 注册桶 → 充值豆（先用会作废的）
 *   ④ ★ 会员到期清零：只清会员桶，注册桶原样保留
 *   ⑤ 幂等：同 bizId 重复发放只记一次
 *   ⑥ 可用额度含注册桶（否则用户看得见却用不了）
 *   ⑦ 对外 grantBalance 仍是「赠豆总量」
 * 全部用商户 3（dev 测试账号），跑完恢复账户原值。
 *
 * 跑法：npx tsx scripts/verify-grant-buckets.ts
 */
import { PrismaClient } from '@prisma/client'
import { consume, expireGrant, freeze, getBalance, grant } from '../src/bean/bean.service.js'

const prisma = new PrismaClient()
const M = 3n
const OP = 'VERIFY_GRANT_BUCKETS'

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
  `商户 ${M} 基线：balance=${snapshot.balance} 会员赠豆=${snapshot.grantBalance} 注册赠豆=${snapshot.grantRegisterBalance} frozen=${snapshot.frozen}\n`,
)

async function setAccount(balance: bigint, membership: bigint, register: bigint) {
  await prisma.beanAccount.update({
    where: { merchantId: M },
    data: { balance, grantBalance: membership, grantRegisterBalance: register, frozen: 0n },
  })
}
async function readAccount() {
  return prisma.beanAccount.findUniqueOrThrow({ where: { merchantId: M } })
}
async function cleanupLedger() {
  await prisma.beanLedger.deleteMany({ where: { merchantId: M, bizType: { in: [OP, 'REGISTER', 'MEMBER_EXPIRE'] } } })
  await prisma.beanReservation.deleteMany({ where: { merchantId: M, bizType: OP } })
}

await cleanupLedger()

console.log('=== ① / ② 两种来源分别进不同的桶 ===')
{
  await setAccount(0n, 0n, 0n)
  const tag = Date.now().toString(36)
  await prisma.$transaction((tx) =>
    grant(tx, { merchantId: M, amount: 30n, source: 'REGISTER', bizId: `t1-${tag}`, remark: '注册赠豆' }),
  )
  let acc = await readAccount()
  check(acc.grantRegisterBalance === 30n, '① 注册赠豆 → 注册桶 = 30', `actual=${acc.grantRegisterBalance}`)
  check(acc.grantBalance === 0n, '① 会员桶不受影响 = 0', `actual=${acc.grantBalance}`)

  await prisma.$transaction((tx) =>
    grant(tx, { merchantId: M, amount: 98000n, source: 'MEMBERSHIP', bizId: `t2-${tag}`, remark: '会员赠送' }),
  )
  acc = await readAccount()
  check(acc.grantBalance === 98000n, '② 会员赠豆 → 会员桶 = 98000', `actual=${acc.grantBalance}`)
  check(acc.grantRegisterBalance === 30n, '② 注册桶不受影响 = 30', `actual=${acc.grantRegisterBalance}`)

  const bal = await getBalance(prisma, M)
  check(bal.grantBalance === 98030n, '⑦ 对外 grantBalance = 总量 98030', `actual=${bal.grantBalance}`)
  check(bal.grantMembershipBalance === 98000n && bal.grantRegisterBalance === 30n, '⑦ 分桶明细同时给出')
  check(bal.available === 98030n, '⑥ 可用额度含注册桶 = 98030', `actual=${bal.available}`)
  await cleanupLedger()
}

console.log('\n=== ③ 消耗顺序：会员桶 → 注册桶 → 充值豆 ===')
{
  const tag = Date.now().toString(36)
  // 会员 100 / 注册 50 / 充值 1000，依次消耗 120、60
  await setAccount(1000n, 100n, 50n)

  const req1 = `${OP}-c1-${tag}`
  await prisma.$transaction(async (tx) => {
    await freeze(tx, { merchantId: M, requestId: req1, amount: 120n, bizType: OP })
    await consume(tx, { merchantId: M, requestId: req1, amount: 120n, bizType: OP })
  })
  let acc = await readAccount()
  check(acc.grantBalance === 0n, '消耗 120：会员桶 100 先被吃完', `actual=${acc.grantBalance}`)
  check(acc.grantRegisterBalance === 30n, '接着吃注册桶 20，剩 30', `actual=${acc.grantRegisterBalance}`)
  check(acc.balance === 1000n, '充值豆还没动 = 1000', `actual=${acc.balance}`)

  const row1 = await prisma.beanLedger.findFirstOrThrow({
    where: { merchantId: M, requestId: req1, type: 'CONSUME' },
  })
  check(row1.grantAmount === 120n, '流水 grantAmount = 120（赠豆总量）', `actual=${row1.grantAmount}`)
  check(row1.grantRegisterAmount === 20n, '流水 grantRegisterAmount = 20（其中注册桶）', `actual=${row1.grantRegisterAmount}`)
  check(row1.grantAmount - row1.grantRegisterAmount === 100n, '可反推会员桶用量 = 100')

  const req2 = `${OP}-c2-${tag}`
  await prisma.$transaction(async (tx) => {
    await freeze(tx, { merchantId: M, requestId: req2, amount: 60n, bizType: OP })
    await consume(tx, { merchantId: M, requestId: req2, amount: 60n, bizType: OP })
  })
  acc = await readAccount()
  check(acc.grantRegisterBalance === 0n, '再消耗 60：注册桶 30 吃完', `actual=${acc.grantRegisterBalance}`)
  check(acc.balance === 970n, '差额 30 走充值豆，剩 970', `actual=${acc.balance}`)
  await cleanupLedger()
}

console.log('\n=== ④ ★ 核心用例：会员到期清零，注册赠豆必须保留 ===')
{
  // 模拟真实场景：注册时发 30，之后买会员送 98000
  await setAccount(0n, 98000n, 30n)
  await prisma.$transaction((tx) => expireGrant(tx, { merchantId: M, remark: `${OP} 会员到期` }))
  const acc = await readAccount()
  check(acc.grantBalance === 0n, '会员桶被清空 = 0', `actual=${acc.grantBalance}`)
  check(acc.grantRegisterBalance === 30n, '★ 注册桶保留 = 30（修复前会被一起清掉）', `actual=${acc.grantRegisterBalance}`)

  const row = await prisma.beanLedger.findFirstOrThrow({
    where: { merchantId: M, bizType: 'MEMBER_EXPIRE', type: 'EXPIRE' },
    orderBy: { id: 'desc' },
  })
  check(row.amount === -98000n, 'EXPIRE 流水只记会员桶 = -98000', `actual=${row.amount}`)
  check(row.grantRegisterAmount === 0n, 'EXPIRE 不含注册赠豆', `actual=${row.grantRegisterAmount}`)
  check(row.grantAfter === 30n, '流水 grantAfter = 剩余赠豆 30', `actual=${row.grantAfter}`)

  const bal = await getBalance(prisma, M)
  check(bal.available === 30n, '清零后可用额度 = 30（注册赠豆仍可用）', `actual=${bal.available}`)
  await cleanupLedger()
}

console.log('\n=== ⑤ 幂等：同 bizId 重复发放只记一次 ===')
{
  await setAccount(0n, 0n, 0n)
  const bizId = `dup-${Date.now().toString(36)}`
  const first = await prisma.$transaction((tx) =>
    grant(tx, { merchantId: M, amount: 30n, source: 'REGISTER', bizId }),
  )
  const second = await prisma.$transaction((tx) =>
    grant(tx, { merchantId: M, amount: 30n, source: 'REGISTER', bizId }),
  )
  const acc = await readAccount()
  check(first.duplicated === false && second.duplicated === true, '第二次被识别为重复')
  check(acc.grantRegisterBalance === 30n, '注册赠豆只发了一次 = 30', `actual=${acc.grantRegisterBalance}`)
  const rows = await prisma.beanLedger.count({ where: { merchantId: M, bizType: 'REGISTER', type: 'GRANT' } })
  check(rows === 1, 'GRANT 流水只有 1 条', `rows=${rows}`)
  await cleanupLedger()
}

// 恢复基线
await prisma.beanAccount.update({
  where: { merchantId: M },
  data: {
    balance: snapshot.balance,
    grantBalance: snapshot.grantBalance,
    grantRegisterBalance: snapshot.grantRegisterBalance,
    frozen: snapshot.frozen,
  },
})
await cleanupLedger()
const restored = await readAccount()
console.log(
  `\n已恢复商户 ${M} 基线：balance=${restored.balance} 会员赠豆=${restored.grantBalance} 注册赠豆=${restored.grantRegisterBalance} frozen=${restored.frozen}`,
)
console.log(`★ ${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
