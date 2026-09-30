/**
 * AI 字幕分行 —— 把 ASR 认出来的整段口语，交给模型切成一屏一条的字幕行。
 *
 * ⚠⚠ 与 `edit-plan.service.ts` 同一条硬纪律：**绝不抛错**。
 *
 *   出片链路里，分行是一个**增强步骤**：它失败的最坏后果应该是「按内建算法分行」，
 *   而**绝不能**是「整单 FAILED、用户白等 4 分钟、还得退积分」。
 *   所以下面每一个失败分支（开关关、没有待分行文本、AI 调用抛错、模型返回的不是 JSON、
 *   JSON 合法但行数与输入对不上、行里有丢字/加字/超宽）都**返回空 Map 而不是 throw**，
 *   调用方拿到空 Map 就完全走内建的 `splitSubtitleText` —— 那条路径是早就跑通的。
 *
 * ★ 为什么一次调用处理**全部**待分行文本，而不是逐条调用：
 *   逐条必然把「一次调用」变成「N 次调用」，N 次等待直接压在出片预算上（同 `editPlan` 给
 *   `shotPlanInput` 整段清单而不是 `shot1`/`shot2` 下标变量的理由）。
 *
 * ★ 为什么 requestId 默认只用 taskId、不带时间戳/随机数：
 *   同一任务的素材与台词是**固定**的，分行自然也该固定。用确定性 requestId 的收益是
 *   ① worker 崩溃重跑（MAX_RESUME=3）时命中幂等去重，**不会重复扣用户的积分**；
 *   ② 重跑拿到的还是同一份分行 ⇒ 用户看到的仍是「同一版片子」。
 *
 * ★★ 但「确定性 requestId」有一个致命副作用（2026-09-30 生产实测踩到）：
 *   `runBilledScene` 在业务请求已是 `FAILED` 时，**不重新调用、直接返回兜底模板**
 *   （见 `ai.service.ts` 的「!claim.created 且 status==='FAILED'」分支）。
 *   于是**同一个 task 一旦失败过，之后每次重跑都拿不到 AI 分行**，永久退回内建算法 ——
 *   而日志上只有一句「走了兜底模板」，分不清是「这次失败」还是「上次的失败还挂着」。
 *   生产证据：`subtitle-split-51` / `subtitle-split-54` 两条业务请求都是 FAILED，
 *   错误一致为三个候选各 30s 超时（`[tokenbox-deepseek/deepseek-v4-flash] request timeout after 30000ms`）。
 *   ⇒ 修法：**成功/进行中复用原 requestId（保住幂等、不重复扣费），
 *     仅当上一次是 FAILED 时换一个新 ID 重试**（失败路径本已全额解冻，重试不会重复扣钱）。
 *
 * ★★ 为什么校验要严到「逐字相同」：
 *   模型在这里唯一被允许做的事是**决定在哪里换行**。一旦它顺手改了字、丢了字、
 *   把「评论区扣一」并掉，字幕就与口播**对不上** —— 那正是我们要修的问题本身。
 *   所以对齐不上就整条作废、退回内建算法，宁可不优化。
 */
import { prisma } from '../db.js'
import { aiGateway } from '../ai/gateway-instance.js'
import { runBilledScene } from '../ai/ai.service.js'
import { SCENE } from '../ai/scene-codes.js'
import { SUBTITLE_MAX_WIDTH, subtitleDisplayWidth } from './synthesis.js'

/**
 * 运维开关。**默认开**（用户 2026-09-29 明确要求「需要 AI 做好分行」）。
 * 显式写 `SUBTITLE_AI_SPLIT_ENABLED=false` 才关。
 *
 * ★ 与 `CHATCUT_EDL_ENABLED` 同一个理由默认「开」：关掉时用户看到的现象是
 *   「字幕又变回按宽度硬切」，而这与「开关忘了配」在界面上**完全无法区分**。
 */
export function subtitleSplitEnabled(): boolean {
  return process.env.SUBTITLE_AI_SPLIT_ENABLED?.trim().toLowerCase() !== 'false'
}

export interface SubtitleSplitRequest {
  /** 商户编号。★ 接受 string：驱动层的 merchantId 是**序列化过的字符串**，转换必须在本模块内做 */
  merchantId: string | bigint
  /** 渲染任务 id（决定 requestId，必须稳定） */
  taskId: string | number | bigint
  /** 按时间顺序排列的待分行文本（**已合并**过的语义段，见 `mergeSubtitleSegments`） */
  texts: readonly string[]
  /** 每行字数上限；缺省取当前生效的 `SUBTITLE_MAX_WIDTH` */
  maxWidth?: number
}

export interface SubtitleSplitOutcome {
  /** 原文 → 行数组。空 Map = 没拿到可用结果，调用方走内建算法 */
  lines: Map<string, string[]>
  /** 给日志看的一句话；成功与失败都会给 */
  notice: string
}

