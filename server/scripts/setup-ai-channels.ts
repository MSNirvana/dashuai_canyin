// AI 通道一键配置：GPT → Claude → DeepSeek 三通道 + 场景自动备用链
//
// ══ 用法（Key 从环境变量读 —— 本仓库是 public，绝不写进代码）══
//   TB_GPT_KEY=sk-xxx TB_CLAUDE_KEY=sk-xxx TB_DEEPSEEK_KEY=sk-xxx \
//     npx tsx scripts/setup-ai-channels.ts
//
//   出图通道是**可选的第 4 个 Key**（不给就自动跳过，其余配置照常完成）：
//   TB_GPT_KEY=… TB_CLAUDE_KEY=… TB_DEEPSEEK_KEY=… TB_IMAGE_KEY=sk-xxx \
//     npx tsx scripts/setup-ai-channels.ts
//
//   ★ 也可以**只给要换的那个 Key**：环境变量缺失的通道会**沿用库里已存的密钥**
//     （输出里逐行标「本次写入新 Key」还是「沿用库中已存密钥」）。所以在服务器上补
//     出图通道，只需要 `TB_IMAGE_KEY=sk-xxx npx tsx scripts/setup-ai-channels.ts`，
//     不必把三个旧 Key 再贴一遍（旧 Key 只在库里，贴一遍反而会进 shell history）。
//     若环境变量缺失且库里也没有 ⇒ 仍然硬失败，不会写出一个没密钥的空壳通道。
//
// ══ 做六件事（幂等，可重复跑）══
//   1. 按 code upsert 三个供应商 —— baseUrl 统一 https://tokenbox.you/v1
//      （实测该中转站是标准 OpenAI 兼容端点；Claude 也支持 openai 端点，
//        所以三个通道统一走 OPENAI_COMPATIBLE，无需 ANTHROPIC_NATIVE）
//   2. 按 (providerId, modelCode) upsert 模型；停用同供应商下的历史模型
//   3. 把全部 ai_scene 的主模型设为 GPT、备用链设为 [Claude, DeepSeek]
//      ⇒ 失败转移顺序由 ai_scene 的候选列表决定，**不是** by ai_provider.priority
//        （priority 只影响后台列表排序）
//      ★ 例外见 SCENE_OVERRIDES：storyboard_generate（唯一的大输出场景）主候选是
//        DeepSeek、备用只有 Claude，且 timeout/ maxRetries / max_output_tokens 都被覆盖。
//   4. 把场景的 max_output_tokens 抬到不低于 SCENE_MIN_OUTPUT_TOKENS（默认 4000）
//      ⇒ 推理模型需要「思考 + 正文」共用 max_tokens，预算太小会返回空正文
//      ⚠ 4000 只够**短输出**场景；storyboard_generate 实测需 ~10500，故由覆盖单独钉住
//   5. 商业参数：场景单次上限（TB_SET_CAPS=1）+ 注册赠积分（TB_REGISTER_GRANT=n）
//      默认都只打印对照，不写库 —— 它们决定用户实付和补贴，属商业决策
//   6. 停用其它历史供应商（**不删除** —— 删除会连带清掉 ai_call_log 历史），
//      清熔断状态，打印生效配置
//
// ══ ★ 出图通道（第 4 个通道，2026-09-21 加）══
//   出图不能挤在文本通道里，两个原因：
//     ① **Key 分组不同**：文本三个通道的 Key 属于文本分组，`/v1/models` 里一个出图模型
//        都没有（`gpt-image-2*` 全 503 model_not_found）。出图 Key 属于另一个分组，
//        `/v1/models` 只返回 5 个 `gpt-image-2*`。一个 ai_provider 行只能带一个 Key，
//        所以出图必须是**独立通道**。
//     ② **计费口径不同**：出图返回里**没有 token 用量**（实测 `usage: null`），
//        计费表按「次数」报价（`quota_type=1 / model_price`），而 ai_model 只有
//        「分/百万 token」两列 —— 也就是**出图的价没法落在 ai_model 上**。
//        所以出图的价格写在 `ai_scene.bean_price`（固定价，见 SCENE_CAPS 的说明），
//        模型行只声明能力（`capability='IMAGE'`）不给单价。
//
//   ⚠ 同理，出图场景必须显式声明 `ai_scene.kind='IMAGE'`，且候选链里**只能有 IMAGE 模型**：
//     网关按 kind 选协议（chat/completions vs images/generations），
//     候选链里混进一个文本模型就会被能力闸门跳过（不是报错，是静默换下一个候选 ——
//     所以链上只有一个候选时，配错的表现是「这个场景永远失败」）。
//
// ══ 环境变量 ══
//   TB_GPT_KEY / TB_CLAUDE_KEY / TB_DEEPSEEK_KEY   必填，三个统一 Key
//   TB_GPT_MODEL / TB_CLAUDE_MODEL / TB_DEEPSEEK_MODEL   模型码覆盖
//   SCENE_MIN_OUTPUT_TOKENS   场景输出预算下限，默认 4000
//   TB_SET_PRICES=1           把真实单价写库（否则单价 0 ⇒ 扣 0 积分）
//   TB_SET_CAPS=1             把场景单次上限写库（否则扣费恒被截断成封顶值）
//   TB_REGISTER_GRANT=n       注册赠积分（未设 = 不改；`0` = 关掉注册赠积分，当前策略）
//   TB_USD_TO_CNY             汇率，默认 7.2
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
//     · src/ai/adapters.ts：空白正文判为 BAD_RESPONSE（否则网关当成功、业务层照常扣积分）
//     · 本脚本 [3/6]：把场景 max_output_tokens 抬到 ≥ SCENE_MIN_OUTPUT_TOKENS
//
// ⚠ 计费单价（input_price_per_mtok / output_price_per_mtok，单位：分 / 百万 token）
//   本脚本已内置从 tokenbox 实际计费表推导出的单价（见下方 PRICES 表）。
//   默认不写库 —— 一旦写进去，商户扣费就从「0 积分」变成「按成本算」，
//   等于把「平台补贴多少」这个商业决策变成默认生效。确认后 TB_SET_PRICES=1。
//   ⚠ 写了单价**还不够**：`charged = min(应付, 场景单次上限)`，
//     上限不一起抬，扣费仍是封顶值（见 [4/6]）。所以两个开关要成对使用。
//   汇率默认 7.2，可用 TB_USD_TO_CNY 覆盖。
//
// ══ ★ 2026-09-15 实测：单次成本能差 15 倍，变量是「思考 token」不是文案长度 ══
//   同一个 copy_intro 提示词、同一个 claude-sonnet-5，连打 3 次：
//     #1  in=433 out=171    →  5 分  →  20 积分   6.9s   126 字
//     #2  in=433 out=1979   → 31 分  → 124 积分  54.7s   130 字   ← 思考爆了
//     #3  deepseek  in=334 out=132  → 2 分 → 8 积分  33.4s   97 字
//   正文都是 100~130 字，成本差 15 倍。所以：
//     · 「按字数/按次」定价会亏，必须按 token 成本算（本项目的做法）
//     · 场景上限只能是**财务安全网**，不能当常规定价用 —— 它一定会被周期性击穿
//     · 失败重试的 token **不计费也不入账**（只记最终成功那次），但那部分钱平台仍付给了上游
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import { encryptSecret, maskSecret } from '../src/lib/secret.js'
import { CREATION_SCENE_PROMPTS, EDIT_PLAN_SCENE, PUBLISH_SCENES } from '../prisma/prompts.js'

