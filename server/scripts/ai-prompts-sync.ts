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
import { CREATION_SCENE_PROMPTS, EDIT_PLAN_SCENE, STORYBOARD_SCENE, PUBLISH_SCENES } from '../prisma/prompts.js'
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
  // AI 剪辑决策（2026-09-22）—— 本项目第一个「模型直接出剪辑参数」的场景。
  // ★ 它自带 kind，但仍显式覆盖成 'TEXT'：与 STORYBOARD_SCENE 同一种写法，
  //   避免 `EDIT_PLAN_SCENE.kind` 被推断成宽泛的 `string` 而与 SceneSpec 的联合类型不兼容。
  { ...EDIT_PLAN_SCENE, kind: 'TEXT' as SceneKind },
]

/**
 * ★★ 已退役的场景码 —— 这些行要被**删除**，而不是留在库里（2026-09-21 加）。
 *
 * 为什么必须有这一步：本脚本上面用的是 `updateMany`，它**只会更新、不会删**。
 * 而「删一个场景」在只跑 sync 的情况下表现是**什么都没发生**：
 * 后台「AI 场景」页照旧列着那两行，运营照旧能编辑它们，前端那边却已经选不到了
 * —— 三处状态不一致，而且**没有任何地方会报错**，看起来像"改型没生效"。
 *
 * ★ 这里刻意用**显式清单**而不是「把不在 scenes 里的全删掉」：
 *   后者会把运营自己建的任何场景一起清掉，而 ai_scene 表并不记录"这行是谁建的"。
 *   要删一个场景，就把它写进这个数组 —— 这也让"退役"成为一个需要走代码评审的动作。
 * ⚠ 与 scenes 冲突（同一个码既在退役清单又在当前清单）时直接报错：那一定是写错了。
 */
const RETIRED_SCENE_CODES: string[] = [
  // 2026-09-21 四款改型：介绍款 / 质量款被删，语义分别由 copy_product / copy_persona 承接。
  // 库里那两行不删掉的话，后台会一直列着两个已经选不到的款式。
  'copy_intro',
  'copy_quality',
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

  // ── 退役场景清理 ──
  // ★ 用一个「重复」当哨兵：同一个码既在退役清单、又在当前清单里，多半是改型时漏删了一边
  const dup = RETIRED_SCENE_CODES.filter((c) => scenes.some((s) => s.code === c))
  if (dup.length) {
    problems.push(`场景码 ${dup.join('、')} 同时在「当前」与「退役」两份清单里 ⇒ 请先决定去留`)
  } else if (RETIRED_SCENE_CODES.length) {
    const gone = await prisma.aiScene.deleteMany({ where: { code: { in: RETIRED_SCENE_CODES } } })
    if (gone.count) {
      console.log(`\n－ 删除退役场景 ${gone.count} 个：${RETIRED_SCENE_CODES.join('、')}`)
      // ★ 提示这件事，是因为「删了行」本身不会让任何人察觉：
      //   后台不再列出它们，历史 ai_call_log 仍然按 code 查得到（它存的是字符串，不是外键）。
      console.log('  ℹ 历史调用日志不受影响（ai_call_log 存 sceneCode 字符串，无外键）')
    } else {
      console.log(`\nℹ 退役场景（${RETIRED_SCENE_CODES.join('、')}）在库里本来就不存在，无需删除`)
    }
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
