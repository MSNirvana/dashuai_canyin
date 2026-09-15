// AI 通道一键配置：GPT → Claude → DeepSeek 三通道 + 场景自动备用链
//
// ══ 用法（三个 Key 从环境变量读 —— 本仓库是 public，绝不写进代码）══
//   TB_GPT_KEY=sk-xxx TB_CLAUDE_KEY=sk-xxx TB_DEEPSEEK_KEY=sk-xxx \
//     npx tsx scripts/setup-ai-channels.ts
//
// ══ 做五件事（幂等，可重复跑）══
//   1. 按 code upsert 三个供应商 —— baseUrl 统一 https://tokenbox.you/v1
//      （实测该中转站是标准 OpenAI 兼容端点；Claude 也支持 openai 端点，
//        所以三个通道统一走 OPENAI_COMPATIBLE，无需 ANTHROPIC_NATIVE）
//   2. 按 (providerId, modelCode) upsert 模型；停用同供应商下的历史模型
//   3. 把全部 ai_scene 的主模型设为 GPT、备用链设为 [Claude, DeepSeek]
//      ⇒ 失败转移顺序由 ai_scene 的候选列表决定，**不是** by ai_provider.priority
//        （priority 只影响后台列表排序）
//   4. 把场景的 max_output_tokens 抬到不低于 SCENE_MIN_OUTPUT_TOKENS（默认 4000）
//      ⇒ 推理模型需要「思考 + 正文」共用 max_tokens，预算太小会返回空正文
//   5. 停用其它历史供应商（**不删除** —— 删除会连带清掉 ai_call_log 历史）
//
// ══ 备用是怎么工作的（代码已在 src/ai/ 里实现，本脚本只配数据）══
//   AiGateway.runScene 按 [defaultModelId, ...fallbackModelIds] 依次尝试：
//   · 通道被熔断 / healthStatus=DOWN / enabled=false / 超预算 → 直接跳过
//   · 通道级硬故障（超时/连不上/401/403/429/5xx）→ 立即熔断 60s 并换下一个候选
//   · 熔断到期自动失效 → 下次请求会重新试主通道 ⇒ **恢复后自动切回**
//
// ══ 模型怎么选的（2026-09-15 实测，不是猜的）══
//   用真实 copy_intro prompt（80~150 字中文文案、max_tokens 800）各打 3 次：
//
//     模型                成功   耗时(秒)              结论
//     gpt-5.4             0/3    HTTP 400 / 超时       不可用
//     gpt-5.6-terra       2/3    36.1 / 7.4 / 60✗      尾部超时风险高
//     gpt-5.6-luna        2/3    25.9 / 32.4 / 45✗     太慢
//     gpt-5.6-sol         3/3    37.6 / 35.7 / 8.4      延迟双峰（7~8s 或 36s+）
//     gpt-6-astra         2/3    4.0 / 6.9 / 45✗        尾部超时风险高
//     ★ gpt-5.5           3/3    9.1 / 8.9 / 8.6       稳，选它
//     ★ claude-sonnet-5   3/3    5.6 / 5.5 / 5.5       稳且最快
//     claude-haiku-4-5    3/3    1.9 / 2.4 / 2.1       备选（更小更快）
//     deepseek-v4-pro     3/3    38.9 / 9.3 / 41.8     慢，且 2000+ token（reasoning）
//     ★ deepseek-v4-flash 3/3    4.2 / 4.2 / 4.2       稳且快，选它
//
//   选型原则：三个模型都要稳稳落在 ai_scene.timeout_ms(30s) 之内，
//   否则「正常的慢」会被当成故障 → 无谓地触发故障转移、白白多等 30s。
//   gpt-5.6-sol 就是反例：它 1/3 概率要 36s，超过 30s 超时线，做主力会周期性拖垮体验。
//   三个模型码都可用环境变量覆盖（见下），换模型不必改代码。
//
// ══ ★ 另一个必须知道的坑：max_tokens 被「思考」吃掉 ══
//   tokenbox（以及不少厂商）把 max_tokens 同时当作「思考(reasoning) + 正文」的总预算。
//   三个候选通道都是推理模型，实测同一 prompt、max_tokens=800 各打 3 次：
//     gpt-5.5            reasoning 188~352 tok，正文正常（completion 404~714，已逼近 800）
//     claude-sonnet-5    reasoning 0，正文正常（但另一次实测返回空）
//     claude-haiku-4-5   ★ 3/3 把 800 全用在思考上 → finish_reason='length'、正文 = ''
//   「正文为空」时 HTTP 仍是 200、报文结构完全合法 —— 仅校验「content 是字符串」会放过它。
//   所以修了两处：
//     · src/ai/adapters.ts：空白正文判为 BAD_RESPONSE（否则网关当成功、业务层照常扣豆）
//     · 本脚本 [3/5]：把场景 max_output_tokens 抬到 ≥ SCENE_MIN_OUTPUT_TOKENS
//
// ⚠ 计费单价（input_price_per_mtok / output_price_per_mtok，单位：分 / 百万 token）
//   本脚本已内置从 tokenbox 实际计费表推导出的单价（见下方 PRICES 表），
//   但**默认不写库** —— 因为一旦写进去，商户的扣费会从「0 豆」变成
//   「min(按成本算出的豆, 场景单次上限)」。5 豆的上限远小于实际成本
//   （实测 gpt-5.5 一次 copy 约合 2880 分/百万 输入、17280 分/百万 输出，
//     单次 copy_intro 约 40 豆），这等于把「平台补贴多少」这个商业决策
//   变成默认生效。所以默认只打印、不落库。
//   确认要按真实成本计费时：TB_SET_PRICES=1 重跑本脚本。
//   汇率默认 7.2，可用 TB_USD_TO_CNY 覆盖。
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import { encryptSecret, maskSecret } from '../src/lib/secret.js'

