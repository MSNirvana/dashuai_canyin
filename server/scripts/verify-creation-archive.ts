/**
 * 创作「归档 / 恢复 / 删除」契约验证。
 *
 * 为什么值得单写一个脚本 —— 这里有三处**静默失效**，破了都不会报错：
 *   ① 归档后仍出现在默认列表：服务层 `archivedAt: null` 过滤漏写，或想靠前端本地过滤
 *      （那样下拉刷新一次就穿帮）。归档的全部价值就是"不在默认分类里"，漏了等于没做。
 *   ② 越权：只按 id 更新、where 不带 merchantId ⇒ 任何人能归档/删除**别人的**创作。
 *      这是最危险的一类 —— 接口返回 200、数据真的被改了，日志里也看不出异常。
 *   ③ 把「删除」写成物理删除：本项目既有语义是软删（`deletedAt` 列 + 列表过滤都在），
 *      物理删会连带 shot / render_task 与素材对象，且误删不可逆。
 *   ④ 列表卡片进度条依赖 `shotsTotal / shotsReady / renderStatus` 三个标量，
 *      少下发一个**不报错，只是进度条永远算不上去**（比如 shotsReady 缺失 ⇒ 素材段恒 0，
 *      项目永远停在 50%）。所以这里连「没分镜时是 0 而不是 undefined」「取最新一条任务」一起断言。
 *
 * 用法：npm run creation-archive:verify
 * 用一个一次性手机号造临时商户 + 门店 + 两条创作，跑完按外键顺序硬删；不动任何真实商户数据。
 * 越权用例是**断言失败**（where 带 merchantId ⇒ count 恒为 0），不会改动真实商户的数据。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CreationNotFoundError,
  archiveCreation,
  createCreation,
  deleteCreation,
  getCreation,
  listCreations,
  unarchiveCreation,
} from '../src/services/creation.service.js'

const prisma = new PrismaClient()
/** 一次性测试账号：本脚本专用，跑完硬删（与 membership/sms/ai-prompts/profile 的号段刻意错开） */
const PHONE = '13900008813'

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
function section(t: string) {
  console.log(`\n── ${t} ──`)
}

/** 断言调用抛的是 CreationNotFoundError —— 越权与已删的统一出口 */
async function rejectsNotFound(fn: () => Promise<unknown>, label: string) {
  try {
    await fn()
    check(false, label, '（没有抛错：闸门是开的）')
  } catch (e) {
    const okNotFound = e instanceof CreationNotFoundError
    check(okNotFound, label, okNotFound ? '' : `（抛的是 ${(e as Error)?.name ?? typeof e}）`)
  }
}

let merchantId: bigint | null = null

/** 按外键依赖顺序清理（顺序错了会报 Foreign key constraint violated） */
async function cleanup(M: bigint) {
  // shot 与 render_task 都有指向 creation 的外键，必须先走
  const ids = (await prisma.creation.findMany({ where: { merchantId: M }, select: { id: true } })).map((c) => c.id)
  await prisma.renderTask.deleteMany({ where: { merchantId: M } })
  if (ids.length > 0) await prisma.shot.deleteMany({ where: { creationId: { in: ids } } })
  await prisma.creation.deleteMany({ where: { merchantId: M } })
  await prisma.membershipReminder.deleteMany({ where: { merchantId: M } })
  await prisma.membership.deleteMany({ where: { merchantId: M } })
  await prisma.order.deleteMany({ where: { merchantId: M } })
  await prisma.beanLedger.deleteMany({ where: { merchantId: M } })
  await prisma.beanReservation.deleteMany({ where: { merchantId: M } })
  await prisma.beanAccount.deleteMany({ where: { merchantId: M } })
  await prisma.store.deleteMany({ where: { merchantId: M } })
  await prisma.merchant.deleteMany({ where: { id: M } })
}

