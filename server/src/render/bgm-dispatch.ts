/**
 * 配乐**派发**：从本地池子里挑一首，并保证「同一个进程里相邻的几次出片」不会配到同一首。
 *
 * ── 为什么不能只用随机 ────────────────────────────────────────────────────────
 * 随机抽取的病是：它**没有记忆**。池子 30 首、同时有 6 条片子出片，两两撞同一首的概率约 40%
 * —— 而那几条片子正是**同时**被看到的两家不同门店。更糟的是同一家门店连着出 3 条：
 * 第 3 条撞前两条的概率约 10%，一个月 8 条约 64%（生日问题，见 `bgm-library.ts::BGM_POOL_TARGET`；
 * 那几个百分比是按当时池子 30 首算的，池子已提到 100 ⇒ 数变小、结论不变）。
 *
 * ★★ 关键结论（决定了本模块为什么长这样）：**「门店 + 时间」这类纯函数救不了并发撞车。**
 *   任何 `index = f(merchantId, now)` 的确定性映射，两条不同片子的碰撞概率**仍然是 1/N**，
 *   而且映射恰好相同的一对门店会**永久**撞在一起（比随机更差）。要让两次派发**一定**不同，
 *   必须有**共享的分配状态**在中间协调 ⇒ 所以这里是「**最近最少使用（LRU）**」：
 *   · 单进程（本项目就是单个 pm2 进程）内 ⇒ 相邻两次派发**必然**不同首（池子 ≥ 2 时）；
 *   · 一个池子会被**完整轮转一遍**才回到起点 ⇒ 池里每一首都真的用得上。
 *
 * ⚠ 踩过的坑（写下来免得下一个人再走一遍）：最初实现是「取第一个没被避开的那首」，
 *   配一个「避开最近 3 首」的**候选窗口**（那是派发器自己的窗口，不是门店维度那个深度，
 *   它早就删了）。结果第 5 首**永远轮不到** —— 因为容量为 3 的窗口一放宽，
 *   队首又变成可用了，序列稳定地落在 `A B C D A B C D…`，池子里剩下的曲子被永久饿死
 *   （比随机更浪费：随机至少每首都有机会）。**多样性要靠轮转，不是靠避让窗口。**
 *
 * ── 与「按门店避开用过的」的分工 ─────────────────────────────────────────────
 * 本模块的记忆活在**内存**里：重启即失，且不区分门店。它负责「同一时刻别撞」。
 * 跨重启、按门店维度的记忆由调用方从库里查出（`RenderTask.bgmTrack`）后作为 `exclude` 传进来。
 * 两者互补：`exclude` 是**硬过滤**，LRU 是**在剩下的里挑最久没用过的**。
 * ★★ `exclude` 是**整池**（`filterTracksByStyle` 不截断，见该函数注释）⇒ 一家门店在某个风格下
 *   **用过一遍之前不会听到重复的曲子**。这条路才是「同一家店别重样」的主力；
 *   LRU 管的是「池子被用遍之后（`exclude` 占空候选、只能放宽）仍然尽量错开」。
 * ★★ 但 AI 选曲那条路径**绕过本模块**：`worker.ts` 里 `selection?.file` 有值就**不调用**
 *   `dispatchBgmFromPool` ⇒「完整轮转」对它**不生效**，它的避重完全由 `exclude` 负责。
 *   这也正是 `note()` 存在的原因 —— AI 选走的那首必须回填进使用次序。
 *
 * ★ 池子为空时返回 `null`，调用方退回 `resolveBgmTrack()`（它会走单文件兜底）。
 *   本模块**绝不抛错**：配乐是增强步骤，任何失败都该退化成「按老规矩找一个文件」。
 */
import { dirname, resolve } from 'node:path'
import { bgmPoolDir, listBgmPool } from './bgm-library.js'

