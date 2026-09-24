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
const TOPIC_VARS = ['topicInfo'] as const

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

/** 分镜场景：在文案变量之上，多了文案正文与镜头数/镜头库 */
const STORYBOARD_VARS = [
  ...COPY_VARS,
  'copyText', 'complexity', 'complexityLabel', 'shotCountRule', 'shotLibrary',
] as const

/** 合成增强场景（已建场景、调用方待接入）：目前模板只用到基础变量 + 文案正文 */
const SYNTH_VARS = [...COPY_VARS, 'copyText', 'shotCountRule'] as const

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
  bgm_select: SYNTH_VARS,
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
