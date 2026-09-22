/**
 * AI 档（ChatCut）镜头时长规划 —— **纯函数**：零 I/O、零环境依赖、零 import。
 *
 * ⚠⚠ 为什么把这段从 `chatcut-driver.ts` 里搬出来（2026-09-22 线上事故）：
 *
 *   这段逻辑原本长在 `startChatCutRender()` 体内，靠一串互相调用的**闭包**传递，
 *   而其中一个闭包在 `const fps = input.output.fps` **之前**就被 `clips.map()` 立即求值：
 *
 *     slotMs = clips.map(… scaledShotMs …)      // ← 这一句一执行就炸
 *        └ rawShotMs → handleMsOf → (handleFrames[i] / fps) * 1000
 *        └ handleFramesOf        → framesOf(…, fps)
 *     const fps = input.output.fps              // ← 声明在这里，太晚 ⇒ TDZ
 *
 *   ⇒ 线上每一次 AI 档合成都抛 `Cannot access 'fps' before initialization`。
 *
 *   ★★ 两个必须记住的判据：
 *     1) **`0 / fps` 也要先求值 `fps`** —— 「handleFrames 是 0，所以用不到 fps」是错的。
 *        JS 不会因为被除数是 0 就跳过除数的求值 ⇒ 这个 TDZ **与转场档位无关**，
 *        CLEAN（handleFrames 全 0）照样炸。当时的错误推断正是「CLEAN 档会提前 return，没事」。
 *     2) **typecheck / 构建 / 部署全看不见它** —— `const` 的 TDZ 只在运行时触发，而
 *        「闭包里引用了后面声明的变量」静态上无法判定（那个函数可能永远不在声明前被调用）。
 *        ⇒ 这类缺陷只能靠**真的把这段逻辑跑一遍**守住：`scripts/verify-chatcut-timing.ts`。
 *
 *   ★ 搬出来的收益（不只是修 bug）：
 *     · `fps` 变成**入参**，且函数体第一行就取它 ⇒ TDZ 在这段逻辑里结构上不可能再出现；
 *     · 不 import `chatcut.ts`（它 import 了 redis）⇒ 守护脚本能零依赖、零连接直接调用，
 *       把「9 种档位组合都能算完」变成每次提交都能验的闸门；
 *     · 档位表**仍然只有一份**（`chatcut.ts` 的 TRANSITION_PLANS / PACING_PLANS），
 *       这里只收**值**（handleFrames / shotScale / minShotMs）⇒ 不存在两份表漂移的问题。
 */

/** 转场余量上限：一个镜头最多把 15% 的时长让给转场（给短镜头兜底，见 handleFramesOf） */
export const TRANSITION_HANDLE_MAX_RATIO = 0.15

/**
 * 时间轴帧数。★ **必须向下取整，不能四舍五入。**
 *
 * ChatCut 会拿源素材的**真实**时长校验 `fromFrame + durationInFrames ≤ 素材时长`，超出**直接拒单**：
 *   `Source range exceeds video asset duration: … plus 90 frame(s) … ends at 3s,
 *    but asset … is 2.968s. Use durationInFrames <= 89`
 * 而客户端上报的分镜时长是**取整值**（实测 3000ms，真实只有 2968ms）⇒ 用 round 算出 90 帧就注定越界。
 * 所以时间轴一律按「探到的真实时长 + 向下取整」排帧（真实时长由 `remoteSource` 探测得到）。
 * `+1e-6` 是防浮点边界：本该整除时算出 89.999999 会白掉一帧。
 */
export function framesOf(ms: number, fps: number): number {
  return Math.max(1, Math.floor((ms / 1000) * fps + 1e-6))
}

/** 参与时长计算的分镜字段（只要这三个，`clips` 的真实类型结构化兼容） */
export interface ShotTimingClip {
  durationMs?: number | null
  trimStartMs?: number | null
  trimEndMs?: number | null
}

