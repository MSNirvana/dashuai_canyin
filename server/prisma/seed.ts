// 种子数据：AI 通道 / 场景 + 加油包 + 订阅套餐 + 演示商家
// 运行：npm run db:seed  （依赖已注入的 DATABASE_URL / APP_MASTER_KEY）
// 计费规则见 docs/05 v5：订阅 ¥980/30天/赠98000积分（后台可改）；加油包 100/200/300 → 1万/2万/3万积分（仅订阅可买）
// AI 计费 = 实际成本 × 系数（bean.cost_multiplier，默认 4），场景 beanPrice 为单次冻结上限
import { createCipheriv, randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/lib/password.js'
import {
  COPY_PROMPT, COPY_FALLBACK,
  COPY_TRAFFIC_PROMPT, COPY_TRAFFIC_FALLBACK,
  COPY_INTRO_PROMPT, COPY_INTRO_FALLBACK,
  COPY_QUALITY_PROMPT, COPY_QUALITY_FALLBACK,
  COPY_RECOMMEND_PROMPT, COPY_RECOMMEND_FALLBACK,
  STORY_PROMPT, STORY_FALLBACK,
  PUBLISH_SCENES,
} from './prompts.js'

const prisma = new PrismaClient()

// ---- 主密钥：本地未配置时回退到固定 dev 密钥（仅本地联调，生产必须改） ----
const DEV_MASTER_KEY =
  '2b3a7c9e1f4d8a6b0c5e2d9f1a7b3c4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c'
const MASTER_KEY = process.env.APP_MASTER_KEY ?? DEV_MASTER_KEY
if (!process.env.APP_MASTER_KEY) {
  console.warn('[seed] APP_MASTER_KEY 未配置，使用内置 dev 密钥（生产请通过 .env 指定 64 位 hex）')
}
// 让运行时（lib/secret 的 decryptSecret）使用同一把密钥
process.env.APP_MASTER_KEY = MASTER_KEY

function encryptSecret(plain: string): Buffer {
  const key = Buffer.from(MASTER_KEY, 'hex')
  if (key.length !== 32) {
    throw new Error(
      `APP_MASTER_KEY 必须是 64 位 hex（当前解析出 ${key.length} 字节，` +
        `原串长度 ${MASTER_KEY.length}）。请用 openssl rand -hex 32 生成后同步 .env 与本文件回退值。`,
    )
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc])
}

// ================= 加油包（仅订阅用户可买，1元=100积分，无额外赠送） =================
// 见 docs/05 v5：100/200/300 元 → 1万/2万/3万 积分；memberPriceFen 已无 8 折含义，同价填充
const beanPackages = [
  { name: '100元 · 10000积分', beans: 10000n, bonusBeans: 0n, priceFen: 10000, tag: '基础包' },
  { name: '200元 · 20000积分', beans: 20000n, bonusBeans: 0n, priceFen: 20000, tag: '标准包' },
  { name: '300元 · 30000积分', beans: 30000n, bonusBeans: 0n, priceFen: 30000, tag: '进阶包' },
]

// ================= 订阅（v5 唯一套餐，替代 v4 的月/季/年卡） =================
// ¥980 / 30 天 / 赠 98000 积分 / 上传空间 5GB；全部后台可改
const memberPlans = [
  {
    name: '订阅 · 30天',
    code: 'SUBSCRIPTION',
    durationDays: 30,
    priceFen: 98000,
    grantBeans: 98000n,
    tag: '含98000积分',
    rights: { uploadQuotaBytes: 5 * 1024 * 1024 * 1024, pointsPerYuan: 100 },
  },
]

// v4 遗留套餐（会员月/季/年卡）：v5 已废除，软下线避免外键报错
const LEGACY_PLAN_CODES = ['MONTH', 'SEASON', 'YEAR']
// v4 遗留充值档位（10/30/68/198/398 元）：v5 由加油包替代，软下线
const LEGACY_PACKAGE_NAMES = [
  '10元 · 1000积分',
  '30元 · 3200积分',
  '68元 · 7600积分',
  '198元 · 22800积分',
  '398元 · 51800积分',
]

// ================= AI 通道 / 模型 / 场景 =================
// ★ MOCK / 本地联调通道已于 2026-09-21 移除（理由见下面 seedAi() 第一段注释）——
//   现在唯一合法的 AI 通道是**真实通道**（每场景必须指向 enabled=true 的真实供应商）。
// deepseek  ：历史真实通道，本文件按 disabled 建出来做占位；填入 DEEPSEEK_API_KEY 并 enabled=true 才可用。
//             ★ 当前生产实际走的是 `scripts/setup-ai-channels.ts` 配的三通道（tokenbox 系）。
// 文案四款 + 分镜的提示词模板已抽到 ./prompts.ts（唯一源，含变量契约说明）：
// 改完模板后用 npm run ai-prompts:sync 同步进库（只更新模板字段，不动价格/模型等运营配置）。

// ================= 合成增强 Skill（AI 生成档的后续能力，场景已就位、调用方待接入） =================
// 说明：这 5 个场景先在后台可见可配，worker 侧逐步接入（见 docs/09-AI-Skill清单.md）。
// 未接入前不会被业务调用，也不会产生费用。

const SCRIPT_POLISH_PROMPT = `你是餐饮短视频口播稿润色专家。请把下面的营销文案改写成【可以直接对着镜头念】的口播稿。
【门店】{{storeName}}｜品类：{{category}}｜城市：{{city}}
【菜品】{{dishName}}｜卖点：{{sellingPoints}}
【原始文案】
{{copyText}}

改写要求：
1. 保留原始文案的核心卖点与情绪，不要新增未提供的信息
2. 拆成短句，每句 8~20 字，方便断句与换气
3. 去掉书面语与生僻词，改成日常说话的语气
4. 数字、地名、菜名口语化（「人均消费」→「人均」这类）
5. 总字数控制在 120 字以内（按每秒约 4~5 字估算时长）
6. 只输出改写后的口播稿正文，不要标题、不要分点、不要任何解释`

const REVIEW_GUARD_PROMPT = `你是短视频内容安全审校员。请检查下面的餐饮短视频文案是否存在违规风险。
【待审文案】
{{copyText}}

检查维度：
1. 极限词与绝对化用语（「最好吃」「第一」「绝对」「独家」）
2. 虚假宣传与医疗功效暗示（「治病」「养生特效」「药膳」）
3. 平台违禁词（涉政、涉黄、涉赌、涉毒、封建迷信）
4. 诱导性表述（「不转不是中国人」「点进来必发财」）
5. 价格与承诺类违规（「全网最低价」「永久免费」）

输出要求：只输出 JSON 对象，不要 Markdown 代码块、不要任何解释：
{"pass": true, "hits": ["命中的违规词"], "reason": "风险原因简述", "suggestion": "改写建议（pass 为 true 时留空）"}`

