/**
 * 素材口播探针：判定「这条素材里哪一段真的有人在说话」，产出可裁剪的保留区间。
 *
 * ★★ 为什么需要它（2026-09-29，用户反馈「AI 剪辑没有删除无用片段」）：
 *   实测那条素材 19.48s 里有 **11.06s 是空白**（头 1.55s、尾 0.76s、中间 4 处 1.65~2.95s 的
 *   大停顿），全部原样进了成片。根因是**没有任何一步在按「有没有人在说话」裁画面**：
 *     · `ffmpeg.ts::probeMeaningfulRange` 的静音分支被显式丢弃（注释：「静音不能单独驱动画面裁切」）
 *     · `chatcut-driver.ts` 的转写**只跑在 TTS 配音轨**上，用户素材从未被分析
 *   ⇒ `Shot.trimStartMs` 恒为 0 ⇒ 首尾废片必然保留。
 *
 * ★★ 为什么判据是「词级时间戳」而不是音量阈值（详见 `speech-range.ts` 头部）：
 *   这条素材底噪被抬到 `-16dB`、峰值已削顶 0dB，说话与不说话的差只有约 10dB，
 *   `silencedetect` 在 -40/-30/-28/-25dB + 各种高通组合下**全部零命中**。
 *   词级时间戳是语义级判据，与底噪无关，也不需要调参。
 *
 * ★★ 本模块的三条铁律（改它之前先读这三条）：
 *   1. **判不出来就什么都不做**。ASR 未配置、素材超 60s/3MB、识别失败、人声覆盖率过低
 *      —— 一律返回 `keepRanges: null`，调用方必须原样保留素材。**绝不允许**在判据缺失时
 *      退回某个「默认裁剪比例」——那会把纯环境音素材剪空。
 *   2. **判定结果要落库**（`Shot.keepRanges`）。有两个不能省的后果：
 *      ① 每次重合成都重跑一次 ASR 是白花钱；
 *      ② 更严重的是**不稳定** —— 同一素材两次识别可能给出差几十毫秒的词边界，
 *         于是「只改调色重合成」会把剪辑点也一起改掉，而用户预期只变颜色。
 *         归一化中间产物缓存键也因此必须把这份计划算进去（见 `cache-keys.ts`）。
 *   3. **结论要带版本与参数指纹**。判据或阈值一变，旧结论必须失效重算 ——
 *      不然会出现「改了阈值但线上一点变化都没有」这种查半天的问题。
 *      版本号 `SHOT_SPEECH_VERSION` 等价于 `cache-keys.ts` 的 `INTERMEDIATE_CACHE_VERSION`。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { prisma } from '../db.js'
import { downloadToFile } from '../lib/cos.js'
import { ffmpegExtractAudio, probeDurationMs } from './ffmpeg.js'
import { transcribeWordsShort } from './transcription.js'
import {
  parseShotSpeechPlan,
  shotSpeechOptions,
  SHOT_SPEECH_VERSION,
  speechKeepRanges,
  type KeepRange,
  type ShotSpeechPlan,
  type SpeechKeepOptions,
} from './speech-range.js'

/**
 * ⚠ `SHOT_SPEECH_VERSION` / `ShotSpeechPlan` / `shotSpeechOptions` / `parseShotSpeechPlan`
 *   **住在 `speech-range.ts`**（纯函数模块），这里只做转发。
 *   原因：它们是「拿旧结论前先验一遍」的判据，必须有守护脚本覆盖；
 *   而本文件 import 了 `prisma` 与 COS，守护脚本一旦引用就会连库、连网 ⇒ 闸门会被跳过。
 */
export { SHOT_SPEECH_VERSION, shotSpeechOptions, parseShotSpeechPlan }
export type { ShotSpeechPlan }

export interface ShotSpeechResult {
  /**
   * 要保留的区间（素材绝对坐标）。
   * ★ `null` = **判不出来** ⇒ 调用方必须原样保留素材，绝不能裁。
   * ★ `[]`  = 判过了、结论是「没什么可剪的」⇒ 同样不裁，但**不要**再重复探测。
   */
  keepRanges: KeepRange[] | null
  /** 是否是一次**成功**的判定（只有 true 才允许写回 `Shot.keepRanges`） */
  resolved: boolean
  source: 'CACHE' | 'PROBE'
  /** 排查用的一句话说明 */
  note: string
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  const raw = (value ?? '').trim().toLowerCase()
  if (!raw) return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw)
}

/** 总开关。默认**开**；置 false 可一键回到改动前的行为（不裁任何东西）。 */
export function shotSpeechTrimEnabled(): boolean {
  return envBool(process.env.SHOT_SPEECH_TRIM_ENABLED, true)
}

/**
 * 主入口：拿到「该保留哪些区间」。
 *
 * @param input.cached      已从库里读到的 `Shot.keepRanges` 原值（调用方读，避免这里再查一次库）
 * @param input.localPath   已经下好的本地素材文件。给了就不重复下载（本地 ffmpeg 路径已经下过）
 * @param input.shotId      给了才写回库（ChatCut 路径与本地路径都拿得到）
 */