const BASE_URL = 'https://tokenbox.you/v1'

/** 模型码可用环境变量覆盖 —— 换模型不必改代码、不必重新审阅脚本 */
const MODEL_GPT = (process.env.TB_GPT_MODEL ?? 'gpt-5.5').trim()
const MODEL_CLAUDE = (process.env.TB_CLAUDE_MODEL ?? 'claude-sonnet-5').trim()
const MODEL_DEEPSEEK = (process.env.TB_DEEPSEEK_MODEL ?? 'deepseek-v4-flash').trim()

/**
 * 场景输出预算下限（token）。低于它的一律抬到它，只抬不降。
 * 理由见 [3/5] 处的注释：max_tokens 要同时容纳「思考 + 正文」，
 * 原先 300~800 的预算配上推理模型会返回空正文。
 */
const MIN_OUTPUT_TOKENS = Number(process.env.SCENE_MIN_OUTPUT_TOKENS ?? 4000)

/** 是否把真实单价写库。默认 false —— 会改变商户扣费，属商业决策，见文件头。 */
const SET_PRICES = process.env.TB_SET_PRICES === '1'
/** USD → CNY 汇率（tokenbox 按美元计费，本仓库按人民币「分」记账） */
const USD_TO_CNY = Number(process.env.TB_USD_TO_CNY ?? 7.2)

/**
 * tokenbox 真实计费（2026-09-15 取自 GET https://tokenbox.you/api/pricing）
 *
 * 该中转站是 NewAPI 系，计费口径：
 *   美元成本 = tokens × 系数 × group_ratio ÷ 500000      ← NewAPI 约定 500000 quota = $1
 *   · usage 里没有 `cost` 字段，只能靠 /api/pricing 的 billing_expr 反推
 *   · billing_expr 形如 `p * 5 + c * 30`（p=输入 token，c=输出 token，cr=缓存命中）
 *   · group_ratio 是分组倍率：这里 GPT 走「Gpt pro号池」×0.4、
 *     Claude 走「Claude max」×2、DeepSeek 走「Deepseek官方」×0.6
 *
 * ⚠ 这些数字请对照你自己 tokenbox 控制台的账单再核一遍再启用。
 * ⚠ DeepSeek 是分时定价：9:00-12:00 与 14:00-18:00 翻倍，表里填的是**空闲时段价**。
 */
const PRICES: Record<string, { inUsdPerMtok: number; outUsdPerMtok: number; note: string }> = {
  'gpt-5.5': { inUsdPerMtok: 4.0, outUsdPerMtok: 24.0, note: 'p×5 c×30，Gpt pro号池 ×0.4' },
  'claude-sonnet-5': { inUsdPerMtok: 4.0, outUsdPerMtok: 20.0, note: 'ratio 1 / completion 5，Claude max ×2' },
  'deepseek-v4-flash': { inUsdPerMtok: 1.2, outUsdPerMtok: 4.8, note: 'p×1 c×4，Deepseek官方 ×0.6（空闲时段）' },
}

