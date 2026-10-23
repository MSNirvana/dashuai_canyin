// 【本地联调专用 · 可删】往本地库塞一条「参考视频」，用来验证端上列表 + 跳转。
// 用法：cd server && npx tsx scripts/seed-local-tutorial.ts
//
// 为什么必须塞数据才看得见：小程序端「参考视频」整块是按**条数**决定露不露脸的
// （`TUTORIAL_FINDER_USER_NAME`/`feedId` 那套口径见 services/tutorial.service.ts），
// 本地库 tutorial_video 是空的 ⇒ 四个分类全 0 条 ⇒ 「我的」页那一组**整块隐藏**，
// 看起来就像「功能没做」。
import 'dotenv/config'
import { prisma } from '../src/db.js'
import { adminUpsertTutorial } from '../src/services/tutorial.service.js'

const FEED_ID = 'export/UzFfBgAAxICrXAAmfHO9k8zT4DCaq-mIJWA4m9LJJfxKwDvAvg'

// 幂等：同标题同分类先删再建，反复跑不会堆一堆
const before = await prisma.tutorialVideo.findMany({
  where: { title: '【本地联调】大帅餐饮助手怎么用' },
  select: { id: true },
})
for (const r of before) await prisma.tutorialVideo.delete({ where: { id: r.id } })

const row = await adminUpsertTutorial(prisma, undefined, {
  category: 'MANUAL',
  title: '【本地联调】大帅餐饮助手怎么用',
  feedId: FEED_ID,
  // 本地显式写死，避免依赖 env 有没有重启生效
  finderUserName: 'sphy2kl2JBjm1Ax',
  sort: 0,
})
console.log('已写入教程行 id=', row.id, 'feedId=', row.feedId, 'finder=', row.finderUserName)

const all = await prisma.tutorialVideo.findMany({ select: { category: true, feedId: true } })
const count = new Map<string, number>()
for (const r of all) if (r.feedId) count.set(r.category, (count.get(r.category) ?? 0) + 1)
console.log('各分类可看条数:', ['SHOOTING', 'EDITING', 'OPERATION', 'MANUAL'].map((c) => `${c}:${count.get(c) ?? 0}`).join(' '))
await prisma.$disconnect()