const TITLE_OVERLAY_PROMPT = `你是餐饮短视频封面文案专家。请为下面的短视频生成封面标题与贴片文案。
【门店】{{storeName}}｜品类：{{category}}｜城市：{{city}}
【菜品】{{dishName}}｜卖点：{{sellingPoints}}
【口播文案】{{copyText}}

生成要求：
1. title：封面主标题，6~12 字，要有钩子、能引发好奇或食欲，可用数字与反差
2. subtitle：副标题，10~18 字，补充到店理由或价格信息
3. badge：角标短句，4~6 字（如「现做现卖」「当天现杀」「同城可送」）
4. 三个字段都口语化、不浮夸，避免绝对化用语
5. 只输出 JSON 对象，不要 Markdown 代码块、不要任何解释：
{"title": "", "subtitle": "", "badge": ""}`

const BGM_SELECT_PROMPT = `你是短视频配乐师。请为下面的餐饮短视频挑选合适的 BGM 风格。
【门店】{{storeName}}｜品类：{{category}}
【菜品】{{dishName}}
【口播文案】{{copyText}}

挑选要求：
1. mood：整体情绪，从 热闹/温馨/治愈/烟火气/高级感/轻快 中选一个
2. tags：3~5 个曲风标签（如 民谣吉他、轻电子、国风、爵士、钢琴）
3. tempo：建议节奏，从 慢/中/快 中选一个
4. reason：一句话说明为什么这样选
5. 只输出 JSON 对象，不要 Markdown 代码块、不要任何解释：
{"mood": "", "tags": [], "tempo": "", "reason": ""}`

const RHYTHM_DETECT_PROMPT = `你是短视频剪辑节奏指导。请为下面的分镜脚本给出卡点建议。
【门店】{{storeName}}｜菜品：{{dishName}}
【分镜数量要求】{{shotCountRule}}
【口播文案】{{copyText}}

输出要求：
1. shots：按分镜顺序给出每个镜头的建议停留时长（整数秒），总和要与口播文案时长匹配
2. beatPoints：建议卡点位置（相对成片起点的秒数，保留 1 位小数），用于踩 BGM 重音
3. reason：一句话说明节奏设计思路
4. 只输出 JSON 对象，不要 Markdown 代码块、不要任何解释：
{"shots": [{"seq": 1, "durationSec": 3}], "beatPoints": [1.2, 4.5], "reason": ""}`

const SCRIPT_POLISH_FALLBACK = `{{copyText}}`
const REVIEW_GUARD_FALLBACK = `{"pass":true,"hits":[],"reason":"","suggestion":""}`
const TITLE_OVERLAY_FALLBACK = `{"title":"{{dishName}}","subtitle":"{{storeName}}·{{sellingPoints}}","badge":"现做现卖"}`
const BGM_SELECT_FALLBACK = `{"mood":"烟火气","tags":["轻快","民谣吉他"],"tempo":"中","reason":"餐饮日常场景通用配乐"}`
const RHYTHM_DETECT_FALLBACK = `{"shots":[],"beatPoints":[],"reason":"按分镜建议时长自然衔接"}`

