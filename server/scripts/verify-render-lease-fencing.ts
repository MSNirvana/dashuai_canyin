/**
 * 渲染 worker「失败释放 + 租约 fencing」回归。
 *
 * 固化的四条行为，对应四个真实缺陷：
 *   ① `storeChatCutState` **不得**写 FAILED 终态。
 *      历史缺陷：它先把任务写成 FAILED，紧随其后的 failRender 因 `status==='FAILED'` 早退，
 *      `unfreeze` 从未执行 ⇒ 任务显示失败、积分永久冻结。
 *   ② 迟到的阶段快照不得把终态改回 RUNNING。
 *      实测能把已 SUCCESS 的任务改回 RUNNING，之后还会继续下载上传、对已退款任务再结算一次。
 *   ③ `failRender` 必须释放预留；且**任务已是 FAILED 时仍要补释放**（修历史残留的那条路）。
 *   ④ 租约版本落后 ⇒ 收尾必须放弃（SUPERSEDED），不能覆盖新执行者的状态。
 *
 * 跑法：npx tsx scripts/verify-render-lease-fencing.ts
 *
 * ★ 用一次性临时商户（跑完连同账户/预留/任务一起硬删），不碰商户 1/3 的真实数据。
 * ★ 不需要 COS / ffmpeg / ChatCut：全部只打数据库与本地服务函数。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { failRender, completeRender } from '../src/services/render.service.js'
import { claimTask, storeChatCutState } from '../src/render/worker.js'
import { freeze } from '../src/bean/bean.service.js'

const prisma = new PrismaClient()

let pass = 0
let fail = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? `  ${extra}` : ''}`) }
}
function section(title: string) { console.log(`\n=== ${title} ===`) }
/** 打印用序列化：结果里带 BigInt（预留/余额），原生 JSON.stringify 会抛 */
const j = (v: unknown) => JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val))

const created: bigint[] = []

async function cleanup(m: bigint) {
  const ids = (await prisma.creation.findMany({ where: { merchantId: m }, select: { id: true } })).map((c) => c.id)
  await prisma.businessRequest.deleteMany({ where: { merchantId: m } })
  await prisma.renderTask.deleteMany({ where: { merchantId: m } })
  if (ids.length > 0) await prisma.shot.deleteMany({ where: { creationId: { in: ids } } })
  await prisma.creation.deleteMany({ where: { merchantId: m } })
  await prisma.beanLedger.deleteMany({ where: { merchantId: m } })
  await prisma.beanReservation.deleteMany({ where: { merchantId: m } })
  await prisma.beanAccount.deleteMany({ where: { merchantId: m } })
  await prisma.store.deleteMany({ where: { merchantId: m } })
  await prisma.merchant.deleteMany({ where: { id: m } })
}

let seq = 0
/** 建一个临时商户 + 门店 + 创作 + 账户（余额 1000） */
async function fixture(tag: string) {
  const phone = `1390000${(9100 + seq++).toString()}`
  const merchant = await prisma.merchant.create({ data: { phone, nickname: `fencing-${tag}` } })
  created.push(merchant.id)
  const store = await prisma.store.create({ data: { merchantId: merchant.id, name: `fencing-${tag}` } })
  const creation = await prisma.creation.create({
    data: { merchantId: merchant.id, storeId: store.id, title: tag, track: 'TRAFFIC', complexity: 'SIMPLE' },
  })
  await prisma.beanAccount.create({ data: { merchantId: merchant.id, balance: 1000n } })
  return { merchantId: merchant.id, creationId: creation.id }
}

/** 建一个 RUNNING 任务，并按 amount 建出对应预留（等价于 submitRender 的 freeze 阶段） */
async function runningTask(m: bigint, creationId: bigint, requestId: string, amount: bigint) {
  await prisma.$transaction((tx) =>
    freeze(tx, { merchantId: m, requestId, amount, bizType: 'RENDER', bizId: requestId }),
  )
  return prisma.renderTask.create({
    data: {
      merchantId: m,
      creationId,
      status: 'RUNNING',
      grade: 'BASIC',
      paramsJson: {},
      beanCharged: amount,
      requestId,
      startAt: new Date(),
      progress: 5,
    },
  })
}

async function frozenOf(m: bigint): Promise<bigint> {
  const acc = await prisma.beanAccount.findUnique({ where: { merchantId: m } })
  return acc?.frozen ?? 0n
}
async function reservationOf(m: bigint, requestId: string) {
  return prisma.beanReservation.findFirst({
    where: { merchantId: m, bizType: 'RENDER', requestId },
    select: { status: true, reserved: true, consumed: true, released: true },
  })
}
async function statusOf(id: bigint): Promise<string> {
  const t = await prisma.renderTask.findUnique({ where: { id }, select: { status: true } })
  return t?.status ?? '(missing)'
}