const BASE_URL = 'https://tokenbox.you/v1'

/** 模型码可用环境变量覆盖 —— 换模型不必改代码、不必重新审阅脚本 */
const MODEL_GPT = (process.env.TB_GPT_MODEL ?? 'gpt-5.5').trim()
const MODEL_CLAUDE = (process.env.TB_CLAUDE_MODEL ?? 'claude-sonnet-5').trim()
const MODEL_DEEPSEEK = (process.env.TB_DEEPSEEK_MODEL ?? 'deepseek-v4-flash').trim()

/**
 * 出图模型码。默认 `gpt-image-2`（裸码，不带分辨率后缀）。
 *
 * ★ 为什么是裸码而不是看起来更便宜的 `-1k`（2026-09-21 实测）：
 *    ① `-1k` **拒绝**我们要的尺寸：`gpt-image-2-1k` + `size=1024x1365`
 *       → HTTP 400 `image size "1024x1365" exceeds channel resolution limit 1k`。
 *       它的每边上限就是 1024，3:4 最大只能给到 768x1024（1k 的价、明显更糊的图）。
 *    ② `-1k` / `-2k` 返回的是 **b64_json**（没有 URL，也没有 `image_generation_route`），
 *       而裸码返回 URL + 完整规格回显。裸码还快一倍（实测 44.6s vs 91.4s）。
 *    ③ **分辨率档位不影响计费**：裸码 + 1024x1365 的 route 里
 *       `resolution_tier=1k`，但实测扣费是 **$0.10**（按请求的模型名计），
 *       不是 1k 档的 $0.06。所以「用裸码会不会按 4k 收费」这个担心是多余的 ——
 *       它本来就按 0.10 收；反过来，指望用 `-1k` 省钱就得接受更小的图。
 *    ⇒ 结论：用裸码 + `AI_IMAGE_SIZE=1024x1365`（原生 864×1152，落盘 1086×1448，比例正好 3:4）。
 *      ⚠ 想换更便宜的 1k 档要**三处同时改**：本变量、`AI_IMAGE_SIZE`、
 *        以及 prompts.ts 里 publish_cover 的 beanPrice（说明写在那里）。
 */
const MODEL_IMAGE = (process.env.TB_IMAGE_MODEL ?? 'gpt-image-2').trim()

/**
 * 场景输出预算下限（token）。低于它的一律抬到它，只抬不降。
 * 理由见 [3/6] 处的注释：max_tokens 要同时容纳「思考 + 正文」，
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
 * （6~9 个分镜、含 100+ 字「怎么拍」的 JSON），**真实输出量远超其它场景**。
 *
 * ★ 2026-09-21 实测重定（同一条真实渲染后的 prompt，直连各通道、超时给足、绕过熔断器）：
 *
 *   通道                         max_tokens=4000              max_tokens=12000
 *   gpt-5.5                      极短 ping 就要 15s           长请求 125.9s → **HTTP 524**
 *   claude-sonnet-5              ✗ 空正文 ×2（45s/44s，       ✓ 109.8s，out=10433
 *                                 finish_reason=length）
 *   deepseek-v4-flash            ✓ 但 95.8s（out=10901，       ✓ 100.1s，out=11257
 *                                 **无视 max_tokens 上限**）
 *
 *   由此得到三条**互相独立**的结论，缺一条都会配错：
 *   ① **GPT 必须移出这条链**：HTTP 524 是上游网关的硬时限（~100s，与我们的 timeout 无关），
 *      意味着它对「大输出」**永远不可能成功**，留在链里只是每次白付一个完整超时。
 *   ② **主候选应为 DeepSeek**：它是唯一「无视 max_tokens 上限」的通道（给 4000 也能吐
 *      10901 个 token），所以对预算不敏感、必定出稿；代价是它**对思考很慷慨**，
 *      耗时在 60~130+ 秒之间波动（实测 62.2s / 91.2s / 95.8s / 100.1s / >130s）。
 *   ③ **输出预算必须给足**：这条 prompt 实测需要约 **10500 output token**，其中约 9000
 *      是思考 token（正文只有 ~1500 字符）。给 4000 时「严格截断」的通道（Claude）
 *      会返回空正文；DeepSeek 只是变慢。所以本场景覆盖成 12000。
 *
 *   ⇒ timeout 150s（覆盖 ② 的 130+s 尾巴）、maxRetries 0（单次尝试约 100s，
 *     重试的代价大于换通道；同时保证最坏 2×150s=300s 不超过前端的 340s 兜底）、
 *     primary=DeepSeek、备用=Claude。
 *   ⚠ 改这里的 timeout / 候选数 / maxRetries 时，**必须同步前端**
 *     `apps/mini/src/services/creation.ts` 的 `STORYBOARD_TIMEOUT_MS`（算法写在那个常量上）。
 */
