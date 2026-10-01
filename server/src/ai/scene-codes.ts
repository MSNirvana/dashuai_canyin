/**
 * 场景码注册表 —— 全系统 sceneCode 的唯一权威来源。
 *
 * 业务代码**必须**从这里引用常量，不要再写字面量：
 *   runBilledScene(prisma, gw, { sceneCode: SCENE.copy_generate, ... })
 *
 * 后台「AI 场景」页的「已接入 / 待接入」标记来自 `LIVE_SCENE_CODES`：
 *   - 在 LIVE_SCENE_CODES 里 → 已接入（代码里有调用方）
 *   - 不在 → 待接入（提示词已配好，等业务方接入）
 *
 * 新增场景时两步走：
 *   1) 在本文件加常量 → seed 配提示词 → 后台可见
 *   2) 业务代码引用常量后，把常量名加到 LIVE_SCENE_CODES 里
 *
 * 这样「已接入」标记永远和代码一致，不需要去改前端硬编码。
 */

export const SCENE = {
  // ── 已接入：代码里已有调用方 ──
  copy_generate: 'copy_generate',
  copy_traffic: 'copy_traffic',
  // 四款菜品文案（2026-09-21 改型）：人设型 / 知识型 / 产品型 / 种草型。
  // ★ 旧的 copy_intro（介绍款）与 copy_quality（质量款）**已删除** ——
  //   删一个场景码时，记得三处一起动：本文件、prompt-vars.ts 的白名单、
  //   creation.service.ts 的 COPY_TRACKS；漏一处会出现「能选到但模板校验不通过」。
  copy_persona: 'copy_persona',
  copy_knowledge: 'copy_knowledge',
  copy_product: 'copy_product',
  copy_recommend: 'copy_recommend',
  storyboard_generate: 'storyboard_generate',
  // 发布素材（文本 + 图像两个场景，链路见 publish-material.service.ts）。
  // ★ publish_cover 是本项目**第一个图像场景**：它的候选模型必须是
  //   `ai_model.capability='IMAGE'`，且 `ai_scene.kind='IMAGE'`（网关据此选图像适配器）。
  //   把文本模型配进它的候选链，网关会在调用前就跳过并给出明确原因，不会「拿一段文字当图片」。
  publish_material: 'publish_material',
  publish_cover: 'publish_cover',
  /**
   * 发布素材 · 封面选帧（2026-09-24 新增）。
   *
   * ★ 它是**视觉文本场景**（`kind='TEXT'`，走 `chat/completions`），不是图像场景：
   *   输入是若干张候选帧 + 一段说明，输出是一句 JSON（选第几张、为什么），
   *   真正出图的是 `publish_cover`。
   * ★ 所以它**不能**进 `IMAGE_SCENE_CODES`（那会让网关按图像协议去调它），
   *   但它必须能收到 `images` —— 网关把它作为多模态输入发给 chat 适配器
   *   （见 adapters.ts 里 `openaiCompatible` 的 userContent 分支）。
   * ★ 为什么单独一个场景而不是塞进 `publish_cover` 的提示词里：
   *   出图模型选不了帧（它只吃参考图不会比较），而「比较 N 张图挑一张」
   *   与「按设计稿出图」是两种能力、两个模型、两笔账。
   */
  publish_cover_pick: 'publish_cover_pick',
  // AI 剪辑决策（EDL）—— 让模型决定「每个镜头各自留多长」以及整片的节奏/转场/字幕/配乐。
  // ★ 它在链路里的位置：AI 档开始合成、素材探测完之后、排轨之前（见 chatcut-driver.ts）。
  // ★ 输出是**结构化 JSON**（结构定义在 render/edl.ts），不是给人读的文案 ——
  //   所以解析器只认 JSON，失败就退回用户在面板选的档位（绝不阻塞出片）。
  edit_plan: 'edit_plan',
  /**
   * 配乐选曲（2026-09-28 接入）。
   *
   * ★ 位置：本地出片路径挑配乐的那一刻（`worker.ts`），与 ffmpeg 的编码工作**并发**发起
   *   —— 这样这一次 AI 调用的等待时间被编码时间盖住，不额外占用出片预算。
   * ★★ 它**不是**「让模型写一段曲风描述」，而是「从本地曲库已有的候选里挑一首」：
   *   输出 `{"index":N}`，N 是候选清单里从 0 开始的编号。
   *   改成这样的原因写在 `prisma/prompts.ts` 的 `BGM_SELECT_SCENE` 那段：
   *   写描述意味着「拿描述去**现生成**一首」，那会把 1~5 分钟的在线等待塞进出片链路，
   *   而 nginx 只给 480s —— 正是池化架构要避开的坑。
   */
  bgm_select: 'bgm_select',
  /**
   * 字幕分行（2026-09-29 接入）—— 把 ASR 认出来的整段口语切成一屏一条的字幕行。
   *
   * ★★ 为什么需要它（用户原话「**需要 AI 做好分行再添加到字幕里**」）：
   *   AI 档的字幕文本走 `subtitleMode='SOURCE_AUDIO'`（对**原声**做 ASR），
   *   而「一行最多几个字」是**画布像素的硬约束**（10 字封顶，见 `SUBTITLE_MAX_WIDTH`）。
   *   中文口语句子的语义边界位置是随机的，10 字上限切断它们的概率很高；
   *   实测已证明**任何只看宽度的规则都不可能同时满足**：
   *     · `廊坊想吃火锅的千万别划走这盘牛肚` 需要**均衡** ⇒ `廊坊想吃火锅的`／`千万别划走这盘牛肚`
   *     · `来大帅火锅旗舰店试第一口` 需要**填满**（专名不许拆）⇒ `来大帅火锅旗舰店`／`试第一口`
   *   ⇒ 只有「知道哪个字串是专名、哪个位置可以断」的模型能同时命中。
   *
   * ★ 它在链路里的位置：`applyAiSynthesis` 拿到 ASR 段、**烧字幕之前**（见 `synthesis.ts`）。
   *   输出是**结构化 JSON**（一组行），解析不过一律退回内建的分条算法（绝不阻塞出片）。
   * ★ 与 `edit_plan` / `bgm_select` 同族：跑在出片链路里 ⇒ 超时与重试要按**出片预算**收，
   *   失败的下场只是「按内建算法分」，那是个完全可接受的降级。
   */
  subtitle_split: 'subtitle_split',

  // ── 待接入：提示词已配好，业务方尚未引用 ──
  script_polish: 'script_polish',
  review_guard: 'review_guard',
  title_overlay: 'title_overlay',
  rhythm_detect: 'rhythm_detect',
} as const

