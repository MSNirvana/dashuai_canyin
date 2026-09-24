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
  // 四款菜品文案（2026-09-21 改型）：人设型 / 干货型 / 产品型 / 种草型。
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

  // ── 待接入：提示词已配好，业务方尚未引用 ──
  script_polish: 'script_polish',
  review_guard: 'review_guard',
  title_overlay: 'title_overlay',
  bgm_select: 'bgm_select',
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
 * ★★ 低推理预算场景（`reasoning_effort: 'low'`）—— 五个菜品文案款。
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
])