async function seedAi() {
  // v5：AI 计费 = 实际成本 × 系数（bean.cost_multiplier，默认 4）。
  // 场景上的 beanPrice 不再是「标价」，而是**单次冻结上限**（财务安全网）：
  // 实际扣费按成本计算且不超过该上限，超出部分由平台承担。后台可调。

  // 1) 本地联调 MOCK 通道 —— ★ 2026-09-21 已整块移除，**不要再加回来**。
  //
  //    移除理由（三条都真实发生过）：
  //    a) 它的适配器**不发网络请求、直接返回可解析的样例文案/分镜 JSON** ⇒ 一旦真实通道
  //       全部不可用，网关会「成功」拿到一段看起来正常、实际是占位样例的文案交给商户。
  //    b) 本文件把 `mockChat.id` 写进**每个场景**的 `fallbackModelIds` ⇒ 上一行那个后果
  //       会发生在**所有 11 个场景**上，而不只是联调时。
  //    c) 这里用的是 upsert 且 update 里强制 `enabled: true` ⇒ 任何人在**生产库**跑一次
  //       `npm run db:seed`，都会把线下配好的真实通道链覆盖掉、并把 MOCK 重新点亮。
  //
  //    要联调就配一个真实通道（`scripts/setup-ai-channels.ts`，Key 走环境变量），
  //    没有 Key 的环境**允许 AI 直接失败**（落兜底模板、不扣积分），这比返回假文案正确。


  // 2) DeepSeek 真实通道（默认禁用；配置密钥后启用）
  const dsKey = process.env.DEEPSEEK_API_KEY ?? 'sk-demo-placeholder'
  const dsProvider = await prisma.aiProvider.upsert({
    where: { code: 'deepseek' },
    create: {
      code: 'deepseek',
      name: 'DeepSeek',
      providerType: 'LLM',
      protocol: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEncrypted: encryptSecret(dsKey),
      apiKeyMasked: dsKey.length <= 8 ? '****' : `${dsKey.slice(0, 3)}****${dsKey.slice(-4)}`,
      enabled: false,
      priority: 90,
      healthStatus: 'HEALTHY',
    },
    update: { baseUrl: 'https://api.deepseek.com', apiKeyEncrypted: encryptSecret(dsKey), apiKeyMasked: dsKey.length <= 8 ? '****' : `${dsKey.slice(0, 3)}****${dsKey.slice(-4)}`, enabled: false },
  })
  const dsChat = await prisma.aiModel.upsert({
    where: { providerId_modelCode: { providerId: dsProvider.id, modelCode: 'deepseek-chat' } },
    create: { providerId: dsProvider.id, modelCode: 'deepseek-chat', displayName: 'DeepSeek-V3', capability: 'TEXT', maxContextTokens: 64000, maxOutputTokens: 4000, inputPricePerMtok: 1, outputPricePerMtok: 2, enabled: true },
    update: { enabled: true },
  })
  const dsReasoner = await prisma.aiModel.upsert({
    where: { providerId_modelCode: { providerId: dsProvider.id, modelCode: 'deepseek-reasoner' } },
    create: { providerId: dsProvider.id, modelCode: 'deepseek-reasoner', displayName: 'DeepSeek-R1', capability: 'TEXT', maxContextTokens: 64000, maxOutputTokens: 8000, inputPricePerMtok: 4, outputPricePerMtok: 16, enabled: true },
    update: { enabled: true },
  })

  // 3) 场景：文案（通用 + 四款）/ 分镜 / 合成增强
  //
  //    模型绑定策略：只绑定「当前已启用的真实模型」（真实通道由 `ai-channels:setup` 配好）。
  //    ★ 2026-09-21 起**没有 MOCK 兜底**：一个真实模型都找不到时**直接中止**，
  //      绝不悄悄绑到占位模型上 —— 「找不到模型」是配置问题，应该在 seed 这一步就炸出来，
  //      而不是让商户在生成时收到一段样例文案。
  //    ⚠ defaultModelId 必须指向 enabled=true 的 provider：指向已停用通道时，
  //      网关候选链会 ALL_FAILED 落兜底模板（前端提示「AI 繁忙」）。
  //
  //    ★ 2026-09-21 加 `capability: 'TEXT'`（原本只按 protocol 过滤）：
  //      出图模型（capability='IMAGE'）现在也在 ai_model 里，而它**恰好是 id 最小的那个**
  //      （新通道后建、但 id 由自增决定，顺序不可依赖）。一旦它被排到 realModels[0]，
  //      下面所有**文本**场景的主候选都会变成出图模型 —— 网关的能力闸门会把它们全部跳过，
  //      表现是「所有 AI 功能集体失败，原因却是『候选是图像模型』」。
  //      按能力过滤后，文本场景与图像场景各取所需，互不污染。
  const realModels = await prisma.aiModel.findMany({
    where: { enabled: true, capability: 'TEXT', provider: { enabled: true, protocol: { not: 'MOCK' } } },
    orderBy: { id: 'asc' },
  })
  if (realModels.length === 0) {
    throw new Error(
      '[seed] 找不到任何「已启用的真实模型」⇒ 拒绝为 AI 场景绑定模型（已移除 MOCK 兜底）。\n' +
        '        正解：先配真实通道 —— cd server && npx tsx scripts/setup-ai-channels.ts（Key 走 TB_*_KEY 环境变量）。\n' +
        '        ★ 不要引入 MOCK / 占位模型来「让链路先跑起来」：它返回的是样例文案，会被当成真结果扣费交付。',
    )
  }
  const defaultModelId = realModels[0]!.id
  const fallbackModelIds = realModels.slice(1).map((m) => Number(m.id))
  console.log(
    `[seed] AI 场景候选链 = ${realModels.map((m) => m.modelCode).join(' → ')}（无 MOCK 兜底）`,
  )

  // 文案四款与小程序端「流量款 / 介绍款 / 质量款 / 种草型」一一对应，提示词均可在后台「AI 场景」页修改
  const copyScenes = [
    { code: 'copy_generate', name: '短视频文案生成（通用·兼容旧客户端）', prompt: COPY_PROMPT, fallback: COPY_FALLBACK, temperature: 0.8 },
    { code: 'copy_traffic', name: '文案 · 流量款（同城引流/话题热度）', prompt: COPY_TRAFFIC_PROMPT, fallback: COPY_TRAFFIC_FALLBACK, temperature: 0.9 },
    { code: 'copy_intro', name: '文案 · 介绍款（菜品讲解/套餐推广）', prompt: COPY_INTRO_PROMPT, fallback: COPY_INTRO_FALLBACK, temperature: 0.8 },
    { code: 'copy_quality', name: '文案 · 质量款（食材品质/匠心人设）', prompt: COPY_QUALITY_PROMPT, fallback: COPY_QUALITY_FALLBACK, temperature: 0.75 },
    { code: 'copy_recommend', name: '文案 · 种草型（真实体验/消费决策）', prompt: COPY_RECOMMEND_PROMPT, fallback: COPY_RECOMMEND_FALLBACK, temperature: 0.85 },
  ]
  for (const s of copyScenes) {
    const data = {
      name: s.name,
      promptTemplate: s.prompt,
      fallbackTemplate: s.fallback,
      defaultModelId,
      fallbackModelIds,
      beanPrice: 5n,
      timeoutMs: 30000,
      maxRetries: 1,
      temperature: s.temperature,
      maxOutputTokens: 800,
      enabled: true,
    }
    await prisma.aiScene.upsert({ where: { code: s.code }, create: { code: s.code, ...data }, update: data })
  }

  const storyData = {
    name: '分镜脚本生成（按复杂度 2~9 镜 + 镜头库匹配）',
    promptTemplate: STORY_PROMPT,
    fallbackTemplate: STORY_FALLBACK,
    defaultModelId,
    fallbackModelIds,
    beanPrice: 10n,
    timeoutMs: 40000,
    maxRetries: 1,
    temperature: 0.7,
    maxOutputTokens: 2500,
    enabled: true,
  }
  await prisma.aiScene.upsert({
    where: { code: 'storyboard_generate' },
    create: { code: 'storyboard_generate', ...storyData },
    update: storyData,
  })

  // 合成增强 Skill：场景已就位（后台可编辑提示词），worker 侧按 docs/09 顺序逐步接入调用
  const synthScenes = [
    { code: 'script_polish', name: '口播润色 · 合成增强（待接入）', prompt: SCRIPT_POLISH_PROMPT, fallback: SCRIPT_POLISH_FALLBACK, temperature: 0.6, maxOutputTokens: 600, beanPrice: 5n },
    { code: 'review_guard', name: '内容安全审校 · 合成增强（待接入）', prompt: REVIEW_GUARD_PROMPT, fallback: REVIEW_GUARD_FALLBACK, temperature: 0.2, maxOutputTokens: 400, beanPrice: 3n },
    { code: 'title_overlay', name: '封面标题贴片 · 合成增强（待接入）', prompt: TITLE_OVERLAY_PROMPT, fallback: TITLE_OVERLAY_FALLBACK, temperature: 0.85, maxOutputTokens: 300, beanPrice: 5n },
    { code: 'bgm_select', name: 'BGM 智能选择 · 合成增强（待接入）', prompt: BGM_SELECT_PROMPT, fallback: BGM_SELECT_FALLBACK, temperature: 0.7, maxOutputTokens: 300, beanPrice: 3n },
    { code: 'rhythm_detect', name: '节奏点检测 · 合成增强（待接入）', prompt: RHYTHM_DETECT_PROMPT, fallback: RHYTHM_DETECT_FALLBACK, temperature: 0.4, maxOutputTokens: 500, beanPrice: 3n },
  ]
  for (const s of synthScenes) {
    const data = {
      name: s.name,
      promptTemplate: s.prompt,
      fallbackTemplate: s.fallback,
      defaultModelId,
      fallbackModelIds,
      beanPrice: s.beanPrice,
      timeoutMs: 30000,
      maxRetries: 1,
      temperature: s.temperature,
      maxOutputTokens: s.maxOutputTokens,
      enabled: true,
    }
    await prisma.aiScene.upsert({ where: { code: s.code }, create: { code: s.code, ...data }, update: data })
  }

  // 4) 发布素材（文本 + 出图）
  //
  //    ★ 这两个场景的定义（模板 / fallback / kind / beanPrice / timeout）**全部来自
  //      prompts.ts 的 PUBLISH_SCENES**，seed 里不再抄一份 —— 与上面 synthScenes 的写法
  //      不同是刻意的：上面那批的提示词在 seed 和 prompts.ts 里各有一份，已经是个隐患。
  //    ★ kind 必须落库：它决定网关走 chat/completions 还是 images/generations。
  const imageModels = await prisma.aiModel.findMany({
    where: { enabled: true, capability: 'IMAGE', provider: { enabled: true, protocol: { not: 'MOCK' } } },
    orderBy: { id: 'asc' },
  })
  for (const s of PUBLISH_SCENES) {
    const isImage = s.kind === 'IMAGE'
    // 图像场景只在有出图模型时才挂它；没有就退回文本模型并**明确告警**（见下）。
    const model = isImage ? (imageModels[0] ?? realModels[0]!) : realModels[0]!
    const data = {
      name: s.name,
      kind: s.kind,
      promptTemplate: s.prompt,
      fallbackTemplate: s.fallback,
      defaultModelId: model.id,
      // 图像场景不给备用候选：文本模型在这条链上只会在能力闸门被跳过
      fallbackModelIds: isImage ? [] : fallbackModelIds,
      beanPrice: BigInt(s.beanPrice),
      timeoutMs: s.timeoutMs,
      maxRetries: s.maxRetries,
      temperature: s.temperature,
      maxOutputTokens: s.maxOutputTokens,
      enabled: true,
    }
    await prisma.aiScene.upsert({ where: { code: s.code }, create: { code: s.code, ...data }, update: data })
    if (isImage && !imageModels[0]) {
      console.log(
        `[seed] ⚠ ${s.code}（出图场景）暂时挂在文本模型 ${model.modelCode} 上 —— ` +
          `它现在**用不了**（网关会以「候选是文本模型，图像场景需要 IMAGE」拒绝）。\n` +
          `        要开通：TB_IMAGE_KEY=sk-xxx npx tsx scripts/setup-ai-channels.ts`,
      )
    }
  }

  console.log(
    `[seed] ai providers: 2, models: 4, scenes: ${copyScenes.length + 1 + synthScenes.length + PUBLISH_SCENES.length}`,
  )
}