export type SceneCode = (typeof SCENE)[keyof typeof SCENE]

/** 已有业务调用方的场景（已接入）—— 后台据此打「已接入」标签 */
export const LIVE_SCENE_CODES: readonly SceneCode[] = [
  SCENE.copy_generate,
  SCENE.copy_traffic,
  SCENE.copy_persona,
  SCENE.copy_knowledge,
  SCENE.copy_product,
  SCENE.copy_recommend,
  SCENE.storyboard_generate,
  SCENE.publish_material,
  SCENE.publish_cover,
  SCENE.publish_cover_pick,
  SCENE.edit_plan,
  SCENE.bgm_select,
  SCENE.subtitle_split,
]

/**
 * 图像场景（`ai_scene.kind='IMAGE'`）的候选**必须**是 `capability='IMAGE'` 的模型。
 *
 * ★ 单独导出成集合而不是就地写 `scene.kind === 'IMAGE'` 判断：后台「AI 场景」页的模型下拉
 *   目前不按能力过滤（运营能看到全部模型），所以下面这条约束是**唯一**的防线：
 *   配错了就在调用前跳过并报明确原因，而不是调错协议、扣了钱、拿回一段没法用的文本。
 */
export const IMAGE_SCENE_CODES: readonly SceneCode[] = [SCENE.publish_cover]