async function main(): Promise<void> {
  // 断言中途失败会留下残留，这里先清一遍再开始
  const stale = await prisma.merchant.findFirst({ where: { phone: PHONE }, select: { id: true } })
  if (stale) {
    console.log(`  ℹ 发现上次残留的临时商户 ${stale.id}，先清理`)
    await cleanup(stale.id)
  }

  const merchant = await prisma.merchant.create({ data: { phone: PHONE, nickname: '归档用例' } })
  merchantId = merchant.id
  const store = await prisma.store.create({ data: { merchantId: merchant.id, name: '归档用例店' } })
  const mk = (title: string) =>
    prisma.creation.create({
      data: { merchantId: merchant.id, storeId: store.id, title, track: 'TRAFFIC', complexity: 'SIMPLE' },
    })
  const a = await mk('待归档')
  const b = await mk('待删除')

  // ═══════════════════════ ① 归档 ═══════════════════════
  section('① 归档：从默认列表移出、只在归档列表出现')
  check((await listCreations(prisma, merchant.id, store.id)).length === 2, '初始：默认列表有 2 条')
  check((await listCreations(prisma, merchant.id, store.id, { archived: true })).length === 0, '初始：归档列表为空')

  await archiveCreation(prisma, merchant.id, a.id)
  const afterArchive = await listCreations(prisma, merchant.id, store.id)
  check(afterArchive.length === 1, '归档后：默认列表只剩 1 条', `（${afterArchive.length}）`)
  check(afterArchive.every((c) => c.id !== a.id), '归档后：那条不在「全部」里（也就不会在进行中/已就绪）')
  const archivedList = await listCreations(prisma, merchant.id, store.id, { archived: true })
  check(archivedList.length === 1 && archivedList[0]?.id === a.id, '归档后：出现在归档列表里')
  const t0 = archivedList[0]?.archivedAt?.getTime()
  check(typeof t0 === 'number', '归档列表带回了 archivedAt')

  await archiveCreation(prisma, merchant.id, a.id)
  const again = await listCreations(prisma, merchant.id, store.id, { archived: true })
  const t1 = again[0]?.archivedAt?.getTime()
  check(typeof t0 === 'number' && t0 === t1, '重复归档是幂等的（时间戳没被刷新）')

  // ═══════════════════════ ② 恢复 ═══════════════════════
  section('② 恢复')
  await unarchiveCreation(prisma, merchant.id, a.id)
  check((await listCreations(prisma, merchant.id, store.id)).length === 2, '恢复后：默认列表回到 2 条')
  check((await listCreations(prisma, merchant.id, store.id, { archived: true })).length === 0, '恢复后：归档列表清空')

  // ═══════════════════════ ③ 删除（必须是软删）═══════════════════════
  section('③ 删除')
  await deleteCreation(prisma, merchant.id, b.id)
  const afterDelete = await listCreations(prisma, merchant.id, store.id)
  check(afterDelete.length === 1 && afterDelete[0]?.id === a.id, '删除后：默认列表不含它')
  check((await listCreations(prisma, merchant.id, store.id, { archived: true })).length === 0, '删除后：归档列表也不含它')

  const row = await prisma.creation.findUnique({ where: { id: b.id }, select: { deletedAt: true } })
  check(row !== null, '删除是软删：行仍在库里（不是物理删除）')
  check(row?.deletedAt instanceof Date, '删除是软删：deletedAt 已写入')

  await rejectsNotFound(() => archiveCreation(prisma, merchant.id, b.id), '已删的不能再归档（否则会复活一条用户以为删掉的数据）')
  await rejectsNotFound(() => unarchiveCreation(prisma, merchant.id, b.id), '已删的不能再恢复')
  await rejectsNotFound(() => deleteCreation(prisma, merchant.id, b.id), '已删的再删返回 4046（不误报成功）')

  // ═══════════════════════ ④ 越权闸门 ═══════════════════════
  section('④ 越权：换个 merchantId 去操作别人的创作')
  // 只做"必须失败"的断言：where 带 merchantId ⇒ count 恒为 0，不会改动真实商户的数据
  const attacked = (await prisma.merchant.findFirst({ where: { phone: { not: PHONE } }, select: { id: true } }))?.id
  if (attacked === undefined) {
    check(false, '库里找不到第二个商户，越权断言无法进行')
  } else {
    await rejectsNotFound(() => archiveCreation(prisma, attacked, a.id), '他人不能归档我的创作')
    await rejectsNotFound(() => unarchiveCreation(prisma, attacked, a.id), '他人不能恢复我的创作')
    await rejectsNotFound(() => deleteCreation(prisma, attacked, a.id), '他人不能删除我的创作')
    const still = await prisma.creation.findUnique({ where: { id: a.id }, select: { deletedAt: true, archivedAt: true } })
    check(still?.deletedAt === null && still?.archivedAt === null, '越权尝试后，那条创作原封不动')
  }
  await rejectsNotFound(() => archiveCreation(prisma, merchant.id, 999999999999n), '不存在的 id 走 4046，不是 500')

  // ═══════════════════════ ⑤ 进度字段 ═══════════════════════
  section('⑤ 进度字段：列表卡片进度条的数据源')
  const c = await prisma.creation.create({
    data: {
      merchantId: merchant.id,
      storeId: store.id,
      title: '进度用例',
      track: 'TRAFFIC',
      complexity: 'SIMPLE',
      copyText: '口播文案',
    },
  })
  // assetId 是裸列（没有外键约束），直接填数字即可，不必造 media_asset
  await prisma.shot.createMany({
    data: [
      { creationId: c.id, seq: 1, assetId: 11n },
      { creationId: c.id, seq: 2, assetId: 12n },
      { creationId: c.id, seq: 3 },
    ],
  })
  const blank = await mk('还没排分镜')

  const rows = await listCreations(prisma, merchant.id, store.id)
  const pRow = rows.find((r) => r.id === c.id)
  const blankRow = rows.find((r) => r.id === blank.id)
  check(pRow?.shotsTotal === 3, '分镜总数下发了', `（${pRow?.shotsTotal}）`)
  check(pRow?.shotsReady === 2, '已上传素材的分镜数下发了', `（${pRow?.shotsReady}）`)
  check(pRow?.renderStatus === null, '从没合成过 ⇒ renderStatus 是 null（不是 undefined / 空串）')
  check(
    blankRow?.shotsTotal === 0 && blankRow?.shotsReady === 0,
    '没有分镜时两个数都是 0（前端才不会 0/0 算出 NaN 把进度条打回 0）',
  )
  const plain = pRow as unknown as Record<string, unknown>

  // ★ 反向断言：`userIdea`（创作页「你想拍什么风格？」）已于 2026-09-20 从整条链路删除，
  //   数据库列 user_idea **保留但不读不写** —— 而「不读不写」必须包含「不往响应里带」：
  //   留着它 ① 前端看到字段还在会以为那个输入框有用；② 形态不一致（新记录恒 null、老记录带旧文本）。
  //   ⚠ 覆盖面要说清：列表查询走**显式 select**、列清单里本就没有 user_idea，所以下面第一条是
  //     防御性的（钉住别有人把它 select 回来）；**真正会泄漏的是详情**，它 `...展开整行` 记录。
  check(!('userIdea' in plain), '列表行不下发 userIdea')
  // ⚠ 用 `blank` 而不是上面那条 `c`：`getCreation` 会校验分镜引用的素材**归属本商家门店**，
  //   而 `c` 的 assetId 是裸数字（本脚本刻意没造 media_asset）⇒ 会抛 CreationAssetMismatchError。
  //   `blank` 没有分镜，走同一条详情代码路径却不会撞校验。
  //
  // ★ 这里**故意**往存量记录里塞一段旧文本：只断言「键不存在」太弱 —— 一条 userIdea=null 的记录
  //   就能过。塞上真值才钉得住「存量数据带着旧文本也不许出现在响应里」，这正是
  //   「列保留但**不读**」的含义。（写这一下本身就证明读路径没读它。）
  const LEGACY_IDEA = '深夜食堂的治愈感'
  await prisma.creation.update({ where: { id: blank.id }, data: { userIdea: LEGACY_IDEA } })
  const detailRaw = await getCreation(prisma, merchant.id, blank.id)
  const detail = (detailRaw ?? {}) as unknown as Record<string, unknown>
  check(detailRaw !== null, '详情能取到（否则下面的断言是空转）')
  check(!('userIdea' in detail), '详情不下发 userIdea 这个键（整行展开，真正的泄漏点）')
  check(
    // replacer 兜 bigint：整行里 id/merchantId 都是 bigint，裸 JSON.stringify 会直接抛
    !JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).includes(LEGACY_IDEA),
    '存量旧文本连值都漏不出来',
  )
  // 顺带确认「摘掉字段」没有误伤 —— 别是为了过断言把整行换成了别的东西
  check('id' in plain && 'archivedAt' in plain && 'copyText' in plain, '列表行其它列没被误伤')
  check('id' in detail && 'copyText' in detail && 'shots' in detail, '详情行其它列没被误伤')
  check(!('shots' in plain) && !('renderTasks' in plain), '原始关联数组不下发（只给算好的三个标量）')

  // 第三条返回路径：创建（`return created`，同样是整行记录）。这个接口**只写行** ——
  // 不调模型、不扣积分、不签 URL（函数体就是一个 $transaction），所以直调不花任何成本，
  // 与前端走 POST /creations 是同一段代码。
  const fresh = (await createCreation(prisma, merchant.id, {
    storeId: store.id,
    title: '创建路径用例',
  })) as unknown as Record<string, unknown>
  check(!('userIdea' in fresh), '创建返回值不下发 userIdea（第三条返回路径）')
  check('id' in fresh && 'title' in fresh && 'track' in fresh, '创建返回值其它列没被误伤')
  check(fresh.title === '创建路径用例', '创建返回的就是刚写进去的那条（不是空对象）')

  // 两条任务，后建的那条才算「最新」—— 断言取的是 id 倒序第一条，不是 SUCCESS 优先
  await prisma.renderTask.create({
    data: { merchantId: merchant.id, creationId: c.id, status: 'SUCCESS', paramsJson: {} },
  })
  await prisma.renderTask.create({
    data: { merchantId: merchant.id, creationId: c.id, status: 'RUNNING', paramsJson: {} },
  })
  const withTask = (await listCreations(prisma, merchant.id, store.id)).find((r) => r.id === c.id)
  check(withTask?.renderStatus === 'RUNNING', 'renderStatus 取最新一条任务', `（${withTask?.renderStatus}）`)

  // ═══════════════════════ ⑥ 路由层守护 ═══════════════════════
  section('⑥ 路由层守护（参数解析与路由注册）')
  const scriptsDir = fileURLToPath(new URL('.', import.meta.url))
  const routeSrc = readFileSync(join(scriptsDir, '../src/routes/creations.ts'), 'utf8')
  check(/req\.query\.archived === '1'/.test(routeSrc), "GET / 解析 ?archived=1")
  check(/router\.post\('\/:id\/archive'/.test(routeSrc), '注册了 POST /:id/archive')
  check(/router\.post\('\/:id\/unarchive'/.test(routeSrc), '注册了 POST /:id/unarchive')
  check(/router\.delete\('\/:id'/.test(routeSrc), '注册了 DELETE /:id')
}

main()
  .catch((e) => {
    console.error('\n脚本异常:', e)
    fail++
  })
  .finally(async () => {
    if (merchantId !== null) {
      await cleanup(merchantId).catch((e) => console.error('清理失败:', e))
      const left = await prisma.merchant.count({ where: { phone: PHONE } })
      console.log(`\n清理：临时商户剩余 ${left} 行（应为 0）`)
    }
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    if (fail > 0) process.exitCode = 1
    await prisma.$disconnect()
  })
