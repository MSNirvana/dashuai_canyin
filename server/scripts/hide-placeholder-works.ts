/**
 * 把**没有素材的占位作品**全部下架（`enabled = false`）。
 *
 * ★ 为什么需要它（2026-09-28）：
 *   `prisma/seed.ts` 种的 28 条优秀作品是**配方模板** —— cover_key / video_key 都留空，
 *   而那批数据建出来时是 `enabled: true`。上架状态下的真实效果是：
 *   小程序首页「优秀作品」整块全是**「封面待补」的灰块**，点进去也播不了。
 *   对一个还没有任何真实作品的账号，这是最糟的第一印象。
 *
 * ★ 判据 = **既没有视频、也没有封面**（`videoKey = null AND coverKey = null`）。
 *   为什么用判据而不是「照着 seed 里的 28 个标题逐个点名」：
 *     · 标题清单是第二份真相，改了 seed 就得同步改这里，必然漂移；
 *     · 而「没有任何素材」恰好**等价于**「seed 造出来的占位品」——
 *       从成片入库的作品一定有 videoKey（见 work.service.createWorkFromRenderTask），
 *       后台手传的作品至少要传一个封面才会被当成作品用。
 *   反过来它也不会误伤：真有素材的作品不可能命中这条。
 *   ⚠ 但它确实**不只是**「seed 造的」——任何没素材的已上架作品都会被下架，
 *     这正是想要的产品规则（没素材的作品不该出现在首页）。
 *
 * ★ 默认 **dry-run**：只列出来、不写库。确认清单无误后加 `--yes` 才真的写。
 *   这是不可逆的运营状态变更（虽然只是 enabled 一列，后台也能手动点回来），
 *   所以刻意不让它一跑就生效。
 *
 * 用法（在 server/ 下）：
 *   npx tsx scripts/hide-placeholder-works.ts          # 只看会动哪些
 *   npx tsx scripts/hide-placeholder-works.ts --yes     # 真的写
 *
 * ⚠ 本脚本打的是**本机 `.env` 里的库**（tsx 脚本一贯行为），改线上要在服务器上跑。
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** 没素材 = 既没视频也没封面。这条判据同时也是「seed 造的占位品」的等价描述 */
const PLACEHOLDER_WHERE = {
  deletedAt: null,
  enabled: true,
  videoKey: null,
  coverKey: null,
} as const

async function main(): Promise<void> {
  const apply = process.argv.includes('--yes')

  const targets = await prisma.excellentWork.findMany({
    where: PLACEHOLDER_WHERE,
    orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    select: { id: true, title: true, category: true, sort: true },
  })

  const [enabledTotal, anyTotal] = await Promise.all([
    prisma.excellentWork.count({ where: { deletedAt: null, enabled: true } }),
    prisma.excellentWork.count({ where: { deletedAt: null } }),
  ])

  console.log('=== 下架「没有素材的占位作品」 ===')
  console.log(`库里作品共 ${anyTotal} 条，其中已上架 ${enabledTotal} 条`)
  console.log(`命中「已上架但既无视频也无封面」的：${targets.length} 条\n`)

  for (const t of targets) {
    console.log(`  #${t.id}  [${t.category}]  ${t.title}   (sort=${t.sort})`)
  }

  if (targets.length === 0) {
    console.log('\n没有需要处理的：上架的每一条都有视频或封面。')
  } else if (!apply) {
    console.log('\n（dry-run，未改库）确认清单无误后加 --yes 重跑：')
    console.log('  npx tsx scripts/hide-placeholder-works.ts --yes')
  } else {
    const r = await prisma.excellentWork.updateMany({
      where: PLACEHOLDER_WHERE,
      // publishedAt 一起清掉：它与 enabled 是一对（见 updateWork/createWork），
      // 留着的话后台的「上架时间」会显示一个并未上架的时间
      data: { enabled: false, publishedAt: null },
    })
    console.log(`\n✓ 已下架 ${r.count} 条（enabled=false, publishedAt=null）`)
  }

  // ★ 这一行才是本次改动的**验收指标**：它决定小程序首页那块显不显示。
  //   0 ⇒ 首页「优秀作品」整块消失；后台传作品并上架后自动出现。
  const left = await prisma.excellentWork.count({ where: { deletedAt: null, enabled: true } })
  console.log(`\n处理后仍「已上架」的作品：${left} 条`)
  console.log(
    left === 0
      ? '  ⇒ 小程序首页「优秀作品」整块会**自动隐藏**（含标题与分类横滑）。'
      : '  ⇒ 小程序首页「优秀作品」整块仍会显示，列出上面这些作品。',
  )
  console.log('  ℹ 静态资源（封面/视频）与前端包都不用动：这是纯数据状态，接口本来就只返回已上架的。')

  if (!apply && targets.length > 0) process.exitCode = 0
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())
