// 提示词变量契约。
//
// 为什么需要它：模板里的 {{占位符}} 由网关做字符串替换，取不到值时返回空串 ——
// 也就是说后台把 {{dishName}} 写成 {{dishname}} 不会报错，只会让那一段在提示词里
// 渲染成空白，而且这次调用照常扣积分。所以在保存场景时校验：模板里出现的占位符
// 必须落在该场景的白名单里。

/**
 * 文案类场景可用变量（= creation.service.ts::buildVariables 的产出，4 款 + 通用兜底共用）
 *
 * ★ 2026-09-20 移除了 `userIdea`：「你想拍什么风格？」那个自由输入框已从整条链路删掉，
 *   它的值不再进提示词（`creation.service.ts::buildUserIdea` 也一并删除）。
 *   **不要再加回来** —— 没有对应的用户输入时，模板里那一行只会永远渲染成兜底文案，
 *   变成一个模型看得见、用户却填不了的假段落。
 */
const COPY_VARS = [
  'storeName', 'storeIntro', 'category', 'city',
  'dishName', 'dishIntro', 'sellingPoints',
  /**
   * ★★ «【菜品】那一行的空值注解»：没选菜时是那段说明，选了菜时是**空串**
   *    （取值见 src/lib/dish-mention.ts::dishEmptyNoteFor）。
   *
   * 为什么必须是变量而不是模板里的静态文本：静态文本会在菜品**有值**时与值自相矛盾 ——
   * 模型看到「锅巴土豆（空 = 这次没选具体菜品…改讲门店本身）」，实测「报出菜名」率
   * 从 92% 掉到 75%（数据见 dish-mention.ts 的文件头）。这类「模板与值打架」
   * 是模板层最难自查的一类缺陷：不报错、也不违反白名单，只是内容悄悄跑偏。
   */
  'dishEmptyNote',
  // 套餐信息（价格 + 包含哪些菜）。★ 与 userIdea 相反，这是**加**变量 ⇒ 白名单先放开是安全的：
  // 库里模板还没引用它时什么都不会发生，而模板一旦引用，若白名单没放开就当场被拒。
  // 语义：有内容 = 这次推广的是一份套餐；单菜时 formatComboInfo 给空串。
  // 所以模板那一段必须写清「空 = 单道菜」，否则模型看到空的套餐标题会自己编一份出来。
  'comboInfo',
  'persona',
  /**
   * 今天日期 / 季节 / 未来三周内的节日与节气（见 src/lib/festival.ts）。
   *
   * ★ 加它的原因：模型**不知道今天是几号**。要它「跟上节假日和当下热点」却没有日期，
   *   它只会瞎编 —— 三月份给你写「中秋快乐」。这是模型唯一的时间来源。
   * ★ 它**保证非空**（任何一天至少有「今天是 …」一行），所以模板里那一行不会渲染成空白
   *   —— 这正是 userIdea 那个坑的反面：取不到值只会静默变空串，而这里不存在取不到的情况。
   * ⚠ 日期按 **Asia/Shanghai** 显式计算。本仓没有统一 TZ 处理、线上 Ubuntu 默认 UTC，
   *   用本地时区取日期会在北京时间 00:00~08:00 那八小时里整体差一天。
   */
  'dateInfo',
  /**
   * 经用户确认的风格素材摘要：只喂少量已筛选片段，不把整份文档塞进提示词。
   * 未配置素材时为空串，模板必须把它当可选参考，不能据此编造事实。
   */
  'styleGuide',
  /** 近期已用的开头/落点摘要，供生成器主动避让重复。 */
  'recentCopyAvoid',
] as const

/**
 * 流量款（话题模式）**专用**变量。
 *
 * ★ 为什么不让它复用 COPY_VARS：流量款已经从「四款文案」拆成独立功能（`creation.mode='TOPIC'`），
 *   输入里**没有门店、也没有菜品**。如果沿用 COPY_VARS，模板里那几行的占位符会被渲染成空串，
 *   模型看到的是一排「【门店】｜品类：｜城市：」—— 它会以为「门店信息漏了」，
  *   于是自己编一个店名补上（这正是契约测试里反复出现的那类静默失效）。
 *   窄白名单在这里是**保护**：模板一旦被人改回引用店名/菜名，保存场景时就会当场被拒。
 *
 * ★ `topicInfo` 与 `dateInfo` 的关系：topicInfo 的第一段就是 formatDateInfo 的输出
 *   （今天几号 / 季节 / 临近节点），后面才接「可用的起头方向」。所以流量款只引用 topicInfo
 *   一项就够 —— 两个都引用会让同一天的信息在提示词里出现两遍。
 */