export interface ShotTimingParams {
  clips: readonly ShotTimingClip[]
  /**
   * 每段素材的**真实**时长（ms，探测所得）。`null` = 探测失败，退回 `clips[i].durationMs`。
   * ★ 绝不能改用客户端上报值：上报 3000ms / 真实 2968ms，按上报值排帧必被 ChatCut 拒单（见 framesOf）。
   */
  clipAssetMs: readonly (number | null)[]
  /** 时间轴帧率 */
  fps: number
  /** 转场档位要求为**每个镜头首尾各**预留的素材帧数（CLEAN = 0） */
  transitionHandleFrames: number
  /** 节奏档位的镜头缩放比（只允许 ≤ 1，见 scaledShotMs） */
  pacingShotScale: number
  /** 节奏档位的镜头时长下限（ms）；档位不带这个字段时传 0 */
  pacingMinShotMs: number
  /**
   * ★★ EDL（AI 剪辑决策表）的逐镜头目标时长（ms）。`null` / 下标越界 = 该镜头没有指令，
   *    仍按 `pacingShotScale` 缩放（见 scaledShotMs）。
   *
   * ★ 为什么走**入参**，而不是「算完再让调用方回头改写 slotMs」：
   *   转场余量 `handleFramesOf` 是按「该镜头修剪后的帧数」算的 —— 如果排轨前才回头改时长，
   *   余量与实际时长就对不上，转场仍会被判「余量不足」而拒单。
   *   放在入参里，`slotMs` 的初值天生就是 EDL 的值，两者必然同源。
   *
   * ⚠ 传进来的值只需保证「有限正数」；粗夹在 `edl.ts::clampShotMs`，
   *   而「不超素材可用时长」的严夹在下面 `scaledShotMs` 里（只有这里知道 rawShotMs）。
   */
  edlShotMs?: readonly (number | null)[] | null
}

export interface ShotTimingResult {
  /** 每个镜头首尾各预留的转场余量（帧）。余量不足 2 帧记 0 ⇒ 那个接缝走硬切。 */
  handleFrames: number[]
  /** 转场余量换算成毫秒 */
  handleMsOf: (index: number) => number
  /** **原始**可用时长（ms）：真实素材时长 ∧ trim ∧ 转场余量三重约束后的值（TTS 的合成目标） */
  rawShotMs: (index: number) => number
  /** **目标**时长（ms）= 原始时长套上剪辑节奏档位（只缩短） */
  scaledShotMs: (index: number) => number
  /** 每个镜头最终排到时间线上的时长（ms）初值；TTS 段会按配音实测长度按需抬高（同一数组引用） */
  slotMs: number[]
}

