/**
 * 给**存量**话题稿（流量型）补短标题。
 *
 * ── 为什么需要这个脚本 ──
 * 话题稿没有门店/菜品可以拼名字，`createCreation` 的 title 兜底对它落到 undefined，
 * 于是列表 / 首页「近期作品」/ 编辑页一律显示前端兜底的「未命名创作」。
 * 新稿已经由 `copy_traffic` 那次文案调用顺便取名（见 `generateCopy`），**存量稿**只能在这里补。
 *
 * ── 为什么不用 AI 取名 ──
 * 逐条调 AI 需要一个新的场景码，而 `gateway.runScene` 的提示词**只能从库里读**
 * （它不接受 prompt override）。为一次性回填去动线上的 AI 场景配置（还要配候选模型链）
 * 不划算，所以这里**从已有的口播文案里取** —— 文案已经写好了，第一句本身就是这条稿在讲什么。
 * ★ 因此存量名字与新稿名字**不等价**：新稿的名字更贴合，存量偏机械。
 *   个别不合适的用 `--set <id>=<名字>` 手工指定。
 *
 * ── 用法（默认只列不改）──
 *   npx tsx scripts/backfill-traffic-title.ts                      # 列清单
 *   npx tsx scripts/backfill-traffic-title.ts --apply              # 真写库
 *   npx tsx scripts/backfill-traffic-title.ts --apply --limit=5    # 只处理前 5 条
 *   npx tsx scripts/backfill-traffic-title.ts --apply --set=123=霜降家常菜 --set=124=一个人吃饭
 *
 * ⚠ 连库脚本：结束务必 disconnect + exit（否则进程挂着不退出）。
 */
import 'dotenv/config'
import { prisma } from '../src/db.js'
import { localTopicTitle } from '../src/services/creation.service.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const limit = Number(argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 0) || 0

/** `--set 123=名字` 的手工指定（取值一律再截到 8 字，与自动规则同一上限） */
const overrides = new Map<string, string>()
for (const a of argv) {
  if (!a.startsWith('--set=')) continue
  const [id, name] = a.slice('--set='.length).split('=')
  if (id && name) overrides.set(id.trim(), name.trim())
}

const TITLE_MAX = 8

;(async () => {
  const rows = await prisma.creation.findMany({
    where: {
      mode: 'TOPIC',
      // 「没有名字」的两种形态都要抓：库里空串与 null 并存（历史写入路径不同）
      OR: [{ title: null }, { title: '' }],
    },
    select: { id: true, title: true, copyText: true, createdAt: true },
    orderBy: { id: 'asc' },
    ...(limit ? { take: limit } : {}),
  })

  console.log(`模式：${apply ? '★ 写库' : '只列不改（加 --apply 才写）'}`)
  console.log(`待补标题的话题稿：${rows.length} 条\n`)

  if (!rows.length) {
    console.log('没有需要补的（mode=TOPIC 且 title 为空的都处理完了）')
    await prisma.$disconnect()
    process.exit(0)
  }

  let skipped = 0
  const plan: Array<{ id: bigint; name: string; source: string }> = []

  for (const r of rows) {
    const copy = (r.copyText ?? '').trim()
    const manual = overrides.get(String(r.id))
    /**
     * ★ 没有文案就**不猜**：用编号或日期起名只会造出一个更难看的假名字，
     *   而且它是「看起来正常」的脏数据，比「未命名创作」更糟（没人知道该不该改）。
     */
    if (!copy && !manual) {
      skipped++
      console.log(`  #${r.id}  ⚠ 没有文案，跳过（无法取名）｜创建于 ${r.createdAt.toISOString().slice(0, 10)}`)
      continue
    }
    const name = (manual ?? localTopicTitle(copy)).slice(0, TITLE_MAX)
    plan.push({ id: r.id, name, source: manual ? '手工指定' : '文案首句' })
    const preview = copy.replace(/\s+/g, ' ').slice(0, 34)
    console.log(`  #${r.id}  「${name}」  [${manual ? '手工指定' : '文案首句'}]`)
    console.log(`         文案：${preview}${copy.length > 34 ? '…' : ''}`)
  }

  console.log(`\n汇总：命中 ${rows.length} 条｜将写入 ${plan.length} 条｜跳过 ${skipped} 条`)

  if (!apply) {
    console.log('\n（未加 --apply，什么都没写）')
    await prisma.$disconnect()
    process.exit(0)
  }

  let done = 0
  for (const p of plan) {
    await prisma.creation.update({ where: { id: p.id }, data: { title: p.name } })
    done++
  }
  console.log(`\n✓ 已写入 ${done} 条标题`)

  // 复核：再扫一次，期望 0 条（跳过的那几条仍在，所以按 plan 数对）
  const left = await prisma.creation.count({
    where: { mode: 'TOPIC', OR: [{ title: null }, { title: '' }] },
  })
  console.log(`复核：mode=TOPIC 且 title 为空 现在剩 ${left} 条（应等于跳过数 ${skipped}）`)

  await prisma.$disconnect()
  process.exit(0)
})()
