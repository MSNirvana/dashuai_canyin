// 口播文案的展示分段（纯函数，无任何依赖 —— 这样守护脚本能直接跑它，见 scripts/verify-copy-paragraphs.ts）。
//
// ★ 为什么必须在前端做，而不是改提示词：
//   四个文案提示词都明确要求「只输出文案正文，不要标题、不要分点」，所以库里存下来的
//   `copyText` 是**一整块没有换行**的 80~150 字文本。`white-space: pre-wrap` 只能保留
//   **已有**的换行，救不了「本来就没有换行」。而且放在前端，**存量作品立刻就能变分段**。
//
// ★ 分段的安全底线：**绝不切断句子**。
//   口播文案是要照着念的，切在错误的位置比不分段更难受；而且这种错不会报错，只会读起来别扭。
//   所以：只在标点处切，且宁可少分段、也不硬凑段数。
//
// 分几段：按字数估（约 70 字一段），上限 3 段，且**段数不会超过句子数** ——
// 一句话不会因为「目标段数够多」而被劈开。

/** 句末标点：真正的句子边界，优先用它切 */
const HARD_END = new Set(['。', '！', '？', '!', '?', '…'])
/** 停顿标点：只有在**完全找不到句末标点**时才退而求其次地用它 */
const SOFT_END = new Set(['；', ';', '，', ',', '、'])

/** 每段目标字数：用来估算该分几段 */
const TARGET_CHARS_PER_PARAGRAPH = 70
/** 默认最多分几段 */
const MAX_PARAGRAPHS = 3
/** 长于这个字数、又完全没有句末标点时，才允许用停顿标点兜底 */
const SOFT_BREAK_MIN_CHARS = 60

export interface SplitCopyOptions {
  /** 最多分几段（默认 3） */
  maxParagraphs?: number
  /** 每段目标字数（默认 70）；短于它就基本不会分段 */
  targetCharsPerParagraph?: number
}

/**
 * 按给定的标点集合切句。
 *
 * ★ 关键细节：**连续标点要一起吞掉**。`……` 是两个 `…` 字符，若逐个字符判定，
 * 会在第一个 `…` 处断句、把第二个 `…` 留成下一句的开头 —— 既切错了位置，
 * 段落还会以标点开头。`!?`、`？!` 同理。
 */
function splitSentences(text: string, enders: Set<string>): string[] {
  const out: string[] = []
  let buffer = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    buffer += ch
    if (!enders.has(ch)) continue
    while (i + 1 < text.length && enders.has(text.charAt(i + 1))) {
      i++
      buffer += text.charAt(i)
    }
    out.push(buffer)
    buffer = ''
  }
  if (buffer) out.push(buffer)
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * 把句子按**字数**均衡地分成 parts 段，**不切断句子**。
 * 做法：先算前缀字数，再为每个段落选一个最接近「理想切点」的句子下标，
 * 并强制「每段至少 1 句、且给后面每段至少留 1 句」—— 否则会切出空段落。
 */
function groupBalanced(sentences: string[], parts: number): string[] {
  const n = sentences.length
  const wanted = Math.max(1, Math.min(parts, n))
  if (wanted <= 1) return [sentences.join('')]

  const prefix: number[] = [0]
  for (const s of sentences) prefix.push((prefix[prefix.length - 1] ?? 0) + s.length)
  const total = prefix[n] ?? 0

  const bounds: number[] = [0]
  for (let p = 1; p < wanted; p++) {
    const target = (total * p) / wanted
    const min = (bounds[bounds.length - 1] ?? 0) + 1
    const max = n - (wanted - p)
    let best = min
    for (let i = min; i <= max; i++) {
      if (Math.abs((prefix[i] ?? 0) - target) < Math.abs((prefix[best] ?? 0) - target)) best = i
    }
    bounds.push(best)
  }
  bounds.push(n)

  const out: string[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    out.push(sentences.slice(bounds[i], bounds[i + 1]).join(''))
  }
  return out.filter((s) => s.length > 0)
}

/** 按字数估段数；封顶 maxParagraphs。注意这里只给「上限」，最终受句子数约束 */
function estimateParagraphs(chars: number, maxParagraphs: number, targetChars: number): number {
  return Math.max(1, Math.min(maxParagraphs, Math.ceil(chars / targetChars)))
}

/**
 * 把口播文案切成段落数组。**纯函数**：同一输入恒等输出，不读任何外部状态。
 *
 * 返回 `[]` 表示没有内容（空串 / 全空白）—— 调用方据此走「未生成」分支，不要当成一段空文本。
 */
export function splitCopyParagraphs(
  text: string | null | undefined,
  options: SplitCopyOptions = {},
): string[] {
  const maxParagraphs = Math.max(1, options.maxParagraphs ?? MAX_PARAGRAPHS)
  const targetChars = Math.max(1, options.targetCharsPerParagraph ?? TARGET_CHARS_PER_PARAGRAPH)

  // 统一换行符再判空：`\r\n` 与 `\n` 必须同口径，否则 Windows 侧产出的文案会被当成"有换行"
  const normalized = (text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []

  // ① 本来就有换行（模型偶尔自己分段，或用户手动编辑过）⇒ 尊重它，只做清洗。
  //    这里不追求"每段等长"：作者写下的分段意图比均衡更重要。
  if (normalized.includes('\n')) {
    const blocks = normalized.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 0)
    if (blocks.length > 1) return blocks
  }
  const flat = normalized.replace(/\n+/g, '')

  // ② 正常路径：按句末标点切句，再均衡分组
  const sentences = splitSentences(flat, HARD_END)
  if (sentences.length >= 2) {
    return groupBalanced(sentences, estimateParagraphs(flat.length, maxParagraphs, targetChars))
  }

  // ③ 整段一句、完全没有句末标点（模型偶尔会这样）：**只有文本确实够长**时，
  //    才退一步用停顿标点（；，、）切。宁可不分段，也不要在句子中间乱切。
  if (flat.length >= SOFT_BREAK_MIN_CHARS) {
    const soft = splitSentences(flat, SOFT_END)
    if (soft.length >= 2) {
      return groupBalanced(soft, estimateParagraphs(flat.length, maxParagraphs, targetChars))
    }
  }
  return [flat]
}

/**
 * 「复制」用的文案：与屏幕上的分段**保持一致**（段落之间空一行）。
 * 放成一个函数是为了让「段间用 \n\n」这个约定只有一处定义 ——
 * 否则展示用换行、复制用逗号这类不一致，用户只有在粘贴时才看得出来。
 */
export function copyTextParagraphs(text: string | null | undefined): string {
  return splitCopyParagraphs(text).join('\n\n')
}
