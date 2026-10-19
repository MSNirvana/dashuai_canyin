/**
 * 产品型「钩子多样性」试跑探针 —— **零计费**（同 probe-copy-output：直调 gateway，不扣积分、不写账本）。
 *
 * 为什么需要它：契约测试只能证明**模板里有那几条规则**，证明不了「连写 6 条开头真的不一样、
 * 而且真的够大胆」。2026-10-19 用户的原话是「钩子不够大胆，都是小心翼翼的不像引流的人会做的事」
 * 加上「每次都不能重复」—— 这两件事都只能靠**真输出**来看，正则看不出来。
 *
 * 它做的事＝把生产的避让逻辑跑一遍闭环：
 *   第 1 条不避让 → 第 2 条避让第 1 条的开头 → 第 3 条避让前两条 …… 共 N 条；
 *   每一轮的 `recentCopyAvoid` 都用生产同一个纯函数 `buildRecentCopyAvoidPrompt` 拼，
 *   所以这里看到的避让块，跟线上模型看到的**逐字一样**。
 *
 * 用法（在 server 目录）：
 *   npx tsx scripts/probe-copy-hook-diversity.ts              # 默认 6 条、默认门店
 *   npx tsx scripts/probe-copy-hook-diversity.ts 8            # 8 条
 *   npx tsx scripts/probe-copy-hook-diversity.ts 6 5          # 6 条、门店 #5
 *
 * ⚠ 会真实调用上游 AI（每条几秒到几十秒）。花费约每条 ¥0.03，全部计入系统成本，不动用户积分。
 */
import 'dotenv/config'
import { prisma, redis } from '../src/db.js'
import { CircuitBreaker } from '../src/ai/circuit-breaker.js'
import { AiGateway } from '../src/ai/gateway.js'
import {
  buildRecentCopyAvoidPrompt,
  copyOpeningLine,
  copySimilarity,
  formatComboInfo,
  formatPersona,
  storeLocationOf,
} from '../src/services/creation.service.js'
import { formatDateInfo } from '../src/lib/festival.js'

const rounds = Number(process.argv[2] ?? 6)
const storeIdArg = process.argv[3] ? BigInt(process.argv[3]) : null

const gateway = new AiGateway(prisma, redis, new CircuitBreaker(redis))

;(async () => {
  const store = storeIdArg
    ? await prisma.store.findUnique({ where: { id: storeIdArg } })
    : await prisma.store.findFirst({
        where: { deletedAt: null, province: { not: null } },
        orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
      })
  if (!store) {
    console.log('没找到可用门店')
    await prisma.$disconnect()
    process.exit(1)
  }
  const dish = await prisma.dish.findFirst({ where: { storeId: store.id }, orderBy: { id: 'asc' } })
  const persona = await prisma.persona.findUnique({ where: { storeId: store.id } })
  const loc = storeLocationOf(store) ?? ''
  console.log(`门店 #${store.id} ${store.name}｜菜品：${dish?.name ?? '(无)'}｜位置：${loc || '(未填)'}`)
  console.log(`计划生成 ${rounds} 条（每条都避让前面所有条的开头）\n`)

  const copies: string[] = []
  for (let i = 1; i <= rounds; i++) {
    const variables: Record<string, string> = {
      storeName: store.name,
      storeIntro: store.intro ?? '',
      category: store.category ?? '',
      city: loc,
      dishName: dish?.name ?? '',
      dishIntro: dish?.intro ?? '',
      sellingPoints: dish?.sellingPoints ?? '',
      comboInfo: formatComboInfo(dish),
      persona: formatPersona(persona),
      dateInfo: formatDateInfo(),
      recentCopyAvoid: buildRecentCopyAvoidPrompt(copies),
      copyLengthRule: '本次写 60~90 字。',
    }
    const t0 = Date.now()
    const r = await gateway.runScene({
      sceneCode: 'copy_product',
      variables,
      requestId: `probe-hook-${Date.now()}-${i}`,
    })
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (!r.ok) {
      console.log(`第 ${i} 条 ✗ reason=${r.reason}（${secs}s）｜attempts=${r.attempts}｜${r.message}`)
      continue
    }
    const text = r.text.trim()
    copies.push(text)
    const head = copyOpeningLine(text)
    const maxSim = copies.length > 1 ? Math.max(...copies.slice(0, -1).map((old) => copySimilarity(old, text))) : 0
    console.log(`第 ${i} 条（${secs}s｜${r.modelCode}${r.usedFallback ? ' 降级' : ''}）`)
    console.log(`  开头：${head}`)
    console.log(`  与前面最高相似度：${maxSim.toFixed(3)}${maxSim >= 0.72 ? '  ← 会被生产闸门判为重复' : ''}`)
  }

  console.log('\n══════ 汇总 ══════')
  const heads = copies.map((t) => copyOpeningLine(t))
  heads.forEach((h, i) => console.log(`${i + 1}. ${h}`))

  const isQuestion = (h: string) => /[？?]$/.test(h)
  const qCount = heads.filter(isQuestion).length
  // 「胆子」的三个可观测代理指标：问句 / 劝退或否定 / 数字开局。
  // 它们都只是**代理**，不是验收标准 —— 最终还是要人读一遍判断像不像引流的人说的话。
  const pushAway = heads.filter((h) => /别点|别来|不用|不是|没有人|吃不惯|劝你|别信/.test(h)).length
  const numberStart = heads.filter((h) => /^[0-9０-９一二三四五六七八九十]/.test(h)).length
  console.log(`\n问句开局 ${qCount}/${heads.length}｜劝退或否定 ${pushAway}/${heads.length}｜数字开局 ${numberStart}/${heads.length}`)

  // 连写时最要命的是「连着两条同一路数」，所以单独看相邻重复。
  let adjacentSame = 0
  for (let i = 1; i < heads.length; i++) if (isQuestion(heads[i]!) && isQuestion(heads[i - 1]!)) adjacentSame++
  console.log(`相邻两条都是问句的次数：${adjacentSame}（目标 0）`)

  let worst = 0
  for (let i = 0; i < copies.length; i++)
    for (let j = i + 1; j < copies.length; j++) worst = Math.max(worst, copySimilarity(copies[i]!, copies[j]!))
  console.log(`整组最高相似度：${worst.toFixed(3)}（生产闸门阈值 0.72）`)

  await prisma.$disconnect()
  process.exit(0)
})()
