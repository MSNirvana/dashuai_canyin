/**
 * 全链路编码参数的**唯一出处**。
 *
 * ★★ 为什么必须有这个文件（2026-09-29 画质审计的结论）：
 *   同一个画面在默认 AI 档要**连续过 3~4 次有损编码** —— 口播裁剪 → 归一化 → 烧字幕，
 *   偶尔还要加上「冻结静音压缩 / 延长画面 / 整片调色」。改动之前这几步**全都写死 crf 23**，
 *   于是误差**逐代累积**：单看一次都不狠，叠起来就是肉眼可见的衰减。
 *
 *   修法不是「把 23 调小一点」，而是**把「中间产物」和「交付物」分成两档**：
 *     · 中间产物 → **近无损**：它们只是过路，职责不是省体积，不该在这里丢信息；
 *     · 交付物   → 交付档：只让**最后一趟**承担「压到交付体积」的责任。
 *   这样世代叠加基本不成立，而体积只在最后一次涨。
 *
 *   ★ 反过来说这条判据也解释了「为什么不能只改一个数」：只要中间产物还在用交付档，
 *     你无论把交付档调多高，前面几代的损失都已经发生了。
 *
 * ⚠⚠ 改这里的**任何**一个值，必须同步递增 `cache-keys.ts` 里的版本号：
 *   · 归一化产物（`INTERMEDIATE_CACHE_VERSION`）
 *   · 口播裁剪产物（`SPEECH_CUT_VERSION`）
 *   键里**不含编码参数** ⇒ 不递增就会继续命中按旧参数编出来的中间产物，
 *   结果是「改了跟没改一样」，而且**不报任何错、没有任何日志**。
 */

export interface EncodeTier {
  preset: string
  crf: number
}

/**
 * 中间产物档：**近无损**。
 *
 * crf 12 相对原来那一套 23 是**数量级**的差别（不是「稍微好一点」）：
 * ★ 2026-09-29 在服务器上拿真实素材实测（976×1920 源、4.13s、按本项目 scale/crop 后 veryfast 重编）：
 *     crf 23 → 1.84MB / 3570kbps ；crf 20 → 3.33MB / 6606kbps ；crf 12 → 11.28MB / 22729kbps
 *   ⇒ 中间产物体积约为旧的 **6.1 倍**（不是「3~5 倍」，按实测量报），交付件约 1.81 倍。
 * 换来的是「过路不丢信息」——这是消灭世代叠加的关键，也是本次唯一真正的画质改动。
 *
 * ★ preset 仍留 `veryfast`：中间产物是**出片时间的大头**（每段素材都要过一遍），
 *   换 medium 会让出片等待明显变长，而它在近无损 crf 下的增益很小。
 */
export const ENCODE_INTERMEDIATE: EncodeTier = { preset: 'veryfast', crf: 12 }

/**
 * 交付档：最终成片。
 *
 * ★ 由 23 提到 20：中间产物改近无损之后，交付这一趟是**唯一**一次真正的有损压缩，
 *   值可以给得更实（23 是在「每一代都按 23 压」的前提下定的旧值）。
 * ★ 体积代价约 +25~35%，只发生在此一处。
 */
export const ENCODE_DELIVERY: EncodeTier = { preset: 'veryfast', crf: 20 }

/**
 * 音频码率：128k → 192k。
 *
 * 语音在 128k 下齿音与气声已经开始发糊，而 192k 在交付件里只占**不到 3%** 的码率
 * （实测交付码率约 6600kbps ⇒ 192k 音频 ≈ 2.9%），是这条链上性价比最高的一处。
 * 音频同样会被重编多次（配音 → 混音 → 成片），中间那几趟也用同一个值，
 * 避免同一个道理在音频上再犯一遍。
 */
export const AUDIO_BITRATE = '192k'

/** 需要统一音频口径时用的采样率/声道数（原来散在各处的字面量 `44100` / `2`）。 */
export const AUDIO_SAMPLE_RATE = '44100'

/**
 * 视频编码参数（**不含** `-movflags`，由调用方按各自需要追加）。
 *
 * ★ 抽成函数而不是让各处抄一遍，是因为这一串以前在 10 个地方各写了一份，
 *   改动时漏掉一处就会长出「某条路径还是旧参数」的静默不一致。
 */
export function videoEncodeArgs(tier: EncodeTier = ENCODE_DELIVERY): string[] {
  return ['-c:v', 'libx264', '-preset', tier.preset, '-crf', String(tier.crf), '-pix_fmt', 'yuv420p']
}

/** 音频编码参数（保留输入自己的采样率/声道）。 */
export function audioEncodeArgs(bitrate: string = AUDIO_BITRATE): string[] {
  return ['-c:a', 'aac', '-b:a', bitrate]
}

/** 音频编码参数 + 显式 44.1k 立体声（归一化/裁剪这类需要统一口径的地方用）。 */
export function audioEncodeArgsStereo(bitrate: string = AUDIO_BITRATE): string[] {
  return [...audioEncodeArgs(bitrate), '-ar', AUDIO_SAMPLE_RATE, '-ac', '2']
}
