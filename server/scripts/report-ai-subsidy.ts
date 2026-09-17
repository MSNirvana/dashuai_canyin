/**
 * AI 场景「平台补贴」报表（只读）。
 *
 * 回答一个此前完全看不到的问题：场景单次上限（ai_scene.bean_price）到底是
 * **安全网**（只在异常调用上生效），还是**常态折扣**（每次调用都在贴钱）？
 *
 * 设计意图（prisma/seed.ts 注释）是前者：「实际扣费按成本计算且不超过该上限，
 * 超出部分由平台承担」。但如果上限低于**正常**成本，它就变成后者 ——
 * 用户每次都少付，平台每次都亏，而账上和日志里毫无痕迹。
 *
 * 本脚本按场景汇总：
 *   - 调用次数 / 总成本 / 总实收 / 总补贴
 *   - 上限生效比例（有多少比例的调用被截断）
 *   - 结论：安全网 or 常态折扣
 *
 * 注意 `absorbed_beans` 列是 2026-09-14 才加的，历史行为 0。脚本因此**同时**给出
 * 「按当前公式回溯估算」的补贴额，便于一次性看清历史亏损。两列分开标注，不混淆。
 *
 * 跑法：npx tsx scripts/report-ai-subsidy.ts [--days=30]
 */
import { PrismaClient } from '@prisma/client'
import { getDecimal } from '../src/lib/settings.js'
import { decFromNumber, decMulCeil } from '../src/lib/decimal.js'

const prisma = new PrismaClient()

const daysArg = process.argv.find((a) => a.startsWith('--days='))
const DAYS = daysArg ? Math.max(1, Number(daysArg.split('=')[1]) || 30) : 30
const since = new Date(Date.now() - DAYS * 86_400_000)

/** 与 ai.service.beansFromCost 同一口径：beans = ceil(costFen × 积分/元 × 系数 / 100) */
function beansFromCost(costFen: number, beansPerYuan: ReturnType<typeof decFromNumber>, multiplier: ReturnType<typeof decFromNumber>) {
  if (!costFen) return 0n
  return decMulCeil([decFromNumber(costFen)!, beansPerYuan!, multiplier!], 100n)
}

const beansPerYuan = await getDecimal(prisma, 'bean', 'points_per_yuan', 100)
const multiplier = await getDecimal(prisma, 'bean', 'cost_multiplier', 4)

const scenes = await prisma.aiScene.findMany({ select: { code: true, name: true, beanPrice: true } })
const priceOf = new Map(scenes.map((s) => [s.code, s.beanPrice]))

const logs = await prisma.aiCallLog.findMany({
  where: { createdAt: { gte: since } },
  select: { sceneCode: true, costFen: true, beanCharged: true, absorbedBeans: true },
})

console.log(`AI 场景补贴报表 · 近 ${DAYS} 天（积分/元=${beansPerYuan!.num}e${beansPerYuan!.exp} 系数=${multiplier!.num}e${multiplier!.exp}）`)
console.log(`口径：应付 = ceil(成本分 × 积分/元 × 系数 / 100)；补贴 = max(0, 应付 − 单次上限)\n`)

type Row = {
  code: string
  n: number
  fen: number
  charged: bigint
  recorded: bigint
  retro: bigint
  capped: number
  price: bigint | null
}
const rows = new Map<string, Row>()
for (const l of logs) {
  const r =
    rows.get(l.sceneCode) ??
    ({ code: l.sceneCode, n: 0, fen: 0, charged: 0n, recorded: 0n, retro: 0n, capped: 0, price: priceOf.get(l.sceneCode) ?? null } as Row)
  r.n += 1
  r.fen += l.costFen
  r.charged += l.beanCharged
  r.recorded += l.absorbedBeans
  const want = beansFromCost(l.costFen, beansPerYuan, multiplier)
  if (r.price !== null && want > r.price) {
    r.retro += want - r.price
    r.capped += 1
  }
  rows.set(l.sceneCode, r)
}

if (rows.size === 0) {
  console.log('该时间窗内没有 AI 调用记录。')
} else {
  const head = ['场景', '调用', '上限', '成本(分)', '实收(积分)', '已记补贴', '回溯补贴', '截断率', '结论']
  const body = [...rows.values()]
    .sort((a, b) => Number(b.retro - a.retro))
    .map((r) => {
      const rate = r.n ? r.capped / r.n : 0
      const verdict =
        r.capped === 0
          ? '✓ 安全网（未生效）'
          : rate >= 0.9
            ? '✗ 常态折扣（几乎每次都在贴）'
            : rate >= 0.3
              ? '⚠ 频繁生效'
              : '⚠ 偶发生效'
      return [
        r.code,
        String(r.n),
        r.price?.toString() ?? '-',
        String(r.fen),
        r.charged.toString(),
        r.recorded.toString(),
        r.retro.toString(),
        `${(rate * 100).toFixed(0)}%`,
        verdict,
      ]
    })
  // noUncheckedIndexedAccess 下 b[i] / widths[i] 被视为可能 undefined；
  // 这里 i 由 head 的长度决定，实际必然存在，用 `?? ''` / `?? 0` 兜底仅为满足类型检查。
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? '').length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ')
  console.log(line(head))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const b of body) console.log(line(b))

  const totalRetro = [...rows.values()].reduce((s, r) => s + r.retro, 0n)
  const totalRecorded = [...rows.values()].reduce((s, r) => s + r.recorded, 0n)
  console.log(
    `\n合计：回溯估算补贴 ${totalRetro} 积分（历史行 absorbed_beans 均为 0，因为该列今天才加）；` +
      `已记录补贴 ${totalRecorded} 积分`,
  )
  console.log(
    '结论判读：截断率接近 100% 说明上限**低于正常成本**，此时它不再是「防跑飞的安全网」，' +
      '而是对每一次正常调用的固定折扣。要不要把上限提到正常成本之上（等于给用户涨价）是商业决策。',
  )
}

await prisma.$disconnect()