/** 出图通道的 code。★ 必须在 SCENE_OVERRIDES 之前声明（那个对象字面量在模块加载时求值） */
const IMAGE_CHANNEL = 'tokenbox-image'

const SCENE_OVERRIDES: Record<
  string,
  {
    /** 覆盖主候选（通道 code）。不给则用默认主候选 GPT */
    primary?: string
    fallbacks?: string[]
    timeoutMs?: number
    maxRetries?: number
    maxOutputTokens?: number
  }
> = {
  storyboard_generate: {
    primary: 'tokenbox-deepseek',
    fallbacks: ['tokenbox-claude'],
    timeoutMs: 150_000,
    maxRetries: 0,
    maxOutputTokens: 12_000,
  },
  /**
   * 封面出图（图像场景，`ai_scene.kind='IMAGE'`）。
   *
   * ★ 候选链**只有出图通道一个**，这是刻意的：图像场景不存在「换个通道重试」——
   *   文本通道在能力闸门就会被跳过（`capability !== 'IMAGE'`），把它们留在链上
   *   只是在每次失败时多打印几条「候选被跳过」，既不会成功也让人以为配了很多备用。
   * ★ `fallbacks: []` 而不是不写：不写会用默认的 [Claude, DeepSeek]（见 [2/6] 的三元表达式），
   *   那正好是最不该出现在这条链上的两个。
   * ★ timeout 90s：实测单张 1024×1365 约 **50s**（含排队），给 90s 留一倍余量。
   *   出图没有「思考 token 吃满」的问题（不走 chat/completions），所以不需要 150s。
   * ★ maxRetries 0：出图是**按张付费**的，重试等于重复付钱（且失败大多是上游硬故障，
   *   立刻重试不会好）。失败直接回给用户，由用户决定要不要再来一次。
   */
  publish_cover: {
    primary: IMAGE_CHANNEL,
    fallbacks: [],
    timeoutMs: 90_000,
    maxRetries: 0,
  },
  /**
   * 五个菜品文案款（流量 / 人设 / 干货 / 产品 / 种草）—— 2026-09-22 实测重定。
   *
   * ★★ 两块实质改动：**主候选换 DeepSeek** + **把 Claude 移出候选链**。
   *   起因：四款文案改型上线后，新场景**一次都没成功**（`ALL_FAILED（90.0s）attempts=3`）。
   *   排查过程与判据（同一提示词、max_tokens=4000、temperature=0.7、
   *   带 `reasoning_effort:'low'`、直连各通道、超时给足 150s）：
   *
   *     通道                 人设型 prompt 上各打 3 次        product/knowledge 上
   *     deepseek-v4-flash    **7.7 / 12.5 / 8.5s**（中位 8.5s）  7.0~9.0s ✅
   *     gpt-5.5              40.4 / 52.1 / 43.7s（中位 43.7s）   7.0~7.6s（但另有一次 30s 超时）
   *     claude-sonnet-5      46~50s 且**正文为空**
   *
   *   ① **主候选必须是 DeepSeek**：它的延迟**稳定**在 8~13s（最坏 12.5s），
   *      在 45s 预算下有 3.5 倍余量；而 GPT 是**双峰**的 —— 短提示词上 7s、
   *      长提示词（人设型 2824 字）上稳定 40s+，30s 预算下必然白白超时。
   *      顺带它是三个通道里最便宜的（$1.2/$4.8 per Mtok vs GPT 的 $4/$24）。
   *   ② **Claude 必须移出**：它对 `reasoning_effort` 与 `thinking:{type:'disabled'}`
   *      **两个参数都无视**，4000 预算必然被思考吃光 → `finish_reason='length'`、
   *      `content=''`。而空正文是 BAD_RESPONSE（**非**通道级故障 ⇒ 会按 max_retries
   *      **反复重试同一通道**），留在链上就是每次白等 46~50 秒 × (maxRetries+1) 次。
   *   ③ `timeoutMs: 45_000`：DeepSeek 最坏 12.5s 的 3.5 倍余量；也给 GPT 这个备用
   *      一次机会（它在短提示词上 7s 就能答完）。
   *   ④ `maxRetries: 0`：两候选各 45s ⇒ 最坏 90s，稳稳落在前端 120s
   *      （`COPY_TIMEOUT_MS`）内。普通重试价值也低 —— 这两个通道的失败是**系统性**的
   *      （限流 / 上游故障），换通道比原地重试有效。
   *
   *   ⚠ 改这里的候选数 / timeout / maxRetries 时**必须同步重算** `COPY_TIMEOUT_MS`
   *     （apps/mini/src/services/creation.ts，算法写在该常量上）。
   *   ⚠ 「压掉思考预算」那一半在**代码侧**（`ai/scene-codes.ts` 的 LOW_REASONING_SCENES
   *     + 网关透传 `reasoning_effort`）—— 不压的话 DeepSeek 也要 50s、GPT 要 84s。
   */
  ...Object.fromEntries(
    ['copy_traffic', 'copy_persona', 'copy_knowledge', 'copy_product', 'copy_recommend'].map((code) => [
      code,
      {
        primary: 'tokenbox-deepseek',
        fallbacks: ['tokenbox-gpt'],
        timeoutMs: 45_000,
        maxRetries: 0,
      },
    ]),
  ),
  /**
   * AI 剪辑决策（EDL）—— 2026-09-22 上线当天**实测之后**才补的。
   *
   * ★★ 为什么这个场景必须显式覆盖：`ai-prompts:sync` 建新场景时用
   *   `firstModelOfKind('TEXT')` —— 取的是**按 `provider.priority` 排序的第一个
   *   文本模型** ⇒ 新场景默认落在 `tokenbox-gpt`（priority 10）上，且
   *   `fallback_model_ids` 是**空数组**（见该脚本的 create 分支）。
   *   对多数场景这没问题，但本场景实测正好踩上 GPT 的**双峰**：
   *
   *     2026-09-22 线上首跑（任务 15，6 个镜头、真实素材、prompt 5097 token）：
   *       gpt-5.5 ｜ 入 5097 · 出 436 token ｜ **latency 46.6s** ｜ SUCCESS
   *
   *   46.6s 对 60s 预算只剩 29% 余量 ⇒ **镜头一多必然超时**。而超时的后果是
   *   `generateEditPlan` 退化成「按面板档位剪」：不报错、只是这次剪辑决策静默消失。
   *   这与 `copy_*` 五款当初「三候选全超时」是同一类问题（实测表见本节上方）。
   *
   * ★ 处置是**保守版**：不动主候选，只补备用 + 放宽超时 + 关掉原地重试。
   *   · `primary` 仍留 GPT —— 它在本次实测里给出的逐镜头决策质量是好的
   *     （1.8 / 4.4 / 3.0 / 1.9 / 1.5 / 4.5s，起伏明显）。换主候选属**未验证的质量变更**，
   *     要做也应该先按上面那张表的口径拿同一批素材 A/B 一轮，而不是顺手换掉。
   *   · `fallbacks: ['tokenbox-deepseek']` —— DeepSeek 在短输出文本场景延迟稳定
   *     8~12.5s（同上表）⇒ GPT 超时后仍能拿到决策，而不是整条退化成档位。
   *     ⚠ **别把 `tokenbox-claude` 放进来**：它无视 `reasoning_effort`，4000 预算会被
   *       思考吃光并返回空正文；空正文是**非通道级**故障 ⇒ 会按 maxRetries 反复重试它。
   *   · `timeoutMs: 90_000` —— 实测 46.6s 的约 1.9 倍余量，给镜头更多的长视频留空间。
   *     ★ 本场景在 **worker 里**跑，**不参与前端超时计算**（见 prompts.ts 的同名说明），
   *       所以放宽它不会牵动小程序侧的等待预算。
   *   · `maxRetries: 0` —— 有真备用之后，在**同一个慢通道**上原地重试纯属浪费：
   *     GPT 的超时是系统性的（双峰），换通道比原地重试有效。最坏 90s + ~10s ≈ 100s。
   */
  edit_plan: {
    primary: 'tokenbox-gpt',
    fallbacks: ['tokenbox-deepseek'],
    timeoutMs: 90_000,
    maxRetries: 0,
    maxOutputTokens: 4_000,
  },
}

