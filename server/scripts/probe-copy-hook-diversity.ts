/**
 * 「钩子 / 路数多样性」试跑探针 —— **零计费**（同 probe-copy-output：直调 gateway，不扣积分、不写账本）。
 *
 * 为什么需要它：契约测试只能证明**模板里有那几条规则**，证明不了「连写 6 条开头真的不一样、
 * 而且真的够大胆」。2026-10-19 用户的原话是「钩子不够大胆，都是小心翼翼的不像引流的人会做的事」
 * 加上「每次都不能重复」；2026-10-21 又说人设型「出来的花样和内容要多，符合案例」——
 * 这几件事都只能靠**真输出**来看，正则看不出来。
 *
 * 它做的事＝把生产的避让逻辑跑一遍闭环：
 *   第 1 条不避让 → 第 2 条避让第 1 条的开头 → 第 3 条避让前两条 …… 共 N 条；
 *   每一轮的 `recentCopyAvoid` 都用生产同一个纯函数 `buildRecentCopyAvoidPrompt` 拼，
 *   所以这里看到的避让块，跟线上模型看到的**逐字一样**。
 *
 * 用法（在 server 目录）：
 *   npx tsx scripts/probe-copy-hook-diversity.ts                  # 产品型 6 条、默认门店
 *   npx tsx scripts/probe-copy-hook-diversity.ts 8                # 8 条
 *   npx tsx scripts/probe-copy-hook-diversity.ts 6 5              # 6 条、门店 #5
 *   npx tsx scripts/probe-copy-hook-diversity.ts 6 12 persona     # 人设型 6 条（门店 #12）
 *
 * ★ 「人设型」这一档的变量按**生产的真实口径**拼：门店与菜品**全空**（关掉「菜品与套餐」＝
 *   一个字都不喂），`persona` 保留，长度规则用 `copyRuleFor(complexity,'PERSONA')`
 *   （110/280/400，而不是通用的 45/90/130）—— 三处写死一处，看到的就不是线上形状了。
 *
 * ⚠ 会真实调用上游 AI（每条几秒到几十秒）。花费约每条 ¥0.03，全部计入系统成本，不动用户积分。
 */
import 'dotenv/config'
import { prisma, redis } from '../src/db.js'
import { CircuitBreaker } from '../src/ai/circuit-breaker.js'
import { AiGateway } from '../src/ai/gateway.js'
import {
  buildRecentCopyAvoidPrompt,
  copyCharCount,
  copyLimitFor,
  copyOpeningLine,
  copyRuleFor,
  copySimilarity,
  formatComboInfo,
  formatPersona,
  storeLocationOf,
} from '../src/services/creation.service.js'
import { formatDateInfo } from '../src/lib/festival.js'
import { dishEmptyNoteFor } from '../src/lib/dish-mention.js'

const rounds = Number(process.argv[2] ?? 6)
const storeIdArg = process.argv[3] ? BigInt(process.argv[3]) : null
const isPersona = (process.argv[4] ?? 'product') === 'persona'
const complexity = 'COMPLEX' as const
const track = isPersona ? ('PERSONA' as const) : ('PRODUCT' as const)
const sceneCode = isPersona ? 'copy_persona' : 'copy_product'
/**
 * ★ `--tags=…` / `--activity=…` 覆盖人设资料，**只在本进程内存里生效**，不写库。
 *
 * 为什么需要：线上 12 家门店的 `persona` 目前**全是 NULL**，直接跑探针只会得到
 * 「没有原料 ⇒ 只能写通识」的结果 —— 那验证不了模板本身能不能把料用起来。
 * 用它塞一份**假想**人设（明确写成"假想"，别当成真实门店资料），才能看出
 * 「有料时模板能不能写出案例那种密度」。真实素材由你自己在小程序里填。
 */