/** 比较用：去掉全部标点与空白（模型被要求「标点全部去掉」，此处只是宽容一点） */
const PUNCT_AND_SPACE = /[。．，、；：！？…⋯·,.!?;:~\s"'“”‘’「」『』【】《》〈〉（）()\[\]{}—–-]/g

function comparable(text: string): string {
  return text.replace(PUNCT_AND_SPACE, '')
}

/** 两字以内的口水词/尾巴不应独占一屏；它们必须与相邻语义合并后重新均分。 */
const WEAK_STANDALONE = new Set(['哎呀', '哎哟', '哎呦', '嗯', '啊', '呀', '哦', '呃', '额', '这个', '那个'])
const BAD_LINE_END = /[的了着啊呀呢吧嘛么和与及又就把给在是只别不也都还]$/
const BAD_LINE_START = /^[的了着啊呀呢吧嘛么和与及又就把给在是只别不也都还]/

function isWeakStandalone(line: string): boolean {
  return WEAK_STANDALONE.has(line) || subtitleDisplayWidth(line) <= 2
}

/** 原文标点后的字符位置；重新均分时优先沿用真实语气停顿，避免从词中间劈开。 */
function punctuationBoundaries(original: string): Set<number> {
  const boundaries = new Set<number>()
  let offset = 0
  for (const char of original) {
    if (comparable(char) === '') {
      if (offset > 0) boundaries.add(offset)
      continue
    }
    offset += char.length
  }
  return boundaries
}

function bestSplit(text: string, maxWidth: number, preferred: Set<number>): [string, string] | null {
  const candidates: Array<{ left: string; right: string; score: number }> = []
  for (let index = 1; index < text.length; index += 1) {
    const left = text.slice(0, index)
    const right = text.slice(index)
    const leftWidth = subtitleDisplayWidth(left)
    const rightWidth = subtitleDisplayWidth(right)
    if (leftWidth > maxWidth || rightWidth > maxWidth) continue
    const isPreferredBoundary = preferred.has(index)
    if (!isPreferredBoundary && (BAD_LINE_END.test(left) || BAD_LINE_START.test(right))) continue
    const punctuationBonus = isPreferredBoundary ? -100 : 0
    const shortPenalty = Math.min(leftWidth, rightWidth) < 4 ? 40 : 0
    candidates.push({ left, right, score: punctuationBonus + shortPenalty + Math.abs(leftWidth - rightWidth) })
  }
  candidates.sort((a, b) => a.score - b.score)
  const best = candidates[0]
  return best ? [best.left, best.right] : null
}

/**
 * 修复模型偶发的「哎呀」/「扣一」孤屏：保持逐字不变，只移动相邻两行的边界。
 * 修不了就返回原结果，交给后面的质量闸门拒绝，而不是硬吞一个更差的断点。
 */
export function rebalanceWeakLines(lines: string[], original: string, maxWidth: number): string[] {
  const result = [...lines]
  const preferred = punctuationBoundaries(original)
  for (let index = 0; index < result.length; index += 1) {
    if (!isWeakStandalone(result[index] ?? '') || result.length < 2) continue
    const neighborIndex = index === result.length - 1 ? index - 1 : index + 1
    const firstIndex = Math.min(index, neighborIndex)
    const combined = `${result[firstIndex]}${result[firstIndex + 1]}`
    const offset = result.slice(0, firstIndex).join('').length
    const localPreferred = new Set([...preferred].map((value) => value - offset).filter((value) => value > 0 && value < combined.length))
    const split = bestSplit(combined, maxWidth, localPreferred)
    if (!split) continue
    result.splice(firstIndex, 2, ...split)
    index = Math.max(-1, firstIndex - 1)
  }
  return result
}

/** 从模型输出里抠出 JSON 对象；抠不到返回 null */
function extractJson(text: string): unknown {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * 校验并归一化模型给的行数组。
 *
 * 返回 `null` = 这一条不可用（丢字/加字/超宽/空行）⇒ 整条退回内建算法。
 * ★ 为什么是「整条退回」而不是「把不合法的行剔掉再用剩下的」：
 *   剔掉一行就等于**丢了一句字**，字幕会与口播直接对不上 —— 比不优化严重得多。
 */
export function acceptLines(raw: unknown, original: string, maxWidth: number): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const lines: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return null
    // 标点一律不写进字幕（与 `splitSubtitleText` 同一口径）
    const line = item.replace(PUNCT_AND_SPACE, '').trim()
    if (!line) return null
    if (subtitleDisplayWidth(line) > maxWidth) return null
    lines.push(line)
  }
  // ★★ 逐字相同才算过：这是本模块唯一的硬底线（丢字/改字会让字幕与口播对不上）
  if (comparable(lines.join('')) !== comparable(original)) return null
  const balanced = rebalanceWeakLines(lines, original, maxWidth)
  if (balanced.some((line) => subtitleDisplayWidth(line) > maxWidth || isWeakStandalone(line))) return null
  if (comparable(balanced.join('')) !== comparable(original)) return null
  return balanced
}

