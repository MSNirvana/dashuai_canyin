/**
 * 文案试跑探针 —— **零计费**：直调 `aiGateway.runScene`，不经过计费包装
 * （不扣积分、不写账本流水；只写一条 `ai_call_log`，那是日志不是账单）。
 *
 * 为什么需要它：契约测试全绿只证明**模板与变量的契约**没问题，
 * 证明不了「生成出来的稿子真的能念」—— 而后者才是业务方唯一的验收标准。
 * 改完提示词之后，用它拿一条真输出看一眼再收工。
 *
 * 用法：
 *   npx tsx scripts/probe-copy-output.ts                 # 默认试跑 copy_traffic
 *   npx tsx scripts/probe-copy-output.ts copy_intro      # 指定场景
 *   npx tsx scripts/probe-copy-output.ts copy_traffic 5  # 指定门店 id
 *
 * ⚠ 会真实调用上游 AI（几秒到一两分钟，取决于通道）。跑完务必 disconnect + exit。
 */
import 'dotenv/config'
import { prisma, redis } from '../src/db.js'
import { CircuitBreaker } from '../src/ai/circuit-breaker.js'
import { AiGateway } from '../src/ai/gateway.js'
import { formatTopicInfo } from '../src/lib/topic.js'
import { storeLocationOf, formatPersona, formatComboInfo } from '../src/services/creation.service.js'
import { formatDateInfo } from '../src/lib/festival.js'

const sceneArg = process.argv[2] ?? 'copy_traffic'
const storeIdArg = process.argv[3] ? BigInt(process.argv[3]) : null

const circuit = new CircuitBreaker(redis)
const gateway = new AiGateway(prisma, redis, circuit)

/** 找到那家话题稿会用的「宿主门店」（同 creation.service 的规则：isDefault 优先、其次 id 最小） */
async function pickStore() {
  const base = storeIdArg
    ? await prisma.store.findUnique({ where: { id: storeIdArg } })
    : await prisma.store.findFirst({
        where: { deletedAt: null, province: { not: null } },
        orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
      })
  return base
}

;(async () => {
  const store = await pickStore()
  if (!store) {
    console.log('没找到可用门店（带 province 的门店一个都没有？）')
    await prisma.$disconnect()
    process.exit(1)
  }
  const loc = storeLocationOf(store) ?? ''
  console.log(`门店 #${store.id} ${store.name}｜位置：${loc || '(没填 → topicInfo 里不出现地域钩子行)'}`)

  // ★ 菜品稿要拿**真实菜品**：填占位值跑出来的稿子全是噪声，看不出提示词好坏。
  const dish = await prisma.dish.findFirst({ where: { storeId: store.id }, orderBy: { id: 'asc' } })
  const persona = await prisma.persona.findUnique({ where: { storeId: store.id } })

  // 复刻 creation.service::buildVariables 里那几个变量的算法（拼装直接复用它的函数，
  // 免得这里手搓一份、跟生产慢慢漂移 —— 探针的全部价值就在「和生产看到的一样」）
  const topicInfo = sceneArg === 'copy_traffic' ? formatTopicInfo(new Date(), loc) : ''
  const variables: Record<string, string> =
    sceneArg === 'copy_traffic'
      ? { topicInfo }
      : {
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
        }

  if (sceneArg === 'copy_traffic') {
    console.log('\n─── 模型实际看到的 {{topicInfo}} ───')
    console.log(topicInfo)
    console.log('─────────────────────────────────\n')
  } else {
    console.log(`菜品：${dish?.name ?? '(这家店没有菜品，变量会是空串)'}`)
  }

  const t0 = Date.now()
  const r = await gateway.runScene({
    sceneCode: sceneArg,
    variables,
    requestId: `probe-copy-${Date.now()}`,
  })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  if (!r.ok) {
    console.log(`✗ 失败 reason=${r.reason}（${secs}s）｜attempts=${r.attempts}`)
    // ★ 真因在 message 里（gateway 塞的是 `[provider/model] 原始错误`）。
    //   不打印它 → 只看到 ALL_FAILED，无从下手；而 attempts 是「发出去了几次请求」：
    //   attempts=0 ⇒ 候选全被熔断器跳过（0 秒），**不是提示词/上游问题**；
    //   attempts≥1 ⇒ 请求真发出去了，message 才是要查的东西。
    console.log(`   message：${r.message}`)
    await prisma.$disconnect()
    process.exit(1)
  }

  const text = r.text.trim()
  const chars = text.replace(/\s/g, '').length
  console.log(`✓ ${sceneArg} 用时 ${secs}s｜通道 ${r.modelCode}${r.usedFallback ? '（降级）' : ''}｜attempts=${r.attempts}`)
  console.log(`\n${text}\n`)
  console.log('─── 自动核对 ───')
  console.log(`字数 ${chars}（普通话口播约 4.3 字/秒 ⇒ 约 ${Math.round(chars / 4.3)} 秒）`)
  const banned = ['匠心', '甄选', '唇齿留香', '口感丰富', '层次分明', '极致', '邂逅', '不容错过']
  const hit = banned.filter((w) => text.includes(w))
  console.log(`禁词命中：${hit.length ? hit.join('、') : '无'}`)
  if (sceneArg === 'copy_traffic') {
    const leak = [store.name, '我们家', '我们店'].filter((w) => w && text.includes(w))
    console.log(`★ 门店/生意泄漏：${leak.length ? leak.join('、') + '  ← 话题稿不该出现' : '无'}`)
  }
  console.log(`模板里是否含骨架：${(await prisma.aiScene.findUnique({ where: { code: sceneArg }, select: { promptTemplate: true } }))?.promptTemplate?.includes('【口播骨架') ? '是（库里已是新版）' : '否'}`)

  await prisma.$disconnect()
  process.exit(0)
})()
