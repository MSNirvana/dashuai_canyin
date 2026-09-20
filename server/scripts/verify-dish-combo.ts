/**
 * 套餐（dish.kind='COMBO'）契约验证。
 *
 * 为什么值得单独一条守护：套餐的每一条约束都是**静默失效型**的 ——
 *   ① 少填套餐价 → 前端照样能保存，「¥0 套餐」进了库，文案里会写出「超值 0 元」；
 *   ② 原价 ≤ 套餐价 → 划线价变成抬价（先涨后降），比不划线更伤信任；
 *   ③ 明细指到**别家门店**的菜 → 接口 200，套餐里出现别人家的招牌菜（越权引用）；
 *   ④ 明细指到**另一个套餐** → 出现「套餐 A 包含 套餐 B」，份数换算不出来；
 *   ⑤ 明细指到**已软删的菜** → 用户看到套餐里少一样，且查不出原因；
 *   ⑥ 单菜带着价格留着 → 没有任何读取方的死数据（用户填了、看着生效、实际无效）。
 * 以上都不会报错、不会有日志，只能靠契约测试钉住。
 *
 * 另外两条是本表特有的坑：
 *   · BigInt 不能 JSON 序列化 —— 出参里任何一处漏转字符串，res.json 直接抛
 *     `TypeError: Do not know how to serialize a BigInt`（接口 500）。所以这里真的
 *     对返回值跑一次 JSON.stringify。
 *   · (combo_id, dish_id) 有唯一索引 —— 同一道菜拆成两行不是「重复」，是**直接撞索引报 500**。
 *
 * 用法：npm run dish-combo:verify
 * 用一个一次性手机号造临时商户/门店/菜品，跑完硬删；不动任何真实商户数据。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import {
  DishStoreMismatchError,
  createDish,
  deleteDish,
  getDish,
  listDishes,
  updateDish,
  DISH_KIND_COMBO,
  DISH_KIND_SINGLE,
} from '../src/services/dish.service.js'

const prisma = new PrismaClient()
/** 一次性测试账号：本脚本专用，跑完硬删。与其他 verify 脚本的号段刻意错开 */
const PHONE = '13900008822'
/** 第二个一次性账号：只用于「另一个商户」的越权判据 */
const PHONE_OTHER = '13900008823'

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

/**
 * 「这道写操作必须被拒绝」的用例模板。
 * ★ 三件事必须一起做，否则用例本身就是个 bug 源：
 *   ① 断言抛的是 DishStoreMismatchError（而不是 TypeError 之类"碰巧抛了"的错误）；
 *   ② 断言**拒绝之后库里没变** —— 校验写在写操作之前，与「先写后校验」在接口层看不出差别；
 *   ③ 返回错误文案，便于人工核对提示是否说人话。
 */
async function expectReject(label: string, fn: () => Promise<unknown>): Promise<void> {
  let err: unknown = null
  try {
    await fn()
  } catch (e) {
    err = e
  }
  const isBusiness = err instanceof DishStoreMismatchError
  check(isBusiness, label, isBusiness ? (err as Error).message : `抛的是 ${err ? (err as Error).name : '（没有抛错）'}`)
}

let merchantId: bigint | null = null
let otherMerchantId: bigint | null = null
let dbReady = true
try {
  await prisma.$queryRaw`SELECT 1`
} catch (e) {
  dbReady = false
  console.log(`  ⚠ 数据库不可用，跳过（本条守护必须连库）：${(e as Error).message.slice(0, 120)}`)
}