/**
 * 场景单次上限（= 预冻结额 = 单次最大扣费，`ai_scene.bean_price`）。
 *
 * ★ 这是**给用户的报价**，不是技术参数 —— 改了它等于改用户实付多少积分。
 *   所以默认**不写库**，只在 `TB_SET_CAPS=1` 时应用。
 *
 * 为什么需要调：计费口径是「扣积分 = ceil(成本分 × points_per_yuan × cost_multiplier / 100)」，
 * 而 beanPrice 是硬截断线（`charged = min(wantCharge, frozenAmount)`）。
 * 实测（2026-09-15，全场景各 1 次真实调用，gpt-5.5）：
 *
 *   场景                 应扣积分   现上限   差距
 *   copy_generate          36  >    5    ← 平台承担 31
 *   storyboard_generate   123  >   10    ← 平台承担 113
 *   copy_traffic           38  >    5
 *   copy_intro             41  >    5   ← 已被 2026-09-21 改型删除，语义由 copy_product 承接
 *   copy_quality           31  >    5   ← 同上，语义由 copy_persona 承接
 *   script_polish          91  >    5
 *   review_guard           20  >    3
 *   title_overlay          36  >    5
 *   bgm_select             28  >    3
 *   rhythm_detect          94  >    3
 *   copy_recommend         28  >    5
 *
 * → **11/11 场景全部被截断**，现上限是按「mock / 早期便宜模型」定的。
 *   要让「按成本×系数扣」真正成立，上限必须抬到不会截断的水平（上限只是财务安全网）。
 *
 * 下表 = 实测应扣积分 × 2 取整到 10（留一倍余量给输出长度抖动）。
 * ⚠ 上限只是安全网，**不保证不被击穿**：实测同一提示词、同一通道连打 3 次，
 *   单次成本 5 / 31 / 2 分（差 15 倍，全看思考 token 花多少），上限一定会周期性被击穿；
 *   被击穿的那部分记 `absorbedBeans`（平台承担）。这是设计如此，不是 bug。
 * ⚠ 注意副作用：上限同时是**预冻结额**，抬上去后「账户可用积分不足」的门槛也一起抬高
 *   （新用户注册赠积分目前 30，copy_persona / copy_knowledge / copy_product 需 80 冻结 ⇒ 新用户一上来用不了）。
 *   所以调上限必须连带调 `TB_REGISTER_GRANT`，否则新用户注册即「一个 AI 功能都用不了」。
 */
