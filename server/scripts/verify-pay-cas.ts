// 支付终态 CAS 并发验证：模拟微信回调重试（两个并发 markOrderPaid），断言权益只发一次
// 运行：npx tsx scripts/verify-pay-cas.ts
import { prisma } from '../src/db.js'
import { markOrderPaid } from '../src/services/order.service.js'

async function main() {
  const merchant = await prisma.merchant.findFirst()
  if (!merchant) throw new Error('数据库中没有商家账号，先 seed')

  const before = await prisma.beanAccount.findUnique({ where: { merchantId: merchant.id } })
  const beforeBalance = before?.balance ?? 0n

  const orderNo = `VCAS${Date.now()}`
  const order = await prisma.order.create({
    data: {
      merchantId: merchant.id,
      orderType: 'BEAN',
      orderNo,
      refId: 0n,
      amountFen: 100,
      originalAmountFen: 100,
      beans: 10n,
      status: 'PENDING',
      expireAt: new Date(Date.now() + 3600_000),
    },
  })

  // 模拟微信回调重试：同一笔支付的两次通知并发到达（不同 transactionId 后缀不影响幂等语义）
  const results = await Promise.allSettled([
    markOrderPaid(prisma, orderNo, `TEST-TX-${orderNo}-A`),
    markOrderPaid(prisma, orderNo, `TEST-TX-${orderNo}-B`),
  ])

  const after = await prisma.beanAccount.findUnique({ where: { merchantId: merchant.id } })
  const gained = (after?.balance ?? 0n) - beforeBalance
  const paid = await prisma.order.findUnique({ where: { orderNo } })

  const okStatus = paid?.status === 'PAID'
  const okBeans = gained === 10n
  const okNoThrow = results.every((r) => r.status === 'fulfilled')
  const ledgerCount = await prisma.beanLedger.count({ where: { merchantId: merchant.id, bizId: orderNo } })

  console.log(`订单终态: ${paid?.status}（期望 PAID）         ${okStatus ? 'PASS' : 'FAIL'}`)
  console.log(`并发回调均正常返回: ${okNoThrow ? '是' : '否'}              ${okNoThrow ? 'PASS' : 'FAIL'}`)
  console.log(`豆变动: +${gained}（期望 +10，双发=+20）    ${okBeans ? 'PASS' : 'FAIL'}`)
  console.log(`充值流水条数: ${ledgerCount}（期望 1）        ${ledgerCount === 1 ? 'PASS' : 'FAIL'}`)

  // 清理测试数据：回滚账户、删流水、删订单，不留痕
  await prisma.beanAccount.update({
    where: { merchantId: merchant.id },
    data: { balance: { decrement: gained }, totalRecharge: { decrement: gained } },
  })
  await prisma.beanLedger.deleteMany({ where: { merchantId: merchant.id, bizId: orderNo } })
  await prisma.order.delete({ where: { id: order.id } })
  console.log('（测试数据已清理）')

  await prisma.$disconnect()
  if (!okStatus || !okBeans || !okNoThrow || ledgerCount !== 1) {
    console.error('RESULT: FAIL')
    process.exit(1)
  }
  console.log('RESULT: PASS —— 支付终态 CAS 并发幂等验证通过')
}

main().catch((e) => {
  console.error('RESULT: ERROR', e)
  process.exit(1)
})