// ================= 演示商家（开发登录用） =================
async function seedDemoMerchant() {
  const phone = '13800000000'
  const openid = `dev_openid_${phone}`
  const merchant = await prisma.merchant.upsert({
    where: { phone },
    create: { phone, wechatOpenid: openid, nickname: '演示商家', status: 'ACTIVE', registerGrantGranted: true },
    update: { wechatOpenid: openid, nickname: '演示商家', registerGrantGranted: true },
  })

  // 默认门店
  const store = await prisma.store.findFirst({ where: { merchantId: merchant.id, isDefault: true, deletedAt: null } })
  if (!store) {
    await prisma.store.create({
      data: { merchantId: merchant.id, name: '大帅火锅（旗舰店）', category: '火锅', city: '廊坊', district: '广阳区', address: '示例路 1 号', isDefault: true },
    })
  }

  // 初始积分（v5 称积分；演示账号预置 98000，足够跑完整个创作闭环）
  await prisma.beanAccount.upsert({
    where: { merchantId: merchant.id },
    create: { merchantId: merchant.id, balance: 98000n, grantBalance: 0n, frozen: 0n },
    update: { balance: 98000n },
  })

  // v5：订阅是使用文案/分镜/合成的硬前提，演示商家必须带一个有效订阅，否则本地联调走不通
  const plan = await prisma.memberPackage.findUnique({ where: { code: 'SUBSCRIPTION' } })
  if (plan) {
    const active = await prisma.membership.findFirst({
      where: { merchantId: merchant.id, status: 'ACTIVE', endAt: { gt: new Date() } },
      orderBy: { endAt: 'desc' },
    })
    if (!active) {
      const startAt = new Date()
      const endAt = new Date(startAt.getTime() + plan.durationDays * 86_400_000)
      await prisma.membership.create({
        data: {
          merchantId: merchant.id,
          packageId: plan.id,
          startAt,
          endAt,
          grantBeans: plan.grantBeans,
          status: 'ACTIVE',
        },
      })
    }
  }
  console.log(`[seed] demo merchant: ${phone} (openid ${openid}), 积分 98000, 订阅 30 天`)
}

// ================= TTS 供应商（腾讯云 / 火山，默认禁用，API Key 走后台配置） =================
async function seedTtsProviders() {
  const providers = [
    { code: 'tencent', name: '腾讯云 TTS', priority: 100 },
    { code: 'volcano', name: '火山引擎 TTS', priority: 90 },
  ]
  for (const p of providers) {
    // 只建记录，不预置密钥：API Key 由后台「AI 配音 → 供应商配置」录入并加密落库
    await prisma.ttsProvider.upsert({
      where: { code: p.code },
      create: { code: p.code, name: p.name, priority: p.priority, enabled: false },
      update: { name: p.name, priority: p.priority },
    })
  }
  console.log(`[seed] TTS 供应商: ${providers.length}（默认禁用，密钥待后台配置）`)
}

