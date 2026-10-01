/**
 * 字幕分行场景「思考预算」A/B 探针 —— **只读、零计费、不写任何日志**。
 *
 * 为什么需要它：线上字幕分行（`subtitle_split`）的**主候选是 GPT 推理模型**。
 * 生产实测（`ai_call_log`）：
 *
 *   requestId              提示词字符   completion_tokens   耗时
 *   subtitle-split-52        841           2,056          28.8s   ← 险胜（超时 30s）
 *   subtitle-split-53        841           2,198          30.2s   ← 已经压线
 *   subtitle-split-51        —              —             超时（3 候选 × 30s）
 *   subtitle-split-54        —              —             超时（3 候选 × 30s）
 *
 * 输入只有 841 字符、可见输出只有一百多字的 JSON，却烧掉 2,000+ 个 completion token
 * ⇒ **差额全是隐藏思考**。这与分镜场景 2026-09-23 的病完全同源
 * （见 `scene-codes.ts` 的 `LOW_REASONING_SCENES` 注释），所以按同一口径真打一轮。
 *
 * ────────────────── ★ 2026-10-01：结论已落地（本探针就是那条证据） ──────────────────
 *
 * 那次「按同口径真打一轮」的结果（gpt-5.6-sol、每组 3 次样本）：
 *
 *   变体          耗时样本（s）        中位    完成 token   acceptLines
 *   不压思考      53.6 / 38.0 / 53.3   ~53    595/595/803   2/2
 *   压 low        8.4 / 6.0 / 6.8      ~6.8   77/77/77      2/2
 *
 * ⇒ `SCENE.subtitle_split` 已加入 `LOW_REASONING_SCENES`（中位 7.8 倍提速、质量持平）。
 * 本脚本**保留**：它是「换模型 / 换通道 / 改提示词之后要不要继续压」的复核工具，
 * 也是 `scene-codes.ts` 那句「要扩到别的场景时必须先按上表口径真打一轮」的执行者。
 * ⚠ 它的默认 `PROBE_SOURCE=subtitle-split-52` 取的是**旧提示词**的快照；
 *   只想量耗时波动时够用，要连**新提示词的断句质量**一起看就传一个新近的 requestId：
 *   `PROBE_SOURCE=<新近 requestId> PROBE_ONLY=gpt PROBE_REPEAT=3 npx tsx scripts/probe-subtitle-split-timing.ts`
 *
 * ★ 为什么**直连适配器**而不是走 `gateway.runScene`：
 *   ① 走网关只能拿到库里配的那个 `reasoningEffort`，无法 A/B；
 *   ② 走网关**会写 ai_call_log**，而 24h 内的真实成功正是健康体检免探测的依据
 *      —— 拿探针给自己刷「健康证据」会把盲区越埋越深。
 *
 * ★ 质量判据不自己发明：直接用**生产同款** `acceptLines()` 判「这一条 AI 结果能不能上屏」，
 *   于是「压思考之后是否变差」变成一个可数出来的通过率，而不是主观印象。
 *
 * 用法（★ 必须在服务器 server/ 目录跑；本地库没有 promptSnapshot）：
 *   PROBE_REPEAT=2 npx tsx scripts/probe-subtitle-split-timing.ts
 *   PROBE_ONLY=gpt npx tsx scripts/probe-subtitle-split-timing.ts
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { getAdapter } from '../src/ai/adapters.js'
import { decryptSecret } from '../src/lib/secret.js'
import { acceptLines, boundaryHitRate } from '../src/render/subtitle-split.service.js'
import { SUBTITLE_MAX_WIDTH } from '../src/render/synthesis.js'

const prisma = new PrismaClient()
const SCENE_CODE = 'subtitle_split'
/** 探针自己的超时：**故意给得很宽**，目的是量出「真实要跑多久」，不是替生产设卡。 */
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 200_000)
/** 单次样本说明不了波动 —— 重复跑才能看出「什么时候会越过 30s」。 */
const REPEAT = Number(process.env.PROBE_REPEAT ?? 2)
/** 取材用的真实请求：它带 promptSnapshot（真实提示词 + 真实待分行文本）。 */
const SOURCE_REQUEST_ID = process.env.PROBE_SOURCE ?? 'subtitle-split-52'

interface Variant {
  label: string
  modelId: bigint
  reasoningEffort?: 'low'
}

const ALL_VARIANTS: Variant[] = [
  { label: 'gpt      不压', modelId: 21n },
  { label: 'gpt      压low', modelId: 21n, reasoningEffort: 'low' },
  { label: 'claude   不压', modelId: 6n },
  { label: 'claude   压low', modelId: 6n, reasoningEffort: 'low' },
  { label: 'deepseek 不压', modelId: 7n },
  { label: 'deepseek 压low', modelId: 7n, reasoningEffort: 'low' },
]
const ONLY = process.env.PROBE_ONLY ?? ''
const VARIANTS = ALL_VARIANTS.filter((v) => !ONLY || v.label.includes(ONLY))

/** 从真实提示词里把「待分行文本」抠回来 —— 它就是 `acceptLines` 的 original。 */
function parseOriginals(prompt: string): string[] {
  const found = new Map<number, string>()
  for (const line of prompt.split('\n')) {
    const m = /^(\d+)｜(.*)$/.exec(line.trim())
    const [, index, text] = m ?? []
    if (index !== undefined && text !== undefined) found.set(Number(index), text)
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text)
}

