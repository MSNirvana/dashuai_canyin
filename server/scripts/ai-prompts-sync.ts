// 把 prisma/prompts.ts 的提示词模板同步进 ai_scene 表。
//
// 只更新 name / promptTemplate / fallbackTemplate / temperature ——
// beanPrice、defaultModelId、fallbackModelIds、timeoutMs、enabled 都算运营配置，
// 后台改过就该保留。跑 npm run db:seed 会把它们连同模板一起打回默认值，
// 所以改模板要用这个脚本，而不是 seed。
//
// ══ ★ 缺场景时**建行**（2026-09-21 加）══
//   原先缺行只报「场景不存在（先跑 npm run db:seed）」。这条指引在**生产上是错的**：
//   db:seed 会把所有场景的 beanPrice / 候选链 / 后台改过的模板一起打回默认值
//   （正是本文件第 3~6 行警告的那件事）。于是「加一个新场景」在生产上无路可走 ——
//   只能手工写 SQL，或者冒着洗掉运营配置的风险跑 seed。
//   现在改成：缺行就按 prompts.ts 的描述**建一行**，并把「还差什么」说清楚。
//   ⚠ 建行时给的候选链是**按能力类型现挑的第一个可用模型**，只是个能跑通的起点：
//     真正的候选顺序与商业定价仍由 `npm run ai-channels:setup` 决定（它会覆盖这两项）。
//
// 用法：npm run ai-prompts:sync
import { PrismaClient } from '@prisma/client'
import { CREATION_SCENE_PROMPTS, STORYBOARD_SCENE, PUBLISH_SCENES } from '../prisma/prompts.js'
import { validateTemplate } from '../src/ai/prompt-vars.js'

const prisma = new PrismaClient()

type SceneKind = 'TEXT' | 'IMAGE'

interface SceneSpec {
  code: string
  name: string
  prompt: string
  fallback: string
  temperature: number
  /** 缺省 TEXT。只有出图场景是 IMAGE（决定网关走哪个协议） */
  kind?: SceneKind
  /** 仅用于「缺行时建行」：已存在的行不会被这几个值覆盖 */
  beanPrice?: number
  timeoutMs?: number
  maxRetries?: number
  maxOutputTokens?: number
}

/** 文案 / 分镜这些老场景全部是文本场景，`kind` 统一兜底成 TEXT */
const scenes: SceneSpec[] = [
  ...CREATION_SCENE_PROMPTS.map((s) => ({ ...s, kind: 'TEXT' as SceneKind })),
  { ...STORYBOARD_SCENE, kind: 'TEXT' as SceneKind },
  ...PUBLISH_SCENES.map((s) => ({ ...s, kind: s.kind as SceneKind })),
]

/**
 * 缺行时用来填 `default_model_id` 的模型：按「提供商优先级 → 模型 id」取第一个
 * **能力匹配且启用**的模型。
 *
 * ★ 必须按 kind 挑：图像场景如果被填上一个文本模型，`ai-gateway` 的能力闸门会
 *   每次请求都跳过它 —— 表现是「这个场景永远失败」，而不是「配置错了」。
 * ★ 取不到就**不建行**并给出明确指引，绝不退而求其次填一个能力不符的模型。
 */
async function firstModelOfKind(kind: SceneKind) {
  return prisma.aiModel.findFirst({
    where: { enabled: true, capability: kind, provider: { enabled: true } },
    orderBy: [{ provider: { priority: 'asc' } }, { id: 'asc' }],
    select: { id: true, modelCode: true, provider: { select: { code: true } } },
  })
}

async function main() {
  let synced = 0
  let created = 0
  const problems: string[] = []

  for (const s of scenes) {
    // 同步前按变量契约自检：未支持的变量运行时会被静默替换成空串，绝不能带病进库
    const tplProblems = validateTemplate(s.code, s.prompt)
    if (tplProblems.length) {
      problems.push(`${s.code} 模板校验不通过：${tplProblems.join('；')}`)
      continue
    }

    const r = await prisma.aiScene.updateMany({
      where: { code: s.code },
      data: { name: s.name, promptTemplate: s.prompt, fallbackTemplate: s.fallback, temperature: s.temperature },
    })
    if (r.count > 0) {
      synced++
      console.log(`✓ 更新 ${s.code.padEnd(20)} ${s.prompt.length} 字`)
      continue
    }

    // ── 缺行：新建 ──
    const kind: SceneKind = s.kind ?? 'TEXT'
    const model = await firstModelOfKind(kind)
    if (!model) {
      problems.push(
        `${s.code} 场景不存在，且库里没有可用的 ${kind} 模型 ⇒ 无法建行。` +
          `先跑 npm run ai-channels:setup 配好通道${kind === 'IMAGE' ? '（出图通道需要 TB_IMAGE_KEY）' : ''}，再重跑本脚本。`,
      )
      continue
    }
    await prisma.aiScene.create({
      data: {
        code: s.code,
        name: s.name,
        kind,
        promptTemplate: s.prompt,
        fallbackTemplate: s.fallback,
        temperature: s.temperature,
        defaultModelId: model.id,
        // 建行时只挂这一个候选。候选顺序与定价属于运营配置，交给 ai-channels:setup
        fallbackModelIds: [],
        beanPrice: BigInt(s.beanPrice ?? 0),
        ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
        ...(s.maxRetries !== undefined ? { maxRetries: s.maxRetries } : {}),
        ...(s.maxOutputTokens !== undefined ? { maxOutputTokens: s.maxOutputTokens } : {}),
        enabled: true,
      },
    })
    created++
    console.log(
      `＋ 新建 ${s.code.padEnd(20)} kind=${kind} 候选=${model.provider.code}/${model.modelCode}` +
        (s.beanPrice === undefined
          ? '  ⚠ 单次上限 = 0（未在 prompts.ts 给默认价）'
          : ` 单次上限=${s.beanPrice}`),
    )
  }

  console.log(`\n已同步 ${synced}/${scenes.length} 个场景${created ? `（其中新建 ${created} 个）` : ''}`)
  if (created) {
    console.log(
      '⚠ 新建的场景只挂了单个候选：跑 npm run ai-channels:setup 才会得到完整候选链与正式定价。',
    )
  }
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`)
    process.exitCode = 1
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())