export function planShotTiming(params: ShotTimingParams): ShotTimingResult {
  // ★★ fps 与 edlShotMs 都在这里（函数体第一行）绑定：下面所有闭包捕获的都是**已绑定**的变量。
  //    改这个文件时请保持「入参先解构、再定义闭包」的顺序 —— 否则又会退化成 TDZ。
  const { clips, clipAssetMs, fps, edlShotMs } = params
  const wanted = params.transitionHandleFrames
  const shotScale = params.pacingShotScale
  const minShotMs = params.pacingMinShotMs

  /** 分镜的**trim 后**可用时长（毫秒，还没扣转场余量）。 */
  const trimmedShotMs = (index: number): number => {
    const clip = clips[index]!
    const assetMs = clipAssetMs[index] ?? clip.durationMs ?? clip.trimEndMs ?? 0
    if (assetMs <= 0) return 0
    const start = Math.max(0, clip.trimStartMs ?? 0)
    const end = clip.trimEndMs && clip.trimEndMs > start ? Math.min(clip.trimEndMs, assetMs) : assetMs
    return Math.max(0, end - start)
  }

  /**
   * 转场在每个镜头**首尾各**预留的素材帧数。
   *
   * ★★ 为什么要在排轨前就预留（而不是「排完轨再往接缝上贴转场」）：
   *   转场要消耗两侧的素材余量，而我们排轨时是把每段素材**用满**的
   *   （source [0, D)）⇒ 余量 0。实测 ChatCut 会直接拒：
   *     `transition duration 14f exceeds feasible visual transition limit 0f`。
   *   预留 = 让素材范围收成 `[handle, D-handle]`，时间线时长随之**变短** 2×handle 帧。
   *   ⇒ 这必须与「镜头时长」同源，否则 A1 的配音、V1 的画面、转场三者对不上。
   *
   * ★ 上限 15% 是给短镜头兜底：一个 0.5s 的镜头不该为了转场再砍掉 0.3s。
   *   算出来不足 2 帧就当 0（那个接缝最后会走硬切）。
   * ★ 余量为 0 时**完全不改变时长**，所以默认的「硬切」档行为与本段引入之前完全一致。
   */
  const handleFramesOf = (index: number): number => {
    if (wanted <= 0) return 0
    const baseFrames = framesOf(trimmedShotMs(index), fps)
    const capped = Math.min(wanted, Math.floor(baseFrames * TRANSITION_HANDLE_MAX_RATIO))
    return capped >= 2 ? capped : 0
  }
  const handleFrames: number[] = clips.map((_, index) => handleFramesOf(index))
  const handleMsOf = (index: number): number => (handleFrames[index]! / fps) * 1000

  /**
   * 分镜的**原始**可用时长（毫秒）：真实素材时长 ∧ trim ∧ 转场余量 三重约束后的值。
   * ⚠ 它同时也是 TTS 的合成目标时长 —— 它是「素材允许的最大值」。
   */
  const rawShotMs = (index: number): number => {
    const trimmed = trimmedShotMs(index)
    const handleMs = handleMsOf(index)
    return Math.max(0, trimmed - 2 * handleMs)
  }

  /**
   * 分镜在时间线上的**目标**时长（毫秒）= 原始时长套上剪辑节奏档位。
   *
   * ⚠ 只允许**缩短**（`shotScale <= 1`）：加速要多耗源素材字节，会撞 ChatCut 的
   *   `Source range exceeds video asset duration` 拒单（见 chatcut.ts PACING_PLANS 的注释）。
   *   `minShotMs` 是下限，但最后必须再和原始时长取小 —— 否则一个本来 1.0s 的镜头
   *   按 0.78 缩放得 0.78s、被下限顶到 1.2s，**比原来还长**，排帧又超素材时长。
   */
  const scaledShotMs = (index: number): number => {
    const raw = rawShotMs(index)
    if (raw <= 0) return raw
    /**
     * ★★ EDL 优先：AI 给了这个镜头的目标时长就用它，**但两道夹取一道都不能省** ——
     *   · 上限 `raw`：超过素材可用时长会被 ChatCut 判
     *     `Source range exceeds video asset duration`（整单失败，不是降级）；
     *   · 下限 `minShotMs`：模型看到的提示词里是**素材总时长**，不是扣掉转场余量后的可用时长，
     *     所以它完全可能给出一个比可用时长还短的值。
     *   粗夹（800~15000ms）已在 `edl.ts::clampShotMs` 做过，这里是严夹。
     */
    const edl = edlShotMs?.[index]
    if (typeof edl === 'number' && Number.isFinite(edl) && edl > 0) {
      return Math.min(raw, Math.max(minShotMs, Math.round(edl)))
    }
    if (shotScale >= 1) return raw
    return Math.min(raw, Math.max(minShotMs, Math.round(raw * shotScale)))
  }

  /**
   * 每个镜头**最终**排到时间线上的时长（毫秒）初值。
   *
   * ★ 为什么不直接用 scaledShotMs：缩短镜头还有一个下界是**配音**。配音是按镜头时长合成的，
   *   把镜头缩到比「这句话本身」还短，就会把台词吃掉（见 driver TTS 段的处理）。
   *   所以初值是缩放值，等 TTS 合成完、量出真实语音长度之后再按需抬高 —— 因此返回的**是数组本身**，
   *   调用方后续可以按下标改写它。
   */
  const slotMs: number[] = clips.map((_, index) => scaledShotMs(index))

  return { handleFrames, handleMsOf, rawShotMs, scaledShotMs, slotMs }
}