/** 模型输出 → 质量读数：JSON 行数 + 「生产同款 acceptLines」逐条判定 + 断点命中率。 */
function inspect(text: string, originals: string[]) {
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s < 0 || e <= s) return { lines: 0, accepted: 0, hitRate: '-', detail: '没有 JSON 对象' }
  let parsed: { lines?: unknown }
  try {
    parsed = JSON.parse(text.slice(s, e + 1)) as { lines?: unknown }
  } catch (err) {
    return { lines: 0, accepted: 0, hitRate: '-', detail: `JSON 解析失败 ${(err as Error).message.slice(0, 30)}` }
  }
  const rows = parsed?.lines
  if (!Array.isArray(rows) || rows.length !== originals.length) {
    return {
      lines: Array.isArray(rows) ? rows.length : 0,
      accepted: 0,
      hitRate: '-',
      detail: `条数不符（给 ${Array.isArray(rows) ? rows.length : 0}，要 ${originals.length}）`,
    }
  }
  let accepted = 0
  /**
   * ★ 断点配额（2026-10-01 增补）：`acceptLines` 只守**硬底线**（不超宽/不丢字/不劈词），
   *   它对「把小意思各切一半拼起来」这种**恰恰是用户抱怨的**切法是**放行**的
   *   —— 那种结果每条都合法。所以「压思考之后质量是否变差」不能只看 acceptLines，
   *   还要看断点落在原文停顿处的比例。两者一起看才不是自欺。
   */
  let hitHits = 0
  let hitTotal = 0
  for (let i = 0; i < originals.length; i += 1) {
    const row = rows[i]
    if (acceptLines(row, originals[i] ?? '', SUBTITLE_MAX_WIDTH)) accepted += 1
    const lineArr: string[] = Array.isArray(row) ? (row as unknown[]).map((x) => String(x)) : []
    const rate = boundaryHitRate(lineArr, originals[i] ?? '')
    hitHits += rate.hits
    hitTotal += rate.total
  }
  return { lines: rows.length, accepted, hitRate: hitTotal ? `${hitHits}/${hitTotal}` : '-', detail: '' }
}

async function main() {
  const scene = await prisma.aiScene.findUniqueOrThrow({ where: { code: SCENE_CODE } })
  console.log(`场景 ${SCENE_CODE}：default_model_id=${scene.defaultModelId} fallback=${JSON.stringify(scene.fallbackModelIds)}`)
  console.log(`  timeout_ms=${scene.timeoutMs} max_output_tokens=${scene.maxOutputTokens} temperature=${scene.temperature} kind=${scene.kind}`)

  const log = await prisma.aiCallLog.findFirst({ where: { requestId: SOURCE_REQUEST_ID } })
  const prompt = log?.promptSnapshot ?? ''
  if (!prompt) throw new Error(`${SOURCE_REQUEST_ID} 没有 promptSnapshot，换一个 PROBE_SOURCE`)
  const originals = parseOriginals(prompt)
  console.log(`\n取材 ${SOURCE_REQUEST_ID}：提示词 ${prompt.length} 字符，待分行 ${originals.length} 条`)
  for (const [i, o] of originals.entries()) console.log(`   ${i}｜${o}`)
  console.log(`  （线上那次 completion_tokens=${log?.completionTokens} latency=${((log?.latencyMs ?? 0) / 1000).toFixed(1)}s model=#${String(log?.modelId)}）\n`)

  const rows: string[] = []
  for (const v of VARIANTS) {
    const model = await prisma.aiModel.findUniqueOrThrow({ where: { id: v.modelId }, include: { provider: true } })
    const adapter = getAdapter(model.provider.protocol)
    for (let round = 1; round <= REPEAT; round += 1) {
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
        const info = inspect(res.text, originals)
        const verdict = res.usage.completionTokens <= 600 ? '★压思考成功' : '（仍偏大）'
        line =
          `${v.label.padEnd(14)}#${round}｜${(ms / 1000).toFixed(1)}s｜完成 token ${String(res.usage.completionTokens).padStart(5)}` +
          `｜acceptLines ${info.accepted}/${originals.length}｜断点命中 ${info.hitRate}` +
          (info.detail ? `｜${info.detail}` : '') +
          `｜${verdict}`
      } catch (err) {
        const ms = Date.now() - t0
        line = `${v.label.padEnd(14)}#${round}｜${(ms / 1000).toFixed(1)}s｜✗ ${(err as Error).message.slice(0, 70)}`
      }
      console.log(line)
      rows.push(line)
    }
  }

  console.log('\n════════ 汇总 ════════')
  for (const r of rows) console.log(r)
  console.log('\n判据：耗时与完成 token 显著下降 ⇒ 压思考成立；')
  console.log('      acceptLines 通过率**与**断点命中率都相当 ⇒ 质量没被压差（只看前者会放过「半句拼半句」）。')

  await prisma.$disconnect()
  process.exit(0)
}

main().catch(async (e) => {
  console.error('探针异常：', e)
  await prisma.$disconnect()
  process.exit(1)
})
