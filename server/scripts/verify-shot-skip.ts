/**
 * 「暂不上传该分镜」（跳过素材）的回归测试。
 *
 * 被验证的缺陷（P2，改动前必现）：
 *   拍摄页的「暂不上传」只写在小程序页面的 state 里（本地 `_skipped` 标记），
 *   而合成页是按「分镜有没有 assetId」判断素材是否齐全的 ⇒ **跳过等于没跳过**：
 *   用户点了「确定跳过」、走到合成页，仍然被「请先补齐全部分镜素材」挡住，
 *   而那个分镜他本来就打算不拍。回去再点一次跳过，还是被挡 —— 一个没有出口的死循环。
 *
 * 另外两处必须与真实行为对齐：
 *   · 弹窗原文写「将使用系统默认占位素材」—— 服务端根本没有占位素材这回事
 *     （ChatCut 要 register_asset_placeholder + PUT 真实字节，本地 ffmpeg 也要真文件），
 *     这是对用户许了一个做不到的承诺。真实语义是「该分镜不进成片、也不计费」。
 *   · 跳过状态必须**落库**：只写本地的话刷新/换设备就丢。
 *
 * 只造一个临时商户，跑完硬删。不联网、不调远端 AI。
 *
 * 用法：npm run shot-skip:verify
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { devLogin } from '../src/auth/auth.service.js'
import * as creationSvc from '../src/services/creation.service.js'
import { buildRenderClips, RenderNoAssetError } from '../src/services/render.service.js'

const prisma = new PrismaClient()
const PHONE = '13900009994' // 与 …9999/9998/9997/9996/9995 区分，避免并行跑互相踩

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
  const creations = await prisma.creation.findMany({ where: { merchantId }, select: { id: true } })
  const creationIds = creations.map((c) => c.id)
  await prisma.shot.deleteMany({ where: { creationId: { in: creationIds } } })
  await prisma.mediaAsset.deleteMany({ where: { merchantId } })
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

const shotOf = (id: bigint) => prisma.shot.findUniqueOrThrow({ where: { id } })

async function main() {
  const stale = await prisma.merchant.findUnique({ where: { phone: PHONE } })
  if (stale) {
    console.log(`（清理上次残留：商户 ${stale.id}）`)
    await cleanup(stale.id)
  }

  await devLogin(prisma, PHONE)
  const mid = (await prisma.merchant.findUniqueOrThrow({ where: { phone: PHONE } })).id
  tempMerchantId = mid

  const store = await prisma.store.create({ data: { merchantId: mid, name: '跳过测试门店', intro: '' } })
  const creation = await prisma.creation.create({
    data: { merchantId: mid, storeId: store.id, track: 'FOOD', complexity: 'SIMPLE', title: '跳过测试' },
  })
  // 另一个商户的创作：用来验证「拿着别人的 shotId 改自己的创作」不会成功
  const other = await prisma.store.create({ data: { merchantId: mid, name: '跳过测试门店2', intro: '' } })
  const creation2 = await prisma.creation.create({
    data: { merchantId: mid, storeId: other.id, track: 'FOOD', complexity: 'SIMPLE', title: '跳过测试2' },
  })

  const mkShots = (creationId: bigint, n: number) =>
    prisma.shot.createMany({
      data: Array.from({ length: n }, (_v, i) => ({
        creationId,
        seq: i + 1,
        shotType: `类型${i + 1}`,
        durationSuggest: 3,
      })),
    })
  await mkShots(creation.id, 3)
  await mkShots(creation2.id, 1)

  const shots = await prisma.shot.findMany({ where: { creationId: creation.id }, orderBy: { seq: 'asc' } })
  const s1 = shots[0]!
  const s2 = shots[1]!
  const otherShot = (await prisma.shot.findFirstOrThrow({ where: { creationId: creation2.id } })).id

  // 造两个真素材（buildRenderClips 要求素材属于本商户 + 本门店 + 未删除）
  const asset = await prisma.mediaAsset.create({
    data: {
      merchantId: mid, storeId: store.id, ownerType: 'SHOT', type: 'VIDEO',
      cosKey: `uploads/${mid}/verify-skip-a.mp4`, bucket: 'verify', region: 'local',
      durationMs: 4000, sizeBytes: 1000n,
    },
  })
  const asset2 = await prisma.mediaAsset.create({
    data: {
      merchantId: mid, storeId: store.id, ownerType: 'SHOT', type: 'VIDEO',
      cosKey: `uploads/${mid}/verify-skip-b.mp4`, bucket: 'verify', region: 'local',
      durationMs: 4000, sizeBytes: 1000n,
    },
  })

  // ── ① 跳过 ⇒ 落库，且与 assetId 互斥 ────────────────────────────
  console.log('\n════ ① 跳过：写入库、清空素材与裁剪区间 ════')
  // 先把 s1 造成「有素材 + 有 trim」的状态，确认跳过会把它们一起清干净
  await creationSvc.updateShotAsset(prisma, mid, creation.id, s1.id, { assetId: asset.id, trimStartMs: 500, trimEndMs: 3000 })
  const before = await shotOf(s1.id)
  check(before.assetId !== null && before.trimStartMs === 500 && before.trimEndMs === 3000, '前置：s1 已绑定素材并设了 trim',
    `assetId=${before.assetId} trim=${before.trimStartMs}-${before.trimEndMs}`)

  const afterSkip = await creationSvc.updateShotAsset(prisma, mid, creation.id, s1.id, { skipped: true })
  const row1 = await shotOf(s1.id)
  check(row1.skipped === true, '★ 跳过已落库（不再只活在前端 state 里）')
  check(row1.assetId === null, '★ 素材被清空（不变量：skipped=true ⇒ assetId=null）', String(row1.assetId))
  check(row1.trimStartMs === 0 && row1.trimEndMs === null, '裁剪区间一并归零（那段素材已经不绑了）',
    `trim=${row1.trimStartMs}-${row1.trimEndMs}`)
  check(afterSkip.skipped === true, '返回值就是落库后的行（前端据此回填，不必再拉一次）')

  // ── ② 只影响被跳过的那个分镜 ─────────────────────────────────────
  console.log('\n════ ② 只改一个分镜，不波及其他 ════')
  const row2 = await shotOf(s2.id)
  check(row2.skipped === false, '相邻分镜的 skipped 不受影响')

  // ── ③ 撤销跳过：只清标记，不动别的 ───────────────────────────────
  console.log('\n════ ③ 撤销跳过 ⇒ 回到「待上传」 ════')
  await creationSvc.updateShotAsset(prisma, mid, creation.id, s1.id, { skipped: false })
  const row3 = await shotOf(s1.id)
  check(row3.skipped === false, '标记已清除')
  check(row3.assetId === null, '素材仍为空（撤销只是「允许重传」，不会凭空变出素材）', String(row3.assetId))

  // ── ④ 传新素材 ⇒ 自动清掉跳过（互斥不变量）────────────────────────
  console.log('\n════ ④ 跳过后又补拍了 ⇒ 跳过必须自动失效 ════')
  await creationSvc.updateShotAsset(prisma, mid, creation.id, s1.id, { skipped: true })
  await creationSvc.updateShotAsset(prisma, mid, creation.id, s1.id, { assetId: asset.id })
  const row4 = await shotOf(s1.id)
  check(row4.assetId === asset.id, '素材已绑定')
  check(row4.skipped === false, '★ 跳过标记被自动清掉（否则合成页会把这个分镜静默丢掉，用户白传一条）',
    `skipped=${row4.skipped}`)
  check(row4.trimEndMs === null, '新素材不带旧 trim 尾巴（重新拍摄 = 全新素材）', String(row4.trimEndMs))

  // ── ⑤ 空 patch ⇒ 只读回读，不写库 ────────────────────────────────
  console.log('\n════ ⑤ 空 patch：只校验归属并回读，绝不顺手改库 ════')
  const readBack = await creationSvc.updateShotAsset(prisma, mid, creation.id, s1.id, {})
  const row5 = await shotOf(s1.id)
  check(readBack.id === s1.id, '返回该分镜')
  check(row5.assetId === asset.id && row5.trimStartMs === 0, '★ 素材与 trim 原样未变（空 patch 不该抹掉已有绑定）',
    `assetId=${row5.assetId} trim=${row5.trimStartMs}`)

  // ── ⑥ 越权：拿着别的创作的分镜编号 ───────────────────────────────
  console.log('\n════ ⑥ 越权：别的创作的分镜编号 ⇒ ShotNotFoundError ════')
  let denied = false
  try {
    await creationSvc.updateShotAsset(prisma, mid, creation.id, otherShot, { skipped: true })
  } catch (e) {
    denied = e instanceof creationSvc.ShotNotFoundError
  }
  const otherRow = await prisma.shot.findUniqueOrThrow({ where: { id: otherShot } })
  check(denied, '抛 ShotNotFoundError')
  check(otherRow.skipped === false, '★ 别人的分镜没有被改（拒绝是真的拒绝，不是只在返回值上）')

  // ── ⑦ 合成取片：跳过的分镜不得进成片（哪怕库里有脏数据）──────────
  console.log('\n════ ⑦ 合成管线：跳过的分镜不进 clips ════')
  await creationSvc.updateShotAsset(prisma, mid, creation.id, s2.id, { skipped: true })
  const clips = await buildRenderClips(prisma, mid, creation.id, store.id)
  check(clips.length === 1 && clips[0]!.shotId === s1.id.toString(), '只取到未跳过的那个分镜',
    `n=${clips.length} shotIds=${clips.map((c) => c.shotId).join(',')}`)

  // 脏数据：绕过 service 直接把 assetId 塞回去（模拟有人手工改库 / 将来新增写入路径漏了互斥）
  await prisma.shot.update({ where: { id: s2.id }, data: { assetId: asset2.id } })
  const dirty = await shotOf(s2.id)
  check(dirty.skipped === true && dirty.assetId !== null, '前置：制造「既跳过、又有素材」的脏数据')
  const clips2 = await buildRenderClips(prisma, mid, creation.id, store.id)
  check(clips2.length === 1, '★ 脏数据也不进成片（where 里的 skipped:false 是对不变量的纵深防御）', `n=${clips2.length}`)

  // ── ⑧ 全部分镜被跳过 ⇒ 明确报错，而不是产出空片 ──────────────────
  console.log('\n════ ⑧ 一个素材都没有 ⇒ RenderNoAssetError（前端据此挡住提交）════')
  // 先清掉脏数据的影响：把 s1 也跳过，此时没有任何可用素材
  await prisma.shot.update({ where: { id: s2.id }, data: { assetId: null } })
  await creationSvc.updateShotAsset(prisma, mid, creation.id, s1.id, { skipped: true })
  let noAsset = false
  try {
    await buildRenderClips(prisma, mid, creation.id, store.id)
  } catch (e) {
    noAsset = e instanceof RenderNoAssetError
  }
  check(noAsset, '★ 抛 RenderNoAssetError（路由层映射 4003；前端 canCompose 要求至少 1 个真素材）')

  // ── ⑨ 列表进度：跳过的算「已就绪」 ──────────────────────────────
  console.log('\n════ ⑨ 列表进度：跳过的分镜不再挂「缺素材」 ════')
  // 此时 s1 / s2 已跳过，s3 还没被碰过（既没素材也没跳过）⇒ 应当是 2/3
  const mid1 = await creationSvc.listCreations(prisma, mid, store.id)
  const card1 = mid1.find((c) => c.id === creation.id)
  check(card1?.shotsTotal === 3, 'shotsTotal=3', String(card1?.shotsTotal))
  check(card1?.shotsReady === 2, '2 个已跳过 ⇒ 2/3 就绪（不再显示 0/3）', `shotsReady=${card1?.shotsReady}`)

  // 把最后一个也跳过：全部就绪，进度不该卡在 2/3
  const s3 = shots[2]!
  await creationSvc.updateShotAsset(prisma, mid, creation.id, s3.id, { skipped: true })
  const list = await creationSvc.listCreations(prisma, mid, store.id)
  const card = list.find((c) => c.id === creation.id)
  check(card?.shotsReady === 3, '★ 全部分镜跳过 ⇒ 3 / 3 就绪：不该继续显示「2/3」催用户去拍',
    `shotsReady=${card?.shotsReady}`)
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