const SCENE_CAPS: Record<string, number> = {
  storyboard_generate: 250,
  script_polish: 180,
  review_guard: 40,
  title_overlay: 70,
  bgm_select: 60,
  rhythm_detect: 190,
  /**
   * 文案各款（含流量款）的价**不在这里写第二遍** —— 直接取 prompts.ts 的 CREATION_SCENE_PROMPTS。
   *
   * ★ 与下面 PUBLISH_SCENES 同一个理由，而且这里**踩过一次真实的坑**：
   *   2026-09-21 四款改型新建了 3 个文案场景，`ai-prompts:sync` 建行时取的是
   *   prompts.ts 里的值 —— 当时那张清单没给 `beanPrice`，于是建出来 `bean_price = 0`
   *   （= 每次生成免费，且不报错）。两个源各写一份，就一定会有一边漏。
   *
   * ⚠ 但**数值本身仍是估算**：旧款实测 41（介绍）/ 31（质量）/ 28（种草）分是
   *   2026-09-15 全场景真打一次测出来的；新款模板还没测过，只是**输出长度档位**
   *   与旧款相同（人设 100~180 字 / 干货 110~190 / 产品 80~150 / 种草 90~170），
   *   所以先按同档给。改价前必须先按旧款那套口径真跑一次（每场景 1 次真实调用，
   *   记 absorbedBeans），否则就是拍脑袋。
   * ★ 上限同时是**预冻结额**：抬上去会连带抬高「可用积分不足」的门槛
   *   （新用户注册赠积分目前 30 ⇒ 80 的冻结额一上来就用不了），
   *   所以改这里必须连带看 `TB_REGISTER_GRANT`。
   */
  ...Object.fromEntries(CREATION_SCENE_PROMPTS.map((s) => [s.code as string, s.beanPrice as number])),
  /**
   * 发布素材的两个场景（P2 新增）。
   *
   * ★ 值**不在这里写第二遍** —— 直接取 prompts.ts 的场景描述。
   *   理由：这两个场景是随「建行」一起诞生的，价必须在那时就正确
   *   （出图场景走固定价结算，beanPrice=0 等于每次出图白送且不报错）。
   *   既然 prompts.ts 已经有了权威值，这里只把它**接进同一张复核表**，
   *   免得「脚本里写 180、建行时是 300」这种对不上账的经典错配。
   *   ⇒ 定价依据（$0.10/张 → 72 分 → ×4 = 288 → 取 300）写在 prompts.ts 的
   *     PUBLISH_SCENES.publish_cover 上，要改价去那里改。
   */
  ...Object.fromEntries(PUBLISH_SCENES.map((s) => [s.code as string, s.beanPrice as number])),
  /**
   * AI 剪辑决策（2026-09-22）。★ 同样**不写第二遍** —— 取 `prompts.ts` 的值。
   *
   * ⚠ 它的价目前是**估算**（输入只有逐镜头清单，远小于 publish_material 的 5510 token），
   *   真跑一次后应回来校准；定价依据写在 prompts.ts 的 `EDIT_PLAN_SCENE` 上。
   * ★ 这个场景与前两者的一个关键差别：它在**每次 AI 档合成时都会被调用一次**，
   *   所以 150 是「每出一条片子多扣 150 积分」，而不是「用户点一次才扣一次」。
   */
  [EDIT_PLAN_SCENE.code]: EDIT_PLAN_SCENE.beanPrice,
}

/** 是否把 SCENE_CAPS 写库。默认 false —— 会改变用户实付，属商业决策。 */
const SET_CAPS = process.env.TB_SET_CAPS === '1'

/**
 * 注册赠积分（`system_setting` 的 `bean.register_grant_points`）。
 * 未设 = 不改。设成数字才写库（`TB_REGISTER_GRANT=600` / `TB_REGISTER_GRANT=0`）。
 *
 * ★ 为什么必须和场景上限一起看：
 *   场景上限同时是**预冻结额**，抬高上限 = 同时抬高「账户可用积分不足」的门槛。
 *   实测（2026-09-15）：上限抬到 40~250 积分后，**11/11 个场景的上限都 > 注册赠积分 30**
 *   ⇒ 新用户一注册就「一个 AI 功能都用不了」——
 *     不是报错扣费，而是**冻结阶段就被拦**：`BeanNotEnoughError: 积分不足：需要 80，可用 30`。
 *   旧上限（3/5/10 积分）时不存在这个问题，所以这是「抬上限」引入的连带回归。
 *
 * ★ 当前策略（2026-09-15 起）：**注册赠积分 = 0**。
 *   产品决策是「注册后必须购买 ¥980 会员才能用 AI」——真正的闸门是
 *   `requireSubscription`（文案 / 分镜 / 合成 三处，未订阅 → 403 + 2005），
 *   赠积分只是「能不能过预冻结」的第二道门。赠积分置 0 后两道门一致，不会出现
 *   「用户拿到赠积分、点生成却报需要订阅」这种前后矛盾的体验。
 *   支付未开放期间由后台「商家详情 → 会员 → 手动开通」发放会员。
 */
const REGISTER_GRANT = (() => {
  const raw = process.env.TB_REGISTER_GRANT
  if (raw === undefined) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new Error(`TB_REGISTER_GRANT 非法（应为 ≥0 的数字）：${raw}`)
  return n
})()

interface ChannelSpec {
  code: string
  name: string
  priority: number
  /** 环境变量名（不存 key 本身） */
  envVar: string
  /** 该通道下所有模型的能力标签（写进 ai_model.capability，供网关的能力闸门判定） */
  capability: 'TEXT' | 'IMAGE'
  /**
   * 可选通道：环境变量缺失时**跳过本通道**而不是报错退出。
   * ★ 只有出图通道是可选 —— 文本三通道缺任何一个都意味着「主链不完整」，必须显式失败；
   *   而出图是附加能力，没配好只该让 publish_cover 这一个场景不可用，
   *   不该让整个脚本（连带文本链）跑不起来。
   */
  optional?: boolean
  models: ModelSpec[]
}

