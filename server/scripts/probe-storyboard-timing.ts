/**
 * 分镜场景「思考预算」A/B 探针 —— **只读、零计费、不写任何日志**。
 *
 * 为什么需要它：线上分镜的主候选是 deepseek-v4-flash，实测它在这个场景上会「跑飞」——
 * `completion_tokens` 从 3,165 到 17,650 不等，而可见 JSON 只有 1,300~1,600 字符，
 * 差额全是**隐藏思考**。`max_output_tokens=12000` 管不住它（id=33 实测 17,650 > 12,000），
 * 于是时间从 29s 跳到 145s，越过 150s 场景超时后降级到 claude（41s）⇒ 用户白等 191 秒。
 *
 * 09-22 已经为五个文案场景验证过有效杠杆是 `reasoning_effort:'low'`（deepseek 50s→7~9s），
 * 而分镜**不在** `LOW_REASONING_SCENES` 里。这个脚本就是「按同样口径对分镜真打一轮」。
 *
 * ★ 为什么**直连适配器**而不是走 `gateway.runScene`：
 *   ① 走网关就只能拿到「库里配的那个 reasoningEffort」，无法 A/B；
 *   ② 走网关**会写 ai_call_log**，而 24h 内的真实成功正是健康体检免探测的依据
 *      —— 拿探针给自己刷「健康证据」会把这个盲区越埋越深。
 *   所以这里只调 `openaiCompatible/anthropicNative`，不落任何库、不扣任何积分。
 *
 * 用法（★ 必须落在 server/ 目录，否则读的是本地库）：
 *   npx tsx scripts/probe-storyboard-timing.ts
 *   npx tsx scripts/probe-storyboard-timing.ts 12345      # 指定 creation id
 *   PROBE_TIMEOUT_MS=240000 npx tsx scripts/probe-storyboard-timing.ts
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { getAdapter } from '../src/ai/adapters.js'
import { renderTemplate } from '../src/ai/gateway.js'
import { decryptSecret } from '../src/lib/secret.js'
import { buildVariables } from '../src/services/creation.service.js'

const prisma = new PrismaClient()
const SCENE_CODE = 'storyboard_generate'
/** 探针自己的超时：**故意给得很宽**（200s），目的是量出「真实要跑多久」，不是替生产设卡。 */
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 200_000)

interface Variant {
  label: string
  modelId: bigint
  reasoningEffort?: 'low'
}

const ALL_VARIANTS: Variant[] = [
  { label: 'deepseek 不压思考', modelId: 7n },
  { label: 'deepseek 压 low', modelId: 7n, reasoningEffort: 'low' },
  { label: 'claude   不压思考', modelId: 6n },
  { label: 'claude   压 low', modelId: 6n, reasoningEffort: 'low' },
]
/**
 * 单次样本说明不了「跑飞」这件事 —— deepseek 线上实测 completion_tokens 从 3,165 到 17,650 都出现过。
 * 要看波动就得重复跑，所以留一个按标签子串过滤的开关（`PROBE_ONLY=deepseek`）。
 */
const ONLY = process.env.PROBE_ONLY ?? ''
const VARIANTS = ALL_VARIANTS.filter((v) => !ONLY || v.label.includes(ONLY))

/** 看「模型到底吐了什么」：可见字符、JSON 形状、镜头条数 —— 质量判据全靠它 */
function inspect(text: string) {
  const chars = text.replace(/\s/g, '').length
  const s = text.indexOf('[')
  const e = text.lastIndexOf(']')
  if (s < 0 || e <= s) return { chars, shape: '没有 JSON 数组', shots: 0, missing: '' }
  let arr: unknown
  try {
    arr = JSON.parse(text.slice(s, e + 1))
  } catch (err) {
    return { chars, shape: 'JSON 解析失败', shots: 0, missing: (err as Error).message.slice(0, 40) }
  }
  if (!Array.isArray(arr) || arr.length === 0) return { chars, shape: '空数组', shots: 0, missing: '' }
  const NEED = ['shotType', 'shotSize', 'durationSuggest', 'line', 'visualReq']
  const missingKeys = new Set<string>()
  for (const row of arr) {
    if (!row || typeof row !== 'object') { missingKeys.add('(非对象)'); continue }
    for (const k of NEED) if (!(k in (row as Record<string, unknown>))) missingKeys.add(k)
  }
  return {
    chars,
    shape: `JSON ${arr.length} 镜`,
    shots: arr.length,
    missing: [...missingKeys].join(','),
  }
}

