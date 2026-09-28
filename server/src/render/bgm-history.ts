/**
 * 配乐的「门店维度历史」：这次出片实际用了哪一首，以及下次该避开哪几首。
 *
 * ── 它解决的是什么 ──────────────────────────────────────────────────────────
 * `bgm-dispatch.ts` 的进程内记忆只管「**同一时刻**别撞」，重启即失、也不区分门店。
 * 而用户真正会察觉的是「**我这个店**连着几条片子配了同一首曲子」—— 那需要一个
 * 跨重启、按门店记账的记忆，落点就是 `RenderTask.bgmTrack` 这一列。
 *
 * ★ 与另一条老路径的关系：`resolveBgmTrack()`（纯随机）与单文件兜底**完全不受影响** ——
 *   本模块只在「已经决定要记录/参考」的地方被调用，查不到历史时的行为与改动前一致。
 * ★ 本模块的读写都**绝不抛错**：配乐是增强步骤，把它搞挂不该影响出片。
 */
import { prisma } from '../db.js'
import { filterTracksByStyle } from './bgm-dispatch.js'

/**
 * 一次查询最多扫这么多条本门店的历史任务。
 *
 * ★ 为什么不是直接 `take: BGM_RECENT_AVOID`：历史里混着**别的风格**的曲子，而且
 *   中间可能有没配乐的任务。只取 3 条很可能一条都不属于当前风格 ⇒ 避开策略静默失效。
 *   取一个「足够覆盖近期几次同风格出片」的窗口，再在内存里按风格过滤。
 */
const HISTORY_SCAN_LIMIT = 60

/** worker 的租约（fencing token）—— 结构类型，避免与 worker.ts 互相 import */
export interface BgmHistoryFence {
  owner: string
  version: number
}

/**
 * 该门店**最近**在同风格下用过的曲子（最新在前）。
 *
 * ★ 任何失败都返回空数组 —— 调用方据此退化成「没有可避开的」，也就是本次改动之前的行为。
 */
export async function recentBgmTracksForMerchant(
  merchantId: bigint,
  style: string | undefined | null,
): Promise<string[]> {
  if (!style) return []
  try {
    const rows = await prisma.renderTask.findMany({
      where: { merchantId, bgmTrack: { not: null } },
      orderBy: { id: 'desc' },
      take: HISTORY_SCAN_LIMIT,
      select: { bgmTrack: true },
    })
    return filterTracksByStyle(
      rows.map((row) => row.bgmTrack),
      style,
    )
  } catch (error) {
    console.warn(
      `[bgm-history] 读取门店配乐历史失败（按「没有历史」处理）：${(error as Error)?.message ?? String(error)}`,
    )
    return []
  }
}

/**
 * 记下这次出片用的配乐。
 *
 * ★ 只按**租约**（fence）过滤、不按 `status = RUNNING` 过滤：写入点发生在渲染进行中，
 *   而收尾/失败的状态翻转可能与它竞争。带 fence 已经足够 —— 被回收重跑的任务 version 已自增，
 *   迟到的旧 owner 写 0 行、天然失权；再加 status 条件只会让一次正常的记录**静默丢**。
 */
export async function storeBgmTrack(
  taskId: bigint,
  file: string,
  fence?: BgmHistoryFence,
): Promise<void> {
  try {
    await prisma.renderTask.updateMany({
      where: { id: taskId, ...(fence ? { leaseOwner: fence.owner, leaseVersion: fence.version } : {}) },
      data: { bgmTrack: file },
    })
  } catch (error) {
    console.warn(
      `[bgm-history] task ${String(taskId)} 配乐记录写入失败（不影响出片）：${(error as Error)?.message ?? String(error)}`,
    )
  }
}
