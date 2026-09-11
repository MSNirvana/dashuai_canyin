// 一键接入 GPT-5-Sol 中转：插入供应商 + 模型 + 把生成文案/分镜默认切换到 gpt-5-sol，mock 降为兜底
// 运行：npx tsx scripts/setup-gpt5sol.ts
import { PrismaClient } from '@prisma/client'
import { encryptSecret, maskSecret } from '../src/lib/secret.js'

const API_KEY = 'sk-JfslOnRv2hSvhM9nOSYaPqoG7ctpju9IU2si4yf9Qia691bX'
const BASE_URL = 'https://tokenbox.you'

async function main() {
  const prisma = new PrismaClient()

  // 已存在则跳过（幂等：方便重复跑）
  let provider = await prisma.aiProvider.findUnique({ where: { code: 'gpt-5-sol' } })
  if (!provider) {
    provider = await prisma.aiProvider.create({
      data: {
        code: 'gpt-5-sol',
        name: 'GPT-5-Sol 中转',
        providerType: 'OPENAI_COMPATIBLE',
        protocol: 'OPENAI_COMPATIBLE',
        baseUrl: BASE_URL,
        apiKeyEncrypted: encryptSecret(API_KEY),
        apiKeyMasked: maskSecret(API_KEY),
        enabled: true,
        priority: 50,
      },
    })
    console.log(`+ provider ${provider.code} (id=${provider.id}) 已创建`)
  } else {
    console.log(`= provider ${provider.code} (id=${provider.id}) 已存在，保持现状`)
  }

  let model = await prisma.aiModel.findFirst({ where: { providerId: provider.id, modelCode: 'gpt-5-sol' } })
  if (!model) {
    model = await prisma.aiModel.create({
      data: {
        providerId: provider.id,
        modelCode: 'gpt-5-sol',
        displayName: 'GPT-5-Sol',
        capability: 'TEXT',
        maxContextTokens: 128000,
        maxOutputTokens: 8192,
        enabled: true,
      },
    })
    console.log(`+ model ${model.modelCode} (id=${model.id}) 已创建`)
  } else {
    console.log(`= model ${model.modelCode} (id=${model.id}) 已存在，保持现状`)
  }

  const mockChat = await prisma.aiModel.findFirst({ where: { modelCode: 'mock-chat' } })
  const mockReasoner = await prisma.aiModel.findFirst({ where: { modelCode: 'mock-reasoner' } })
  if (!mockChat || !mockReasoner) throw new Error('mock 模型未找到，请确认 seed 已跑')

  // copy_generate：文案（默认走 chat 类，mock-chat 兜底）
  const copyScene = await prisma.aiScene.update({
    where: { code: 'copy_generate' },
    data: { defaultModelId: model.id, fallbackModelIds: [mockChat.id] },
  })
  console.log(`✓ scene copy_generate: default=gpt-5-sol, fallback=mock-chat`)

  // storyboard_generate：分镜（reasoner 类，mock-reasoner 兜底）
  const shotScene = await prisma.aiScene.update({
    where: { code: 'storyboard_generate' },
    data: { defaultModelId: model.id, fallbackModelIds: [mockReasoner.id] },
  })
  console.log(`✓ scene storyboard_generate: default=gpt-5-sol, fallback=mock-reasoner`)

  // 验证解密往返
  const { decryptSecret } = await import('../src/lib/secret.js')
  const decrypted = decryptSecret(provider.apiKeyEncrypted)
  if (decrypted !== API_KEY) throw new Error('加密往返失败，停止！')
  console.log(`✓ apiKey 加密往返 OK（${provider.apiKeyMasked}）`)

  await prisma.$disconnect()
  console.log('\n配置完成。可在管理后台「供应商配置」看到 gpt-5-sol；点「生成文案/分镜」即走 GPT-5-Sol，失败自动降级 mock。')
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })