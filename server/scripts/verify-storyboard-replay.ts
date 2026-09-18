/**
 * 「AI 分镜结果重复应用」的回归测试。
 *
 * 被验证的缺陷（P1-14，改动前必现）：
 *   AI 账务层对同一 requestId 会正确返回**缓存结果**（不重复扣费），
 *   但 `generateShots` 拿到结果后**无条件** `deleteMany` + 重建分镜。
 *   于是「首次生成成功后，用户改了分镜 / 绑了素材，客户端因网络重试又提交了同一个 requestId」
 *   会把用户的全部编辑静默清空 —— 而且看起来完全成功（返回了 shots、扣费也是幂等的）。
 *
 * 同时覆盖两个相邻问题：
 *   · 迟到的**旧** requestId 重放，不得用旧结果覆盖更新的分镜；
 *   · 真正的「重新生成」（新 requestId）必须照常重建。
 *
 * 用一个假 gateway 注入，**不联网、不调远端 AI**；只造一个临时商户，跑完硬删。
 *
 * 用法：npm run storyboard-replay:verify
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { devLogin } from '../src/auth/auth.service.js'
import { generateShots } from '../src/services/creation.service.js'
import type { AiGateway } from '../src/ai/gateway.js'
import * as bean from '../src/bean/bean.service.js'

const prisma = new PrismaClient()
const PHONE = '13900009995' // 与 …9999/9998/9997/9996 区分，避免并行跑互相踩

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

let tempMerchantId: bigint | null = null

async function cleanup(merchantId: bigint) {
  // 顺序受外键约束。shot 表没有 merchantId，只能先按 creationId 找出来再删
  // （漏掉它会让 creation 的删除以 `Foreign key constraint violated: creation_id` 失败，
  //   临时商户永久留在库里）。
  const creations = await prisma.creation.findMany({ where: { merchantId }, select: { id: true } })
  const creationIds = creations.map((c) => c.id)
  await prisma.shot.deleteMany({ where: { creationId: { in: creationIds } } })
  await prisma.membershipReminder.deleteMany({ where: { merchantId } })
  await prisma.membership.deleteMany({ where: { merchantId } })
  await prisma.order.deleteMany({ where: { merchantId } })
  await prisma.aiCallLog.deleteMany({ where: { merchantId } })
  await prisma.beanLedger.deleteMany({ where: { merchantId } })
  await prisma.beanReservation.deleteMany({ where: { merchantId } })
  await prisma.businessRequest.deleteMany({ where: { merchantId } })
  await prisma.beanAccount.deleteMany({ where: { merchantId } })
  await prisma.renderTask.deleteMany({ where: { merchantId } })
  await prisma.creation.deleteMany({ where: { merchantId } })
  await prisma.store.deleteMany({ where: { merchantId } })
  await prisma.merchant.deleteMany({ where: { id: merchantId } })
}

/**
 * 假 gateway：按调用序返回不同的分镜 JSON，并记录被调了几次。
 *
 * ★ 必须同时落一行 AiCallLog —— 这不是「多此一举」，而是**真 gateway 的可观测契约**：
 *   `runBilledScene` 判断「这个 requestId 是重放」之后，要靠 ai_call_log 才能拿到
 *   上次的结果（含 costFen / responseSnapshot）。不写日志的假 gateway 会让重放
 *   走进 ScenePendingError 分支，测出来的就不是真实链路了。
 */
function fakeGateway(
  prisma: PrismaClient,
  merchantId: bigint,
  sceneCode: string,
  shotsPerCall: string[],
  providerId: bigint,
  modelId: bigint,
) {
  let n = 0
  const calls: string[] = []
  const gw = {
    async runScene(params: { sceneCode: string; requestId: string }) {
      calls.push(params.requestId)
      const text = shotsPerCall[Math.min(n, shotsPerCall.length - 1)] as string
      n += 1
      await prisma.aiCallLog.create({
        data: {
          merchantId,
          sceneCode,
          requestId: params.requestId,
          providerId,
          modelId,
          isFallback: false,
          costFen: 1,
          totalTokens: 30,
          status: 'SUCCESS',
          responseSnapshot: text,
        },
      })
      return {
        ok: true as const,
        text,
        usage: { promptTokens: 10, completionTokens: 20 },
        costFen: 1,
        providerId,
        modelId,
        modelCode: 'verify-fake',
        usedFallback: false,
        attempts: 1,
      }
    },
  }
  return { gw: gw as unknown as AiGateway, calls }
}

/** 造 N 条分镜的 AI 响应（seq 从 100 起，便于分辨是「哪一次结果」） */
function shotsJson(count: number, base: number): string {
  const arr = Array.from({ length: count }, (_v, i) => ({
    seq: i + 1,
    shotType: `类型${base + i}`,
    shotSize: '中景',
    durationSuggest: 3,
    line: `台词${base + i}`,
    visualReq: `画面${base + i}`,
  }))
  return JSON.stringify({ shots: arr })
}

const shotsOf = (creationId: bigint) =>
  prisma.shot.findMany({ where: { creationId }, orderBy: { seq: 'asc' }, select: { id: true, shotType: true, line: true } })

async function main() {
  const stale = await prisma.merchant.findUnique({ where: { phone: PHONE } })
  if (stale) {
    console.log(`（清理上次残留：商户 ${stale.id}）`)
    await cleanup(stale.id)
  }

  await devLogin(prisma, PHONE)
  const mid = (await prisma.merchant.findUniqueOrThrow({ where: { phone: PHONE } })).id
  tempMerchantId = mid

  const store = await prisma.store.create({ data: { merchantId: mid, name: '重放测试门店', intro: '' } })
  const creation = await prisma.creation.create({
    data: { merchantId: mid, storeId: store.id, track: 'FOOD', complexity: 'SIMPLE', title: '重放测试' },
  })
  // requireSubscription 是硬前提：直接给一张有效会员
  const pkg = await prisma.memberPackage.findFirstOrThrow({ where: { code: 'SUBSCRIPTION' } })
  await prisma.membership.create({
    data: {
      merchantId: mid, packageId: pkg.id,
      startAt: new Date(Date.now() - 1000), endAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      grantBeans: 0n, grantExpireAt: new Date(Date.now() + 30 * 24 * 3600 * 1000), status: 'ACTIVE',
    },
  })
  // 留足积分（分镜场景标价 250）
  await prisma.beanAccount.upsert({
    where: { merchantId: mid },
    create: { merchantId: mid, balance: 100000n },
    update: { balance: 100000n, frozen: 0n },
  })
  void bean

  const provider = await prisma.aiProvider.findFirstOrThrow({ orderBy: { id: 'asc' } })
  const model = await prisma.aiModel.findFirstOrThrow({ orderBy: { id: 'asc' } })
  const { gw, calls } = fakeGateway(
    prisma,
    mid,
    'storyboard_generate',
    [shotsJson(3, 100), shotsJson(4, 200), shotsJson(5, 300)],
    provider.id,
    model.id,
  )

  // ── ① 首次生成：正常重建 ────────────────────────────────────────
  console.log('\n════ ① 首次生成 ⇒ 建立分镜并写下「已应用」标记 ════')
  const R1 = `R1-${Date.now()}`
  const r1 = await generateShots(prisma, gw, mid, creation.id, R1)
  check(r1.parsed && r1.shots.length === 3, '生成 3 条分镜', `parsed=${r1.parsed} n=${r1.shots.length}`)
  let row = await prisma.creation.findUniqueOrThrow({ where: { id: creation.id } })
  check(row.storyboardAppliedRequestId === R1, '标记为本次 requestId', String(row.storyboardAppliedRequestId))
  check(row.storyboardAppliedAt !== null, '写下应用时刻（用作排序键）')

  // ── ② 用户编辑分镜 + 绑定素材 ───────────────────────────────────
  console.log('\n════ ② 用户手动改分镜（并绑定素材）════')
  const beforeEdit = await shotsOf(creation.id)
  await prisma.shot.update({
    where: { id: beforeEdit[0]!.id },
    data: { line: '用户改过的台词', shotType: '用户改过的类型', status: 'READY' },
  })
  const editedIds = (await shotsOf(creation.id)).map((s) => s.id.toString())
  const edited = await shotsOf(creation.id)
  check(edited[0]?.line === '用户改过的台词', '编辑已落库')

  // ── ③ 重放同一个 requestId：**不得清掉用户编辑** ─────────────────
  console.log('\n════ ③ 重放同一 requestId（客户端网络重试）⇒ 必须保留用户编辑 ════')
  const callsBefore = calls.length
  const r2 = await generateShots(prisma, gw, mid, creation.id, R1)
  const after2 = await shotsOf(creation.id)
  check(
    after2.map((s) => s.id.toString()).join(',') === editedIds.join(','),
    '★ 分镜行 ID 完全未变（没有被删掉重建）',
    `${editedIds.length} → ${after2.length}`,
  )
  check(after2[0]?.line === '用户改过的台词', '★ 用户的编辑内容原样保留', String(after2[0]?.line))
  check(
    after2[0]?.shotType === '用户改过的类型',
    '★ 第 1 条没有被写回 AI 原文（类型100）',
    String(after2[0]?.shotType),
  )
  check(after2.length === editedIds.length, '分镜条数未变', `${editedIds.length} → ${after2.length}`)
  check(r2.shots.length === after2.length, '返回值就是当前分镜（不是 AI 的旧数组）', `n=${r2.shots.length}`)
  check(r2.parsed === true, '仍标记为 parsed=true（分镜确实存在，前端不会误判为「没生成」）')
  check(r2.duplicated === true, '账务层识别为重复请求', String(r2.duplicated))
  check(calls.length === callsBefore, '没有再次调用 AI 网关', `calls +${calls.length - callsBefore}`)

  // ── ④ 真正的重新生成（新 requestId）：必须照常重建 ────────────────
  console.log('\n════ ④ 重新生成（新 requestId）⇒ 必须重建，用户编辑被新分镜取代 ════')
  const R2 = `R2-${Date.now()}`
  const r3 = await generateShots(prisma, gw, mid, creation.id, R2)
  const after3 = await shotsOf(creation.id)
  check(after3.length === 4, '按第二次的 AI 结果重建为 4 条', `n=${after3.length}`)
  check(
    after3.map((s) => s.id.toString()).join(',') !== editedIds.join(','),
    '分镜行确实被替换（重新生成是用户主动要的结果）',
  )
  check(after3[0]?.shotType === '类型200', '内容来自第二次 AI 结果', String(after3[0]?.shotType))
  row = await prisma.creation.findUniqueOrThrow({ where: { id: creation.id } })
  check(row.storyboardAppliedRequestId === R2, '标记推进到 R2', String(row.storyboardAppliedRequestId))
  check(r3.shots.length === 4, '返回 4 条', `n=${r3.shots.length}`)

  // ── ⑤ 迟到的旧 requestId 重放：不得用旧结果覆盖新分镜 ──────────────
  console.log('\n════ ⑤ 迟到的旧 requestId（R1）重放 ⇒ 不得覆盖 R2 的分镜 ════')
  const r4 = await generateShots(prisma, gw, mid, creation.id, R1)
  const after4 = await shotsOf(creation.id)
  check(after4.length === 4, '★ 仍是 4 条（旧结果的 3 条没有写回来）', `n=${after4.length}`)
  check(after4[0]?.shotType === '类型200', '★ 内容仍是 R2 的结果', String(after4[0]?.shotType))
  check(r4.shots.length === 4, '返回当前分镜', `n=${r4.shots.length}`)

  // ── ⑥ 崩溃恢复：标记为空但 AI 已出结果 ⇒ 必须补建一次 ─────────────
  console.log('\n════ ⑥ 崩溃恢复（标记为空、AI 结果已在库）⇒ 补建一次 ════')
  await prisma.creation.update({
    where: { id: creation.id },
    data: { storyboardAppliedRequestId: null, storyboardAppliedAt: null },
  })
  const r5 = await generateShots(prisma, gw, mid, creation.id, R2)
  const after5 = await shotsOf(creation.id)
  check(r5.parsed && after5.length === 4, '补建成功（4 条）', `n=${after5.length}`)
  row = await prisma.creation.findUniqueOrThrow({ where: { id: creation.id } })
  check(row.storyboardAppliedRequestId === R2, '标记重新写下', String(row.storyboardAppliedRequestId))

  // ── ⑦ 标记说已应用、但分镜被清空 ⇒ 不能返回 0 条把用户卡住 ─────────
  console.log('\n════ ⑦ 标记已应用但分镜为空 ⇒ 补建（否则前端认定「没生成」）════')
  await prisma.shot.deleteMany({ where: { creationId: creation.id } })
  const r6 = await generateShots(prisma, gw, mid, creation.id, R2)
  check(r6.parsed && r6.shots.length === 4, '★ 空分镜时补建，不返回空数组', `n=${r6.shots.length}`)

  // ── ⑧ 空数组响应不得清掉已有分镜 ────────────────────────────────
  console.log('\n════ ⑧ AI 返回空分镜数组 ⇒ 不得清掉库里已有分镜 ════')
  const gwEmpty = fakeGateway(prisma, mid, 'storyboard_generate', ['{"shots":[]}'], provider.id, model.id)
  const R3 = `R3-${Date.now()}`
  const r7 = await generateShots(prisma, gwEmpty.gw, mid, creation.id, R3)
  const after7 = await shotsOf(creation.id)
  check(after7.length === 4, '★ 已有分镜原样保留（没有被清空）', `n=${after7.length}`)
  check(r7.parsed === false, '如实报告本次没生成出新分镜', `parsed=${r7.parsed}`)
  check(r7.shots.length === 4, '把现有分镜一并返回', `n=${r7.shots.length}`)
}

async function teardown() {
  if (tempMerchantId === null) return
  console.log('\n（清理临时商户…）')
  await cleanup(tempMerchantId).catch((e) => console.error('清理失败：', (e as Error).message))
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
    await teardown()
    await prisma.$disconnect()
    process.exit(1)
  })
