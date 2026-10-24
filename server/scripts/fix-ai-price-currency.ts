/**
 * 一次性修复：把 AI 计价的币种口径从「美元 × 7.2」纠正为「人民币 1:1」。
 *
 * ══ 为什么要修（2026-10-24 实测）══
 *
 * tokenbox 的 `GET /api/status` 里 `price = 1`，含义是「¥1 买 1 站内美元额度」——
 * 它的「美元」只是标签，与人民币 **1:1**。原先把标价当美元又乘 7.2，两处实测：
 *
 *   · 文本 claude-sonnet-5、6420 输入 token：上游实扣 ¥0.0258，账面 ¥0.1855 ⇒ **7.20 倍**
 *   · 图像 gpt-image-2 每张：上游实扣 ¥0.06，账面 ¥0.72 ⇒ **12 倍**
 *     （12 = 7.2 的汇率错 × 漏乘分组倍率 0.6）
 *
 * 量法：`GET /v1/dashboard/billing/usage` 的 `total_usage` 前后差 × ¥0.01。
 * 按次计费的式子：`人民币/次 = model_price × group_ratio`（因为 price=1）。
 *
 * ══ 本脚本做的事（只改这几列，其余一律不碰）══
 *   1. `ai_model.unit_price_micro_fen`   出图按张单价：¥0.72 → ¥0.06
 *   2. `ai_model.input/output_price_per_mtok`  文本单价 ÷ 7.2
 *   3. `ai_scene.bean_price`             各场景预冻结额按新口径重算
 *
 * ★ 为什么不直接重跑 `setup-ai-channels.ts` / `seed.ts`：
 *   前者会顺带重写候选链、timeout、开关等一大片字段（且不带 TB_SET_PRICES=1 时
 *   会把单价清成 0）；后者会重写 prompt 模板。这里只想要「三个数字」变，不是整表变。
 *
 * 用法：
 *   npx tsx scripts/fix-ai-price-currency.ts            # 只打印差异，不写库
 *   npx tsx scripts/fix-ai-price-currency.ts --apply    # 真正写库
 *
 * 幂等：重复跑结果相同（值已经是目标值时跳过）。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')

/** 文本模型：分 / 百万 token。⇒ ¥4/¥24 这类整数价，说明换算对了 */
const TEXT_PRICES: Array<{ code: string; inFen: number; outFen: number; why: string }> = [
  { code: 'gpt-5.5', inFen: 400, outFen: 2400, why: 'p×5 c×30，Gpt pro号池 ×0.4 ⇒ $4/$24' },
  { code: 'gpt-5.6-sol', inFen: 400, outFen: 2400, why: '与 gpt-5.5 同系数同价' },
  { code: 'claude-sonnet-5', inFen: 400, outFen: 2000, why: 'ratio1/completion5，Claude max ×2 ⇒ $4/$20' },
  { code: 'deepseek-v4-flash', inFen: 120, outFen: 480, why: 'p×1 c×4，Deepseek官方 ×0.6 空闲档' },
]

/** 图像模型：1e-6 分 / 张。6000000 = 6 分 = ¥0.06 */
const IMAGE_PRICES: Array<{ code: string; microFen: bigint; why: string }> = [
  { code: 'gpt-image-2', microFen: 6_000_000n, why: 'model_price 0.1 × 分组倍率 0.6 = ¥0.06' },
]

/**
 * 场景预冻结额。规则沿用既有的「实测 × 2 取整到 10」。
 * ⚠ 这是**预冻结上限**不是实收：结算走 settleAiCharge 按实际成本算，
 *   给宽了不会多扣用户的钱，只多占一点冻结额度（超出会自动 increaseReservation）。
 */
