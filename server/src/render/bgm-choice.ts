/**
 * 配乐选曲的**纯逻辑**：把候选曲目写成给模型的清单、把模型返回的 JSON 解析成下标。
 *
 * ★ 为什么单独一个模块、而不是塞进 `bgm-select.service.ts`：
 *   那边一 import 就会拉起 `PrismaClient` 与网关单例（模块级副作用），于是**守护脚本没法测**。
 *   而「清单编号」与「下标解析」恰恰是这里最容易**静默**出错的两处：
 *   编号从 1 开始、解析时不校验范围、接受了一个不存在的下标 —— 三种写法都不会抛错，
 *   只会让片子配上另一首歌，或者永远悄悄退回随机。
 *   与 `edl.ts` / `edit-plan.service.ts` 的分工完全一致：纯函数进这里，调用与计费在 service 里。
 *
 * ★ 没有外部依赖（不连库、不联网、不读文件），可以放心被守护脚本直接 import。
 */
import type { BgmCandidate } from './bgm-library.js'

/** 模型该返回的东西：挑中的候选下标 + 一句理由 */
export interface BgmChoice {
  /** 候选清单里的下标，**从 0 开始**，且一定落在 `[0, count)` 内 */
  index: number
  /** 一句话理由；模型没给就是空串（不影响取用） */
  reason: string
}

/** 候选没有描述时占位用的文案。★ 必须是「人话」，否则模型会把占位符本身当成曲风特征。 */
const NO_NOTE = '（这一首没有留下描述）'

/**
 * 把候选曲目写成**带编号**的清单。
 *
 * ★ 编号必须从 **0** 开始，且与 `candidates` 的数组下标严格一一对应 ——
 *   模型返回的就是这个编号，而调用方拿它去 `candidates[index]` 取文件。
 *   写成从 1 开始（或只给一行行描述不给编号）不会报错，只会稳定地取错一首。
 * ★ 描述取自生成时的提示词（侧车 `prompt`），是本项目里唯一「能说清这首曲子长什么样」的文本。
 *   模型看不到音频，这就是它全部的判断依据。
 */
export function buildBgmOptionText(candidates: readonly BgmCandidate[]): string {
  return candidates.map((candidate, index) => `${index}. ${candidate.note?.trim() || NO_NOTE}`).join('\n')
}

/**
 * 解析模型返回的选曲 JSON。**任何不合规的输入都返回 `null`**（调用方据此退回随机抽取）。
 *
 * 宽容的地方（都是为了「模型偶尔不守格式」时不至于白花钱）：
 *   · 正文可能被 ``` 代码块或前后解释包着 ⇒ 取第一个 `{` 到最后一个 `}` 再解析
 *   · `index` 给成字符串 `"2"` 也认
 * 严格的地方（错了就会**静默配错歌**，所以一律拒收）：
 *   · `index` 必须是整数且落在 `[0, count)` —— 越界**不做夹取**：夹到 0 会让「模型写了 9」
 *     变成「永远选第一首」，那是把一个可见的错误换成一条看不见的规律。
 *   · 非 JSON、不是对象、没有 index ⇒ null
 */
export function parseBgmChoice(raw: string, count: number): BgmChoice | null {
  if (!Number.isInteger(count) || count <= 0) return null

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const rawIndex = (parsed as { index?: unknown }).index
  const index =
    typeof rawIndex === 'number'
      ? rawIndex
      : typeof rawIndex === 'string' && rawIndex.trim() !== ''
        ? Number(rawIndex)
        : Number.NaN
  if (!Number.isInteger(index) || index < 0 || index >= count) return null

  const rawReason = (parsed as { reason?: unknown }).reason
  // ★ 只用于日志，所以截断即可 —— 模型偶尔会写一整段，别让它把一个日志行撑爆
  const reason = typeof rawReason === 'string' ? rawReason.trim().slice(0, 80) : ''
  return { index, reason }
}
