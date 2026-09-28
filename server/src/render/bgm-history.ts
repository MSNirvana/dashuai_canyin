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
import { BGM_HISTORY_SCAN_LIMIT, filterTracksByStyle } from './bgm-dispatch.js'

/** worker 的租约（fencing token）—— 结构类型，避免与 worker.ts 互相 import */
export interface BgmHistoryFence {
  owner: string
  version: number
}

/**
 * 该门店在**同风格**下用过的曲子（最新在前）。
 *
 * ★★ 返回的是**全部**（扫描窗口内的每一条同风格记录），不截断成「最近几首」——
 *   调用方拿它当**硬过滤**，语义就是「这家店用过的曲子，用完一遍之前不再出现」。
 *   2026-09-28 之前它只取「最近 3 首」（一个叫 `BGM_HISTORY_AVOID` 的深度），那个深度已删掉：
 *   它只能保证 4 条不重样（判据：**保证不重样的条数 = 深度 + 1**），听感上就是「老在几首里打转」。
 * ★★ 于是**扫描窗口 `BGM_HISTORY_SCAN_LIMIT` 成了唯一的真正上限**，它必须够大，
 *   否则 `filterTracksByStyle` 只会返回一个短数组、**不报任何错** ⇒ 避重静默变浅。
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
      // ★ 窗口必须装得下「一整个风格的池子」，理由见 `BGM_HISTORY_SCAN_LIMIT` 的注释
      take: BGM_HISTORY_SCAN_LIMIT,
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