/**
 * 门店历史一次最多扫多少条任务（`bgm-history.ts` 的 `take`）。
 *
 * ── 为什么这里**没有**「避让深度」这个旋钮了（2026-09-28 删掉） ────────────────
 * 原先是 `BGM_HISTORY_AVOID = 3`，语义是「只要不和最近 3 首重样就行」——
 * 而 `A B C D A B C D…` 完全满足它，用户听到的却是「这家店老在几首里打转」。
 * 现在 `filterTracksByStyle` **不截断**：该门店在这个风格下用过的曲子**全部**拿去当避开集合，
 * 语义变成「池子里的曲子在这家店用过一遍之前不会再出现」。
 *   ★ 判据（记下来，免得被重新引入）：**保证不重样的连续条数 = 避让深度 + 1**。
 *     深度 3 ⇒ 只保证 4 条；**不截断 ⇒ 保证 N 条**（N = 池内数量）。
 *   ★ 守护里有一条用例拿「比池子目标还长」的历史来钉它 —— 退化成任何小常数都会红
 *     （先前写成 `= BGM_POOL_TARGET` 也是一种小常数，它当场被这条用例逮住）。
 *
 * ★★ 于是「扫描窗口」成了唯一的真正上限 —— **它必须 ≥ 池子大小 × 风格数**：
 *   `bgmTrack` 这一列里混着**别的风格**的曲子（还有退回单文件兜底写进来的条目），
 *   一个三种风格都在用的店，要凑出「LIGHT 整池 100 条」，窗口至少得装下约 300 条。
 *   窗口不够时 `filterTracksByStyle` 只会返回一个**短数组**、不报任何错
 *   ⇒ 避让**静默变浅**，又回到「老在几首里打转」。
 * ★★ 写成**字面量**而不是 `BGM_POOL_TARGET * BGM_STYLES.length`：写成算式会让守护里那条
 *   关系断言变成**恒等式**（怎么改都绿）。字面量 + 断言，才能做到「改池子目标的人被迫看一眼这里」。
 * ★ 代价只是每次出片多扫几百行**单列**数据（`select: { bgmTrack: true }`），相对 ffmpeg 可忽略。
 */
export const BGM_HISTORY_SCAN_LIMIT = 300

/**
 * LRU 记忆容量：最多记住多少首的「最近使用次序」。
 *
 * ★ 取一个明显大于常见池子大小的值即可 —— 它只影响内存（每项就是一条路径字符串），
 *   而当池子比它更大时，多出来的曲子会被当成「从没用过」，优先级反而最高，无害。
 */
export const BGM_LRU_CAPACITY = 200

/**
 * 纯函数：在 `target` 里挑**最久没有使用过**的那一首。
 *
 * @param target 允许挑的集合（已经过 `exclude` 过滤），**顺序必须稳定**
 * @param order  使用次序，**最新使用的在前**（`order[0]` 是上一次用的那首）
 *
 * ★ 从没使用过的（不在 `order` 里）优先级最高 ⇒ 保证池子里每一首都会被轮到，
 *   而不是「只有前几首在循环」（见文件头那个坑）。
 * ★ 同优先级时取 `target` 里靠前的 —— 让结果**完全确定**，守护才测得住。
 */
export function pickLeastRecent(target: readonly string[], order: readonly string[]): string | null {
  const list = target.filter((file) => Boolean(file))
  if (list.length === 0) return null
  const rankOf = (file: string): number => {
    const at = order.indexOf(file)
    // 从没使用过 ⇒ 排在最久之前（优先级最高）
    return at < 0 ? Number.POSITIVE_INFINITY : at
  }
  let best = list[0] ?? null
  if (!best) return null
  let bestRank = rankOf(best)
  for (const file of list) {
    const rank = rankOf(file)
    if (rank > bestRank) {
      best = file
      bestRank = rank
    }
  }
  return best
}

/** 一次派发的结果（给日志用） */
export interface BgmDispatch {
  file: string
  /** 是否因为「该门店的历史把候选全占了」而放弃了避开策略（放宽） */
  relaxed: boolean
  /** 池内总数与本次实际可用的数量，便于排查「为什么又重样了」 */
  poolSize: number
  usableSize: number
}

/** 一个风格的派发器。**每个风格一份记忆**：`LIGHT` 的近期使用不该影响 `UPBEAT` 的派发。 */
export interface BgmAllocator {
  dispatch(candidates: readonly string[], exclude?: readonly string[]): BgmDispatch | null
  /**
   * 把一首**不是本分配器发出的**曲子记进使用次序（用于 AI 选曲那条路径）。
   *
   * ★ 为什么需要它：AI 选曲直接从池子里挑、绕过 `dispatch`。若不做这一步，LRU 里就缺了这一首
   *   ⇒ 紧接着的下一次派发很可能**又把它发出去**，两条机制各记一半、等于没记。
   */
  note(file: string): void
  /** 只给测试用：清掉记忆，让断言互相独立 */
  reset(): void
}

export function createBgmAllocator(capacity: number = BGM_LRU_CAPACITY): BgmAllocator {
  /** 使用次序，**最新在前** */
  let order: string[] = []
  const cap = Math.max(0, Math.floor(capacity))

  const remember = (file: string): void => {
    if (cap <= 0) return
    order = [file, ...order.filter((item) => item !== file)].slice(0, cap)
  }

  return {
    dispatch(candidates, exclude = []) {
      const list = candidates.filter((file) => Boolean(file))
      if (list.length === 0) return null

      const blocked = new Set(exclude.filter((file) => Boolean(file)))
      const allowed = blocked.size > 0 ? list.filter((file) => !blocked.has(file)) : list
      // ★ 逐级放宽：历史把候选占满时宁可重样（也不能没有配乐）
      const relaxed = allowed.length === 0
      const target = relaxed ? list : allowed

      const file = pickLeastRecent(target, order)
      if (!file) return null
      remember(file)

      return { file, relaxed, poolSize: list.length, usableSize: allowed.length }
    },
    note(file) {
      if (typeof file === 'string' && file.trim()) remember(file)
    },
    reset() {
      order = []
    },
  }
}

