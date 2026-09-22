/**
 * 计费现状自检：一眼看清「当下按什么在扣积分」。
 *
 * 为什么需要它：本轮（2026-09-15）踩到的坑是「配置看起来完全正确，实际一分没扣」——
 *   · `charge_mode = COST_BASED` 在库里有，但**代码从来没读过**它（死配置）
 *   · 三个模型单价是 0，`costFen = 0` ⇒ `beansFromCost` 直接 return 0n ⇒ 扣 0 积分
 *   · 场景单次上限（3/5/10 积分）远低于真实成本 ⇒ 就算补上单价也只会被截断成封顶值
 * 这三件事在后台界面上都看不出来。所以做一个只读自检，把「实际生效的」打出来。
 *
 * 用法：npx tsx scripts/billing-status.ts   （或 npm run billing:status）
 * 只读，不写任何数据。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * 2026-09-15 全场景实测（各 1 次真实调用，真实提示词）—— 只作「参照量级」，不是承诺值。
 *
 * ★ 2026-09-21 四款改型：`copy_intro` / `copy_quality` 两个场景已删除，条目一并删掉
 *   （留着只会让「无实测参照」的判断再也走不到，掩盖新场景没测过这件事）。
 *   新的 `copy_persona` / `copy_knowledge` / `copy_product` **故意不给 beans** ——
 *   它们还没实测过，填一个"照抄旧款"的数字会让人以为测过了。
 *   缺 beans 时脚本会显示「未实测」，提示该去真打一次。
 */
const MEASURED: Record<string, { beans?: number; note: string }> = {
  copy_generate: { beans: 36, note: '324/454 tok' },
  storyboard_generate: { beans: 123, note: '1106/1594 tok' },
  copy_traffic: { beans: 38, note: '676/426 tok' },
  copy_persona: { note: '未实测（2026-09-21 新模板）' },
  copy_knowledge: { note: '未实测（2026-09-21 新模板）' },
  copy_product: { note: '未实测（2026-09-21 新模板）' },
  script_polish: { beans: 91, note: '626/1204 tok' },
  review_guard: { beans: 20, note: '552/196 tok' },
  title_overlay: { beans: 36, note: '598/410 tok' },
  bgm_select: { beans: 28, note: '514/312 tok' },
  rhythm_detect: { beans: 94, note: '534/1262 tok' },
  copy_recommend: { beans: 28, note: '696/280 tok（模板已于 2026-09-21 重写，该数值偏旧）' },
}