async function main() {
  // ═══════════ ① storeChatCutState 不得写 FAILED 终态 ═══════════
  section('① storeChatCutState 不写 FAILED 终态（否则预留永不释放）')
  {
    const f = await fixture('state')
    const task = await runningTask(f.merchantId, f.creationId, 'vf-state-1', 30n)
    await storeChatCutState(
      task.id,
      { projectId: 'verify-project', uploadAssetIds: [], transcriptionAssetIds: [], phase: 'PREPARE' },
      'FAILED',
    )
    check(
      (await statusOf(task.id)) === 'RUNNING',
      '传入 FAILED 后任务仍是 RUNNING（终态只归 failRender）',
      `status=${await statusOf(task.id)}`,
    )
    check((await frozenOf(f.merchantId)) === 30n, '此时预留仍冻结 30（未被误动）')
  }

  // ═══════════ ② 迟到快照不得复活终态 ═══════════
  section('② 迟到阶段快照不能把终态改回 RUNNING')
  {
    const f = await fixture('stale')
    const task = await runningTask(f.merchantId, f.creationId, 'vf-stale-1', 30n)
    await prisma.$transaction((tx) =>
      completeRender(tx, f.merchantId, task.id, { resultKey: `renders/${f.merchantId}/x.mp4` }),
    )
    check((await statusOf(task.id)) === 'SUCCESS', '先结算成功 → SUCCESS')
    await storeChatCutState(
      task.id,
      { projectId: 'verify-project', uploadAssetIds: [], transcriptionAssetIds: [], phase: 'RENDER' },
      'SUCCESS',
    )
    check(
      (await statusOf(task.id)) === 'SUCCESS',
      '再收到迟到的阶段快照 → 仍是 SUCCESS（没有复活成 RUNNING）',
      `status=${await statusOf(task.id)}`,
    )
    const res = await reservationOf(f.merchantId, 'vf-stale-1')
    check(res?.status === 'RELEASED' || res?.consumed === 30n, '预留已被正常结算（未重复扣费）', j(res))
  }

  // ═══════════ ③ failRender 释放预留，且幂等 ═══════════
  section('③ failRender 释放预留，并且可重复调用')
  {
    const f = await fixture('fail')
    const task = await runningTask(f.merchantId, f.creationId, 'vf-fail-1', 30n)
    check((await frozenOf(f.merchantId)) === 30n, '失败前：frozen=30（已预留）')
    const s1 = await failRender(prisma, task.id, 'FFMPEG_FAILED', '用例：模拟合成失败')
    check(s1 === 'FAILED', 'failRender → FAILED', `state=${s1}`)
    check((await frozenOf(f.merchantId)) === 0n, '失败后：frozen=0（预留已释放）', `frozen=${await frozenOf(f.merchantId)}`)
    // 再调一次：幂等，不得二次释放把账户弄成负数
    const s2 = await failRender(prisma, task.id, 'FFMPEG_FAILED', '用例：重复调用')
    check(s2 === 'FAILED' && (await frozenOf(f.merchantId)) === 0n, '重复调用仍 FAILED 且 frozen 依旧 0（幂等）')
  }

  // ═══════════ ④ 历史残留：已 FAILED 但预留还在 ⇒ 必须补释放 ═══════════
  section('④ 任务已是 FAILED、预留仍 ACTIVE ⇒ 补释放（修历史缺陷的路径）')
  {
    const f = await fixture('legacy')
    const task = await runningTask(f.merchantId, f.creationId, 'vf-legacy-1', 30n)
    // 手工复刻缺陷留下的状态：任务被写成 FAILED，但预留原地不动
    await prisma.renderTask.update({ where: { id: task.id }, data: { status: 'FAILED', errorCode: 'CHATCUT_FAILED' } })
    check((await frozenOf(f.merchantId)) === 30n, '构造出「已 FAILED 但冻结仍在」的存量行')
    const s = await failRender(prisma, task.id, 'CHATCUT_FAILED', '用例：补释放历史残留')
    check(s === 'FAILED' && (await frozenOf(f.merchantId)) === 0n, '再次收尾时把遗留预留释放掉（frozen→0）')
    const res = await reservationOf(f.merchantId, 'vf-legacy-1')
    check(res?.status === 'RELEASED', '预留状态 → RELEASED', j(res))
  }

  // ═══════════ ⑤ 租约版本落后 ⇒ 收尾放弃 ═══════════
  section('⑤ 租约版本落后（已被回收重跑）⇒ 旧执行者收尾必须放弃')
  {
    const f = await fixture('fence')
    const task = await runningTask(f.merchantId, f.creationId, 'vf-fence-1', 30n)
    const fence = await claimTask(task.id, { onlyQueued: false })
    check(!!fence, '认领成功，拿到执行权凭证', j(fence))
    // 模拟「租约过期后被孤儿回收」：version 自增、owner 清空
    await prisma.renderTask.update({
      where: { id: task.id },
      data: { leaseVersion: { increment: 1 }, leaseOwner: null, leaseExpireAt: null },
    })
    const s = await failRender(prisma, task.id, 'FFMPEG_FAILED', '用例：旧执行者迟到收尾', fence!)
    check(s === 'SUPERSEDED', '旧凭证收尾 → SUPERSEDED（不写终态）', `state=${s}`)
    check((await statusOf(task.id)) === 'RUNNING', '任务状态未被旧执行者改动', `status=${await statusOf(task.id)}`)
    check((await frozenOf(f.merchantId)) === 30n, '旧执行者也没有误释放预留（留给真正的持有者）')
  }

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`)
}

main()
  .catch((e) => {
    console.error('验证脚本执行失败:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    for (const m of created) {
      try { await cleanup(m) } catch (e) { console.error(`清理商户 ${m} 失败:`, (e as Error).message) }
    }
    await prisma.$disconnect()
  })