const argOf = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const tagsOverride = argOf('tags')
const activityOverride = argOf('activity')

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
  const dish = isPersona ? null : await prisma.dish.findFirst({ where: { storeId: store.id }, orderBy: { id: 'asc' } })
  const persona = await prisma.persona.findUnique({ where: { storeId: store.id } })
  const loc = storeLocationOf(store) ?? ''
  console.log(
    `场景 ${sceneCode}｜门店 #${store.id} ${store.name}｜菜品：${dish?.name ?? '(不喂)'}｜位置：${isPersona ? '(不喂)' : loc || '(未填)'}`,
  )
  const personaText = formatPersona(
    tagsOverride || activityOverride
      ? { bossTags: tagsOverride ?? persona?.bossTags, activity: activityOverride ?? persona?.activity }
      : persona,
  )
  console.log(`人设：${personaText || '(空) —— 这一档没有「老板是谁」的原料，只能写通识，字数也会偏短'}`)
  const rule = copyRuleFor(complexity, track)
  console.log(`长度规则：${rule}（上限 ${copyLimitFor(complexity, track)} 字）`)
  console.log(`计划生成 ${rounds} 条（每条都避让前面所有条的开头）\n`)

  const copies: string[] = []
  for (let i = 1; i <= rounds; i++) {
    const variables: Record<string, string> = {
      // ★ 人设型：门店与菜品一个字都不喂（`mode='STYLE'` 的真实口径）
      storeName: isPersona ? '' : store.name,
      storeIntro: isPersona ? '' : (store.intro ?? ''),
      category: isPersona ? '' : (store.category ?? ''),
      city: isPersona ? '' : loc,
      storeEmptyNote: isPersona
        ? '（空 = 这次不提供门店资料：正文里不要出现店名、招牌、品类、城市、地址，也不要拿别家店的常见做法冒充本店）'
        : '',
      dishName: dish?.name ?? '',
      dishIntro: dish?.intro ?? '',
      sellingPoints: dish?.sellingPoints ?? '',
      comboInfo: formatComboInfo(dish),
      dishEmptyNote: dishEmptyNoteFor(dish?.name ?? ''),
      persona: personaText,
      dateInfo: formatDateInfo(),
      recentCopyAvoid: buildRecentCopyAvoidPrompt(copies),
      copyLengthRule: copyRuleFor(complexity, track),
    }
    const t0 = Date.now()
    const r = await gateway.runScene({
      sceneCode,
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
    const chars = copyCharCount(text)
    const maxSim = copies.length > 1 ? Math.max(...copies.slice(0, -1).map((old) => copySimilarity(old, text))) : 0
    console.log(`第 ${i} 条（${secs}s｜${r.modelCode}${r.usedFallback ? ' 降级' : ''}｜${chars} 字）`)
    console.log(`  开头：${head}`)
    console.log(`  与前面最高相似度：${maxSim.toFixed(3)}${maxSim >= 0.72 ? '  ← 会被生产闸门判为重复' : ''}`)
    // 人设型必须看全文：它的问题从来不在开头，而在「后面有没有具体的事」。
    if (isPersona) console.log(`  正文：${text.replace(/\n/g, ' ')}`)
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

  // ★ 字数单独汇总：人设型「内容多不多」只能靠这个看。
  //   上限与实际是两件事 —— 上限抬到 280 但模型仍写 90 字，那也是「内容少」，得回模板加料。
  if (copies.length) {
    const lens = copies.map((t) => copyCharCount(t)).sort((a, b) => a - b)
    const mid = lens[Math.floor(lens.length / 2)]!
    const limit = copyLimitFor(complexity, track)
    console.log(
      `字数：中位数 ${mid}｜最短 ${lens[0]}｜最长 ${lens[lens.length - 1]}｜上限 ${limit}` +
        `（${lens.filter((n) => n > limit).length} 条超上限、会被生产判为超长）`,
    )
  }

  await prisma.$disconnect()
  process.exit(0)
})()