const TOPIC_VARS = ['topicInfo', 'styleGuide', 'recentCopyAvoid'] as const

// ★ 这里**故意没有** `trackLabel`（款式中文名）。
//   2026-09-20 做「文案口语化」那一版时想过加它 —— 让通用兜底场景或分镜知道这次是哪一款，
//   好调整口吻与镜头配比。但契约测试里有一条既有不变量：
//       「款式不是变量，款式靠选模板生效」（verify-prompt-vars.ts 里逐模板断言
//         模板中不许出现 {{track}} / {{trackLabel}}）
//   它的道理是：四款各有自己的场景与模板，款式**已经体现在「选了哪个模板」里**；
//   再传一个变量进去，等于同一件事有两个来源，两者一旦不一致（改了款式没换模板、
//   或反过来）模型就会收到自相矛盾的指令，而且**不会报错**。
//   所以通用兜底场景保持「通用」，分镜保持「款式无关」——
//   分镜要贴合文案，靠的是它拿到了 {{copyText}} 正文，而不是靠一个款式标签。
//
// ★★ 2026-09-29 补一句，别把上面这条读成「永远不能给分镜任何身份信息」：
//   那天要修「种草型产出的是老板视角」（界面上种草型写「达人素人视角」，分镜却写死
//   「按一个老板、老板自拍口播」，用户看到的画面描述是「老板站在店内镜头前」）。
//   第一反应是「不传变量、让分镜从 {{copyText}} 自己判断说话人是谁」，**实测不成立** ——
//   见下面 STORYBOARD_VARS 里 `speakerRole` 那段记录。所以最终走了「按款式派生一个称呼」。
//   结论要分开记：**「款式名」仍然不许进提示词**（上面那条断言照旧有效），
//   但**「由款式派生出来的、模型自己判断不出来的事实」可以进** ——
//   判据是「不传它时，产出会不会稳定地错」。这次会（3 次里 1 次全写成老板）。

/** 分镜场景：在文案变量之上，多了文案正文与镜头数/镜头库，以及出镜人的称呼 */
const STORYBOARD_VARS = [
  ...COPY_VARS,
  'copyText', 'complexity', 'complexityLabel', 'shotCountRule', 'shotLibrary',
  /**
   * ★★ `speakerRole` = 这次分镜里出镜的那个人该怎么称呼（2026-09-29 加）。
   *
   * **它是本项目里唯一一个「按款式派生」的变量，属于有据可依的破例** ——
   * 上面那段「故意没有 trackLabel」的结论是「款式靠选模板生效、分镜不必知道款式」，
   * 它成立的前提是「分镜要贴合文案，靠的是它拿到了 {{copyText}}」。**这条前提被实测推翻了**：
   *   · 让分镜「读文案自己判断说话人是谁」，同一份提示词跑两次：一次 6/6 条写
   *     「出镜说话的人」、一次 5/5 条**全写「老板」**；
   *   · 把判据挪到提示词最前面并加自检后，3 次里仍有 1 次全写「老板」。
   *   而界面上种草型写的是「**达人素人视角**」—— 用户看到的画面描述却是「老板站在店内镜头前」。
   *
   * ★ 破例的边界：只传**一个称呼**（`SPEAKER_ROLE_BY_TRACK` 里的名词短语），
   *   **不传款式名、不传模板选择**。分镜怎么切、怎么拍仍然只由 `{{copyText}}` 决定，
   *   所以「款式不是变量」这条不变量在**实质**上仍然成立（下面那条断言照旧有效：
   *   模板里不许出现 `{{track}}` / `{{trackLabel}}`）。取值与完整实测见
   *   `services/creation.service.ts` 的 SPEAKER_ROLE_BY_TRACK。
   * ⚠ 它**不在** COPY_VARS 里：四个文案场景引用不到它 —— 文案的身份写在各款的正文里，
   *   不需要、也不该由这个变量再喂一遍（两个来源必然打架）。
   */
  'speakerRole',
] as const

/** 合成增强场景（已建场景、调用方待接入）：目前模板只用到基础变量 + 文案正文 */
const SYNTH_VARS = [...COPY_VARS, 'copyText', 'shotCountRule'] as const