if (dbReady) {
  try {
    const merchant = await prisma.merchant.create({ data: { phone: PHONE, nickname: '套餐契约测试账号' } })
    merchantId = merchant.id
    // 另一个商户：门店归属判据必须用**真正不属于自己的门店**来测。
    // ★ 同一商户的另一家门店**不算越权**（门店本身合法），只是「这家店里没有这个菜」，
    //   两者返回的东西不同（抛错 vs null），混作一条测等于把两条判据都测糊了。
    const otherMerchant = await prisma.merchant.create({ data: { phone: PHONE_OTHER, nickname: '套餐契约测试账号·越权用' } })
    otherMerchantId = otherMerchant.id
    const store = await prisma.store.create({ data: { merchantId, name: '套餐契约测试门店', category: '川菜', city: '济南' } })
    // 同一商户的另一家门店：用来验证「套餐明细不能跨门店引用」
    const otherStore = await prisma.store.create({ data: { merchantId, name: '套餐契约测试门店·另一家', category: '川菜', city: '济南' } })

    const mkDish = (storeId: bigint, name: string) => createDish(prisma, merchantId!, storeId, { name })

    // ──────────────────────── ① 单菜语义不变 ────────────────────────
    section('① 单菜的语义没有因为加套餐而变化')
    const single = await mkDish(store.id, '契约测试·宫保鸡丁')
    check(single.kind === DISH_KIND_SINGLE, '不传 kind 创建出来的是单菜', `kind=${single.kind}`)
    check(single.priceFen === null && single.originalPriceFen === null, '单菜的两个价格都是 null（不是 0）')
    check(Array.isArray(single.comboItems) && single.comboItems.length === 0, '单菜的 comboItems 是空数组（而不是 undefined）')
    // 直接查库确认，避免「出参拼得对、库里其实存了别的」
    const singleRow = await prisma.dish.findUniqueOrThrow({ where: { id: BigInt(single.id) }, select: { kind: true, priceFen: true } })
    check(singleRow.kind === DISH_KIND_SINGLE && singleRow.priceFen === null, '库里存的也是 SINGLE / 价格 NULL')

    const rice = await mkDish(store.id, '契约测试·米饭')
    const soup = await mkDish(store.id, '契约测试·例汤')
    const otherStoreDish = await mkDish(otherStore.id, '契约测试·别家店的菜')

    // ──────────────────────── ② 正常创建套餐 ────────────────────────
    section('② 创建套餐：价格与明细确实落库，出参带菜名')
    const combo = await createDish(prisma, merchantId, store.id, {
      name: '契约测试·双人套餐',
      kind: DISH_KIND_COMBO,
      priceFen: 8800,
      originalPriceFen: 12000,
      comboItems: [{ dishId: BigInt(single.id), quantity: 1 }, { dishId: BigInt(rice.id), quantity: 2 }],
    })
    check(combo.kind === DISH_KIND_COMBO, '创建出来的 kind = COMBO')
    check(combo.priceFen === 8800 && combo.originalPriceFen === 12000, '套餐价/原价按分落库', `${combo.priceFen} / ${combo.originalPriceFen}`)
    check(combo.comboItems.length === 2, '明细两条', `实际 ${combo.comboItems.length}`)
    check(combo.comboItems.map((i: any) => i.name).join('、') === '契约测试·宫保鸡丁、契约测试·米饭', '明细带出了菜名（小程序不用再查一次）')
    check(combo.comboItems.map((i: any) => i.quantity).join(',') === '1,2', '份数落对（米饭 2 份）')
    check(
      combo.comboItems.every((i: any) => typeof i.id === 'string' && typeof i.dishId === 'string'),
      '明细里的 id 全部是字符串（BigInt 没漏出来）',
    )
    /**
     * ★ 为什么不直接断言「`JSON.stringify(combo)` 不抛」：
     *   生产上 Express 有一条 `app.set('json replacer', …)`（server/src/index.ts）把 bigint 转成字符串，
     *   所以 `ok(res, 原始记录)` 是安全的，最外层 `storeId` 至今仍是 BigInt。
     *   但**我们自己新增的**嵌套 id 不该指望去蹭那条 replacer —— 脚本、redis 缓存、日志里的
     *   `JSON.stringify` 都没有它。所以这里只断言「套餐明细里没有 BigInt 残留」。
     */
    const leaked: string[] = []
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'bigint') { leaked.push(path); return }
      if (v && typeof v === 'object') for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], `${path}.${k}`)
    }
    walk(combo.comboItems, 'comboItems')
    check(leaked.length === 0, '套餐明细里没有 BigInt 残留（不依赖 Express 的 json replacer）', leaked.join(', '))
    // 与生产同款 replacer 下整份列表必须能过（这条挡的是「自己 JSON.stringify 就炸」）
    const withReplacer = (v: unknown) => JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val))
    let listSerializable = true
    try {
      withReplacer(await listDishes(prisma, merchantId, store.id))
    } catch {
      listSerializable = false
    }
    check(listSerializable, '列表在「与生产同款 replacer」下可序列化')

    // 创建后立刻回读：出参与「下次读它」必须一致
    const reread = await getDish(prisma, merchantId, store.id, BigInt(combo.id))
    check(reread?.comboItems.length === 2 && reread.comboItems[0].name === '契约测试·宫保鸡丁', '回读得到的明细与创建响应一致')

    // ──────────────────────── ③ 校验闸门 ────────────────────────
    section('③ 闸门：这些入参必须被拒，且拒绝后库里不变')
    const before = await prisma.dish.count({ where: { storeId: store.id } })
    const comboBase = { name: '契约测试·非法套餐', kind: DISH_KIND_COMBO as typeof DISH_KIND_COMBO }
    const items = [{ dishId: BigInt(single.id) }]

    await expectReject('套餐不填价格 → 拒', () => createDish(prisma, merchantId!, store.id, { ...comboBase, comboItems: items }))
    await expectReject('套餐价为 0 → 拒', () => createDish(prisma, merchantId!, store.id, { ...comboBase, priceFen: 0, comboItems: items }))
    await expectReject('原价等于套餐价 → 拒', () =>
      createDish(prisma, merchantId!, store.id, { ...comboBase, priceFen: 8800, originalPriceFen: 8800, comboItems: items }))
    await expectReject('原价低于套餐价 → 拒', () =>
      createDish(prisma, merchantId!, store.id, { ...comboBase, priceFen: 8800, originalPriceFen: 1200, comboItems: items }))
    await expectReject('套餐明细为空 → 拒', () => createDish(prisma, merchantId!, store.id, { ...comboBase, priceFen: 8800, comboItems: [] }))
    await expectReject('明细指向不存在的菜 → 拒', () =>
      createDish(prisma, merchantId!, store.id, { ...comboBase, priceFen: 8800, comboItems: [{ dishId: 99999999n }] }))
    await expectReject('明细指向**套餐**（套餐套套餐）→ 拒', () =>
      createDish(prisma, merchantId!, store.id, { ...comboBase, priceFen: 8800, comboItems: [{ dishId: BigInt(combo.id) }] }))
    await expectReject('明细指向**别家门店**的菜 → 拒', () =>
      createDish(prisma, merchantId!, store.id, { ...comboBase, priceFen: 8800, comboItems: [{ dishId: BigInt(otherStoreDish.id) }] }))
    await expectReject('份数为 0 → 拒', () =>
      createDish(prisma, merchantId!, store.id, { ...comboBase, priceFen: 8800, comboItems: [{ dishId: BigInt(single.id), quantity: 0 }] }))
    await expectReject('份数超过 99 → 拒', () =>
      createDish(prisma, merchantId!, store.id, { ...comboBase, priceFen: 8800, comboItems: [{ dishId: BigInt(single.id), quantity: 100 }] }))
    await expectReject('明细条目数超过 30 → 拒', () =>
      createDish(prisma, merchantId!, store.id, {
        ...comboBase, priceFen: 8800,
        comboItems: Array.from({ length: 31 }, () => ({ dishId: BigInt(single.id) })),
      }))
    /**
     * ★ 门店归属有两种，返回的东西不一样，必须分开断言：
     *   ① 同一商户的另一家门店 —— 门店本身合法，`ensureStoreOwned` 会放行；
     *      只是「这家店里没有这个菜」⇒ 返回 null（路由映射成 404「菜品不存在」）。
     *   ② 另一个商户 —— 门店根本不属于他 ⇒ 必须抛错（否则拿别人的 storeId 就能越权读写菜品）。
     *   把两者混成一条「必须抛错」的用例，会把 ① 误判成失败，也测不出 ② 究竟有没有被拦。
     */
    const crossStore = await getDish(prisma, merchantId, otherStore.id, BigInt(combo.id))
    check(crossStore === null, '同一商户的别的门店读不到这家店的套餐（返回 null → 404，而不是抛错）')
    await expectReject('另一个商户用这个 storeId 读菜品 → 拒', () => getDish(prisma, otherMerchantId!, store.id, BigInt(combo.id)))
    await expectReject('另一个商户用这个 storeId 建套餐 → 拒', () =>
      createDish(prisma, otherMerchantId!, store.id, {
        name: '越权套餐', kind: DISH_KIND_COMBO, priceFen: 100, comboItems: [{ dishId: BigInt(single.id) }],
      }))
    check((await prisma.dish.count({ where: { storeId: store.id } })) === before, '上述拒绝全部没有落库（拒绝后库里菜品数不变）')

    // ──────────────────────── ④ 同一道菜出现两次 ────────────────────────
    section('④ 同一道菜写两行 = 合并成份数，而不是撞唯一索引报 500')
    const merged = await createDish(prisma, merchantId, store.id, {
      name: '契约测试·重复菜品套餐',
      kind: DISH_KIND_COMBO,
      priceFen: 6600,
      comboItems: [{ dishId: BigInt(rice.id), quantity: 1 }, { dishId: BigInt(rice.id), quantity: 2 }],
    })
    check(merged.comboItems.length === 1, '两道「米饭」被合并成一行', `实际 ${merged.comboItems.length} 行`)
    check(merged.comboItems[0]?.quantity === 3, '份数累加为 3（1 + 2）', `实际 ${merged.comboItems[0]?.quantity}`)

    // ──────────────────────── ⑤ 被引用的菜不许直接删 ────────────────────────
    section('⑤ 被套餐引用的菜不能直接删（软删后套餐会静默少一样）')
    await expectReject('删除被套餐引用的菜 → 拒', () => deleteDish(prisma, merchantId!, store.id, BigInt(rice.id)))
    const riceStillThere = await getDish(prisma, merchantId!, store.id, BigInt(rice.id))
    check(riceStillThere !== null, '被拒后那道菜仍然在（没有被软删掉）')

    // 米饭此刻同时被 combo 与 merged 两个套餐引用。先只摘掉 merged 的那一份 ——
    // ★ 闸门数的是「还有几个套餐在引用它」，只从一个套餐里摘掉**仍然该被拦**：
    //   否则另一个套餐会静默少一样东西，而用户完全看不出原因。
    await updateDish(prisma, merchantId, store.id, BigInt(merged.id), {
      name: '契约测试·重复菜品套餐', kind: DISH_KIND_COMBO, priceFen: 6600, comboItems: [{ dishId: BigInt(single.id) }],
    })
    await expectReject('只从其中一个套餐移除、另一个还引用着 → 仍然拒', () => deleteDish(prisma, merchantId!, store.id, BigInt(rice.id)))

    // 把 combo 里那份也摘掉 → 这次必须放行（闸门不能把用户锁死）
    await updateDish(prisma, merchantId, store.id, BigInt(combo.id), {
      name: '契约测试·双人套餐', kind: DISH_KIND_COMBO, priceFen: 8800, originalPriceFen: 12000, comboItems: [{ dishId: BigInt(single.id) }],
    })
    const deletedAfterDetach = await deleteDish(prisma, merchantId!, store.id, BigInt(rice.id))
    check(deletedAfterDetach, '全部摘干净后就能删了（闸门没把用户锁死）')

    // 删掉的菜不能再被加进套餐
    await expectReject('把已删除的菜加进套餐 → 拒', () =>
      createDish(prisma, merchantId!, store.id, { name: '契约测试·引用已删菜', kind: DISH_KIND_COMBO, priceFen: 100, comboItems: [{ dishId: BigInt(rice.id) }] }))

    /**
     * 读取侧兜底：闸门只拦得住「以后」，拦不住**闸门上线前就已经存在**的坏数据。
     * 这里绕过 service 直接把菜软删，模拟那条历史数据 —— 明细行还在库里，
     * 但读取时不该把它算进套餐内容（否则用户看到套餐里少一样，且查不出原因）。
     * ★ 同时断言「库里那条明细其实还在」：否则这条用例分不清是**读取侧过滤**还是写侧顺手清掉了。
     */
    const legacyCombo = await createDish(prisma, merchantId, store.id, {
      name: '契约测试·历史坏数据套餐', kind: DISH_KIND_COMBO, priceFen: 2000, comboItems: [{ dishId: BigInt(soup.id) }],
    })
    await prisma.dish.update({ where: { id: BigInt(soup.id) }, data: { deletedAt: new Date() } })
    const legacyRead = await getDish(prisma, merchantId, store.id, BigInt(legacyCombo.id))
    check(legacyRead?.comboItems.length === 0, '已软删的菜不出现在套餐明细里（读取侧兜底）')
    check(
      (await prisma.dishComboItem.count({ where: { comboId: BigInt(legacyCombo.id) } })) === 1,
      '而库里那条明细其实还在 —— 说明是读取侧过滤，不是写侧清零',
    )

    // ──────────────────────── ⑥ 切回单菜 = 价格与明细清空 ────────────────────────
    section('⑥ 切回单菜时价格与明细被清空（kind 是唯一事实来源）')
    const downgraded = await updateDish(prisma, merchantId, store.id, BigInt(combo.id), { name: '契约测试·双人套餐', kind: DISH_KIND_SINGLE })
    check(downgraded?.kind === DISH_KIND_SINGLE, 'kind 已切回 SINGLE')
    check(downgraded?.comboItems.length === 0, '明细已清空')
    const downgradedRow = await prisma.dish.findUniqueOrThrow({ where: { id: BigInt(combo.id) }, select: { priceFen: true, originalPriceFen: true } })
    check(downgradedRow.priceFen === null && downgradedRow.originalPriceFen === null, '库里两个价格列也是 NULL（不留死数据）')
    check(
      (await prisma.dishComboItem.count({ where: { comboId: BigInt(combo.id) } })) === 0,
      '明细行真的被删了（不是只被读取侧过滤）',
    )

    // ──────────────────────── ⑦ 「没提这件事」不会毁掉套餐 ────────────────────────
    section('⑦ 只改名字的调用方不会把套餐搞坏（没传 ≠ 清空）')
    const combo2 = await createDish(prisma, merchantId, store.id, {
      name: '契约测试·不改类型的套餐', kind: DISH_KIND_COMBO, priceFen: 5000, originalPriceFen: 8000,
      comboItems: [{ dishId: BigInt(single.id) }],
    })
    // 模拟不带 kind / priceFen / comboItems 的调用方（只想改个菜名）
    const renamed = await updateDish(prisma, merchantId, store.id, BigInt(combo2.id), { name: '契约测试·改过名字的套餐' })
    check(renamed?.kind === DISH_KIND_COMBO, 'kind 仍为 COMBO（没被默认成 SINGLE 降级掉）', `kind=${renamed?.kind}`)
    check(renamed?.priceFen === 5000 && renamed?.originalPriceFen === 8000, '价格沿用库里的值（没被判失败、也没被清空）', `${renamed?.priceFen} / ${renamed?.originalPriceFen}`)
    check(renamed?.comboItems.length === 1 && renamed?.comboItems[0]?.name === '契约测试·宫保鸡丁', '明细沿用库里的（一次改名不会把整套组合抹掉）')
    check(renamed?.name === '契约测试·改过名字的套餐', '名字确实改了')

    // ★ 显式清空划线价：`null` 与「不传」必须产生**不同**结果 ——
    //   否则用户在编辑页把原价删掉、保存、刷新，原价又回来了（填过就再也删不掉）。
    const cleared = await updateDish(prisma, merchantId, store.id, BigInt(combo2.id), {
      name: '契约测试·改过名字的套餐', kind: DISH_KIND_COMBO, priceFen: 5000, originalPriceFen: null,
    })
    check(cleared?.originalPriceFen === null, '传 null 能清掉划线价（与「不传」区分开了）')
    check(cleared?.priceFen === 5000, '清划线价没有顺带动到套餐价')
    check(cleared?.comboItems.length === 1, '清划线价也没有顺带动到明细')
  } finally {
    // 两个临时商户都要清（越权用例那个没有任何门店，只删 merchant 即可）
    const merchantIds = [merchantId, otherMerchantId].filter((x): x is bigint => x !== null)
    if (merchantIds.length) {
      // 硬删：combo_item → dish_media → dish → store → merchant（顺序遵循外键；
      // dish 上的 ON DELETE CASCADE 也会兜住明细，这里显式删是为了让顺序可读）
      const stores = await prisma.store.findMany({ where: { merchantId: { in: merchantIds } }, select: { id: true } })
      const storeIds = stores.map((s) => s.id)
      await prisma.dishComboItem.deleteMany({ where: { combo: { storeId: { in: storeIds } } } })
      await prisma.dishMedia.deleteMany({ where: { dish: { storeId: { in: storeIds } } } })
      await prisma.dish.deleteMany({ where: { storeId: { in: storeIds } } })
      await prisma.store.deleteMany({ where: { merchantId: { in: merchantIds } } })
      await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } })
      const left = await prisma.merchant.count({ where: { phone: { in: [PHONE, PHONE_OTHER] } } })
      check(left === 0, '两个临时商户都已清理干净', `残留 ${left}`)
    }
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exitCode = 1
await prisma.$disconnect()