/** 把 PRICES 里的美元单价换算成库里的「分 / 百万 token」（SET_PRICES=false 时返回 0） */
function priceOf(modelCode: string): {
  inputFen: number
  outputFen: number
  inUsdPerMtok: number
  outUsdPerMtok: number
} {
  const p = PRICES[modelCode]
  if (!p) return { inputFen: 0, outputFen: 0, inUsdPerMtok: 0, outUsdPerMtok: 0 }
  return {
    inputFen: SET_PRICES ? Math.round(p.inUsdPerMtok * USD_TO_CNY * 100) : 0,
    outputFen: SET_PRICES ? Math.round(p.outUsdPerMtok * USD_TO_CNY * 100) : 0,
    inUsdPerMtok: p.inUsdPerMtok,
    outUsdPerMtok: p.outUsdPerMtok,
  }
}

interface ModelSpec {
  modelCode: string
  displayName: string
}

/**
 * 场景级覆盖。默认全部场景都是「主 GPT → 备 Claude → 备 DeepSeek」，
 * 只有 storyboard_generate 例外 —— 它是唯一的「大输出」场景
 * （6~8 个分镜、1000+ token JSON），三个通道实测差异极大：
 *
 *   通道                 结果（真实提示词，含 425 字镜头库）
 *   gpt-5.5              ✓ 21.7s  1715 字  8 个分镜
 *   deepseek-v4-flash    ✓ 46.4s  1381 字  7 个分镜   ← 超过 40s 的默认超时
 *   claude-sonnet-5      ✗ 105s 且最终**空正文**（4000 token 被思考吃光）
 *
 * 所以：① 备用顺序调成 DeepSeek 优先 —— Claude 放它后面，
 *          否则 Claude 会先干等一次超时（最坏 90s）再轮到 DeepSeek；
 *       ② timeout 单独放宽到 90s —— 40s 装不下 DeepSeek 的 46s。
 * 不这么做的话，GPT 上游一挂，storyboard 直接回落 3 分镜兜底模板。
 */
const SCENE_OVERRIDES: Record<string, { fallbacks?: string[]; timeoutMs?: number }> = {
  storyboard_generate: { fallbacks: ['tokenbox-deepseek', 'tokenbox-claude'], timeoutMs: 90_000 },
}

interface ChannelSpec {
  code: string
  name: string
  priority: number
  /** 环境变量名（不存 key 本身） */
  envVar: string
  models: ModelSpec[]
}

/** 顺序即备用优先级：第 0 个是主通道，其余依次降级 */
const CHANNELS: ChannelSpec[] = [
  {
    code: 'tokenbox-gpt',
    name: 'GPT（tokenbox 中转）',
    priority: 10,
    envVar: 'TB_GPT_KEY',
    models: [{ modelCode: MODEL_GPT, displayName: `GPT（${MODEL_GPT}）` }],
  },
  {
    code: 'tokenbox-claude',
    name: 'Claude（tokenbox 中转）',
    priority: 20,
    envVar: 'TB_CLAUDE_KEY',
    models: [{ modelCode: MODEL_CLAUDE, displayName: `Claude（${MODEL_CLAUDE}）` }],
  },
  {
    code: 'tokenbox-deepseek',
    name: 'DeepSeek（tokenbox 中转）',
    priority: 30,
    envVar: 'TB_DEEPSEEK_KEY',
    models: [{ modelCode: MODEL_DEEPSEEK, displayName: `DeepSeek（${MODEL_DEEPSEEK}）` }],
  },
]

function readKeys(): Map<string, string> {
  const out = new Map<string, string>()
  const missing: string[] = []
  for (const c of CHANNELS) {
    const v = (process.env[c.envVar] ?? '').trim()
    if (!v) missing.push(c.envVar)
    else out.set(c.code, v)
  }
  if (missing.length) {
    throw new Error(
      `缺少环境变量：${missing.join(', ')}\n` +
        `用法：${CHANNELS.map((c) => `${c.envVar}=sk-xxx`).join(' ')} npx tsx scripts/setup-ai-channels.ts`,
    )
  }
  return out
}

