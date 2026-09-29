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
 * ★ 为什么 requestId 只用 taskId、不带时间戳/随机数：
 *   同一任务的素材与台词是**固定**的，分行自然也该固定。用确定性 requestId 的收益是
 *   ① worker 崩溃重跑（MAX_RESUME=3）时命中幂等去重，**不会重复扣用户的积分**；
 *   ② 重跑拿到的还是同一份分行 ⇒ 用户看到的仍是「同一版片子」。
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
  return lines
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
    const r = await runBilledScene(prisma, aiGateway, {
      sceneCode: SCENE.subtitle_split,
      merchantId,
      requestId: `subtitle-split-${String(input.taskId)}`,
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