/**
 * 配乐选曲场景（`bgm_select`）：只吃**口播文案**与**候选曲目清单**。
 *
 * ★★ 为什么**刻意不给** `COPY_VARS`（门店 / 品类 / 菜品那一套）—— 这是本表里最容易想当然的一处：
 *   渲染期在 `worker.ts` 里根本拿不到门店与菜品信息（合成任务的入参只有素材、台词、档位），
 *   白名单一旦放开而模板又引用了，那几行会被渲染成**空串** —— 模型看到的是
 *   「【门店】｜品类：」，它会认为「门店信息漏了」于是自己编一个店名补上。
 *   这正是本文件反复出现的那类静默失效：模板校验通过、调用照常扣积分、结果不对。
 *   （原提示词正是引用了 storeName/dishName 的，接线时一并改掉了。）
 * ★ 反过来，`bgmOptions` 是**必须**的：模型看不到音频，候选清单是它唯一的判断依据，
 *   取不到就只剩「闭着眼睛挑一个」，而这一次调用照样花钱。
 */
const BGM_SELECT_VARS = ['copyText', 'bgmOptions'] as const

/**
 * AI 剪辑决策场景（`edit_plan`）：拿到**逐镜头的台词与素材时长**，输出剪辑决策 JSON。
 *
 * ★ 为什么只有 `copyText` 不够、必须有 `shotPlanInput`（逐镜头清单）：
 *   `copyText` 是整段口播文案，模型看不出「哪一句对应哪个镜头、那一段素材有多长」，
 *   而剪辑决策的核心恰恰是**逐镜头**的时长分配。
 * ★ 为什么不拆成 `shot1Sec` / `shot2Sec` 这类下标变量：镜头数由用户决定、不固定，
 *   下标变量必须预先知道数量 ⇒ 镜头一多必然漏掉后面的。一个整段文本变量支持任意镜头数。
 * ★ `preferPlan` = 用户在面板上选的档位，写进提示词是为了让它当**倾向**（参考），
 *   最终仍由模型决定；只有在解析失败时它才作为兜底值使用（见 edit-plan.service.ts）。
 */
const EDIT_PLAN_VARS = [...COPY_VARS, 'copyText', 'note', 'shotPlanInput', 'preferPlan'] as const

/**
 * 字幕分行场景（`subtitle_split`）：只吃**待分行的编号清单**与**每行字数上限**。
 *
 * ★★ 为什么**刻意不给** `COPY_VARS`（门店 / 品类 / 菜品那一套）：与 `bgm_select` 同一个理由 ——
 *   渲染期在 `worker.ts` 里拿不到门店与菜品信息。白名单放开而模板又引用 ⇒ 渲染成**空串**，
 *   模型看到「【门店】」后面什么都没有，会自己编一个店名补上。这是本文件反复出现的那类静默失效。
 * ★ 为什么 `lineInput` 是**一整段编号清单**而不是 `line1` / `line2` 这些下标变量：
 *   段数由 ASR 结果决定、每次都不一样 ⇒ 下标变量必然漏掉后面的段，
 *   而且逐段调用会把「一次调用」变成「N 次调用」，直接压在出片预算上（同 `shotPlanInput` 的理由）。
 * ★★ 为什么必须有 `maxWidth`：这是**画布像素算出来的硬约束**（`10 × 104px ＋ 描边 12 = 1052 ≤ 1080`）。
 *   写死在提示词里的话，将来改字号就得**同时**改代码与库里的模板；当成变量传进来，
 *   模型拿到的永远是此刻生效的那个值。
 */
const SUBTITLE_SPLIT_VARS = ['lineInput', 'maxWidth'] as const

/**
 * 发布素材 · 文本场景：门店/菜品上下文 + **口播文案正文**。
 *
 * ★ 为什么必须有 `copyText` 而没有别的：这条链路的验收标准是
 *   「标题与文案不超出老板实际说出口的范围」—— 口播文案是唯一的事实来源。
 *   分镜那套 `shotCountRule` / `shotLibrary` 与它无关，**故意不放进来**：
 *   白名单宽一分，「模板里写了个取不到值的占位符」这种静默失效就多一分机会。
 */
const PUBLISH_VARS = [...COPY_VARS, 'copyText'] as const

/**
 * 发布素材 · 图像场景：只吃**文本场景产出的画面描述**，不吃任何业务字段。
 *
 * ★ 这是刻意的窄白名单：出图模板只负责「画风与规格」，拍什么由 coverPrompt 决定。
 *   放开 storeName/dishName 会让「门店信息」在两份提示词里各写一遍，
 *   迟早出现「文本场景说拍红烧肉、图像场景按 dishName 拍别的菜」这种自相矛盾，
 *   而且**不会报错**。
 */
const PUBLISH_COVER_VARS = ['coverPrompt', 'coverTitle'] as const