// ================= 镜头库（拍摄技巧示范，category 与 AI 分镜 shotType 对齐） =================
async function seedShotLibrary() {
  const items = [
    // 开场：3 秒内抓住人
    {
      code: 'open_storefront',
      name: '门头打卡开场',
      category: '开场',
      tips: '手机横握改竖拍，站在马路对面拍完整门头；清晨或傍晚光线最柔和。开头 1 秒把招牌菜名喊出来，比任何画面都留人。',
    },
    {
      code: 'open_hook',
      name: '悬念钩子开场',
      category: '开场',
      tips: '直接拍最馋人的一口（拉丝/冒气/爆汁），配一句「就在你家楼下」。先给结果再讲过程，完播率翻倍。',
    },
    // 特写：菜品微距
    {
      code: 'closeup_dish',
      name: '招牌菜出锅特写',
      category: '特写',
      tips: '擦净镜头，凑近到 20cm 左右，锁焦点在食物上。蒸汽升腾的瞬间连拍 3 条选最饱满的一条；侧逆光让食物更有光泽。',
    },
    {
      code: 'closeup_texture',
      name: '口感细节特写',
      category: '特写',
      tips: '拍「切开/掰开/拉丝」动作，速度放慢一半。白瓷盘+深色桌面背景，画面干净才显得高级。',
    },
    // 制作：后厨过程
    {
      code: 'make_kitchen',
      name: '后厨制作全景',
      category: '制作',
      tips: '站在厨师侧后方 45°，一镜到底拍完整动作，中途别停顿。开场 2 秒先扫一眼干净的灶台——卫生是餐饮内容的信任基础。',
    },
    {
      code: 'make_fire',
      name: '猛火翻炒瞬间',
      category: '制作',
      tips: '火焰窜起的瞬间最抓眼球，提前半秒按录制。注意别凑太近，油星溅到镜头整条就废了。',
    },
    // 试吃：表情反应
    {
      code: 'taste_reaction',
      name: '真实试吃反应',
      category: '试吃',
      tips: '别演！夹起、入口、点头三个动作连贯拍。第一口的自然反应比任何台词都可信，拍完再补拍一段竖屏表情特写备用。',
    },
    {
      code: 'taste_dipping',
      name: '蘸料蘸酱镜头',
      category: '试吃',
      tips: '夹起食物在蘸料碗里缓慢滚动一圈，酱汁挂住的瞬间最馋人。背景虚化，突出酱汁光泽。',
    },
    // 卖点：价格与优惠
    {
      code: 'selling_price',
      name: '价目牌展示',
      category: '卖点',
      tips: '价目牌擦干净，正对镜头停 2 秒。手指着「今日特价」一行划过去，观众视线跟着走，比静态展示清楚 10 倍。',
    },
    {
      code: 'selling_combo',
      name: '套餐组合展示',
      category: '卖点',
      tips: '把套餐所有菜品摆好俯拍一张，再逐个快速特写。结尾停全家福+价格字幕 2 秒，让观众截图。',
    },
    // 收尾：引导到店
    {
      code: 'ending_location',
      name: '定位引导收尾',
      category: '收尾',
      tips: '拍一张门店+街道环境，字幕打「XX 路 XX 号」。口播别念「欢迎光临」，念「明天中午 12 点，第一锅出锅」——给一个具体时间点。',
    },
    {
      code: 'ending_cta',
      name: '关注引导收尾',
      category: '收尾',
      tips: '最后一个镜头固定：老板对镜头说一句话（如「想吃扣 1」），说完再停 1 秒切黑。互动率上去了，下一条流量才稳。',
    },
    // 基础拍摄手法（分镜匹配的必备库：美食特写 / 老板口播 / 出锅 / 环境 / 原料 / 制作过程）
    {
      code: 'closeup_food',
      name: '美食特写',
      category: '特写',
      tips: '把镜头怼到 15~20cm，锁死焦点在菜品最诱人的部位（焦边、拉丝、爆汁处）。侧逆光让油光更亮，蒸汽升起时连拍 3 条挑最饱满的一条。',
    },
    {
      code: 'boss_talk',
      name: '老板口播',
      category: '口播',
      tips: '机位与眼睛齐平，人物居中，背后留出门店环境做背景。开拍前先深呼吸、看镜头说话，别念稿；一句一个动作，手可以指着菜或价目牌。',
    },
    {
      code: 'make_serve',
      name: '出锅装盘',
      category: '制作',
      tips: '从锅里盛出的瞬间最能刺激食欲：一手端盘一手舀菜，让热气正对镜头。提前想好落盘位置，动作要一次到位，别来回找角度。',
    },
    {
      code: 'scene_ambience',
      name: '门店环境',
      category: '环境',
      tips: '横移或缓推拍一张干净的门店环境（堂食区/明档/招牌），停在「有烟火气但不乱」的画面上 2 秒。结尾用它压定位字幕，观众一眼知道在哪。',
    },
    {
      code: 'make_ingredient',
      name: '新鲜原料',
      category: '原料',
      tips: '把当天采购的原料平铺或摆盘，俯拍一张全景再逐个特写。强调「当天到货、现切现用」，可用手拿起展示纹理，让新鲜看得见。',
    },
    {
      code: 'make_process',
      name: '制作过程',
      category: '制作',
      tips: '从备料到下锅一条完整动作线，中间不要停机。拍之前先想清楚 3 个关键动作（下料/翻炒/调味），每步各给 1~2 秒，节奏比时长重要。',
    },
  ]
  for (const it of items) {
    await prisma.shotLibrary.upsert({
      where: { code: it.code },
      create: { ...it, source: 'MANUAL', sort: 0, enabled: true },
      update: { name: it.name, category: it.category, tips: it.tips, enabled: true },
    })
  }
  const categories = new Set(items.map((it) => it.category))
  console.log(`[seed] 镜头库: ${items.length} 条拍摄技巧（${categories.size} 类）`)
}

// ================= 首页优秀作品（运营内容，带同款配方） =================
// 说明：这里只种「配方 + 分类 + 标签」，封面/视频由运营在后台补齐（cover_key / video_key 留空）。
// 前端对没有封面的作品展示中性占位块，不假装成真封面。
// 配方里的 track / complexity 与 creation 的取值一一对应，「生成同款」直接拿它预填创作流。