/**
 * 进程级派发器（**每个风格一份**）。
 *
 * ★ 进程内的可变状态在这里是**刻意的**：它就是这个模块存在的理由（见文件头）。
 *   单进程部署下足够；将来若要多实例，这份记忆需要挪到共享存储（或接受按实例各记各的）。
 */
const allocators = new Map<string, BgmAllocator>()

function allocatorFor(style: string): BgmAllocator {
  let hit = allocators.get(style)
  if (!hit) {
    hit = createBgmAllocator()
    allocators.set(style, hit)
  }
  return hit
}

/**
 * 按风格从池子里派发一首。池子为空（没有 `assets/bgm/<风格>/` 目录、或里面没有可用文件）
 * 时返回 `null`，调用方应退回 `resolveBgmTrack()` 走单文件约定。
 *
 * @param exclude 该门店最近用过的曲子（绝对路径）。查不到就给空数组，行为退化成纯 LRU 轮转。
 */
export function dispatchBgmFromPool(
  style: string | undefined | null,
  exclude: readonly string[] = [],
): BgmDispatch | null {
  let pool: string[]
  try {
    pool = listBgmPool(style)
  } catch {
    // 读目录失败 = 没有池子，交给调用方兜底
    return null
  }
  if (pool.length === 0) return null
  try {
    return allocatorFor(String(style ?? '').trim().toUpperCase()).dispatch(pool, exclude)
  } catch {
    // 派发本身不该失败；万一失败也让调用方去走随机/单文件那条老路
    return null
  }
}

/** 只给测试用：清掉全部风格的派发记忆 */
export function resetBgmDispatch(): void {
  allocators.clear()
}

/**
 * 记下「这一首刚刚被用掉了」—— 供 **AI 选曲**那条路径回填使用次序（见 `BgmAllocator.note`）。
 * 绝不抛错：它只是记忆，坏了顶多多一次重样。
 */
export function noteBgmDispatched(style: string | undefined | null, file: string | undefined | null): void {
  if (typeof file !== 'string' || !file.trim()) return
  try {
    allocatorFor(String(style ?? '').trim().toUpperCase()).note(file)
  } catch {
    // 记忆失败无所谓
  }
}

/**
 * 纯函数：从一批历史配乐路径里，挑出**属于该风格池子**的那些，按原顺序返回。
 *
 * ★ 放在本模块（而不是 `bgm-history.ts`）是为了让守护**不连库**就能测它 ——
 *   `bgm-history.ts` 在 import 时就拉进 `PrismaClient`，守护脚本必须能独立跑。
 *
 * ★ 判据是「文件所在目录 == `assets/bgm/<风格>/`」而不是「路径里含风格名」——
 *   后者会把 `LIGHT.mp3` 这种**单文件**也算进来，而它不是池内候选，
 *   传去当 `exclude` 只会白占一个位置（永远匹配不上任何候选）。
 *
 * ★★ 不传 `limit` ⇒ **不截断**（返回全部同风格历史）。调用方 `bgm-history.ts` 就是这么用的：
 *   它拿到的是「这家店在这个风格下用过的**全部**曲子」⇒ 避开策略的语义是
 *   「池子用过一遍之前不再出现」。**别再给它加默认上限**（曾经是 3，也正是「老在几首里打转」
 *   的根因；连 `= 池子目标` 这种「够用」的上限都会被守护里那条长历史用例逮住）——
 *   判据见 `BGM_HISTORY_SCAN_LIMIT` 的注释：**保证不重样的连续条数 = 深度 + 1**。
 *   要临时只取最近 n 条，显式传 `limit`。
 *
 * @param limit 最多返回几条；**不传 = 全部**。`<= 0` 返回空数组（显式关掉避开）。
 */
export function filterTracksByStyle(
  files: readonly (string | null | undefined)[],
  style: string | undefined | null,
  limit?: number,
): string[] {
  if (!style) return []
  const cap = limit === undefined ? Number.POSITIVE_INFINITY : limit
  if (cap <= 0) return []
  const dir = bgmPoolDir(style)
  const hits: string[] = []
  for (const file of files) {
    if (typeof file !== 'string' || !file.trim()) continue
    if (resolve(dirname(file)).toLowerCase() !== resolve(dir).toLowerCase()) continue
    hits.push(file)
    if (hits.length >= cap) break
  }
  return hits
}
