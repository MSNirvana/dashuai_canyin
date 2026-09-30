/**
 * 把合成计费切到**按档位固定价**（2026-09-30）。
 *
 * 做的事只有两件，都很窄：
 *   ① `render.grade_beans_basic / _ai / _premium` —— **不存在才建**（create-only）。
 *   ② 把三个**已废弃**的旧键的 displayName 打上「【已废弃·勿用】」前缀（只改标签，不动值）。
 *
 * ★ 为什么必须单独一个脚本、而不是 `npm run db:seed`：
 *   `prisma/seed.ts` 的 settings 段是「upsert **覆盖 settingVal**」的写法 ——
 *   在生产上跑一次会把运营改过的 `bean` / `render` / `storage` / `subscription`
 *   配置**全部打回默认值**（积分汇率、AI 成本系数、订阅价、以及**演示账号那一行**）。
 *   它不会报错，只会让计费口径悄悄变掉。本次只需要动 render 组里的几行。
 *
 * ★ 为什么 grade_beans_* 是 create-only：后台调价后如果谁再跑一次这个脚本，
 *   覆盖式写法会把运营调好的价**打回 500/5000**。已存在就什么都不做才是对的。
 *
 * ★ 为什么旧键要打标签（而不是删掉）：`point_per_sec` / `grade_ratio_*` 自本次起
 *   **不再被任何代码读取**。行还在后台「系统设置」里显示，运营照着它调价会发现
 *   「改了完全没反应」—— 这是最难查的一类问题。删掉又会丢掉这段历史，
 *   所以在标签上写清楚。
 *
 * 用法（在 server/ 下）：
 *   npx tsx scripts/seed-render-pricing.ts          # 默认 dry-run，只看会做什么
 *   npx tsx scripts/seed-render-pricing.ts --yes    # 真的写
 *
 * ⚠ 本机跑打的是**本地库**；要改线上必须在服务器上跑（表名见 schema 的 @@map）。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** 与 src/render/grade-pricing.ts 的 GRADE_BEANS_DEFAULT 保持一致（改一处要改两处，见下方自检） */
const BEANS: ReadonlyArray<{ grade: 'basic' | 'ai' | 'premium'; value: string; label: string }> = [
  { grade: 'basic', value: '500', label: '基础生成固定价(积分/次)' },
  { grade: 'ai', value: '500', label: 'AI生成固定价(积分/次)' },
  { grade: 'premium', value: '5000', label: '精品生成固定价(积分/次)' },
]

/** 已废弃的旧键：只改 displayName 前缀，值一律不动 */
const DEPRECATED: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'point_per_sec', label: '【已废弃·勿用】合成每秒积分' },
  { key: 'grade_ratio_basic', label: '【已废弃·勿用】基础生成系数' },
  { key: 'grade_ratio_ai', label: '【已废弃·勿用】AI生成系数' },
  { key: 'grade_ratio_premium', label: '【已废弃·勿用】精品生成系数' },
]

const PREFIX = '【已废弃·勿用】'

async function main(): Promise<void> {
  const yes = process.argv.includes('--yes')

  // ── 只读盘点 ──
  const existing = await prisma.systemSetting.findMany({
    where: { groupKey: 'render' },
    select: { settingKey: true, settingVal: true, displayName: true },
  })
  const byKey = new Map(existing.map((r) => [r.settingKey, r]))

  console.log(`render 组现有 ${existing.length} 行。逐项结论：\n`)
  const toCreate: (typeof BEANS)[number][] = []
  for (const b of BEANS) {
    const key = `grade_beans_${b.grade}`
    const cur = byKey.get(key)
    if (cur) {
      const same = cur.settingVal === b.value
      console.log(
        `  · ${key} 已存在，值 = ${cur.settingVal}` +
          (same ? '（与本次一致）' : `（与本次的 ${b.value} 不同 ⇒ **保留不覆盖**，这是运营调过的价）`),
      )
    } else {
      console.log(`  · ${key} 不存在 ⇒ 将创建，值 = ${b.value}`)
      toCreate.push(b)
    }
  }
  const toLabel = DEPRECATED.filter((d) => {
    const cur = byKey.get(d.key)
    return !!cur && !(cur.displayName ?? '').startsWith(PREFIX)
  })
  for (const d of toLabel) {
    console.log(`  · ${d.key} 已废弃 ⇒ 把显示名改成「${d.label}」（值不动）`)
  }
  const missingDeprecated = DEPRECATED.filter((d) => !byKey.has(d.key))
  for (const d of missingDeprecated) {
    console.log(`  · ${d.key} 本环境不存在（跳过；新环境本来就不该有）`)
  }

  if (toCreate.length === 0 && toLabel.length === 0) {
    console.log('\n没有需要写入的改动。')
  } else if (!yes) {
    console.log('\n（dry-run：未写入。确认无误后加 --yes）')
    return
  } else {
    for (const b of toCreate) {
      await prisma.systemSetting.create({
        data: {
          groupKey: 'render',
          settingKey: `grade_beans_${b.grade}`,
          settingVal: b.value,
          valueType: 'NUMBER',
          displayName: b.label,
          description:
            '合成一次的**固定**扣费，与成片时长无关（2026-09-30 起）。' +
            '改这里即刻生效；小程序报价是从 /render/capabilities 读的，**不需要重新发版**。',
          sort: 0,
          isPublic: false,
        },
      })
    }
    for (const d of toLabel) {
      await prisma.systemSetting.update({
        where: { groupKey_settingKey: { groupKey: 'render', settingKey: d.key } },
        data: { displayName: d.label },
      })
    }
    console.log(`\n已写入：新建 ${toCreate.length} 行，改标签 ${toLabel.length} 行。`)
  }

  // ── 回读自证：不靠"我刚写成功了"，而是把库里的最终状态打出来 ──
  const after = await prisma.systemSetting.findMany({
    where: { groupKey: 'render' },
    select: { settingKey: true, settingVal: true, displayName: true },
    orderBy: { settingKey: 'asc' },
  })
  console.log('\nrender 组最终状态：')
  for (const r of after) console.log(`  ${r.settingKey.padEnd(24)} = ${r.settingVal.padEnd(6)}  ${r.displayName ?? ''}`)

  // ★ 价要从**回读的结果**里取，不能拿开头那份 byKey 快照 —— 快照是写入前的状态，
  //   第一次跑时里面压根没有 grade_beans_*，会打印出「兜底值」冒充「库里的值」。
  const afterMap = new Map(after.map((r) => [r.settingKey, r.settingVal]))
  const eff = BEANS.map((b) => afterMap.get(`grade_beans_${b.grade}`) ?? b.value)
  console.log(`\n库里的价：基础 ${eff[0]} / AI ${eff[1]} / 精品 ${eff[2]} 积分/次`)
  console.log(
    '⚠ 这只说明**库里**是什么。要让它真正对用户生效，运行中的服务进程必须已经是\n' +
      '  「按 grade_beans_* 计费」的那版代码；小程序还要配合新版包（旧包显示的是按时长估的价，\n' +
      '  会与实扣不符）。先 `git log -1 --format=%h` 对齐代码，别看到这行就以为线上已经改价。',
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