export async function resolveShotSpeech(input: {
  cosKey: string
  durationMs?: number | null
  cached?: unknown
  localPath?: string | null
  shotId?: bigint | null
  enabled?: boolean
}): Promise<ShotSpeechResult> {
  const enabled = input.enabled ?? shotSpeechTrimEnabled()
  if (!enabled) return { keepRanges: null, resolved: false, source: 'PROBE', note: '总开关已关闭' }

  const options = shotSpeechOptions()

  // ── 1) 库里的结论优先。命中就直接复用，一次 ASR 都不花。
  const cached = parseShotSpeechPlan(input.cached, options)
  if (cached) {
    return {
      keepRanges: cached.ranges,
      resolved: true,
      source: 'CACHE',
      note: `复用库中结论（${cached.ranges.length} 段保留）`,
    }
  }

  let dir: string | null = null
  try {
    // ── 2) 素材时长。判不出来就不裁。
    const durationMs = input.durationMs && input.durationMs > 0
      ? Math.round(input.durationMs)
      : null
    let sourcePath = input.localPath ?? null
    let assetMs = durationMs
    if (!sourcePath || !assetMs) {
      dir = await mkdtemp(join(tmpdir(), 'shot-speech-'))
      const downloaded = join(dir, basename(input.cosKey) || 'asset.mp4')
      await downloadToFile(input.cosKey, downloaded)
      sourcePath = sourcePath ?? downloaded
      assetMs = assetMs ?? ((await probeDurationMs(sourcePath)) ?? null)
    }
    if (!sourcePath) return { keepRanges: null, resolved: false, source: 'PROBE', note: '素材不可读' }
    if (!assetMs || assetMs <= 0) {
      return { keepRanges: null, resolved: false, source: 'PROBE', note: '探不到素材时长' }
    }
    if (assetMs > 60_000) {
      // ★ 超短音频接口上限（60s）。**不降级到长音频**：调用方语义是「判不出来就不剪」，
      //   为一条长素材去跑分钟级异步任务不划算。也不写缓存 —— 素材时长不变，但
      //   以后若放宽上限，这条旧结论会挡住重算。
      return { keepRanges: null, resolved: false, source: 'PROBE', note: `素材 ${assetMs}ms 超过短音频上限` }
    }

    // ── 3) 抽 16k 单声道 wav 后识别词级时间戳
    if (!dir) dir = await mkdtemp(join(tmpdir(), 'shot-speech-'))
    const wavPath = join(dir, 'audio.wav')
    await ffmpegExtractAudio(sourcePath, wavPath)
    const words = await transcribeWordsShort(wavPath)
    if (!words) {
      return { keepRanges: null, resolved: false, source: 'PROBE', note: 'ASR 未配置或调用失败' }
    }

    // ── 4) 词级时间戳 → 保留区间
    //
    // ★ 用**视频**时长而不是音频时长当分母：词时间戳是相对音频起点的，而 `-vn` 抽音不移动起点。
    //   音频时长与视频时长差几十毫秒是容器/编码的常态，拿小的那个当分母会把尾部多算一截空白。
    const plan = speechKeepRanges({ durationMs: assetMs, words: words.words, options })

    const text = words.text.replace(/\s+/g, '').slice(0, 120)
    const stored: ShotSpeechPlan = {
      v: SHOT_SPEECH_VERSION,
      ranges: plan?.ranges ?? [],
      pauseMs: options.pauseMs,
      padMs: options.padMs,
      durationMs: assetMs,
      text,
    }
    // 探测成功（哪怕结论是「没什么可剪的」）⇒ 写回库，下次不再花 ASR
    const persisted = await persistShotSpeech(input.shotId ?? null, stored)
    const note = plan
      ? `识别 ${words.words.length} 词 → 保留 ${plan.ranges.length} 段（剪掉 ${plan.cutMs}ms）${persisted}`
      : `识别 ${words.words.length} 词 → 无可剪空白${persisted}`
    return { keepRanges: stored.ranges, resolved: true, source: 'PROBE', note }
  } catch (error) {
    // ★ 任何异常都退化成「不裁」—— 这里绝不能把渲染任务带崩（出片优先于剪得漂亮）
    return {
      keepRanges: null,
      resolved: false,
      source: 'PROBE',
      note: `探针失败：${(error as Error)?.message ?? String(error)}`,
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 写回 `Shot.keepRanges`。失败**只记日志**，绝不影响出片。 */
async function persistShotSpeech(shotId: bigint | null, plan: ShotSpeechPlan): Promise<string> {
  if (!shotId) return '（无 shotId，未落库）'
  try {
    await prisma.shot.update({ where: { id: shotId }, data: { keepRanges: plan as never } })
    return '（已落库）'
  } catch (error) {
    console.warn(`[shot-speech] 写入 Shot ${shotId} 的 keepRanges 失败：`, (error as Error).message)
    return '（落库失败，下次将重算）'
  }
}

/**
 * 只读地把「库里那份计划」读出来（不探测）。给不需要探测、只需要一个稳定哈希的场景用。
 * ★ 与 `resolveShotSpeech` 的区别：这个函数**永远不会**触发下载或 ASR。
 */
export async function readShotSpeechPlan(shotId: bigint): Promise<ShotSpeechPlan | null> {
  const row = await prisma.shot.findUnique({ where: { id: shotId }, select: { keepRanges: true } })
  return parseShotSpeechPlan(row?.keepRanges, shotSpeechOptions())
}

/** 供诊断脚本使用：直接把一个本地素材文件跑一遍，返回识别文本与计划（不落库）。 */
export async function probeLocalShotSpeech(
  file: string,
  options?: SpeechKeepOptions,
): Promise<{ text: string; audioDurationMs: number; words: number; plan: ReturnType<typeof speechKeepRanges> } | null> {
  const merged = { ...shotSpeechOptions(), ...(options ?? {}) }
  const durationMs = await probeDurationMs(file)
  if (!durationMs) return null
  const dir = await mkdtemp(join(tmpdir(), 'shot-speech-probe-'))
  try {
    const wavPath = join(dir, 'audio.wav')
    await ffmpegExtractAudio(file, wavPath)
    const recognized = await transcribeWordsShort(wavPath)
    if (!recognized) return null
    const plan = speechKeepRanges({ durationMs, words: recognized.words, options: merged })
    return { text: recognized.text, audioDurationMs: recognized.audioDurationMs, words: recognized.words.length, plan }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