/**
 * ★★ 低推理预算场景（`reasoning_effort: 'low'`）—— 起初是「五个菜品文案款」，
 *    后经同口径实打各加一次：**分镜**（2026-09-23）、**字幕分行**（2026-10-01）。
 *    三组场景的共同点是「输出短、但模型会自作主张烧掉几百到上万个思考 token」。
 *
 * 这一条是 **2026-09-22 实测出来的**，起因是「四款文案改型后全部生成失败」。
 * 排查结论：**不是提示词坏了，也不是上游挂了，而是思考预算没人管**。
 *
 * 实测（带 `reasoning_effort:'low'`、max_tokens=4000、同一提示词直连、超时给足 150s）：
 *
 *   通道                  短提示词（产品/干货 2.2k 字）   长提示词（人设 2.8k 字）
 *   deepseek-v4-flash     **7.0~9.0s**                    **7.7 / 12.5 / 8.5s**（中位 8.5s）
 *   gpt-5.5               7.0~7.6s（但另有一次 30s 超时）   40.4 / 52.1 / 43.7s（中位 43.7s）
 *   claude-sonnet-5       **46~50s 且正文为空**（见下）
 *
 * 三个各自独立的结论，缺一条都配不对：
 *
 *   ① 这五款的输出只有 80~190 字，**根本不需要深度思考**，但推理模型会自作主张
 *      花掉 3000~8600 个思考 token。不压的话：DeepSeek 50s、GPT 84s（另一次 126s 直接 524）
 *      ⇒ 场景 timeout 30s 下**三个候选全部超时** ⇒ `ALL_FAILED（90.0s）attempts=3`。
 *   ② **主候选必须换成 DeepSeek**（见 setup-ai-channels.ts 的 SCENE_OVERRIDES）：
 *      GPT 即使压了思考预算也是**双峰**的 —— 短提示词 7s、长提示词稳定 40s+。
 *      30s 预算下后者必然白等一次超时；而 DeepSeek 最坏只 12.5s。
 *   ③ **`claude-sonnet-5` 必须移出这五款的候选链**：它对 `reasoning_effort` 与
 *      `thinking:{type:'disabled'}` **两个参数都完全无视**，4000 预算必然被思考吃光
 *      → `finish_reason='length'` 且 `content=''`。网关把空正文判为 BAD_RESPONSE
 *      （属于**非**通道级故障 ⇒ **会按 max_retries 反复重试同一通道**），
 *      留在链上就是每次白等 46~50 秒 × (maxRetries+1) 次。
 *
 * ★ 压思考预算**不会**掉质量：正文长度、禁词、四型视角约束已逐条比对一致。
 * ★ 但**单靠它也不够** —— 它把 50s 压到 8s，却压不平 GPT 的双峰。两者必须一起改。
 *
 * ★ 为什么用「代码里的集合」而不是 `ai_scene` 加一列：`reasoning_effort` 是否被接受
 *   取决于**上游通道**（这里两个通道都实测过、claude 不认），不是运营可调的商业参数；
 *   写成运营可改反而会让「给不支持的模型配上它」变成静默 400。
 *   要扩到别的场景时，**必须先按上表的口径真打一轮**再往这里加。
 *
 * ────────────────── ★★ 2026-09-23 增补：分镜场景（storyboard_generate） ──────────────────
 *
 * 它**最初不在这个集合里**（当时的判断是「大输出场景更需要思考」），代价是生产上
 * 反复出现的 191 秒白等：
 *   `ai_call_log` 实测同一场景同一通道 `completion_tokens` 从 3,165 到 17,650 都出现过，
 *   而可见 JSON 只有 1,300~1,600 字符 ⇒ **差额全是隐藏思考**。
 *   一次真实请求：思考跑飞越过 150s 场景超时 → 降级 Claude（41s）⇒ **用户实等 191 秒**，
 *   nginx 记到 499（用户早切走页面了）；而 30 分钟一轮的健康体检**全程判该通道 HEALTHY**，
 *   从来不会降级它 —— 因为证据是「通道级」的，它在别的场景成功过。
 *   ⚠ `max_output_tokens=12000` **管不住思考**（实测 `completion_tokens=17650 > 12000`，
 *   上游没按它裁）⇒「把 max_output_tokens 调小」是**无效动作**，有效杠杆只有压思考。
 *
 * ★ 已按上表同样的口径真打一轮（`scripts/probe-storyboard-timing.ts`，
 *   同一条真实渲染后的 prompt、直连适配器、每组 4 次样本）：
 *
 *   变体                  耗时样本（s）                   中位    完成 token    可见字数     镜头数
 *   deepseek 不压思考      108.3 / 63.1 / 100.4 / 104.3   ~102   6080~10151   1159~1237   6/6/6/6
 *   deepseek 压 low        35.5 / 51.5 / 29.1 / 43.0      ~39    2602~5561    985~1576    5/6/6/6
 *   claude   不压思考      54.2（线上另一次 41.3）         ~54    4511         1079        6
 *   claude   压 low        50.3                           ~50    4316         1077        6
 *
 *   三条结论，缺一条都会配错：
 *   ① 压思考对 DeepSeek 有效：中位 **102s → 39s**，4/4 全部 ≤ 51.5s
 *      （不压时 3/4 都在 100s 以上）。只有 2.6 倍、不是文案那种 7 倍 —— 因为分镜的
 *      **正文本身**就要 ~1000 字，被压掉的是思考（约 9,000 → 约 1,500 token）。
 *   ② **质量未降**：可见字数与镜头数同档，且 4/4 全部落在 `COMPLEX`（5~6 镜）规则内。
 *   ③ Claude 仍然无视 `reasoning_effort`（54.2 → 50.3s，属噪声）；而压思考之后
 *      **DeepSeek(39s) 仍快于 Claude(54s)** ⇒ 主候选**不需要**从 DeepSeek 换走。
 *
 * ★ 配套改动（必须一起看）：
 *   · `scripts/setup-ai-channels.ts` 的 `SCENE_OVERRIDES.storyboard_generate.timeoutMs`
 *     150_000 → 90_000（中位 39s、最坏样本 51.5s，90s 留 1.75 倍余量）；
 *   · 前端 `apps/mini/src/services/creation.ts` 的 `STORYBOARD_TIMEOUT_MS` **不用动** ——
 *     本次是**收紧**（服务端最坏 2×90=180s ≤ 前端 340s），所以也不需要重出小程序包。
 * ★ 加场景时**不要**顺手调 `max_output_tokens`：它跟压思考无关，而且是 Claude 这条
 *   备用通道的活路（给 4000 时它会因 `finish_reason=length` 返回空正文）。
 */
