/**
 * 幂等守卫回归：并发同 requestId 的「业务请求占用」在两种隔离级别下的行为差异。
 *
 * 背景（P2-2）：MySQL 默认 REPEATABLE READ。事务内第一条一致读就把快照定死，
 * 赢家在我们读完之后才提交，于是 claimBusinessRequest 命中 P2002 后的**同事务重读返回 null**，
 * 代码走 `throw e` 把 P2002 重新抛出 → 上层 500。
 * 实测（8 并发同 requestId 打 /creations/:id/render）：1×200 + 7×500「提交合成失败」，
 * 数据虽正确（1 任务 / 1 冻结）但客户端看到的是失败，且轮询重试会持续吃 5xx。
 * 修法：submitRender / runScene 的事务显式 isolationLevel='ReadCommitted'。修后 8/8 全 200。
 *
 * 本脚本把这个「为什么」固化成断言，不需要起服务：
 *   ① READ COMMITTED 下，输家能读到赢家刚提交的行（返回 created:false，不抛错）
 *   ② REPEATABLE READ 下会抛 P2002（记录危险基线，防止有人把 isolationLevel 删掉）
 *   ③ 同 requestId 换参数 → RequestConflictError
 *   ④ 真正并发（Promise.all）下只有一个赢家，落库恒为 1 行
 *
 * 跑法：npx tsx scripts/verify-request-idempotency.ts
 */
import { PrismaClient, Prisma } from '@prisma/client'
import { claimBusinessRequest, payloadHash, RequestConflictError } from '../src/domain/request.js'

const prisma = new PrismaClient()
const MERCHANT = 1n
const OP = 'VERIFY_REQUEST_IDEMPOTENCY'
/** 赢家与输家用完全相同的 payload，确保唯一的变量只有隔离级别 */
const PAYLOAD = { seed: true }
const HASH = payloadHash(PAYLOAD)

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

async function cleanup() {
  await prisma.businessRequest.deleteMany({ where: { operation: OP } })
}

/** 让一个事务先插入占住唯一索引，但不提交，直到 holdMs 之后 */
function holdWinnerTx(reqId: string, holdMs: number) {
  return prisma.$transaction(async (tx) => {
    await tx.businessRequest.create({
      data: { merchantId: MERCHANT, operation: OP, requestId: reqId, payloadHash: HASH },
    })
    await new Promise((r) => setTimeout(r, holdMs))
  })
}

/** 输家：先读（定快照），等赢家提交后再插入（撞唯一索引） */
async function loserRun(reqId: string, isolationLevel: 'ReadCommitted' | 'RepeatableRead') {
  return prisma.$transaction(
    async (tx) => {
      try {
        const r = await claimBusinessRequest(tx, {
          merchantId: MERCHANT,
          operation: OP,
          requestId: reqId,
          payload: PAYLOAD,
        })
        return { threw: false as const, created: r.created }
      } catch (e) {
        const e2 = e as Prisma.PrismaClientKnownRequestError
        return { threw: true as const, code: e2.code ?? e2.name }
      }
    },
    { isolationLevel },
  )
}

async function scenario(isolationLevel: 'ReadCommitted' | 'RepeatableRead') {
  const reqId = `${OP}-${isolationLevel}-${Date.now().toString(36)}`
  await cleanup()
  const winner = holdWinnerTx(reqId, 350)
  await new Promise((r) => setTimeout(r, 60))
  const [loser] = await Promise.all([
    // 让输家先完成首次一致读，再撞唯一索引
    (async () => {
      await new Promise((r) => setTimeout(r, 60))
      return loserRun(reqId, isolationLevel)
    })(),
  ])
  await winner.catch(() => {})
  return { reqId, loser }
}

console.log('=== ① READ COMMITTED（当前实现的依赖）===')
{
  const { loser } = await scenario('ReadCommitted')
  check(!loser.threw, '输家不抛错，正常返回首次结果', `created=${'created' in loser ? loser.created : '-'}`)
  check('created' in loser && loser.created === false, '输家识别为重复请求（created=false）')
}

console.log('\n=== ② REPEATABLE READ（危险基线：说明为何必须显式设隔离级别）===')
{
  const { loser } = await scenario('RepeatableRead')
  check(
    loser.threw && loser.code === 'P2002',
    'REPEATABLE READ 下重读为 null → 重抛 P2002（上层会 500）',
    `threw=${loser.threw} code=${'code' in loser ? loser.code : '-'}`,
  )
}

console.log('\n=== ③ 同 requestId 换业务参数 ===')
{
  const reqId = `${OP}-conflict-${Date.now().toString(36)}`
  await cleanup()
  await prisma.businessRequest.create({
    data: { merchantId: MERCHANT, operation: OP, requestId: reqId, payloadHash: 'different' },
  })
  let conflict = false
  try {
    await prisma.$transaction(
      (tx) => claimBusinessRequest(tx, { merchantId: MERCHANT, operation: OP, requestId: reqId, payload: PAYLOAD }),
      { isolationLevel: 'ReadCommitted' },
    )
  } catch (e) {
    conflict = e instanceof RequestConflictError
  }
  check(conflict, '抛 RequestConflictError（→ 409 / code 2007）')
  await cleanup()
}

console.log('\n=== ④ 真并发：多个事务抢同一 requestId ===')
{
  const reqId = `${OP}-race-${Date.now().toString(36)}`
  await cleanup()
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      prisma
        .$transaction(
          (tx) => claimBusinessRequest(tx, { merchantId: MERCHANT, operation: OP, requestId: reqId, payload: PAYLOAD }),
          { isolationLevel: 'ReadCommitted' },
        )
        .then((r) => (r.created ? 'win' : 'dup'))
        .catch((e) => `err:${(e as Error).name}`),
    ),
  )
  const wins = results.filter((r) => r === 'win').length
  const errs = results.filter((r) => r.startsWith('err:')).length
  const rows = await prisma.businessRequest.count({ where: { operation: OP, requestId: reqId } })
  check(wins === 1, '恰好一个赢家', `wins=${wins}`)
  check(errs === 0, '没有任何请求报错', `errors=${errs}`)
  check(rows === 1, '落库恒为 1 行', `rows=${rows}`)
  console.log(`    分布：${results.join(', ')}`)
  await cleanup()
}

await cleanup()
console.log(`\n★ ${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
