/**
 * 初始化后台 AI 成片调色 + 基本美颜配置。默认只 dry-run；加 --yes 才写库。
 * 全部为 create-only：已存在的运营值绝不覆盖。
 *
 * ★ 两组一起建，是因为它们同属 `render` 分组、同一个后台页面：
 *   只建调色会让新加的「基本美颜设置」卡片显示「配置未初始化」，
 *   运营点了也没反应（读不到行 ⇒ 走默认 0，看起来像坏掉）。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import {
  RENDER_BEAUTY_SETTINGS,
  RENDER_COLOR_GROUP,
  RENDER_COLOR_SETTINGS,
} from '../src/render/color-settings.js'

const prisma = new PrismaClient()

const COLOR_DESC = 'AI 成片全局调色，范围 -100～100。0 表示关闭该项；只影响新开始的 AI 合成。'
const BEAUTY_DESC = '基本美颜，范围 0～100。0 表示不做处理；只影响新开始的 AI 合成。'

/** 两组拍平成同一形状，后面只认这个数组 */
const SPECS = [
  ...RENDER_COLOR_SETTINGS.map((item) => ({ ...item, description: COLOR_DESC })),
  ...RENDER_BEAUTY_SETTINGS.map((item) => ({ ...item, description: BEAUTY_DESC })),
]

async function main(): Promise<void> {
  const yes = process.argv.includes('--yes')
  const existing = await prisma.systemSetting.findMany({
    where: { groupKey: RENDER_COLOR_GROUP },
    select: { settingKey: true, settingVal: true },
  })
  const byKey = new Map(existing.map((row) => [row.settingKey, row.settingVal]))
  const missing = SPECS.filter((item) => !byKey.has(item.key))

  for (const item of SPECS) {
    const value = byKey.get(item.key)
    console.log(value === undefined ? `将创建 ${item.key} = 0` : `保留 ${item.key} = ${value}`)
  }

  if (!yes) {
    console.log('\n（dry-run：未写入；确认后加 --yes）')
    return
  }

  for (const item of missing) {
    await prisma.systemSetting.create({
      data: {
        groupKey: RENDER_COLOR_GROUP,
        settingKey: item.key,
        settingVal: '0',
        valueType: 'INT',
        displayName: item.label,
        description: item.description,
        sort: item.sort,
        isPublic: false,
      },
    })
  }

  const after = await prisma.systemSetting.findMany({
    where: { groupKey: RENDER_COLOR_GROUP, settingKey: { in: SPECS.map((item) => item.key) } },
    select: { settingKey: true, settingVal: true },
    orderBy: { settingKey: 'asc' },
  })
  console.log(`\n已初始化 ${missing.length} 项，最终值：`)
  for (const row of after) console.log(`  ${row.settingKey} = ${row.settingVal}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