export const LOW_REASONING_SCENES: ReadonlySet<string> = new Set<string>([
  SCENE.copy_traffic,
  SCENE.copy_persona,
  SCENE.copy_knowledge,
  SCENE.copy_product,
  SCENE.copy_recommend,
  /**
   * 分镜：本集合里**唯一**一个「压思考之后仍然比备用通道快」的场景
   * （39s vs Claude 54s）。★ 别用「分镜更复杂、所以要更多思考」的直觉把它删掉 ——
   * 实测那 9,000 个 token 是与正文无关的**跑飞**，不是推理深度。
   */
  SCENE.storyboard_generate,
  /**
   * 字幕分行（2026-10-01）—— 它是纯排版题，**最不需要**思考的一个。
   *
   * 起因：用户第二次反馈「字幕断句还是一半一半的」。查下去是**两个叠加的问题**：
   *   ① 断句口径不对 —— 提示词自己把模型推向贪心（见 `prisma/prompts.ts` 的
   *      SUBTITLE_SPLIT_PROMPT，已重写）；
   *   ② AI 分行这条路径**跑不跑得成看运气** —— 它经常 60s 超时退回兜底，于是同一条原声
   *      在「AI 偶尔成功那一版」和「内建算法那一版」之间摇摆。
   *      ★ 实测教训：**兜底的内建算法产出是好的**（`synthesis.ts:516` 逐子句装箱、
   *        不跨意群拼）。所以「一半一半」的**坏**那一半来自 AI 成功时的贪心输出，
   *        不是兜底 —— 下结论前一定要先跑一遍。
   *
   * A/B 实测（`scripts/probe-subtitle-split-timing.ts`，直连适配器、零计费、
   * gpt-5.6-sol、每组 3 次样本，2026-10-01）—— **两组样本，第二组才是真实工作量**：
   *
   *   取材                       变体        耗时（s）                完成 token
   *   2 句（探针自造）           不压        53.6 / 38.0 / 53.3      595 / 595 / 803
   *                              压 low       8.4 / 6.0 / 6.8        77 / 77 / 77
   *   4 句（线上 subtitle-56）   不压        121.2 / 125.8(524) / 119.2  1667 / — / 2108
   *                              压 low      47.5 / 18.6 / 6.1      111 / 110 / 115
   *
   *   ① 完成 token 掉 **94%**（4 句组 1667~2108 → 110~115），被压掉的全是
   *      **与那几十字 JSON 输出毫无关系**的隐藏思考，不是推理深度；
   *   ② 真实工作量下「不压」是 **119~126s**（还撞过一次 HTTP 524）⇒ 对
   *      `timeout_ms=60_000` 是**必然失败**、每次都要白等一个完整超时；
   *   ③ 质量：`acceptLines`（生产同款硬底线）压思考组出现 1/4、0/4（详见下面 ①）；
   *   ④ ★ **`timeout_ms` 保持 60_000 不动**：压完最坏样本 47.5s，余量只有 1.26 倍 ——
   *      不是「很宽裕」而是「勉强够」。真要动它是运营配置（走后台），且**不是**本次的事。
   *
   *   ⚠ 两条必须一起记住（2026-10-01 挖到底之后补写）：
   *     ① **这个中转站对 `reasoning_effort` 的支持是抽风的** —— 同一配置连打 3 次，
   *        完成 token 出现 `113 / 1152 / 1151` 两个量级 ⇒ 有时认、有时不认。
   *        · 认了（~113 token）：快（6~47s），但模型**数不清字数**，会吐出 11~12 字的行
   *          （实测 `这回来店里专门给他点了`(11) / `这海骨的小黄鱼炸的透透的`(12)）
   *          ⇒ 被 `acceptLines` 判超宽拒掉；
   *        · 不认（~1150 token）：慢，回到「不压」那一档。
   *        ★ 拒掉**不是灾难**：`breakSubtitleLines` 是**逐句**判定，
   *          被拒的句子由 `normalizeSubtitleSegments` 的 `?? null` 退回**内建算法**，
   *          而内建算法是逐子句装箱、产出良好（`synthesis.ts:516`）。
   *          代价只是「这一句用了内建版」，不会留白、也不会串味。
   *     ② 所以「压思考」在本场景是**净收益但不保证**：它把「必然 119~126s 超时 → 全靠兜底」
   *        变成「有时 6~47s 成功、有时仍超时」。**真正的根因是中转站吞吐波动 ~8 倍
   *        ＋主候选是重推理模型**，压思考只是把这个组合往好里推一格。
   */
  SCENE.subtitle_split,
])

