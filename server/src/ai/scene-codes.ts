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
 */
export const LOW_REASONING_SCENES: ReadonlySet<string> = new Set<string>([
  SCENE.copy_traffic,
  SCENE.copy_persona,
  SCENE.copy_knowledge,
  SCENE.copy_product,
  SCENE.copy_recommend,
])