/** 顺序即备用优先级：第 0 个是主通道，其余依次降级 */
const CHANNELS: ChannelSpec[] = [
  {
    code: 'tokenbox-gpt',
    name: 'GPT（tokenbox 中转）',
    priority: 10,
    envVar: 'TB_GPT_KEY',
    capability: 'TEXT',
    models: [{ modelCode: MODEL_GPT, displayName: `GPT（${MODEL_GPT}）` }],
  },
  {
    code: 'tokenbox-claude',
    name: 'Claude（tokenbox 中转）',
    priority: 20,
    envVar: 'TB_CLAUDE_KEY',
    capability: 'TEXT',
    models: [{ modelCode: MODEL_CLAUDE, displayName: `Claude（${MODEL_CLAUDE}）` }],
  },
  {
    code: 'tokenbox-deepseek',
    name: 'DeepSeek（tokenbox 中转）',
    priority: 30,
    envVar: 'TB_DEEPSEEK_KEY',
    capability: 'TEXT',
    models: [{ modelCode: MODEL_DEEPSEEK, displayName: `DeepSeek（${MODEL_DEEPSEEK}）` }],
  },
  {
    code: 'tokenbox-image',
    name: '出图（tokenbox 中转）',
    priority: 40,
    envVar: 'TB_IMAGE_KEY',
    capability: 'IMAGE',
    optional: true,
    models: [{ modelCode: MODEL_IMAGE, displayName: `出图（${MODEL_IMAGE}）` }],
  },
]

/** 环境里给了 Key 的通道（只读环境变量，不碰数据库） */
function readEnvKeys(): Map<string, string> {
  const keys = new Map<string, string>()
  for (const c of CHANNELS) {
    const v = (process.env[c.envVar] ?? '').trim()
    if (v) keys.set(c.code, v)
  }
  return keys
}

/** 通道的密钥来源：本次环境变量给的，或沿用库里已存的那把 */
interface ResolvedKey {
  channel: ChannelSpec
  /** 本次要写入的新 Key（null = 沿用库里已存的，不动密钥字段） */
  fresh: string | null
  /** 用于打印的掩码（沿用时的值由调用方从库里取） */
  masked: string | null
  /** 沿用时的 provider id（此时 provider 一定已存在） */
  reuseProviderId: bigint | null
}

/**
 * 把「本通道该用哪把 Key」解析清楚，**在写任何东西之前**。
 *
 * ★ 为什么允许沿用库里的密钥（2026-09-21 加）：
 *   本脚本最初要求三个文本 Key 每次都从环境变量给。于是「只想补一个出图 Key」
 *   也得把三个旧 Key 重新贴一遍 —— 而运维手里通常只有新 Key（旧的只在服务器库里），
 *   结果要么把密钥再写进 shell（进 history / 进日志），要么干脆放弃配置。
 *   沿用已存密钥没有引入新的信任边界：那把密钥本来就在这个库里，
 *   脚本能读它、也就能覆盖它。
 * ★ 但**必须显式**：输出里逐通道写清「本次新写入」还是「沿用库中已存」，
 *   否则「我明明换了 Key 怎么还是旧的」会变成排查噩梦。
 * ★ 全部通道都解析不到（既没环境变量、库里也没有）⇒ 直接失败，不写任何东西。
 */
async function resolveKeys(
  prisma: PrismaClient,
  envKeys: Map<string, string>,
): Promise<{ resolved: Map<string, ResolvedKey>; skipped: string[] }> {
  const resolved = new Map<string, ResolvedKey>()
  const skipped: string[] = []
  const missing: string[] = []

  for (const c of CHANNELS) {
    const fresh = envKeys.get(c.code)
    if (fresh) {
      resolved.set(c.code, { channel: c, fresh, masked: maskSecret(fresh), reuseProviderId: null })
      continue
    }
    const existing = await prisma.aiProvider.findUnique({ where: { code: c.code } })
    if (existing?.apiKeyEncrypted) {
      resolved.set(c.code, {
        channel: c,
        fresh: null,
        masked: existing.apiKeyMasked,
        reuseProviderId: existing.id,
      })
      continue
    }
    if (c.optional) skipped.push(c.code)
    else missing.push(c.envVar)
  }

  if (missing.length) {
    throw new Error(
      `缺少环境变量：${missing.join(', ')}（库里也没有可沿用的历史密钥）\n` +
        `用法：${CHANNELS.filter((c) => !c.optional)
          .map((c) => `${c.envVar}=sk-xxx`)
          .join(' ')} npx tsx scripts/setup-ai-channels.ts`,
    )
  }
  return { resolved, skipped }
}