/**
 * ★★ 「本场景的一次失败，**不许**把整条通道熔断」的场景清单（2026-10-01）。
 *
 * 背景：熔断键是 `ai:cb:open:<providerId>` —— **按通道**，不是按场景，
 * 且 `DEFAULT_CIRCUIT.openSeconds = 300`。而 `isChannelLevelFailure()` 把 `TIMEOUT`
 * 一律算作「通道级硬故障」⇒ 任何**慢场景**的一次超时，会让这个通道上的**所有场景**
 * 在接下来 5 分钟里被直接跳过。
 *
 * 生产实证（`business_request` / `render-worker` 日志，2026-10-01）：
 * ```
 *  09:00:17 subtitle-split-61  FAILED  [tokenbox-gpt] request timeout after 60000ms
 *  09:04:07 subtitle-split-62  FAILED  没有可用的候选通道：候选通道 tokenbox-gpt 处于熔断中
 *  09:37:11 subtitle-split-63  FAILED  同上（timeout）
 *  09:42:03 subtitle-split-64  FAILED  同上（熔断中）
 * ```
 * ⇒ **字幕分行**（`timeout_ms=60_000`，是出片链路里最慢的一个**增强**步骤）一次超时，
 *   就让整个 `tokenbox-gpt` 通道在 5 分钟里对**分镜 / 五个文案款 / 封面选帧**也关门。
 *   典型的「低价值可选步骤拖垮高价值主链路」。
 *
 * ★★ 判据（加新场景前先问这一句）：
 *   **这个场景超时，说明「通道坏了」还是「这个场景本来就慢」？**
 *   后者一律加进来 —— 它的失败不该被当成通道的健康信号。
 *
 * ★ 后果边界（故意的，不是遗漏）：
 *   · 该场景的调用**不** open 熔断、**不** `record(false)` 失败率、**不** `noteChannelFailure`；
 *   · 也就是说它对「通道健康」这件事**完全静默** —— 代价是万一这条通道真的整体挂了，
 *     没有别的场景在跑的话，只有它一个场景时后台不会自己亮红灯；
 *   · 它自己的失败仍然照常返回（调用方拿到空 Map ⇒ 退回内建算法，绝不阻塞出片）。
 */
export const NO_TRIP_SCENES: ReadonlySet<string> = new Set<string>([
  /**
   * 字幕分行：60s 超时、典型 16s，是**纯排版题**（temperature 0.2、输出只有几十个字）。
   * 它超时最常见的成因是模型这一刻抽风/排队，而不是通道不可用 ——
   * 实测同一天 60 次成功耗时 16.3s，紧邻的几次却 >60s。
   */
  SCENE.subtitle_split,
])

/**
 * ★ 「这一次调用失败，要不要把整条通道熔断」—— 抽成纯函数是为了让守护能直接断言，
 *   而不是靠 grep `gateway.ts` 的调用点（那种断言在重构后必然假绿）。
 */
export function shouldTripCircuit(sceneCode: string): boolean {
  return !NO_TRIP_SCENES.has(sceneCode)
}