/** 待分行文本 → 提示词里的编号清单 */
export function buildLineInput(texts: readonly string[]): string {
  return texts.map((text, index) => `${index}｜${text}`).join('\n')
}

/**
 * 生成分行。**永不抛错** —— 任何失败都退化成空 Map。
 */
export async function breakSubtitleLines(input: SubtitleSplitRequest): Promise<SubtitleSplitOutcome> {
  const empty = (notice: string): SubtitleSplitOutcome => ({ lines: new Map(), notice })

  if (!subtitleSplitEnabled()) return empty('AI 分行已关闭（SUBTITLE_AI_SPLIT_ENABLED=false）⇒ 用内建算法')

  // 相同的文本只处理一次（ASR 会重复出「哎呀」这种短句；去重后编号仍与传入顺序一致）
  const unique: string[] = []
  for (const text of input.texts) {
    const clean = String(text ?? '').trim()
    if (clean && !unique.includes(clean)) unique.push(clean)
  }
  if (!unique.length) return empty('没有待分行的文本 ⇒ 用内建算法')

  const maxWidth = input.maxWidth ?? SUBTITLE_MAX_WIDTH

  try {
    /**
     * ★ 转换放在 `try` **内**：非法编号会在这里抛出、被下面的 catch 接住 ⇒ 退化成内建算法，
     *   而不是在启动阶段抛错把整单打成 FAILED。
     * ★ 不能用 `Number()`：商户 id 是 bigint，超过 2^53 会**静默丢精度**、扣错账户。
     */
    const merchantId = typeof input.merchantId === 'bigint' ? input.merchantId : BigInt(input.merchantId)

    /**
     * requestId：默认 `subtitle-split-{taskId}`（确定性 ⇒ 重跑命中幂等、不重复扣费）。
     *
     * ★★ 但「上一次是 FAILED」时必须**换一个新 ID**：`runBilledScene` 对 FAILED 的旧请求
     *   是**直接返回兜底模板**的（不重新调用），沿用旧 ID 等于把「上次的失败」当成
     *   「这次的结果」⇒ AI 分行对这个 task **永久失效**，且日志只写「走了兜底模板」。
     *   FAILED 的业务请求本就是**全额解冻**的，所以换 ID 重试不会重复扣用户的积分。
     *   ⚠ 查询失败（例如库抖动）不该拖垮分行：catch 成 null ⇒ 退回确定性 requestId。
     */
    const baseRequestId = `subtitle-split-${String(input.taskId)}`
    const previous = await prisma.businessRequest
      .findFirst({
        where: { merchantId, operation: 'AI_SUBTITLE_SPLIT', requestId: { startsWith: baseRequestId } },
        orderBy: { id: 'desc' },
        select: { requestId: true, status: true },
      })
      .catch(() => null)
    const reusePrevious = previous?.status === 'COMPLETED' || previous?.status === 'PENDING'
    const requestId = reusePrevious
      ? (previous?.requestId ?? baseRequestId)
      : previous
        ? `${baseRequestId}-r${Date.now()}`
        : baseRequestId

    const r = await runBilledScene(prisma, aiGateway, {
      sceneCode: SCENE.subtitle_split,
      merchantId,
      requestId,
      variables: { lineInput: buildLineInput(unique), maxWidth: String(maxWidth) },
      bizId: String(input.taskId),
    })

    // 兜底模板 = 场景没配好/通道全挂，网关返回了一段预置文本 —— 那**不是**分行结果。
    if (r.isFallbackTemplate) return empty('AI 分行走了兜底模板 ⇒ 用内建算法')

    const parsed = extractJson(r.text) as { lines?: unknown } | null
    const rows = parsed?.lines
    if (!Array.isArray(rows) || rows.length !== unique.length) {
      return empty(`AI 分行结果与输入条数不符（给 ${Array.isArray(rows) ? rows.length : 0} 条，要 ${unique.length} 条）⇒ 用内建算法`)
    }

    const lines = new Map<string, string[]>()
    const rejected: string[] = []
    unique.forEach((text, index) => {
      const accepted = acceptLines(rows[index], text, maxWidth)
      if (accepted) lines.set(text, accepted)
      else rejected.push(`#${index}`)
    })

    if (!lines.size) return empty(`AI 分行结果全部不合法（${rejected.join('、')}）⇒ 用内建算法`)

    const changed = [...lines.values()].filter((value) => value.length > 1).length
    return {
      lines,
      notice:
        `AI 分行：${lines.size}/${unique.length} 条可用（其中 ${changed} 条被切成多行）` +
        (rejected.length ? `，${rejected.length} 条不合法已退回内建算法（${rejected.join('、')}）` : ''),
    }
  } catch (e) {
    // ★ 这里 catch 的是 runBilledScene 的一切失败：场景没建/被停用、候选链全灭、超时、熔断、积分不足……
    const msg = (e as Error)?.message ?? String(e)
    return empty(`AI 分行调用失败（${msg.slice(0, 80)}）⇒ 用内建算法`)
  }
}