async function main() {
  const prisma = new PrismaClient()
  const { resolved, skipped: skippedChannels } = await resolveKeys(prisma, readEnvKeys())

  try {
    console.log(`\n[1/6] 配置供应商（baseUrl = ${BASE_URL}）`)
    if (skippedChannels.length) {
      console.log(
        `  ⚠ 跳过可选通道：${skippedChannels.join(', ')}（未提供环境变量，库里也没有历史密钥）。\n` +
          `    出图场景 publish_cover 会保持现状不改 —— 要开通就补 TB_IMAGE_KEY 后重跑。`,
      )
    }
    const providerIds: bigint[] = []
    /** channelCode → 该通道第一个模型 id（用作场景主/备模型） */
    const primaryModelOf = new Map<string, bigint>()

    for (const c of CHANNELS) {
      const rk = resolved.get(c.code)
      if (!rk) continue // 可选通道且既没给 Key 也没历史密钥：整条跳过
      const payload = {
        name: c.name,
        providerType: 'LLM',
        protocol: 'OPENAI_COMPATIBLE',
        baseUrl: BASE_URL,
        // 沿用历史密钥时**根本不带这两个字段**（写了就会用 undefined 覆盖掉真密钥）
        ...(rk.fresh ? { apiKeyEncrypted: encryptSecret(rk.fresh), apiKeyMasked: rk.masked } : {}),
        enabled: true,
        priority: c.priority,
        healthStatus: 'HEALTHY',
        circuitOpenUntil: null,
        lastTestError: null,
      }

      const existing = await prisma.aiProvider.findUnique({ where: { code: c.code } })
      const provider = existing
        ? await prisma.aiProvider.update({ where: { id: existing.id }, data: payload })
        : await prisma.aiProvider.create({
            data: {
              code: c.code,
              ...payload,
              // 新建时必须有密钥，否则这一行是个永远 401 的空壳
              apiKeyEncrypted: encryptSecret(rk.fresh!),
              apiKeyMasked: rk.masked!,
            },
          })
      providerIds.push(provider.id)
      console.log(
        `  ${existing ? '更新' : '新建'}  ${c.code.padEnd(20)} key=${provider.apiKeyMasked}  ` +
          `priority=${c.priority}  ${rk.fresh ? '★ 本次写入新 Key' : '（沿用库中已存密钥）'}`,
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
          // ★ 能力取自通道规格，不再硬编码 'TEXT' —— 出图模型必须是 'IMAGE'，
          //   否则网关的能力闸门会把它当成「文本模型」而拒绝在图像场景里使用它。
          capability: c.capability,
          enabled: true,
          inputPricePerMtok: price.inputFen,
          outputPricePerMtok: price.outputFen,
        }
        const model = dup
          ? await prisma.aiModel.update({ where: { id: dup.id }, data: modelData })
          : await prisma.aiModel.create({ data: modelData })
        if (!primaryModelOf.has(c.code)) primaryModelOf.set(c.code, model.id)
        console.log(`        模型 ${dup ? '更新' : '新建'}  ${m.modelCode}  (id=${model.id})`)
        if (c.capability === 'IMAGE') {
          // ★ 出图没有 token 用量，ai_model 的两列「分/百万 token」对它没有意义，
          //   所以这里**故意留 0**，而把价写在 ai_scene.bean_price（固定价）。
          //   打印时不说清楚，运维会以为「单价 0 ⇒ 扣 0 积分 ⇒ 白送」——
          //   实际恰恰相反：固定价走的是另一条路。
          console.log(
            `          能力=IMAGE，token 单价不适用（留 0）` +
              `；**价在 ai_scene.bean_price**（固定价，见 prompts.ts 的 PUBLISH_SCENES）`,
          )
        } else {
          console.log(
            `          单价 in=${price.inputFen} out=${price.outputFen} 分/百万token` +
              `（$${price.inUsdPerMtok}/$${price.outUsdPerMtok} per Mtok × ${USD_TO_CNY}）` +
              (SET_PRICES ? '' : '  ⚠ 未应用（当前按 0 计，见 TB_SET_PRICES）'),
          )
        }
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

    console.log('\n[2/6] 重建场景备用链')
    const primary = primaryModelOf.get('tokenbox-gpt')!
    const claudeModelId = primaryModelOf.get('tokenbox-claude')!
    const deepseekModelId = primaryModelOf.get('tokenbox-deepseek')!
    const fallbacks = [claudeModelId, deepseekModelId]
    /** 通道 code → 模型 id，供场景级覆盖按名字指定备用顺序 */
    const modelOfChannel = primaryModelOf

    const scenes = await prisma.aiScene.findMany({ orderBy: { id: 'asc' } })
    let chainSkipped = 0
    for (const s of scenes) {
      const ov = SCENE_OVERRIDES[s.code]
      /**
       * ★ 可选通道（出图）本次没配时，引用它的场景**整条跳过**、保持库里原值。
       *
       * 为什么不是「退回默认主候选」：那会把 publish_cover 挂到 GPT/Claude 上，
       * 而图像场景配文本模型是**每次请求都失败**的配置（能力闸门跳过全部候选）。
       * 也比抛错退出好：出图是可加能力，没配它不该让文本链的配置也做不成。
       * ★ 并且这里**显式打印**：让「出图没开通」在输出里直接可见，
       *   而不是让人从「候选链没变」这种看不出来的证据去反推。
       */
      if (ov?.primary && !modelOfChannel.has(ov.primary)) {
        console.log(`  ⏭ ${s.code}：候选通道 ${ov.primary} 本次未配置，保持库里原值`)
        chainSkipped++
        continue
      }
      /** 覆盖主候选：按通道 code 查模型；查不到就炸，绝不悄悄退回默认主候选 */
      const scenePrimary = ov?.primary
        ? (() => {
            const id = modelOfChannel.get(ov.primary!)
            if (!id) throw new Error(`场景 ${s.code} 的主候选通道 ${ov.primary} 没有对应模型`)
            return id
          })()
        : primary
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
          defaultModelId: scenePrimary,
          // 存数字而非 BigInt：Prisma 的 Json 字段无法序列化 BigInt
          fallbackModelIds: chain.map((v) => Number(v)),
          ...(ov?.timeoutMs ? { timeoutMs: ov.timeoutMs } : {}),
          ...(ov?.maxRetries !== undefined ? { maxRetries: ov.maxRetries } : {}),
          ...(ov?.maxOutputTokens !== undefined ? { maxOutputTokens: ov.maxOutputTokens } : {}),
        },
      })
    }
    if (chainSkipped > 0) {
      console.log(`  ⚠ 有 ${chainSkipped} 个场景按上表跳过 —— 它们对应的能力本次不可用（补 Key 后重跑即可）`)
    }
    console.log(`  ${scenes.length} 个场景 → 主 ${primary}，默认备用 [${fallbacks.join(', ')}]`)
    for (const s of scenes) {
      const ov = SCENE_OVERRIDES[s.code]
      console.log(
        `    ${s.code}` +
          (ov
            ? `  ★ 覆盖：主=${ov.primary ?? '默认'} 备用顺序=${ov.fallbacks?.join(' → ') ?? '默认'}` +
              `${ov.timeoutMs ? ` timeout=${ov.timeoutMs}ms` : ''}` +
              `${ov.maxRetries !== undefined ? ` retries=${ov.maxRetries}` : ''}` +
              `${ov.maxOutputTokens !== undefined ? ` maxOut=${ov.maxOutputTokens}` : ''}`
            : ''),
      )
    }

    console.log(`\n[3/6] 抬高场景输出预算（下限 ${MIN_OUTPUT_TOKENS} token，只抬不降）`)
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
      // ★ 已被 SCENE_OVERRIDES 显式指定预算的场景必须跳过。
      //   下面用的是 [2/6] 之前读到的 `scenes` 快照，`cur` 是**过期值**：
      //   大输出场景（storyboard_generate）刚被覆盖成 12000，这里读到的却还是旧值，
      //   一旦旧值 < 下限就会把它**写回下限**（本步号称「只抬不降」，靠快照是做不到的）。
      const pinned = SCENE_OVERRIDES[s.code]?.maxOutputTokens
      if (pinned !== undefined) {
        console.log(`  ${s.code.padEnd(22)}  ★ 按场景覆盖固定为 ${pinned}（本步跳过）`)
        continue
      }
      const cur = s.maxOutputTokens ?? 0
      if (cur >= MIN_OUTPUT_TOKENS) continue
      await prisma.aiScene.update({ where: { id: s.id }, data: { maxOutputTokens: MIN_OUTPUT_TOKENS } })
      raised++
      console.log(`  ${s.code.padEnd(22)} ${String(cur).padStart(5)} → ${MIN_OUTPUT_TOKENS}`)
    }
    if (raised === 0) console.log('  （全部已在下限之上，无需调整）')

    console.log(`\n[4/6] 商业参数（场景单次上限 + 注册赠积分）${SET_CAPS ? '' : ' —— 上限仅对照，未应用'}`)
    // 上限是硬截断线，决定用户实付多少积分。默认只打印对照，不改。
    let capChanged = 0
    console.log(`  ${'场景'.padEnd(22)}${'现上限'.padEnd(9)}建议   说明`)
    for (const s of scenes) {
      const want = SCENE_CAPS[s.code]
      const cur = Number(s.beanPrice)
      const note =
        want === undefined
          ? '（未给出建议值，保持原样）'
          : want === cur
            ? '已一致'
            : want > cur
              ? `低于实测应扣 ⇒ 现在会被截断`
              : `高于实测应扣（收紧）`
      console.log(`  ${s.code.padEnd(22)}${String(cur).padEnd(9)}${String(want ?? '-').padEnd(8)}${note}`)
      if (SET_CAPS && want !== undefined && want !== cur) {
        await prisma.aiScene.update({ where: { id: s.id }, data: { beanPrice: BigInt(want) } })
        capChanged++
      }
    }
    if (SET_CAPS) {
      console.log(`  ⇒ 已更新 ${capChanged} 个场景的上限`)
    } else {
      console.log(
        '  ⚠ 未应用（未设 TB_SET_CAPS=1）。上限现在会截断几乎所有场景的真实成本，\n' +
          '    于是实际扣费是「封顶值」而不是「成本 × 系数」。确认后 TB_SET_CAPS=1 重跑。',
      )
    }

    // 上限 = 预冻结额 ⇒ 抬上限会连带抬高「可用积分不足」的门槛。新用户只有注册赠积分，
    // 若赠积分 < 最贵场景的上限，他一个 AI 功能都用不了（冻结阶段就被拦，不是扣费问题）。
    // 赠积分 = 0 是**合法的当前策略**（必须先买会员），不是故障，所以要分开说。
    const grantRow = await prisma.systemSetting.findUnique({
      where: { groupKey_settingKey: { groupKey: 'bean', settingKey: 'register_grant_points' } },
    })
    let grantNow = Number(grantRow?.settingVal ?? 0)
    const maxCap = Math.max(...scenes.map((s) => Number(s.beanPrice)))
    if (REGISTER_GRANT !== null && REGISTER_GRANT !== grantNow) {
      await prisma.systemSetting.update({
        where: { groupKey_settingKey: { groupKey: 'bean', settingKey: 'register_grant_points' } },
        data: { settingVal: String(REGISTER_GRANT) },
      })
      console.log(`\n  注册赠积分 ${grantNow} → ${REGISTER_GRANT} 积分（已写库）`)
      grantNow = REGISTER_GRANT
    } else {
      console.log(`\n  注册赠积分 = ${grantNow} 积分${REGISTER_GRANT === null ? '（未指定，保持不变）' : '（已一致）'}`)
    }
    const affordable = scenes.filter((s) => Number(s.beanPrice) <= grantNow).length
    console.log(`  最贵场景上限 = ${maxCap} 积分 ⇒ 新用户可用的场景 ${affordable}/${scenes.length}`)
    if (grantNow === 0) {
      console.log('  ℹ 注册赠积分 = 0 ⇒ 当前策略「注册后必须购买会员才能用 AI」。')
      console.log('    闸门是 requireSubscription（文案/分镜/合成 → 403+2005），赠积分只是第二道门。')
      console.log('    支付未开放期间：后台「商家详情 → 会员 → 手动开通会员」发放。')
    } else if (affordable < scenes.length) {
      const need = scenes.length - affordable
      console.log(
        `  ⚠ ${need}/${scenes.length} 个场景的上限 > 注册赠积分 ⇒ 新用户注册后冻结就过不去（不是扣费问题）。\n` +
          `    要改的话：TB_REGISTER_GRANT=<积分数> 重跑本脚本（不会影响老用户已得赠积分）。\n` +
          `    要彻底关掉注册赠积分（必须先买会员）：TB_REGISTER_GRANT=0。`,
      )
    }

    console.log('\n[5/6] 停用历史供应商（保留数据，不删除）')
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

    console.log('\n[6/6] 清理熔断状态 + 打印当前生效配置')
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
          '\n  于是 ai_call_log.cost_fen = 0、商户实际扣 0 积分 —— 等于平台全额补贴。' +
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