/** 镜头骨架模板：shotType / shotSize 取值与 creation/edit 的下拉选项一致 */
const WORK_SHOT_TEMPLATES: Record<string, Array<Record<string, string | number>>> = {
  溯源纪实: [
    { shotType: '开场', shotSize: '全景', durationSuggest: 3, visualReq: '凌晨的进货口或后厨备料，竖拍一镜到底，1 秒内喊出招牌菜' },
    { shotType: '原料', shotSize: '特写', durationSuggest: 4, visualReq: '手拿起当天原料展示纹理，背景虚化，强调「当天到货」' },
    { shotType: '制作', shotSize: '中景', durationSuggest: 5, visualReq: '侧后方 45° 拍关键动作，一镜不停机，突出火候与手法' },
    { shotType: '收尾', shotSize: '全景', durationSuggest: 3, visualReq: '成品端上桌，定位字幕停留 2 秒引导到店' },
  ],
  前后对比: [
    { shotType: '开场', shotSize: '近景', durationSuggest: 3, visualReq: '先给「改造前」的真实状态，不加修饰，制造反差预期' },
    { shotType: '制作', shotSize: '中景', durationSuggest: 5, visualReq: '记录处理过程的关键一步，动作干脆，节奏放快' },
    { shotType: '特写', shotSize: '大特写', durationSuggest: 4, visualReq: '「改造后」的细节特写，侧逆光让质感更明显' },
    { shotType: '卖点', shotSize: '全景', durationSuggest: 3, visualReq: '前后同机位对比 + 价格/套餐字幕停留 2 秒' },
  ],
  教程教学: [
    { shotType: '开场', shotSize: '中景', durationSuggest: 3, visualReq: '一句话说清「看完能学会什么」，直接给结果' },
    { shotType: '制作', shotSize: '近景', durationSuggest: 6, visualReq: '分步骤演示，每个关键动作给 1~2 秒，手部入镜' },
    { shotType: '口播', shotSize: '中景', durationSuggest: 4, visualReq: '正面口播讲清要点，镜头与眼睛齐平' },
    { shotType: '收尾', shotSize: '全景', durationSuggest: 3, visualReq: '成果展示 + 引导到店体验' },
  ],
  情怀叙事: [
    { shotType: '开场', shotSize: '近景', durationSuggest: 3, visualReq: '老板的手部动作或老物件特写，先给情绪不给人脸' },
    { shotType: '口播', shotSize: '中景', durationSuggest: 5, visualReq: '老板正面讲一句「为什么坚持这么多年」，语速放慢' },
    { shotType: '制作', shotSize: '中景', durationSuggest: 5, visualReq: '传统手法的完整动作，保留环境音，不要配乐盖住' },
    { shotType: '试吃', shotSize: '特写', durationSuggest: 3, visualReq: '出锅瞬间的蒸汽/拉丝特写，收在招牌菜上' },
  ],
  探店实拍: [
    { shotType: '开场', shotSize: '全景', durationSuggest: 3, visualReq: '门头 + 人气画面，第一秒就把招牌菜名喊出来' },
    { shotType: '环境', shotSize: '全景', durationSuggest: 4, visualReq: '横移或缓推拍干净的环境，停在有烟火气但不乱的画面' },
    { shotType: '特写', shotSize: '大特写', durationSuggest: 4, visualReq: '招牌菜出锅或爆汁瞬间，凑近到 20cm，锁焦在食物上' },
    { shotType: '卖点', shotSize: '近景', durationSuggest: 4, visualReq: '价目牌或套餐组合展示，手指划过重点一行，停 2 秒' },
  ],
}

const WORK_STYLE_NOTES: Record<string, string> = {
  溯源纪实: '靠「过程可信」打动人：把看不见的辛苦拍出来，比夸好吃有用。',
  前后对比: '反差就是钩子：前 3 秒必须让人看到「有多糟」，后面才有惊喜。',
  教程教学: '用户为「学会」停留：先给结果，再拆步骤，最后引导到店。',
  情怀叙事: '卖的不是菜是坚持：老板本人出镜讲一句真心话，完播率最高。',
  探店实拍: '主打「馋」：出锅瞬间 + 价目牌，两个画面决定要不要到店。',
}

const WORK_STYLES = ['溯源纪实', '前后对比', '教程教学', '情怀叙事', '探店实拍'] as const

/** 28 条作品：分类 / 二级分类 / 标签 / 采用的镜头风格模板 */
const excellentWorks = [
  { title: '郴州 34 年老卤味 · 24 载坚守地道味', category: '餐饮', subCategory: '卤味', tags: ['素材智能成片', '卤味'], style: '情怀叙事' },
  { title: '温州茶山阿海 · 5 小时慢煨一罐汤', category: '餐饮', subCategory: '汤馆', tags: ['爆款文案', '餐饮其他'], style: '情怀叙事' },
  { title: '成都小面馆 · 凌晨四点熬的一锅红油', category: '餐饮', subCategory: '面馆', tags: ['AI 配音', '面馆'], style: '情怀叙事' },
  { title: '重庆老火锅 · 现炒底料香到隔壁街', category: '餐饮', subCategory: '火锅', tags: ['口播种草', '火锅'], style: '探店实拍' },
  { title: '潮汕牛肉店 · 现宰三小时就上桌', category: '餐饮', subCategory: '牛肉', tags: ['探店实拍', '牛肉'], style: '探店实拍' },
  { title: '巷子口早餐铺 · 一笼包子卖了 20 年', category: '餐饮', subCategory: '早餐', tags: ['情怀叙事', '早餐'], style: '情怀叙事' },
  { title: '海鲜大排档 · 老板凌晨去码头抢货', category: '餐饮', subCategory: '海鲜', tags: ['溯源纪实', '海鲜'], style: '溯源纪实' },
  { title: '社区烧烤摊 · 夏天第一口五花肉', category: '餐饮', subCategory: '烧烤', tags: ['夜宵场景', '烧烤'], style: '探店实拍' },
  { title: '江南糖水铺 · 手作桂圆莲子羹', category: '餐饮', subCategory: '甜品', tags: ['慢生活', '甜品'], style: '情怀叙事' },
  { title: '川味小炒 · 三分钟一道家常菜', category: '餐饮', subCategory: '小炒', tags: ['教程教学', '小炒'], style: '教程教学' },
  { title: '少儿编程体验课 · 8 岁孩子自己做出小游戏', category: '教培', subCategory: '编程', tags: ['效果展示', '编程'], style: '前后对比' },
  { title: '少儿美术 · 一节课画完一幅水彩', category: '教培', subCategory: '美术', tags: ['作品展示', '美术'], style: '前后对比' },
  { title: '英语口语班 · 30 天敢开口说', category: '教培', subCategory: '英语', tags: ['学员见证', '英语'], style: '前后对比' },
  { title: '舞蹈教室 · 零基础也能跟上第一节课', category: '教培', subCategory: '舞蹈', tags: ['课堂实录', '舞蹈'], style: '教程教学' },
  { title: '书法课堂 · 从握笔到写出第一幅作品', category: '教培', subCategory: '书法', tags: ['过程记录', '书法'], style: '教程教学' },
  { title: '篮球训练营 · 周末两小时练出基本功', category: '教培', subCategory: '体育', tags: ['训练剪影', '体育'], style: '教程教学' },
  { title: '社区理发店 · 剪完像换了个人', category: '美业', subCategory: '美发', tags: ['前后对比', '美发'], style: '前后对比' },
  { title: '独立美甲工作室 · 把春天留在指尖', category: '美业', subCategory: '美甲', tags: ['作品特写', '美甲'], style: '前后对比' },
  { title: '皮肤管理 · 做完全脸透亮', category: '美业', subCategory: '护肤', tags: ['效果对比', '护肤'], style: '前后对比' },
  { title: '养生 SPA · 肩颈按完睡了个好觉', category: '美业', subCategory: '养生', tags: ['体验记录', '养生'], style: '探店实拍' },
  { title: '家电清洗 · 洗完空调吹出的风都干净', category: '生活服务', subCategory: '清洗', tags: ['前后对比', '清洗'], style: '前后对比' },
  { title: '搬家公司 · 全屋打包两小时搞定', category: '生活服务', subCategory: '搬家', tags: ['流程记录', '搬家'], style: '教程教学' },
  { title: '家政保洁 · 三小时让家焕然一新', category: '生活服务', subCategory: '保洁', tags: ['效果展示', '保洁'], style: '前后对比' },
  { title: '管道疏通 · 半夜上门 20 分钟解决', category: '生活服务', subCategory: '维修', tags: ['应急响应', '维修'], style: '教程教学' },
  { title: '台球厅 · 一杆清台的爽感', category: '休闲娱乐', subCategory: '台球', tags: ['高光时刻', '台球'], style: '探店实拍' },
  { title: '密室逃脱 · 吓到尖叫的第一视角', category: '休闲娱乐', subCategory: '密室', tags: ['沉浸体验', '密室'], style: '探店实拍' },
  { title: '露营基地 · 城市边上的星空营地', category: '休闲娱乐', subCategory: '露营', tags: ['场景展示', '露营'], style: '探店实拍' },
  { title: 'KTV 新店 · 音响一开就停不下来', category: '休闲娱乐', subCategory: 'KTV', tags: ['氛围展示', 'KTV'], style: '探店实拍' },
] as const