/**
 * 发布素材 · 封面选帧场景：只吃**候选帧的说明文字**（哪张来自哪个镜头、那个镜头想拍什么）。
 *
 * ★ 候选帧图片本身**不是变量**，走 `images` 参数（二进制图塞进模板只会变成一大段 base64）。
 * ★ 它也**不该**吃到门店/菜品变量：选帧只判画面好坏，不判内容对不对
 *   —— 让模型看着店名去挑帧，等于给它一个与画面无关的干扰项。
 */
const PUBLISH_PICK_VARS = ['pickContext'] as const

/**
 * 场景 → 可用变量白名单。
 * 表里**没有**的场景不做校验（宽松放行），避免以后新增场景一上线就被拦。
 */
export const SCENE_VARIABLES: Record<string, readonly string[]> = {
  copy_generate: COPY_VARS,
  // ★ 流量款走话题白名单，与四款菜品文案**刻意不同**（理由见 TOPIC_VARS 的声明处）
  copy_traffic: TOPIC_VARS,
  copy_persona: COPY_VARS,
  copy_knowledge: COPY_VARS,
  copy_product: COPY_VARS,
  copy_recommend: COPY_VARS,
  storyboard_generate: STORYBOARD_VARS,
  script_polish: SYNTH_VARS,
  review_guard: SYNTH_VARS,
  title_overlay: SYNTH_VARS,
  // ★ 配乐选曲**不是** SYNTH_VARS：它跑在渲染链路里，拿不到门店/菜品（理由见上面 BGM_SELECT_VARS）
  bgm_select: BGM_SELECT_VARS,
  // ★ 字幕分行**不是** SYNTH_VARS：它跑在渲染链路里，拿不到门店/菜品（理由见上面 SUBTITLE_SPLIT_VARS）
  subtitle_split: SUBTITLE_SPLIT_VARS,
  rhythm_detect: SYNTH_VARS,
  publish_material: PUBLISH_VARS,
  publish_cover: PUBLISH_COVER_VARS,
  publish_cover_pick: PUBLISH_PICK_VARS,
  edit_plan: EDIT_PLAN_VARS,
}

/**
 * 抽出模板里的全部占位符（去重）。
 * 正则必须与网关替换时用的那条一致（`\w+`），否则会出现「网关照替换、这里查不到」的漏网。
 */
export function extractPlaceholders(template: string): string[] {
  const out = new Set<string>()
  for (const m of template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) out.add(m[1]!)
  return [...out]
}

/** 模板里「白名单之外」的占位符；场景不在表里则返回空数组（= 不校验） */
export function findUnknownPlaceholders(sceneCode: string, template: string): string[] {
  const allowed = SCENE_VARIABLES[sceneCode]
  if (!allowed) return []
  const set = new Set(allowed)
  return extractPlaceholders(template).filter((v) => !set.has(v))
}

/** 供后台保存失败时给出可读提示 */
export function describeUnknownPlaceholders(unknown: string[]): string {
  return unknown.map((v) => `{{${v}}}`).join('、')
}

/**
 * 写法不合法、网关也**不会替换**的「类占位符」：`{{store.intro}}` / `{{dish name}}` / `{{}}`。
 *
 * 为什么单独查一遍：替换用的正则是 `\{\{\s*(\w+)\s*\}\}`，`\w+` 不认点号和空格 ——
 * 这类写法既不会变成空串，也不会被 findUnknownPlaceholders 抓到，而是**原样留在提示词里**，
 * 模型会看到一堆花括号。危害比「静默变空串」小，但同样是后台手抖写错导致的无声故障。
 */
export function findMalformedPlaceholders(template: string): string[] {
  const out = new Set<string>()
  for (const m of template.matchAll(/\{\{[^{}]*\}\}/g)) {
    if (!/^\{\{\s*\w+\s*\}\}$/.test(m[0])) out.add(m[0])
  }
  return [...out]
}

/**
 * 一次给出模板的全部问题（空数组 = 通过）。
 * 保存场景 / 同步模板都用它，保证「后台手填」和「代码里同步」走同一套判据。
 */
export function validateTemplate(sceneCode: string, template: string): string[] {
  const problems: string[] = []
  const unknown = findUnknownPlaceholders(sceneCode, template)
  if (unknown.length) {
    const allowed = (SCENE_VARIABLES[sceneCode] ?? []).map((v) => `{{${v}}}`).join('、')
    problems.push(`含该场景不支持的变量 ${describeUnknownPlaceholders(unknown)}。该场景可用变量：${allowed}`)
  }
  const malformed = findMalformedPlaceholders(template)
  if (malformed.length) {
    problems.push(
      `含写法不正确的占位符 ${malformed.join('、')}（应为 {{变量名}} 形式，否则网关不会替换，会原样出现在提示词里）`,
    )
  }
  return problems
}