async function main() {
  const prisma = new PrismaClient()
  const keys = readKeys()

  try {
    console.log(`\n[1/5] 配置供应商（baseUrl = ${BASE_URL}）`)
    const providerIds: bigint[] = []
    /** channelCode → 该通道第一个模型 id（用作场景主/备模型） */
    const primaryModelOf = new Map<string, bigint>()

    for (const c of CHANNELS) {
      const apiKey = keys.get(c.code)!
      const payload = {
        name: c.name,
        providerType: 'LLM',
        protocol: 'OPENAI_COMPATIBLE',
        baseUrl: BASE_URL,
        apiKeyEncrypted: encryptSecret(apiKey),
        apiKeyMasked: maskSecret(apiKey),
        enabled: true,
        priority: c.priority,
        healthStatus: 'HEALTHY',
        circuitOpenUntil: null,
        lastTestError: null,
      }

      const existing = await prisma.aiProvider.findUnique({ where: { code: c.code } })
      const provider = existing
        ? await prisma.aiProvider.update({ where: { id: existing.id }, data: payload })
        : await prisma.aiProvider.create({ data: { code: c.code, ...payload } })
      providerIds.push(provider.id)
      console.log(
        `  ${existing ? '更新' : '新建'}  ${c.code.padEnd(20)} key=${provider.apiKeyMasked}  priority=${c.priority}`,
      )

      for (const m of c.models) {
        const dup = await prisma.aiModel.findFirst({
          where: { providerId: provider.id, modelCode: m.modelCode },
        })
        const price = priceOf(m.modelCode)
        const modelData = {
          providerId: provider.id,
          modelCode: m.modelCode,
          displayName: m.displayName,
          capability: 'TEXT',
          enabled: true,
          inputPricePerMtok: price.inputFen,
          outputPricePerMtok: price.outputFen,
        }
        const model = dup
          ? await prisma.aiModel.update({ where: { id: dup.id }, data: modelData })
          : await prisma.aiModel.create({ data: modelData })
        if (!primaryModelOf.has(c.code)) primaryModelOf.set(c.code, model.id)
        console.log(`        模型 ${dup ? '更新' : '新建'}  ${m.modelCode}  (id=${model.id})`)
        console.log(
          `          单价 in=${price.inputFen} out=${price.outputFen} 分/百万token` +
            `（$${price.inUsdPerMtok}/$${price.outUsdPerMtok} per Mtok × ${USD_TO_CNY}）` +
            (SET_PRICES ? '' : '  ⚠ 未应用（当前按 0 计，见 TB_SET_PRICES）'),
        )
      }

      // 停用该供应商下「不在本次清单里」的历史模型。改模型码时会留下残留
      // （例如从 gpt-5.6-sol 换成 gpt-5.5 后，旧的还挂在后台模型列表里）。
      // 只停用、不删除：ai_call_log.model_id 有外键，删模型会连带清掉调用历史。
      const stale = await prisma.aiModel.updateMany({
        where: {
          providerId: provider.id,
          enabled: true,
          modelCode: { notIn: c.models.map((m) => m.modelCode) },
        },
        data: { enabled: false },
      })
      if (stale.count > 0) console.log(`        停用同供应商下 ${stale.count} 个历史模型`)
    }

    console.log('\n[2/5] 重建场景备用链')
    const primary = primaryModelOf.get('tokenbox-gpt')!
    const claudeModelId = primaryModelOf.get('tokenbox-claude')!
    const deepseekModelId = primaryModelOf.get('tokenbox-deepseek')!
    const fallbacks = [claudeModelId, deepseekModelId]
    /** 通道 code → 模型 id，供场景级覆盖按名字指定备用顺序 */
    const modelOfChannel = primaryModelOf

    const scenes = await prisma.aiScene.findMany({ orderBy: { id: 'asc' } })
    for (const s of scenes) {
      const ov = SCENE_OVERRIDES[s.code]
      const chain = ov?.fallbacks
        ? ov.fallbacks.map((code) => {
            const id = modelOfChannel.get(code)
            if (!id) throw new Error(`场景 ${s.code} 的备用通道 ${code} 没有对应模型`)
            return id
          })
        : fallbacks
      await prisma.aiScene.update({
        where: { id: s.id },
        data: {
          defaultModelId: primary,
          // 存数字而非 BigInt：Prisma 的 Json 字段无法序列化 BigInt
          fallbackModelIds: chain.map((v) => Number(v)),
          ...(ov?.timeoutMs ? { timeoutMs: ov.timeoutMs } : {}),
        },
      })
    }
    console.log(`  ${scenes.length} 个场景 → 主 ${primary}，默认备用 [${fallbacks.join(', ')}]`)
    for (const s of scenes) {
      const ov = SCENE_OVERRIDES[s.code]
      console.log(
        `    ${s.code}` +
          (ov ? `  ★ 覆盖：备用顺序=${ov.fallbacks?.join(' → ') ?? '默认'}${ov.timeoutMs ? ` timeout=${ov.timeoutMs}ms` : ''}` : ''),
      )
    }

    console.log(`\n[3/5] 抬高场景输出预算（下限 ${MIN_OUTPUT_TOKENS} token，只抬不降）`)
    // ★ 为什么必须抬：实测发现中转站（以及不少厂商）把 max_tokens 同时当作
    //   「思考(reasoning)预算 + 正文预算」。三个候选通道全是推理模型，
    //   GPT-5.5 在极短提示下就要花 188~352 个思考 token，
    //   claude-haiku 在 mt=800 时 3/3 次把预算全用在思考上、正文返回空串。
    //   而本仓库原先的场景预算（title_overlay/bgm_select 300、review_guard 400、
    //   rhythm_detect 500）是按非推理模型（mock / 早期 deepseek）定的，
    //   配上真实推理模型后几乎必然「思考吃满 → 正文为空」。
    //   抬高上限不强制多花 token（模型该花多少花多少），只是不再被截断。
    let raised = 0
    for (const s of scenes) {
      const cur = s.maxOutputTokens ?? 0
      if (cur >= MIN_OUTPUT_TOKENS) continue
      await prisma.aiScene.update({ where: { id: s.id }, data: { maxOutputTokens: MIN_OUTPUT_TOKENS } })
      raised++
      console.log(`  ${s.code.padEnd(22)} ${String(cur).padStart(5)} → ${MIN_OUTPUT_TOKENS}`)
    }
    if (raised === 0) console.log('  （全部已在下限之上，无需调整）')

    console.log('\n[4/5] 停用历史供应商（保留数据，不删除）')
    const retired = await prisma.aiProvider.findMany({
      where: { code: { notIn: CHANNELS.map((c) => c.code) }, enabled: true },
    })
    if (retired.length === 0) {
      console.log('  （没有需要停用的）')
    } else {
      for (const p of retired) {
        await prisma.aiProvider.update({
          where: { id: p.id },
          data: { enabled: false, circuitOpenUntil: null },
        })
        console.log(`  停用 ${p.code}（${p.name}）`)
      }
    }

    console.log('\n[5/5] 清理熔断状态 + 打印当前生效配置')
    // 熔断状态在 Redis（ai:cb:open:<providerId>，TTL 60s），不在数据库。
    // 刚把某个通道改好（比如换了 key / 换了模型）却不清它，会有最长 60s
    // 「明明配好了，请求还是走备用」的窗口 —— 排查起来非常费解。
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    })
    try {
      for (const id of providerIds) {
        await redis.del(`ai:cb:open:${id}`, `ai:cb:req:${id}`, `ai:cb:fail:${id}`)
      }
      console.log('  已清除三个通道的熔断计数（Redis）')
    } catch (e) {
      console.log(`  ⚠ 清理熔断状态失败（不影响配置本身）：${(e as Error).message}`)
    } finally {
      await redis.quit().catch(() => {})
    }

    const active = await prisma.aiProvider.findMany({
      where: { enabled: true },
      include: { models: { where: { enabled: true } } },
      orderBy: { priority: 'asc' },
    })
    for (const p of active) {
      console.log(`  ${p.code.padEnd(20)} ${p.baseUrl.padEnd(28)} ${p.models.map((m) => m.modelCode).join(', ')}`)
    }

    // 自检：确认密钥能解回来（防止 APP_MASTER_KEY 不匹配导致运行期才炸）
    const { decryptSecret } = await import('../src/lib/secret.js')
    const first = await prisma.aiProvider.findUnique({ where: { code: CHANNELS[0]!.code } })
    if (first) {
      const plain = decryptSecret(first.apiKeyEncrypted)
      const ok = plain.startsWith('sk-') && plain.length > 20
      console.log(`\n自检 解密 ${CHANNELS[0]!.code} 的密钥：${ok ? '✓ 正常' : '✗ 异常（APP_MASTER_KEY 可能不匹配）'}`)
      if (!ok) process.exitCode = 1
    }

    if (SET_PRICES) {
      console.log(`\n单价已写库（汇率 ${USD_TO_CNY}）—— 商户扣费将按真实成本计算，并受场景单次上限约束。`)
    } else {
      console.log(
        '\n⚠ 单价**未**写库（TB_SET_PRICES 未设为 1）：模型单价仍为 0，' +
          '\n  于是 ai_call_log.cost_fen = 0、商户实际扣 0 豆 —— 等于平台全额补贴。' +
          '\n  上表已打印按 tokenbox 计费表推导的真实单价，确认后再 TB_SET_PRICES=1 重跑。',
      )
    }

    console.log('\n完成。下一步：跑 npm run ai-failover:verify 验证故障转移。')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error('\n✗ 配置失败：', (e as Error).message)
  process.exit(1)
})