async function seedExcellentWorks() {
  // 幂等：以 title 作为业务键，重复 seed 只更新配方与分类，不新增重复作品
  for (let i = 0; i < excellentWorks.length; i++) {
    const w = excellentWorks[i]
    if (!w) continue
    const recipe = {
      track: (w.style === '教程教学' ? 'INTRO' : w.style === '前后对比' ? 'QUALITY' : w.style === '探店实拍' ? 'RECOMMEND' : 'TRAFFIC') as
        | 'TRAFFIC'
        | 'INTRO'
        | 'QUALITY'
        | 'RECOMMEND',
      complexity: (w.style === '探店实拍' || w.style === '溯源纪实' ? 'COMPLEX' : 'FINE') as
        | 'SIMPLE'
        | 'COMPLEX'
        | 'FINE',
      titleHint: w.title,
      shotSkeleton: WORK_SHOT_TEMPLATES[w.style] ?? [],
      notes: WORK_STYLE_NOTES[w.style] ?? '',
    }
    const data = {
      category: w.category,
      subCategory: w.subCategory,
      tags: [...w.tags],
      recipeJson: recipe,
      sort: i,
    }
    const existing = await prisma.excellentWork.findFirst({ where: { title: w.title, deletedAt: null } })
    if (existing) {
      await prisma.excellentWork.update({ where: { id: existing.id }, data })
    } else {
      await prisma.excellentWork.create({
        data: {
          title: w.title,
          ...data,
          // 封面/视频留空，由运营在后台补齐；未补素材前前端展示中性占位
          enabled: true,
          sourceType: 'MANUAL',
          publishedAt: new Date(),
        },
      })
    }
  }
  const categories = new Set(excellentWorks.map((w) => w.category))
  console.log(`[seed] 优秀作品: ${excellentWorks.length} 条（${categories.size} 个分类，${WORK_STYLES.length} 套镜头模板）`)
}

// ================= 后台管理员（单角色全权限，密码 scrypt 哈希） =================
async function seedAdminUser() {
  const username = process.env.ADMIN_USERNAME ?? 'admin'
  const password = process.env.ADMIN_PASSWORD ?? 'admin123456'
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[seed] ADMIN_PASSWORD 未配置，使用默认 admin/admin123456（生产务必修改）')
  }
  await prisma.adminUser.upsert({
    where: { username },
    create: { username, passwordHash: hashPassword(password), displayName: '管理员', status: 'ACTIVE' },
    update: {}, // 不重置密码，避免重复 seed 覆盖后台改过的口令
  })
  console.log(`[seed] 后台管理员: ${username}`)
}

// ================= 首页轮播图（运营内容，独立一条） =================
/**
 * 小程序首页顶部「创作入口」轮播的**初始值**。
 *
 * 它只是一份起点：首次 seed 把行建出来，之后运营在后台「首页轮播图」里改的内容一律不动
 * （见下面 seedSettings 里那个 `update: {}` 的 upsert）。
 *
 * image 必须是**完整公开 URL**：小程序 <Image src> 不做签名、也不认对象键。
 * 这里用的对象与 apps/mini/src/constants/static-assets.ts::HOME_CREATE_HERO 是同一个
 * （COS `static/mini/home/create-hero.jpg`，对象级 ACL: public-read）。
 * 文案与「改成轮播之前那张静态卡片」逐字一致 —— 所以只有 1 张时，
 * 小程序侧 autoplay=false、不显示圆点，行为与改造前完全一样。
 */
const HOME_CAROUSEL_SEED = [
  {
    id: 'seed',
    image: 'https://dashuai-1485028436.cos.ap-beijing.myqcloud.com/static/mini/home/create-hero.jpg',
    kicker: '从一道菜开始',
    title: '做一条能带来客人的视频',
    desc: '', // 副标题已按需求下线（2026-09-16）
    actionText: '开始创作',
    link: 'CREATE',
    workId: '',
    enabled: true,
    sort: 0,
  },
]