const SCENE_BEANS: Array<{ code: string; beans: number; why: string }> = [
  { code: 'copy_generate', beans: 20, why: '旧 70 → 实测约 10 积分 ×2' },
  { code: 'copy_traffic', beans: 30, why: '旧 80 → 约 11 ×2' },
  { code: 'copy_persona', beans: 30, why: '旧 80' },
  { code: 'copy_knowledge', beans: 30, why: '旧 80' },
  { code: 'copy_product', beans: 30, why: '旧 80' },
  { code: 'copy_recommend', beans: 20, why: '旧 60' },
  { code: 'storyboard_generate', beans: 50, why: '旧 10 从来不够（实测约 24 积分）' },
  { code: 'publish_material', beans: 50, why: '旧 180' },
  { code: 'publish_cover', beans: 50, why: '实测 24 积分 ×2' },
  { code: 'publish_cover_pick', beans: 50, why: '实测最坏 17 积分 ×2.5' },
  { code: 'edit_plan', beans: 50, why: '旧 150' },
  { code: 'bgm_select', beans: 20, why: '旧 60' },
  { code: 'subtitle_split', beans: 20, why: '旧 60' },
]

async function main() {
  console.log(APPLY ? '=== APPLY 模式：会写库 ===' : '=== DRY-RUN：只看差异，不写库（加 --apply 才写）===')

  let changed = 0

  for (const p of TEXT_PRICES) {
    const rows = await prisma.aiModel.findMany({
      where: { modelCode: p.code, capability: 'TEXT' },
      select: { id: true, inputPricePerMtok: true, outputPricePerMtok: true },
    })
    if (!rows.length) {
      console.log(`[跳过] 文本模型 ${p.code} 不在库里`)
      continue
    }
    for (const r of rows) {
      const same = r.inputPricePerMtok === p.inFen && r.outputPricePerMtok === p.outFen
      console.log(
        `${same ? '[=]' : '[改]'} ${p.code} (id=${r.id}) ` +
          `${r.inputPricePerMtok}/${r.outputPricePerMtok} → ${p.inFen}/${p.outFen} 分/Mtok  (${p.why})`,
      )
      if (!same && APPLY) {
        await prisma.aiModel.update({
          where: { id: r.id },
          data: { inputPricePerMtok: p.inFen, outputPricePerMtok: p.outFen },
        })
      }
      if (!same) changed++
    }
  }

  for (const p of IMAGE_PRICES) {
    const rows = await prisma.aiModel.findMany({
      where: { modelCode: p.code, capability: 'IMAGE' },
      select: { id: true, unitPriceMicroFen: true },
    })
    if (!rows.length) {
      console.log(`[跳过] 图像模型 ${p.code} 不在库里`)
      continue
    }
    for (const r of rows) {
      const same = r.unitPriceMicroFen === p.microFen
      console.log(
        `${same ? '[=]' : '[改]'} ${p.code} (id=${r.id}) ` +
          `unit_price_micro_fen ${r.unitPriceMicroFen} → ${p.microFen} ` +
          `(= ¥${Number(p.microFen) / 1e6 / 100}/张)  (${p.why})`,
      )
      if (!same && APPLY) {
        await prisma.aiModel.update({ where: { id: r.id }, data: { unitPriceMicroFen: p.microFen } })
      }
      if (!same) changed++
    }
  }

  for (const s of SCENE_BEANS) {
    const row = await prisma.aiScene.findUnique({ where: { code: s.code }, select: { id: true, beanPrice: true } })
    if (!row) {
      console.log(`[跳过] 场景 ${s.code} 不在库里`)
      continue
    }
    const same = row.beanPrice === BigInt(s.beans)
    console.log(`${same ? '[=]' : '[改]'} ${s.code} bean_price ${row.beanPrice} → ${s.beans}  (${s.why})`)
    if (!same && APPLY) {
      await prisma.aiScene.update({ where: { id: row.id }, data: { beanPrice: BigInt(s.beans) } })
    }
    if (!same) changed++
  }

  console.log(`\n共 ${changed} 处${APPLY ? '已写入' : '待写（加 --apply 生效）'}`)

  /**
   * 写完后自检：出图单价的「分/张」必须能整除成整数元或角，
   * 否则说明又用错币种了（¥0.72 这种数是 7.2 倍错配的典型产物）。
   */
  const img = await prisma.aiModel.findFirst({ where: { modelCode: 'gpt-image-2' }, select: { unitPriceMicroFen: true } })
  if (img) {
    const fen = Number(img.unitPriceMicroFen) / 1e6
    console.log(`自检：gpt-image-2 = ${fen} 分/张 = ¥${(fen / 100).toFixed(4)}`)
    if (fen > 20) console.log('  ⚠ 仍高于 ¥0.20/张，怀疑币种或倍率没改对')
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
