/**
 * 账务竞态与 AI 预留恢复的回归测试。
 *
 * 覆盖 5 类「不会报错、只会在账上静默出错」的缺陷：
 *   ① 同一商户两笔会员订单并发结算 —— 旧实现只续一期（两笔都收钱、只给一期）
 *   ② 会员到期清零与续费并发 —— 旧实现把刚到账的赠积分清掉
 *   ③ 冻结跨会员到期 —— 旧实现清零后可用余额为负 / 在途任务结算报「积分不足」
 *   ④ AI 请求进程崩溃后预留无主 —— 旧实现永久冻结，无人认领
 *   ⑤ 运营改价后重放旧预留 —— 旧实现按新价释放，差额或超额永久冻结
 *
 * 全部在本地库跑，只用一个临时手机号造商户，跑完硬删；不联网、不碰真支付/真 AI。
 *
 * 用法：npm run accounting:verify
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { devLogin } from '../src/auth/auth.service.js'
import * as bean from '../src/bean/bean.service.js'
import { lockMerchantAccount, type Db } from '../src/bean/bean.service.js'
import { markOrderPaid } from '../src/services/order.service.js'
import { scanGrantExpiry } from '../src/services/grant-expiry.service.js'
import { scanStaleAiRequests } from '../src/ai/ai-recovery.service.js'
import { settleAiCharge } from '../src/ai/ai.service.js'
import { getNumber } from '../src/lib/settings.js'

const prisma = new PrismaClient()
const PHONE = '13900009997' // 与 membership:verify(…9999) / pay-reconcile:verify(…9998) 区分
const DAY = 24 * 60 * 60 * 1000

let pass = 0
let failed = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${extra ? `  （${extra}）` : ''}`)
  }
}
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

let seq = 0
const nextId = () => `ACC${Date.now().toString().slice(-8)}${String(++seq).padStart(2, '0')}`

let tempMerchantId: bigint | null = null

async function cleanup(merchantId: bigint) {
  await prisma.membershipReminder.deleteMany({ where: { merchantId } })
  await prisma.membership.deleteMany({ where: { merchantId } })
  await prisma.order.deleteMany({ where: { merchantId } })
  // 账务：先删流水与预留，再删账户
  await prisma.beanLedger.deleteMany({ where: { merchantId } })
  await prisma.beanReservation.deleteMany({ where: { merchantId } })
  await prisma.businessRequest.deleteMany({ where: { merchantId } })
  await prisma.beanAccount.deleteMany({ where: { merchantId } })
  await prisma.store.deleteMany({ where: { merchantId } })
  await prisma.merchant.deleteMany({ where: { id: merchantId } })
}

/** 造一张 MEMBER 订单 */
async function mkMemberOrder(merchantId: bigint, pkgId: bigint) {
  const orderNo = `M${nextId()}`
  await prisma.order.create({
    data: {
      orderNo,
      merchantId,
      orderType: 'MEMBER',
      refId: pkgId,
      amountFen: 98000,
      originalAmountFen: 98000,
      memberDiscountApplied: false,
      beans: 0n,
      status: 'PENDING',
      expireAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  })
  return orderNo
}

async function accountOf(merchantId: bigint) {
  const a = await prisma.beanAccount.findUniqueOrThrow({ where: { merchantId } })
  return {
    balance: a.balance,
    grant: a.grantBalance,
    register: a.grantRegisterBalance,
    frozen: a.frozen,
    available: bean.availableOf(a),
  }
}

/**
 * 账务不变量：可用余额不得为负；且账户级 frozen 必须等于所有在途预留的未结余量之和。
 * 这两条一旦被破坏，后续任何一次结算都可能随机失败。
 */
async function assertInvariants(merchantId: bigint, label: string) {
  const acc = await accountOf(merchantId)
  check(acc.available >= 0n, `${label}：可用余额不为负`, j(acc))
  const rows = await prisma.beanReservation.findMany({
    where: { merchantId, status: 'ACTIVE' },
    select: { reserved: true, consumed: true, released: true },
  })
  const sum = rows.reduce((s, r) => s + (r.reserved - r.consumed - r.released), 0n)
  check(sum === acc.frozen, `${label}：账户 frozen 与在途预留未结余量一致`, `${sum} vs ${acc.frozen}`)
}

/** 给商户灌入会员桶赠积分（走正规 grant 路径，保证流水/桶都正确） */
async function seedGrant(merchantId: bigint, amount: bigint, bizId: string) {
  await prisma.$transaction(async (tx: Db) => {
    await bean.grant(tx, { merchantId, amount, bizId, source: 'MEMBERSHIP' })
  })
}

async function main() {
  const stale = await prisma.merchant.findUnique({ where: { phone: PHONE } })
  if (stale) {
    console.log(`（清理上次残留：商户 ${stale.id}）`)
    await cleanup(stale.id)
  }

  const pkg = await prisma.memberPackage.findFirst({ where: { code: 'SUBSCRIPTION' } })
  if (!pkg) throw new Error('缺少 code=SUBSCRIPTION 的会员套餐，无法造会员订单')
  await devLogin(prisma, PHONE)
  const mid = (await prisma.merchant.findUniqueOrThrow({ where: { phone: PHONE } })).id
  tempMerchantId = mid

  const subDays = await getNumber(prisma, 'subscription', 'duration_days', 30)
  const subGrant = BigInt(Math.round(await getNumber(prisma, 'subscription', 'grant_points', 98000)))

  // ── ① 两笔会员订单并发结算：必须续两期 ──────────────────────────
  console.log('\n════ ① 同一商户两笔会员订单并发结算 ⇒ 会员期必须增加两期 ════')
  {
    const [o1, o2] = [await mkMemberOrder(mid, pkg.id), await mkMemberOrder(mid, pkg.id)]
    const before = Date.now()
    await Promise.all([
      markOrderPaid(prisma, o1, null),
      markOrderPaid(prisma, o2, null),
    ])
    const active = await prisma.membership.findMany({
      where: { merchantId: mid, status: 'ACTIVE', endAt: { gt: new Date() } },
      orderBy: { endAt: 'desc' },
    })
    check(active.length === 1, '★ 只存在一行有效会员（没有重叠记录）', `rows=${active.length}`)
    const endAt = active[0]?.endAt.getTime() ?? 0
    const expected = before + 2 * subDays * DAY
    // 允许几秒误差（事务提交时间）
    check(
      Math.abs(endAt - expected) < 60_000,
      `★ 到期时间 = 两期之和（+${2 * subDays} 天），不是一期`,
      `实际剩余 ${((endAt - Date.now()) / DAY).toFixed(2)} 天，期望 ${2 * subDays} 天`,
    )
    const acc = await accountOf(mid)
    check(
      acc.grant === subGrant * 2n,
      '两次赠积分都到账（没有少发）',
      `${acc.grant} vs ${subGrant * 2n}`,
    )
    // 两笔都是 PAID
    const paids = await prisma.order.count({ where: { merchantId: mid, orderNo: { in: [o1, o2] }, status: 'PAID' } })
    check(paids === 2, '两笔订单都完成结算', `paids=${paids}`)
    await assertInvariants(mid, '①')
  }

  // ── ② 到期清零与续费并发：不能清掉刚到账的赠积分 ─────────────────
  console.log('\n════ ② 到期清零与续费并发 ⇒ 续费到账的赠积分不得被清掉 ════')
  {
    // 造出「旧周期已过期但仍 ACTIVE」+「本周期续费」的临界状态：
    // 先把现有会员改成已过期（模拟周期结束），再灌一笔旧周期残留赠积分。
    const cur = await prisma.membership.findFirstOrThrow({ where: { merchantId: mid } })
    await prisma.membership.update({
      where: { id: cur.id },
      data: { endAt: new Date(Date.now() - 1000), grantExpireAt: new Date(Date.now() - 1000), status: 'ACTIVE' },
    })
    const grantBefore = (await accountOf(mid)).grant
    check(grantBefore > 0n, '旧周期残留赠积分已就位', String(grantBefore))

    // 用长事务占住商户锁，模拟「续费事务已开始、尚未提交」
    let locked!: () => void
    const lockedP = new Promise<void>((r) => { locked = r })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let renewalError: unknown = null

    const renewal = prisma
      .$transaction(async (tx: Db) => {
        await lockMerchantAccount(tx, mid)
        locked()
        await gate // 持锁等待，直到扫描已经读到候选并尝试抢锁
        // 锁内完成续费：新建本期会员行 + 发本期赠积分（与 activateMembership 同构）
        const endAt = new Date(Date.now() + subDays * DAY)
        await tx.membership.updateMany({
          where: { merchantId: mid, status: 'ACTIVE', endAt: { lte: new Date() } },
          data: { status: 'EXPIRED' },
        })
        await tx.membership.create({
          data: {
            merchantId: mid, packageId: pkg.id, startAt: new Date(), endAt,
            sourceOrderId: null, grantBeans: subGrant, grantExpireAt: endAt, status: 'ACTIVE',
          },
        })
        await bean.grant(tx, { merchantId: mid, amount: subGrant, bizId: nextId(), source: 'MEMBERSHIP' })
      })
      .catch((e) => { renewalError = e })

    await lockedP
    // 启动扫描：它此刻读到的候选是「已过期且 ACTIVE」的那一行
    const scanning = scanGrantExpiry(prisma)
    // 给扫描一点时间走到「抢锁」那一步（它会在锁上阻塞），再放行续费事务
    await new Promise((r) => setTimeout(r, 300))
    release()

    const r = await scanning
    await renewal
    if (renewalError) throw renewalError

    check(r.beansCleared === 0n, '★ 扫描没有清掉任何积分（识别出续费已发生）', `cleared=${r.beansCleared}`)
    const acc = await accountOf(mid)
    check(
      acc.grant === grantBefore + subGrant,
      '★ 本期赠积分完整保留 = 旧残留 + 本期',
      `${acc.grant} vs ${grantBefore + subGrant}`,
    )
    const active = await prisma.membership.count({
      where: { merchantId: mid, status: 'ACTIVE', endAt: { gt: new Date() } },
    })
    check(active === 1, '续费后存在且仅存在一行有效会员', `rows=${active}`)
    await assertInvariants(mid, '②')
  }

  // ── ③ 冻结跨会员到期：只清未预留部分 ────────────────────────────
  console.log('\n════ ③ 会员到期时仍有在途预留 ⇒ 只清未预留部分，在途任务仍能结算 ════')
  {
    // 干净起点：清掉账户余额（保留流水便于排查），只留会员桶 10000
    await prisma.beanAccount.update({
      where: { merchantId: mid },
      data: { balance: 0n, grantBalance: 0n, grantRegisterBalance: 0n, frozen: 0n },
    })
    await seedGrant(mid, 10000n, nextId())

    const requestId = nextId()
    const bizType = 'AI_copy_generate'
    await prisma.$transaction(async (tx: Db) => {
      await bean.freeze(tx, { merchantId: mid, requestId, amount: 5000n, bizType, bizId: nextId(), remark: '③ 在途预留' })
    })
    const freezeRow = await prisma.beanLedger.findFirstOrThrow({
      where: { merchantId: mid, requestId, type: 'FREEZE' },
    })
    check(freezeRow.grantAmount === 5000n, '★ 预留流水记下了桶归属（全部来自会员桶）', j(freezeRow.grantAmount))

    // 会员到期：本轮清零必须跳过被预留的 5000
    const cleared = await prisma.$transaction(async (tx: Db) => {
      const r = await bean.expireGrant(tx, { merchantId: mid, remark: '③ 测试到期清零' })
      return r
    })
    check(cleared.expired === 5000n, '只清了未预留的 5000', `expired=${cleared.expired}`)
    check(cleared.retained === 5000n, '保留被预留占用的 5000', `retained=${cleared.retained}`)

    const acc = await accountOf(mid)
    check(acc.grant === 5000n, '会员桶剩余 5000', String(acc.grant))
    check(acc.frozen === 5000n, 'frozen 仍为 5000', String(acc.frozen))
    check(acc.available === 0n, '★ 可用余额为 0（不是负数）', String(acc.available))
    await assertInvariants(mid, '③')

    // 在途任务结算：必须从保留的会员桶扣，而不是「积分不足」失败、也不是去扣充值桶
    const consumed = await prisma.$transaction(async (tx: Db) => {
      return bean.consume(tx, { merchantId: mid, requestId, amount: 5000n, bizType })
    })
    check(consumed.bucket === 'GRANT', '★ 结算走的是赠积分桶（没有回落到充值桶）', consumed.bucket)
    check(consumed.grantUsed === 5000n, '赠积分用量 5000', String(consumed.grantUsed))
    const acc2 = await accountOf(mid)
    check(acc2.balance === 0n, '充值桶未被错误扣减', String(acc2.balance))
    check(acc2.frozen === 0n, '预留已结清', String(acc2.frozen))
    await assertInvariants(mid, '③-after')
  }

  // ── ④ AI 请求无主恢复 ──────────────────────────────────────────
  console.log('\n════ ④ AI 请求执行进程崩溃（预留无主）⇒ 必须被回收，不得永久冻结 ════')
  {
    await prisma.beanAccount.update({
      where: { merchantId: mid },
      data: { balance: 100000n, grantBalance: 0n, grantRegisterBalance: 0n, frozen: 0n },
    })

    // 4a：上游没有结果 → 全额释放 + FAILED
    const reqA = nextId()
    const bizA = 'AI_copy_generate'
    await prisma.$transaction(async (tx: Db) => {
      await bean.freeze(tx, { merchantId: mid, requestId: reqA, amount: 300n, bizType: bizA, bizId: nextId() })
    })
    await prisma.businessRequest.create({
      data: {
        merchantId: mid, operation: 'AI_COPY', requestId: reqA, payloadHash: 'a'.repeat(64),
        status: 'PENDING',
        // 无主：租约已过期；同时把 createdAt 提前以越过宽限期
        leaseOwner: null, leaseExpireAt: null,
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    })
    const frozenBefore = (await accountOf(mid)).frozen
    check(frozenBefore === 300n, '无主请求的预留已冻结（这就是要被回收的那笔）', String(frozenBefore))

    const rA = await scanStaleAiRequests(prisma, { now: new Date() })
    check(rA.recovered >= 1, '扫描到并回收了无主请求', `recovered=${rA.recovered}`)
    const rowA = await prisma.businessRequest.findFirstOrThrow({ where: { merchantId: mid, requestId: reqA } })
    check(rowA.status === 'FAILED', '请求已置为 FAILED（不再是无主 PENDING）', rowA.status)
    check(rowA.errorCode === 'AI_LEASE_EXPIRED', 'errorCode 明确说明是租约过期', String(rowA.errorCode))
    const accA = await accountOf(mid)
    check(accA.frozen === 0n, '★ 预留已全额释放，积分不再被冻结', String(accA.frozen))
    const resA = await prisma.beanReservation.findFirstOrThrow({ where: { merchantId: mid, requestId: reqA } })
    check(resA.status === 'RELEASED', '预留记录已置 RELEASED', resA.status)
    await assertInvariants(mid, '④a')

    // 4b：上游其实成功了（有响应快照），只差结算 → 必须补结算，而不是白送
    const provider = await prisma.aiProvider.findFirst({ orderBy: { id: 'asc' } })
    const model = await prisma.aiModel.findFirst({ orderBy: { id: 'asc' } })
    if (!provider || !model) {
      console.log('  （跳过 ④b：库里没有可用的 AI provider/model）')
    } else {
      const reqB = nextId()
      const bizB = 'AI_copy_generate'
      await prisma.$transaction(async (tx: Db) => {
        await bean.freeze(tx, { merchantId: mid, requestId: reqB, amount: 300n, bizType: bizB, bizId: nextId() })
      })
      await prisma.businessRequest.create({
        data: {
          merchantId: mid, operation: 'AI_COPY', requestId: reqB, payloadHash: 'b'.repeat(64),
          status: 'PENDING', leaseOwner: null, leaseExpireAt: null,
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
        },
      })
      await prisma.aiCallLog.create({
        data: {
          merchantId: mid, sceneCode: 'copy_generate', requestId: reqB,
          providerId: provider.id, modelId: model.id,
          costFen: 10, totalTokens: 100, status: 'SUCCESS',
          responseSnapshot: '恢复测试的假响应',
        },
      })
      const before = await accountOf(mid)
      const rB = await scanStaleAiRequests(prisma, { now: new Date() })
      check(rB.settled >= 1, '识别出「上游已成功」，走了补结算分支', `settled=${rB.settled}`)
      const rowB = await prisma.businessRequest.findFirstOrThrow({ where: { merchantId: mid, requestId: reqB } })
      check(rowB.status === 'COMPLETED', '请求已置 COMPLETED', rowB.status)
      const logB = await prisma.aiCallLog.findFirstOrThrow({ where: { merchantId: mid, requestId: reqB } })
      check(logB.beanCharged > 0n, '★ 按日志成本补扣了积分（没有白送这次调用）', String(logB.beanCharged))
      const after = await accountOf(mid)
      check(after.frozen === 0n, '★ 预留被完整结清（扣费 + 释放差额）', `frozen ${before.frozen} → ${after.frozen}`)
      const spent = before.balance + before.grant + before.register - (after.balance + after.grant + after.register)
      check(spent === logB.beanCharged, '总余额减少额 = 实际扣费额', `${spent} vs ${logB.beanCharged}`)
      await assertInvariants(mid, '④b')

      // 4c：幂等 —— 再扫一轮不该重复动作
      const rB2 = await scanStaleAiRequests(prisma, { now: new Date() })
      const after2 = await accountOf(mid)
      check(after2.frozen === 0n && rB2.settled === 0, '★ 再扫一轮不会重复结算/重复释放', `settled=${rB2.settled}`)
    }
  }

  // ── ⑤ 改价后重放旧预留：按预留快照结清，不留永久冻结 ──────────────
  console.log('\n════ ⑤ 运营改价后旧预留被重放 ⇒ 按预留快照结清，不按新价 ════')
  {
    const scene = await prisma.aiScene.findFirst({ orderBy: { id: 'asc' } })
    if (!scene) {
      console.log('  （跳过 ⑤：库里没有 AI 场景）')
    } else {
      const oldPrice = scene.beanPrice
      await prisma.beanAccount.update({
        where: { merchantId: mid },
        data: { balance: 100000n, grantBalance: 0n, grantRegisterBalance: 0n, frozen: 0n },
      })
      const requestId = nextId()
      const bizType = `AI_${scene.code}`
      const snapshot = 40n // 首次冻结时的标价
      await prisma.$transaction(async (tx: Db) => {
        await bean.freeze(tx, { merchantId: mid, requestId, amount: snapshot, bizType, bizId: nextId() })
      })

      // 运营把标价调高 10 倍（改动前：重放会拿新价去 unfreeze 旧预留 → 超出预留直接抛错）
      await prisma.aiScene.update({ where: { id: scene.id }, data: { beanPrice: oldPrice * 10n } })
      try {
        const before = await accountOf(mid)
        // 模拟「按预留快照结算」：cap 取自 bean_reservation 的未结余量
        const remaining = await bean.reservationRemaining(prisma, {
          merchantId: mid, requestId, bizType,
        })
        check(remaining === snapshot, '★ 预留快照金额可被读回（不读当前标价）', `${remaining} vs ${snapshot}`)
        const res = await settleAiCharge(prisma, {
          merchantId: mid,
          sceneCode: scene.code,
          operation: 'AI_COPY',
          requestId,
          bizType,
          bizId: null,
          sceneName: scene.name,
          costFen: 10,
          usedFallback: false,
          cap: remaining ?? snapshot,
        })
        const after = await accountOf(mid)
        check(after.frozen === 0n, '★ 预留被完整结清，没有永久冻结', `frozen ${before.frozen} → ${after.frozen}`)
        const dropped = before.balance - after.balance
        check(dropped === res.charged, '扣费额与账户减少额一致', `${dropped} vs ${res.charged}`)
        check(res.charged <= snapshot, '扣费不超过首次冻结的预留额', `${res.charged} <= ${snapshot}`)
        await assertInvariants(mid, '⑤')
      } finally {
        await prisma.aiScene.update({ where: { id: scene.id }, data: { beanPrice: oldPrice } })
      }
    }
  }
}

async function teardown() {
  if (tempMerchantId === null) return
  console.log('\n（清理临时商户…）')
  await cleanup(tempMerchantId)
}

main()
  .then(async () => {
    await teardown()
    console.log(`\n★ ${failed === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${failed} 失败\n`)
    await prisma.$disconnect()
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch(async (e) => {
    console.error('\n脚本异常：', e)
    await teardown().catch((x) => console.error('清理临时商户失败，请手动删除：', (x as Error).message))
    await prisma.$disconnect()
    process.exit(1)
  })