async function main() {
  const scene = await prisma.aiScene.findUniqueOrThrow({ where: { code: SCENE_CODE } })
  console.log(`场景 ${SCENE_CODE}：default_model_id=${scene.defaultModelId} fallback=${JSON.stringify(scene.fallbackModelIds)}`)
  console.log(`  timeout_ms=${scene.timeoutMs} max_output_tokens=${scene.maxOutputTokens} temperature=${scene.temperature} kind=${scene.kind}`)

  // 取一条**真实**的创作（有文案正文、有门店菜品）—— 占位值跑出来的分镜看不出好坏
  const creationIdArg = process.argv[2] ? BigInt(process.argv[2]) : null
  const creation = creationIdArg
    ? await prisma.creation.findUniqueOrThrow({ where: { id: creationIdArg } })
    : await prisma.creation.findFirstOrThrow({
        where: { copyText: { not: null } },
        orderBy: { id: 'desc' },
        select: { id: true, title: true, mode: true, track: true, complexity: true, copyText: true },
      })
  const copyText = creation.copyText ?? ''
  if (!copyText.trim()) throw new Error(`creation #${creation.id} 的 copyText 是空的，换一条（或传 creation id）`)
  console.log(`\n取材 creation #${creation.id}「${creation.title ?? ''}」mode=${creation.mode} track=${creation.track} complexity=${creation.complexity}`)
  console.log(`文案正文 ${copyText.replace(/\s/g, '').length} 字`)

  const vars = (await buildVariables(prisma, creation.id, {})) as unknown as Record<string, string>
  const prompt = renderTemplate(scene.promptTemplate, vars)
  console.log(`渲染后提示词 ${prompt.length} 字符（${prompt.replace(/\s/g, '').length} 非空白）\n`)

  const rows: string[] = []
  for (const v of VARIANTS) {
    const model = await prisma.aiModel.findUniqueOrThrow({
      where: { id: v.modelId },
      include: { provider: true },
    })
    const adapter = getAdapter(model.provider.protocol)
    const t0 = Date.now()
    let line: string
    try {
      const res = await adapter({
        baseUrl: model.provider.baseUrl,
        apiKey: decryptSecret(model.provider.apiKeyEncrypted),
        model: model.modelCode,
        user: prompt,
        temperature: scene.temperature ? Number(scene.temperature) : undefined,
        maxOutputTokens: scene.maxOutputTokens ?? undefined,
        ...(v.reasoningEffort ? { reasoningEffort: v.reasoningEffort } : {}),
        timeoutMs: PROBE_TIMEOUT_MS,
        sceneCode: SCENE_CODE,
      })
      const ms = Date.now() - t0
      const info = inspect(res.text)
      line =
        `${v.label.padEnd(18)}｜${(ms / 1000).toFixed(1)}s｜完成 token ${String(res.usage.completionTokens).padStart(5)}` +
        `｜可见 ${String(info.chars).padStart(4)} 字｜${info.shape}` +
        (info.missing ? `｜缺字段 ${info.missing}` : '')
    } catch (err) {
      const ms = Date.now() - t0
      line = `${v.label.padEnd(18)}｜${(ms / 1000).toFixed(1)}s｜✗ ${(err as Error).message.slice(0, 80)}`
    }
    console.log(line)
    rows.push(line)
  }

  console.log('\n════════ 汇总 ════════')
  for (const r of rows) console.log(r)
  console.log('\n判据：可见字符/镜头条数相当 ⇒ 质量不变；耗时与完成 token 显著下降 ⇒ 压思考成立。')

  await prisma.$disconnect()
  process.exit(0)
}

main().catch(async (e) => {
  console.error('探针异常：', e)
  await prisma.$disconnect()
  process.exit(1)
})