// ================= 系统设置（v5 计费与配额默认值，全部后台可改） =================
async function seedSettings() {
  const GB = 1024 * 1024 * 1024
  const items = [
    // 积分换算与 AI 计费
    { groupKey: 'bean', settingKey: 'points_per_yuan', settingVal: '100', displayName: '1元兑换积分数' },
    { groupKey: 'bean', settingKey: 'cost_multiplier', settingVal: '4', displayName: 'AI成本系数' },
    { groupKey: 'bean', settingKey: 'register_grant_points', settingVal: '30', displayName: '注册赠送积分' },
    // v5 强制「成本 × 系数」，不再按固定标价
    { groupKey: 'bean', settingKey: 'charge_mode', settingVal: 'COST_BASED', displayName: '计费模式' },
    // 合成按时长计费
    { groupKey: 'render', settingKey: 'point_per_sec', settingVal: '1', displayName: '合成每秒积分' },
    { groupKey: 'render', settingKey: 'recolor_ratio', settingVal: '0.5', displayName: '重调色折扣系数' },
    // 三档生成系数（按时长 × point_per_sec × 档位系数）
    { groupKey: 'render', settingKey: 'grade_ratio_basic', settingVal: '1', displayName: '基础生成系数' },
    { groupKey: 'render', settingKey: 'grade_ratio_ai', settingVal: '1.5', displayName: 'AI生成系数' },
    { groupKey: 'render', settingKey: 'grade_ratio_premium', settingVal: '3', displayName: '精品生成系数' },
    { groupKey: 'render', settingKey: 'premium_sla_hours', settingVal: '48', displayName: '精品SLA时长(小时)' },
    // 上传空间配额
    { groupKey: 'storage', settingKey: 'quota_free_bytes', settingVal: String(1 * GB), displayName: '未订阅空间(字节)' },
    { groupKey: 'storage', settingKey: 'quota_subscribed_bytes', settingVal: String(5 * GB), displayName: '订阅空间(字节)' },
    // 订阅参数（运行时覆盖 MemberPackage）
    { groupKey: 'subscription', settingKey: 'price_fen', settingVal: '98000', displayName: '订阅价格(分)' },
    { groupKey: 'subscription', settingKey: 'duration_days', settingVal: '30', displayName: '订阅周期(天)' },
    { groupKey: 'subscription', settingKey: 'grant_points', settingVal: '98000', displayName: '订阅赠送积分' },
  ]
  for (const it of items) {
    await prisma.systemSetting.upsert({
      where: { groupKey_settingKey: { groupKey: it.groupKey, settingKey: it.settingKey } },
      create: { ...it, valueType: it.settingVal.includes('.') ? 'FLOAT' : (it.groupKey === 'bean' && it.settingKey === 'charge_mode' ? 'STRING' : 'INT'), description: '', sort: 0, isPublic: false },
      update: { settingVal: it.settingVal, displayName: it.displayName },
    })
  }
  console.log(`[seed] system settings: ${items.length}`)

  // ── 首页轮播图：**刻意不放进上面的 items 数组** ──
  // items 那个循环的 update 会覆盖 settingVal；轮播是运营内容，重跑一次 seed 就把它
  // 打回默认值是不可接受的。所以这里单独用「不存在才建」的 upsert（update 为空对象，
  // 与上面 adminUser 同一手法）：只在缺行时插入，已有配置（哪怕被清成空数组）一律不动。
  await prisma.systemSetting.upsert({
    where: { groupKey_settingKey: { groupKey: 'home', settingKey: 'carousel' } },
    create: {
      groupKey: 'home',
      settingKey: 'carousel',
      settingVal: JSON.stringify(HOME_CAROUSEL_SEED),
      valueType: 'JSON',
      displayName: '首页轮播图',
      description: '小程序首页顶部「创作入口」的轮播。留空则回退到内置默认单张；保存后小程序下次进入首页生效。',
      sort: 0,
      isPublic: true,
    },
    update: {}, // 不覆盖：运营改过的轮播必须能在重跑 seed 后活下来
  })
  console.log('[seed] home carousel: 已保证存在（不覆盖已有配置）')

  // ── 首页口号图：同样只在缺行时插入 ──
  // 运营上传过就绝不能被 seed 洗掉（跟轮播一个道理），所以 update 也是空对象。
  //
  // ★ 默认值是**空串**：空 = 「没配，用小程序内置的那张」。不用「把内置图的 URL 抄进来」
  //   当默认值 —— 那样内置图以后改了版，库里这条陈旧地址会把新版**永久遮住**，
  //   而且从库里完全看不出这是「默认值」还是「运营上传的」。
  // ★ valueType 用 STRING 而不是 JSON：值就是一个地址，没有第二个字段。
  //   JSON 类型在公开接口那边会被 parse 完再 stringify，小程序拿到的是字符串、
  //   还得再 parse 一次（轮播那边的坑）；单标量用 STRING 直接读，少一层可以错的转换。
  await prisma.systemSetting.upsert({
    where: { groupKey_settingKey: { groupKey: 'home', settingKey: 'sloganBanner' } },
    create: {
      groupKey: 'home',
      settingKey: 'sloganBanner',
      settingVal: '',
      valueType: 'STRING',
      displayName: '首页口号图',
      description:
        '小程序首页顶部的口号海报（默认是代码生成的红白黑三色图）。留空/删除本项 = 用内置默认图；上传后小程序下次进入首页生效。建议 1125×411（约 2.74:1）。',
      sort: 1,
      isPublic: true,
    },
    update: {}, // 不覆盖：运营上传过的口号图必须活过重跑 seed
  })
  console.log('[seed] home slogan banner: 已保证存在（不覆盖已有配置）')
}

async function main() {
  // 加油包：v5 废除 8 折，memberPriceFen 与 priceFen 同价
  // BeanPackage.name 非唯一，upsert where:{name} 非法；改 findFirst + create/update（幂等）
  for (let i = 0; i < beanPackages.length; i++) {
    const p = beanPackages[i]
    if (!p) continue
    const data = {
      beans: p.beans,
      bonusBeans: p.bonusBeans,
      priceFen: p.priceFen,
      memberPriceFen: p.priceFen,
      tag: p.tag,
      sort: i,
      enabled: true,
    }
    const existing = await prisma.beanPackage.findFirst({ where: { name: p.name } })
    if (existing) {
      await prisma.beanPackage.update({ where: { id: existing.id }, data })
    } else {
      await prisma.beanPackage.create({ data: { name: p.name, ...data } })
    }
  }
  // 订阅套餐
  for (let i = 0; i < memberPlans.length; i++) {
    const m = memberPlans[i]
    if (!m) continue
    await prisma.memberPackage.upsert({
      where: { code: m.code },
      create: { name: m.name, code: m.code, durationDays: m.durationDays, priceFen: m.priceFen, grantBeans: m.grantBeans, tag: m.tag, rightsJson: m.rights, sort: i, enabled: true },
      update: { name: m.name, durationDays: m.durationDays, priceFen: m.priceFen, grantBeans: m.grantBeans, tag: m.tag, rightsJson: m.rights, sort: i, enabled: true },
    })
  }
  console.log(`[seed] 加油包: ${beanPackages.length}, 订阅套餐: ${memberPlans.length}`)

  // v4 遗留档位/套餐软下线（保留历史订单外键，仅停止售卖）
  const offPkg = await prisma.beanPackage.updateMany({
    where: { name: { in: LEGACY_PACKAGE_NAMES } },
    data: { enabled: false },
  })
  const offPlan = await prisma.memberPackage.updateMany({
    where: { code: { in: LEGACY_PLAN_CODES } },
    data: { enabled: false },
  })
  if (offPkg.count || offPlan.count) {
    console.log(`[seed] 已下线 v4 遗留：充值档位 ${offPkg.count} 个、会员套餐 ${offPlan.count} 个`)
  }

  await seedSettings()
  await seedAi()
  await seedTtsProviders()
  await seedShotLibrary()
  await seedExcellentWorks()
  await seedAdminUser()
  await seedDemoMerchant()
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('[seed] failed:', e)
    process.exit(1)
  })