async function main() {
  console.log('\n════ 一、计费系数（system_setting · bean 组）════')
  const settings = await prisma.systemSetting.findMany({
    where: { groupKey: 'bean' },
    orderBy: { settingKey: 'asc' },
  })
  const get = (k: string) => settings.find((s) => s.settingKey === k)?.settingVal ?? '(缺失)'
  const ppy = get('points_per_yuan')
  const mul = get('cost_multiplier')
  const grant = Number(get('register_grant_points'))
  for (const s of settings) {
    console.log(`  ${s.settingKey.padEnd(22)} = ${String(s.settingVal).padEnd(12)} ${s.displayName ?? ''}`)
  }
  console.log(`  ⇒ 换算：1 分成本 = ceil(${ppy} × ${mul} / 100) = ${Math.ceil((Number(ppy) * Number(mul)) / 100)} 积分`)
  console.log('  ⚠ charge_mode 是死配置：全仓库只有 prisma/seed.ts 写过它，代码从未读取 ——')
  console.log('    它显示 COST_BASED **不代表**真的按成本计费，要看下面第二节的单价。')

  console.log('\n════ 二、各通道单价（ai_model，单位：分/百万 token）════')
  const models = await prisma.aiModel.findMany({
    where: { provider: { enabled: true } },
    include: { provider: { select: { code: true } } },
    orderBy: [{ enabled: 'desc' }, { id: 'asc' }],
  })
  const priced = models.filter((m) => m.enabled && (m.inputPricePerMtok > 0 || m.outputPricePerMtok > 0))
  for (const m of models) {
    const zero = m.inputPricePerMtok === 0 && m.outputPricePerMtok === 0
    // 0 单价本身无害，**启用中的** 0 单价才是风险：走它 = 平台全额补贴
    const risk = !m.enabled ? '停用（不影响计费）' : zero ? '★ 0 单价且启用中＝走它扣 0 积分' : ''
    console.log(
      `  ${(m.enabled ? '● ' : '○ ')}${m.provider.code.padEnd(18)} ${m.modelCode.padEnd(18)} in=${String(
        m.inputPricePerMtok,
      ).padStart(5)} out=${String(m.outputPricePerMtok).padStart(5)} ${risk}`,
    )
  }
  console.log(`  （● 启用 / ○ 停用；启用中且单价 >0 的模型数 = ${priced.length}）`)

  console.log('\n════ 三、场景：上限（＝预冻结额＝单次扣费硬上限）vs 实测应扣 ════')
  const scenes = await prisma.aiScene.findMany({ orderBy: { id: 'asc' } })
  console.log(`  ${'场景'.padEnd(22)}${'上限(积分)'.padEnd(10)}${'实测应扣(参照)'.padEnd(16)}说明`)
  let truncated = 0
  for (const s of scenes) {
    const cap = Number(s.beanPrice)
    const m = MEASURED[s.code]
    let note = '（无实测参照）'
    if (m && m.beans !== undefined) {
      if (cap < m.beans) {
        note = `会被截断（平台承担 ${m.beans - cap} 积分）`
        truncated++
      } else {
        note = '不截断 ✓'
      }
    } else if (m) {
      // 新场景：条目在表里但还没实测过 —— 必须区别于「表里根本没这个场景」，否则
      // 「改型后新模板忘了测」和「场景还没接入」会长得一模一样
      note = '未实测（先跑一次真实调用再填）'
    }
    console.log(
      `  ${s.code.padEnd(22)}${String(cap).padEnd(10)}${(m ? `${m.beans}（${m.note}）` : '-').padEnd(16)}${note}`,
    )
  }

  console.log('\n════ 四、新用户可负担性（注册赠积分 vs 场景上限）════')
  const maxCap = Math.max(...scenes.map((s) => Number(s.beanPrice)))
  const ok = scenes.filter((s) => Number(s.beanPrice) <= grant).length
  console.log(`  注册赠积分 = ${grant} 积分；最贵场景上限 = ${maxCap} 积分`)
  console.log(`  ⇒ 新用户注册后可用的场景：${ok}/${scenes.length}${grant === 0 || ok === scenes.length ? '' : ' ⚠'}`)
  if (grant === 0) {
    console.log('  ℹ 注册赠积分 = 0 ⇒ 当前**策略**是「注册后必须购买会员才能用 AI」，不是故障。')
    console.log('    真正的闸门是 `requireSubscription`（文案/分镜/合成 → 403 + 2005），')
    console.log('    赠积分只是「能不能过预冻结」的第二道门。两者都拦 = 前后一致。')
    console.log('    支付未开放期间发放方式：后台「商家详情 → 会员 → 手动开通会员」。')
  } else if (ok < scenes.length) {
    console.log('  ⚠ 上限同时是**预冻结额**：赠积分不够时不是「扣得少」，而是**冻结阶段就被拦**，')
    console.log('    报 `BeanNotEnoughError: 积分不足：需要 X，可用 Y`，功能直接不可用。')
    console.log(`    修法：TB_REGISTER_GRANT=<积分数> 重跑 setup-ai-channels.ts（只影响新注册，老用户不受影响）。`)
    console.log('    或彻底关掉注册赠积分（必须先买会员）：TB_REGISTER_GRANT=0。')
  }

  console.log('\n════ 五、最近 10 次真实调用的实际扣费（证明到底扣没扣）════')
  const logs = await prisma.aiCallLog.findMany({
    where: { sceneCode: { notIn: ['PROVIDER_TEST'] } },
    orderBy: { id: 'desc' },
    take: 10,
    include: { provider: { select: { code: true } } },
  })
  if (!logs.length) console.log('  （还没有真实调用记录）')
  for (const l of logs) {
    console.log(
      `  ${l.sceneCode.padEnd(22)} ${l.provider.code.padEnd(18)} tok=${String(l.promptTokens).padStart(4)}/${String(
        l.completionTokens,
      ).padStart(5)}  cost=${String(l.costFen).padStart(3)}分  charged=${String(l.beanCharged).padStart(4)}积分  absorbed=${String(
        l.absorbedBeans,
      ).padStart(4)}  ${l.status}`,
    )
  }
  const chargedCount = logs.filter((l) => l.beanCharged > 0n).length
  console.log(`  ⇒ 最近 ${logs.length} 次里有 ${chargedCount} 次真的扣了积分`)

  console.log('\n════ 结论 ════')
  if (priced.length === 0) {
    console.log('  ✗ 所有模型单价为 0 ⇒ costFen 恒为 0 ⇒ **商户扣 0 积分，平台全额补贴**。')
    console.log('    要按成本计费：TB_SET_PRICES=1 重跑 setup-ai-channels.ts')
  } else if (truncated > 0) {
    console.log(`  △ 单价已就位，但 ${truncated}/${scenes.length} 个场景的上限低于实测应扣 ⇒`)
    console.log('    实际扣费是「封顶值」而不是「成本 × 系数」。')
    console.log('    要真正按成本扣：TB_SET_CAPS=1 重跑 setup-ai-channels.ts')
  } else {
    console.log('  ✓ 单价已就位、上限高于实测应扣 ⇒ **按「成本 × 系数」扣费已生效**。')
    console.log('    注意：上限只是财务安全网，成本波动可达 15 倍（看思考 token），')
    console.log('    被击穿的那部分记 absorbedBeans（平台承担），这是设计如此。')
  }
  console.log('')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
