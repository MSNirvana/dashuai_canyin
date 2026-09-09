// 种子数据：AI 通道 / 场景 + 加油包 + 订阅套餐 + 演示商家
// 运行：npm run db:seed  （依赖已注入的 DATABASE_URL / APP_MASTER_KEY）
// 计费规则见 docs/05 v5：订阅 ¥980/30天/赠98000积分（后台可改）；加油包 100/200/300 → 1万/2万/3万积分（仅订阅可买）
// AI 计费 = 实际成本 × 系数（bean.cost_multiplier，默认 4），场景 beanPrice 为单次冻结上限
import { createCipheriv, randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/lib/password.js'

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
  '10元 · 1000豆',
  '30元 · 3200豆',
  '68元 · 7600豆',
  '198元 · 22800豆',
  '398元 · 51800豆',
]

// ================= AI 通道 / 模型 / 场景 =================
// mock-local：本地联调协议，不发起网络请求，直接返回可解析样例（文案/分镜 JSON）
// deepseek  ：真实 OpenAI 兼容通道，默认 disabled；填入 DEEPSEEK_API_KEY 并 enabled=true 即可上线
const COPY_PROMPT = `你是一家餐饮门店的短视频文案助手。
门店：{{storeName}}
品类：{{category}}
城市：{{city}}
菜品：{{dishName}}
菜品简介：{{dishIntro}}
卖点：{{sellingPoints}}
人设：{{persona}}
请写一段适合抖音/视频号口播的 30 秒短视频文案，口语化、有钩子、突出到店理由。`
const STORY_PROMPT = `你是短视频分镜导演。根据以下信息把文案拆成 6-8 个镜头。
门店：{{storeName}}
菜品：{{dishName}}
已有文案：{{copyText}}
请只输出 JSON 数组，每个元素含 shotType、durationSuggest(秒)、line(口播)、visualReq(画面要求)。`
const COPY_FALLBACK = `{{storeName}}{{dishName}}好味道，欢迎到店品尝。`
const STORY_FALLBACK = `[{"shotType":"主厨","durationSuggest":4,"line":"今日推荐","visualReq":"招牌菜特写"}]`

async function seedAi() {
  // v5：AI 计费 = 实际成本 × 系数（bean.cost_multiplier，默认 4）。
  // 场景上的 beanPrice 不再是「标价」，而是**单次冻结上限**（财务安全网）：
  // 实际扣费按成本计算且不超过该上限，超出部分由平台承担。后台可调。

  // 1) MOCK 本地通道（默认启用）
  const mockProvider = await prisma.aiProvider.upsert({
    where: { code: 'mock-local' },
    create: {
      code: 'mock-local',
      name: '本地联调（MOCK）',
      providerType: 'MOCK',
      protocol: 'MOCK',
      baseUrl: 'mock://local',
      apiKeyEncrypted: encryptSecret('mock-local-key'),
      apiKeyMasked: 'mock****local',
      enabled: true,
      priority: 100,
      healthStatus: 'HEALTHY',
    },
    update: { name: '本地联调（MOCK）', protocol: 'MOCK', enabled: true, priority: 100 },
  })
  const mockChat = await prisma.aiModel.upsert({
    where: { providerId_modelCode: { providerId: mockProvider.id, modelCode: 'mock-chat' } },
    create: { providerId: mockProvider.id, modelCode: 'mock-chat', displayName: 'Mock 对话', capability: 'TEXT', inputPricePerMtok: 100, outputPricePerMtok: 400, enabled: true },
    update: { displayName: 'Mock 对话', inputPricePerMtok: 100, outputPricePerMtok: 400, enabled: true },
  })
  const mockReasoner = await prisma.aiModel.upsert({
    where: { providerId_modelCode: { providerId: mockProvider.id, modelCode: 'mock-reasoner' } },
    create: { providerId: mockProvider.id, modelCode: 'mock-reasoner', displayName: 'Mock 推理', capability: 'TEXT', inputPricePerMtok: 100, outputPricePerMtok: 400, enabled: true },
    update: { displayName: 'Mock 推理', inputPricePerMtok: 100, outputPricePerMtok: 400, enabled: true },
  })

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

  // 3) 场景：文案 / 分镜。default 指向 MOCK 模型，fallback 指向另一个 MOCK 模型，保证本地可跑
  await prisma.aiScene.upsert({
    where: { code: 'copy_generate' },
    create: {
      code: 'copy_generate',
      name: '短视频文案生成',
      promptTemplate: COPY_PROMPT,
      fallbackTemplate: COPY_FALLBACK,
      defaultModelId: mockChat.id,
      fallbackModelIds: [Number(mockReasoner.id)],
      beanPrice: 5n,
      timeoutMs: 30000,
      maxRetries: 1,
      temperature: 0.8,
      maxOutputTokens: 800,
      enabled: true,
    },
    update: {
      name: '短视频文案生成',
      promptTemplate: COPY_PROMPT,
      fallbackTemplate: COPY_FALLBACK,
      defaultModelId: mockChat.id,
      fallbackModelIds: [Number(mockReasoner.id)],
      beanPrice: 5n,
      timeoutMs: 30000,
      maxRetries: 1,
      temperature: 0.8,
      maxOutputTokens: 800,
      enabled: true,
    },
  })
  await prisma.aiScene.upsert({
    where: { code: 'storyboard_generate' },
    create: {
      code: 'storyboard_generate',
      name: '分镜脚本生成',
      promptTemplate: STORY_PROMPT,
      fallbackTemplate: STORY_FALLBACK,
      defaultModelId: mockReasoner.id,
      fallbackModelIds: [Number(mockChat.id)],
      beanPrice: 10n,
      timeoutMs: 40000,
      maxRetries: 1,
      temperature: 0.7,
      maxOutputTokens: 2000,
      enabled: true,
    },
    update: {
      name: '分镜脚本生成',
      promptTemplate: STORY_PROMPT,
      fallbackTemplate: STORY_FALLBACK,
      defaultModelId: mockReasoner.id,
      fallbackModelIds: [Number(mockChat.id)],
      beanPrice: 10n,
      timeoutMs: 40000,
      maxRetries: 1,
      temperature: 0.7,
      maxOutputTokens: 2000,
      enabled: true,
    },
  })
  console.log('[seed] ai providers: 2, models: 4, scenes: 2')
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
  ]
  for (const it of items) {
    await prisma.shotLibrary.upsert({
      where: { code: it.code },
      create: { ...it, source: 'MANUAL', sort: 0, enabled: true },
      update: { name: it.name, category: it.category, tips: it.tips, enabled: true },
    })
  }
  console.log(`[seed] 镜头库: ${items.length} 条拍摄技巧（6 类）`)
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
  await seedAdminUser()
  await seedDemoMerchant()
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('[seed] failed:', e)
    process.exit(1)
  })
