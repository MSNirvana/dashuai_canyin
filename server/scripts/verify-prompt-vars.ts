/**
 * 变量契约验证：提示词的「模板 ↔ 变量 ↔ 场景白名单」三者必须严丝合缝。
 *
 * 背景：`ai_scene.prompt_template` 存在数据库里，`{{变量}}` 由网关做**纯字符串替换** ——
 * 取不到的键替换成空串：不报错、提示词那一段渲染成空白、这次调用照常扣积分。
 * 也就是说这类缺陷**没有任何错误日志**，只能靠契约测试钉死。本脚本覆盖四类：
 *   ① 模板层：所有创建场景模板 / 兜底模板的占位符都在白名单内，且改动后确实引用了
 *      门店介绍与老板人设（这两个字段此前根本没进提示词）
 *   ② 判据一致性：白名单提取正则必须与网关替换正则等价 —— 否则会出现
 *      「网关照替换、契约查不到」的漏网（`{{store.intro}}` 就是这种：不替换、原样留在提示词里）
 *   ③ 拼装格式：门店介绍必须带值；人设两个字段必须带标签，全空时必须整段消失而不是留空标签
 *   ④ 真实数据链路：临时门店（分别填/不填介绍与人设）→ buildVariables → 渲染，逐项对值
 *
 * ★ 2026-09-20：「你想拍什么风格？」模块（{{userIdea}}）已从整条链路删除 ⇒
 *   本脚本原本钉住它的正向断言，现改成**反向**断言（模板与白名单里都不许再出现）。
 *
 * ★ 2026-09-20：菜单资产新增**套餐**（`dish.kind='COMBO'`）⇒ 新增变量 {{comboInfo}}。
 *   它与上面的字段不同，是**正向**断言（7 个模板都必须引用、恰好一次），
 *   并且单菜那一侧要反向断言「comboInfo 必须是空串」—— 否则每道炒菜都会被写成套餐。
 *
 * ★ 2026-09-20 同日：流量款从「四款文案」拆成独立功能（`creation.mode='TOPIC'`）⇒
 *   `copy_traffic` 的模板与白名单**都不再包含门店/菜品**（改用 {{topicInfo}}）。
 *   所以本脚本里所有「7 个模板都引用 X」的断言都按「菜品稿 / 话题稿」两组拆开：
 *   菜品组正向、话题组**反向**（引用了就渲染成一排空标题，模型会自己编一个店名补上）。
 *   新增 ⑥ 段专测话题方向库（同一天稳定、隔天轮换、节点只抢 14 天内的头条）。
 *
 * 用法：npm run ai-prompts:verify
 * 用一个一次性手机号造临时商户/门店/菜品/创作，跑完硬删；不动任何真实商户数据。
 * 未配置数据库时只跑 ①②③（纯离线），仍然有意义。
 *
 * ★ 2026-09-25：菜品从「创建时必选」改成**可选项**（可以不选、默认不选）⇒ `{{dishName}}`
 *   为空变成**预期状态**。新增 ⑦ 段与 4.2b：三处会因此**静默**出问题的地方逐个钉住 ——
 *   ① 提示词那一行空着（模型以为资料漏了，自己编一道菜）
 *   ② 兜底模板里的 `{{storeName}}的{{dishName}}，…` 渲染成「大帅餐饮的，…」这种病句
 *   ③ 创建标题落 undefined ⇒ 前端 4 处 `title || '未命名创作'` 全显示「未命名创作」
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import {
  COPY_PROMPT,
  COPY_TRAFFIC_PROMPT,
  COPY_PERSONA_PROMPT,
  COPY_KNOWLEDGE_PROMPT,
  COPY_PRODUCT_PROMPT,
  COPY_RECOMMEND_PROMPT,
  STORY_PROMPT,
  COPY_FALLBACK,
  COPY_TRAFFIC_FALLBACK,
  COPY_PERSONA_FALLBACK,
  COPY_KNOWLEDGE_FALLBACK,
  COPY_PRODUCT_FALLBACK,
  COPY_RECOMMEND_FALLBACK,
  STORY_FALLBACK,
  CREATION_SCENE_PROMPTS,
  STORYBOARD_SCENE,
} from '../prisma/prompts.js'
// 人设型范文池：数据本身也要守（条数/长度/去重/轮转不重复），不然「抽一条」会静默退化成「总抽同一条」
import {
  PERSONA_SAMPLES,
  personaBandOf,
  personaSampleIndex,
  personaSamplesFor,
  sampleLeaks,
} from '../src/lib/persona-samples.js'
import {
  extractPlaceholders,
  findUnknownPlaceholders,
  findMalformedPlaceholders,
  validateTemplate,
  SCENE_VARIABLES,
} from '../src/ai/prompt-vars.js'
import { renderTemplate } from '../src/ai/gateway.js'
import { formatDateInfo, shanghaiYmd, upcomingNodes, LUNAR_FESTIVAL_MAX_YEAR } from '../src/lib/festival.js'
// 话题方向库（流量款独立功能的时间/话题来源）
import { formatTopicInfo, topicDirections, IDENTITY_CUTS, EVERGREEN_TOPICS, topicFamilyOf } from '../src/lib/topic.js'
import {
  buildVariables,
  formatPersona,
  formatComboInfo,
  createCreation,
  updateCreation,
  CONTENT_MODES,
  TOPIC_TRACK,
  STYLE_TRACKS,
  DEFAULT_STYLE_TRACK,
  isStyleTrack,
  StyleCreationDishForbiddenError,
  StyleCreationTrackForbiddenError,
  speakerRoleFor,
  unsupportedAddressFacts,
} from '../src/services/creation.service.js'
import { upsertAiScene, AdminAiInvalidTemplateError } from '../src/services/admin-ai.service.js'
// ★ 菜品空值注解：模板侧是 {{dishEmptyNote}}，取值在 src/lib/dish-mention.ts。
//   这里钉的是「buildVariables 真的把它接上了」——纯离线脚本（verify-dish-mention.ts）
//   只能验判据与模板，验不了变量装配这一步（漏接线的后果是：没选菜时那段说明**整段消失**）。
import { DISH_EMPTY_NOTE, dishEmptyNoteFor } from '../src/lib/dish-mention.js'

const prisma = new PrismaClient()
/** 一次性测试账号：本脚本专用，跑完硬删。与其他 verify 脚本的号段刻意错开 */
const PHONE = '13900008811'

let pass = 0
let fail = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? `  ${extra}` : ''}`)
  }
}
function section(t: string) {
  console.log(`\n── ${t} ──`)
}

/** 7 个创作场景的「模板 + 兜底」清单（2026-09-21 四款改型：删介绍款/质量款，换人设型/干货型/产品型） */
const TEMPLATES: Array<{ code: string; label: string; tpl: string; fallback: string }> = [
  { code: 'copy_generate', label: '文案·通用（兼容旧客户端）', tpl: COPY_PROMPT, fallback: COPY_FALLBACK },
  { code: 'copy_traffic', label: '文案·流量款', tpl: COPY_TRAFFIC_PROMPT, fallback: COPY_TRAFFIC_FALLBACK },
  { code: 'copy_persona', label: '文案·人设型', tpl: COPY_PERSONA_PROMPT, fallback: COPY_PERSONA_FALLBACK },
  { code: 'copy_knowledge', label: '文案·知识型', tpl: COPY_KNOWLEDGE_PROMPT, fallback: COPY_KNOWLEDGE_FALLBACK },
  { code: 'copy_product', label: '文案·产品型', tpl: COPY_PRODUCT_PROMPT, fallback: COPY_PRODUCT_FALLBACK },
  { code: 'copy_recommend', label: '文案·种草型', tpl: COPY_RECOMMEND_PROMPT, fallback: COPY_RECOMMEND_FALLBACK },
  { code: 'storyboard_generate', label: '分镜', tpl: STORY_PROMPT, fallback: STORY_FALLBACK },
]

/**
 * ★ 话题驱动模板（流量款）。
 *
 * 流量款已拆成独立功能：输入里**没有门店、也没有菜品**，那几个变量在话题稿里全是空串。
 * 模板一旦引用它们，渲染出来就是一排空标题（「【门店】｜品类：｜城市：」），
 * 模型会以为信息漏了并**自己编一个店名补上** —— 而且不报错。
 * 所以下面凡「7 个模板都要引用 X」的断言都按这两组分开，话题组另补**反向**断言。
 */
const TOPIC_CODES = new Set(['copy_traffic'])
const dishTemplates = TEMPLATES.filter((t) => !TOPIC_CODES.has(t.code))
const topicTemplates = TEMPLATES.filter((t) => TOPIC_CODES.has(t.code))

/**
 * 用「记录所有被读取的键」的代理渲染一次，得到网关**真正会替换掉**的占位符集合。
 * 这是验证「提取正则 == 替换正则」的关键手段：不能靠肉眼看两条正则长得像。
 */
function placeholdersGatewayReplaces(tpl: string): string[] {
  const seen = new Set<string>()
  const spy = new Proxy({} as Record<string, string>, {
    get: (_t, k) => {
      if (typeof k !== 'string') return undefined
      seen.add(k)
      return `⟨${k}⟩`
    },
  })
  renderTemplate(tpl, spy)
  return [...seen].sort()
}

// ──────────────────────── ① 模板层（离线） ────────────────────────
section('① 模板层：占位符都在白名单内 / 关键字段确实被引用')

for (const t of TEMPLATES) {
  const problems = validateTemplate(t.code, t.tpl)
  check(problems.length === 0, `${t.label} 模板校验通过`, problems.join('；'))
  const fbProblems = validateTemplate(t.code, t.fallback)
  check(fbProblems.length === 0, `${t.label} 兜底模板校验通过`, fbProblems.join('；'))
}

// 门店介绍 / 老板人设此前从未进过提示词，这里钉住「以后不许再掉」
for (const t of dishTemplates) {
  check(t.tpl.includes('{{storeIntro}}'), `${t.label} 引用了门店介绍 {{storeIntro}}`)
  check(t.tpl.includes('{{persona}}'), `${t.label} 引用了门店人设 {{persona}}`)
}
// 反向：话题模板**不许**引用它们 —— 渲染成空串会让模型以为门店信息漏了，于是自己编一个
for (const t of topicTemplates) {
  check(
    !t.tpl.includes('{{storeIntro}}') && !t.tpl.includes('{{persona}}'),
    `${t.label}（话题）不引用门店介绍/人设`,
  )
}

// ★ 套餐信息（{{comboInfo}}）与上面两个字段不同，它**必须**在 7 个模板里都被引用：
//   套餐与单菜在库里是同一张表，「菜名/简介/卖点」表达不出「含哪些菜、多少钱」，
//   而这两件事正是套餐推广的全部卖点 —— 模板少引用一个场景，那个场景的套餐文案就退回编造。
//   所以这里逐个钉「引用」而不是「可以引用」。
for (const t of dishTemplates) {
  check(t.tpl.includes('{{comboInfo}}'), `${t.label} 引用了套餐信息 {{comboInfo}}`)
}
// 且必须**只出现一次**：同一份套餐信息出现两遍，模型会当成两份不同的套餐去写（同 userIdea 的教训）
for (const t of dishTemplates) {
  const n = (t.tpl.match(/\{\{comboInfo\}\}/g) ?? []).length
  check(n === 1, `${t.label} 恰好引用一次 {{comboInfo}}`, `实际 ${n} 次`)
}
// 反向：话题稿没有门店、没有菜品，更没有套餐 —— 引用它只会渲染成空串
for (const t of topicTemplates) {
  check(!t.tpl.includes('{{comboInfo}}'), `${t.label}（话题）不引用套餐信息 {{comboInfo}}`)
}
// 兜底模板不加：兜底文案本来就短，塞套餐明细只会更容易超出口播长度（同 storeIntro 的取舍）
check(
  TEMPLATES.every((t) => !t.fallback.includes('{{comboInfo}}')),
  '兜底模板不引用 {{comboInfo}}（避免超出口播长度）',
)
// 文案与分镜都要认这个变量：一个场景漏登记白名单，后台一保存就报「未支持的变量」
check(
  findUnknownPlaceholders('copy_product', '{{comboInfo}}').length === 0 &&
    findUnknownPlaceholders('storyboard_generate', '{{comboInfo}}').length === 0,
  'comboInfo 已在文案与分镜两个场景的白名单里',
)
// 反向：话题场景的白名单里**没有** comboInfo —— 后台若给流量款手填这段会被当场拒绝
check(
  findUnknownPlaceholders('copy_traffic', '{{comboInfo}}').length === 1,
  'comboInfo 不在流量款（话题）白名单里',
)

// ★ 反向断言：{{userIdea}} 已随「你想拍什么风格？」模块一起删除，**不许再出现**。
//   为什么会有人加回来：模板里那一行看着「挺合理」，顺手补回去就成了一段
//   永远渲染成兜底文案的假内容 —— 模型看得见、用户却填不了，而且不改代码查不出来。
for (const t of TEMPLATES) {
  check(!t.tpl.includes('{{userIdea}}'), `${t.label} 模板已不含 {{userIdea}}`)
  check(!t.fallback.includes('{{userIdea}}'), `${t.label} 兜底模板已不含 {{userIdea}}`)
}
// 反向的一半：白名单里也必须没有 —— 这样后台有人手填会当场被拒，而不是静默渲染成兜底文案
check(
  findUnknownPlaceholders('copy_traffic', '{{userIdea}}').length === 1 &&
    findUnknownPlaceholders('storyboard_generate', '{{userIdea}}').length === 1,
  'userIdea 已不在文案与分镜的白名单里（后台若手填会被拒）',
)

// 兜底文案刻意保持短，不塞门店介绍（见 prisma/prompts.ts 注释）
check(
  TEMPLATES.filter((t) => t.code.startsWith('copy_')).every((t) => !t.fallback.includes('{{storeIntro}}')),
  '兜底文案不引用门店介绍（避免超出口播长度）',
)

// 复杂度必须同时进入文案和分镜：否则简单版只约束镜头数量，口播仍按长稿生成。
check(
  dishTemplates.every((t) => t.tpl.includes('{{copyLengthRule}}')) &&
    topicTemplates.every((t) => t.tpl.includes('{{copyLengthRule}}')),
  '所有文案模板都引用 {{copyLengthRule}}',
)
check(
  STORY_PROMPT.includes('{{shotCountRule}}') && STORY_PROMPT.includes('{{copyLengthRule}}'),
  '分镜模板同时收到镜头数量和口播长度规则',
)
check(
  findUnknownPlaceholders('copy_product', '{{copyLengthRule}}').length === 0 &&
    findUnknownPlaceholders('copy_traffic', '{{copyLengthRule}}').length === 0 &&
    findUnknownPlaceholders('storyboard_generate', '{{copyLengthRule}}').length === 0,
  'copyLengthRule 已进入文案、话题和分镜白名单',
)

// 4 款文案必须彼此不同 —— 款式是靠「选哪个模板」生效的，模板一旦撞车就等于款式失效
const copyTpls = TEMPLATES.filter((t) => t.code.startsWith('copy_') && t.code !== 'copy_generate').map((t) => t.tpl)
check(new Set(copyTpls).size === copyTpls.length, '4 款文案模板互不相同', `共 ${copyTpls.length} 份`)

// ★ 产品型也必须先有钩子。2026-10-19 起它的钩子按**动作**分五类（取舍/纠错/门槛/数字/场景），
//   不再给「视角 + 示例句」——旧写法五个标签共用一个句法骨架，模型照抄句式、开头必然同质化。
check(COPY_PRODUCT_PROMPT.includes('【开头钩子 · 第一优先级】'), '产品型明确要求首句先给钩子')
// ★★ 2026-10-19 第二次改：用户反馈「钩子不够大胆，都是小心翼翼的不像引流的人会做的事」。
//   上一版五类动作（取舍/纠错/门槛/数字/场景）**分类对了、语气错了** —— 五条全是「告知」型动作，
//   写出来必然像商品说明。这一版换成五条**带风险、带立场**的路数，并补一条「胆子测试」
//   （抠掉菜名后换任何一家同行都能照说 ⇒ 不合格），否则模型一定会退回温和的告知句。
check(
  ['反常识型', '当众立论型', '逼问型', '硬门槛型', '算账对峙型'].every((t) =>
    COPY_PRODUCT_PROMPT.includes(t),
  ),
  '产品型钩子覆盖反常识/当众立论/逼问/硬门槛/算账五条带风险的路数',
)
check(
  COPY_PRODUCT_PROMPT.includes('胆子测试') && COPY_PRODUCT_PROMPT.includes('换任何一家同行都能照说'),
  '产品型有可执行的胆子测试（否则钩子会退回温和的告知句）',
)
// ★★★ 胆子一放开，就必须同时把边界钉死 —— 否则「大胆」会直接变成骂顾客、地域歧视。
//   用户给的范例原句是「我不是瞧不起固安人的胃」：**结构**可以学（先立靶子再翻手），
//   但**靶子不能是人**（他那句本身就把本地人当靶子，照抄会被挂出去）。这条断言守的就是这个分寸。
check(
  COPY_PRODUCT_PROMPT.includes('不许冲吃饭的人') && COPY_PRODUCT_PROMPT.includes('地域歧视'),
  '产品型放开胆子的同时钉死「不冲顾客 / 不贬低某地人」',
)
check(
  COPY_PRODUCT_PROMPT.includes('假问句不算'),
  '产品型区分真问句与「还在纠结吃什么吗」这类假问句',
)
check(
  COPY_PRODUCT_PROMPT.includes('不要沿用任何示例句式'),
  '产品型明确禁止照抄示例句式（否则五条路数会退化成一个模板）',
)
// ★★★ 只换路数不够：五类路数里模型最爱用问句，连写会变成「五条都是问句」——
//   所以句式也要轮换，这条断言是「每次不能重复」在模板侧的落点。
check(
  COPY_PRODUCT_PROMPT.includes('句式也不许一样'),
  '产品型要求同店连写时换句式（不只换路数）',
)
check(
  COPY_PRODUCT_PROMPT.includes('{{recentCopyAvoid}}'),
  '产品型接了近期避让（同一道菜连写要换开头路数）',
)
check(
  COPY_PRODUCT_PROMPT.includes('写完自检') && COPY_PRODUCT_PROMPT.includes('有没有踩四条红线'),
  '产品型有自己的写完自检（胆子测试 / 四条红线 / 第二句落地）',
)
check(
  COPY_PRODUCT_PROMPT.includes('第二句话必须马上回答钩子') &&
    COPY_PRODUCT_PROMPT.includes('不能连续两句只吊胃口'),
  '产品型第二句必须兑现钩子，不能只制造悬念',
)
check(
  ['今天给大家介绍', '我们家有一道', '美食不只是', '每一道菜都', '还在纠结吃什么吗'].every((s) =>
    COPY_PRODUCT_PROMPT.includes(s),
  ),
  '产品型显式禁止五类通用 AI 开场',
)
check(
  COPY_PRODUCT_PROMPT.includes('不得编造优惠、份量、招牌地位、销量或顾客评价'),
  '产品型钩子仍受事实边界约束',
)

// 款式不是变量：模板里若出现 {{track}}，说明有人把「选模板」误实现成了「填变量」
for (const t of TEMPLATES) {
  const hasTrack = extractPlaceholders(t.tpl).some((v) => v === 'track' || v === 'trackLabel')
  check(!hasTrack, `${t.label} 未把款式写成变量（款式靠选模板生效）`)
}

// 同步脚本与 seed 共用同一份清单，别出现「代码里 6 个、清单里 5 个」
// ★ 2026-09-21 四款改型后文案场景由 5 个变 6 个（删介绍/质量，增人设/干货/产品）
check(
  CREATION_SCENE_PROMPTS.length === 6 && STORYBOARD_SCENE.code === 'storyboard_generate',
  '场景清单完整（文案 6 + 分镜 1）',
)

check(unsupportedAddressFacts('地址在经十路100号，欢迎到店', '山东省济南市历下区经十路100号').length === 0, '输入地址中的街道不会被误判')
check(unsupportedAddressFacts('地址在和平路88号，欢迎到店', '山东省济南市历下区经十路100号').includes('和平路88号'), '地址触发词后的未提供街道会被拦截')
check(unsupportedAddressFacts('庆丰路那家，老板就一个想法', '河北省廊坊市固安县新中东街103号').includes('庆丰路'), '隐含地址指代中的未提供街道会被拦截')
check(unsupportedAddressFacts('这一路都很热闹，中心位置方便', '山东省济南市历下区经十路100号').length === 0, '普通文本不触发地址事实校验')

// ──────────────────────── ② 判据一致性（离线） ────────────────────────
section('② 判据一致性：白名单提取正则 == 网关替换正则')

for (const t of TEMPLATES) {
  const byExtract = extractPlaceholders(t.tpl).sort()
  const byGateway = placeholdersGatewayReplaces(t.tpl)
  check(
    JSON.stringify(byExtract) === JSON.stringify(byGateway),
    `${t.label} 两侧看到的占位符一致`,
    byExtract.length === byGateway.length ? `${byExtract.length} 个` : `提取 ${byExtract.length} / 替换 ${byGateway.length}`,
  )
}

// 复现缺陷本身：小写变量是「静默变空串」，点号变量是「原样留在提示词里」
const lowerCase = '门店：{{storeName}}｜菜品：{{dishname}}'
check(
  renderTemplate(lowerCase, { storeName: '大帅川菜' }) === '门店：大帅川菜｜菜品：',
  '复现：未支持的变量被静默替换成空串（不报错）',
)
// ★ 用菜品场景（copy_intro）验：话题场景现在连 storeName 都不在白名单里，
//   拿它测「只多出一个 dishname」会变成多出两个，断言本身失去意义。
check(
  findUnknownPlaceholders('copy_product', lowerCase).join(',') === 'dishname',
  '能拦住未支持的变量 {{dishname}}',
)
check(
  findMalformedPlaceholders(lowerCase).length === 0,
  '小写变量不会被误判成「写法不合法」',
)
check(
  findMalformedPlaceholders('门店介绍：{{store.intro}}').join(',') === '{{store.intro}}',
  '能拦住写法不合法、网关不会替换的 {{store.intro}}',
)
check(
  renderTemplate('{{store.intro}}', {}) === '{{store.intro}}',
  '复现：写法不合法的占位符会原样出现在提示词里',
)
check(
  findMalformedPlaceholders('{{ dishName }}').length === 0 &&
    findUnknownPlaceholders('copy_product', '{{ dishName }}').length === 0,
  '带空格的 {{ dishName }} 属于合法写法，两边都放行',
)
// 白名单里没有的场景宽松放行，避免新场景一上线就被拦
check(validateTemplate('brand_new_scene', '{{whatever}}').length === 0, '未登记的场景不校验（宽松放行）')

// ──────────────────────── ③ 拼装格式（离线） ────────────────────────
section('③ 拼装格式：门店介绍带值 / 人设两字段带标签')

check(
  formatPersona({ bossTags: '90后老板 / 退伍军人', activity: '开业酬宾 8 折' }) ===
    '老板人设标签：90后老板 / 退伍军人；最近想重点告诉顾客：开业酬宾 8 折',
  '人设两字段都有 → 两个标签都在，顺序为「标签 → 活动」',
)
check(
  formatPersona({ bossTags: '匠人型老板', activity: null }) === '老板人设标签：匠人型老板',
  '只有老板标签 → 不出现「最近想重点告诉顾客」空标签',
)
check(
  formatPersona({ bossTags: null, activity: '每周三会员日' }) === '最近想重点告诉顾客：每周三会员日',
  '只有门店活动 → 不出现「老板人设标签」空标签',
)
check(
  formatPersona({ bossTags: '   ', activity: '\n' }) === '',
  '两字段都是空白字符 → 整段消失（视同未填写）',
)
check(formatPersona(null) === '', '门店没有填写过任何东西 → 空串')

// ── 套餐信息（纯函数，可离线验：不连库就能把每个分支走一遍）──
const comboDish = {
  kind: 'COMBO',
  priceFen: 8800,
  originalPriceFen: 12000,
  comboItems: [
    { quantity: 1, dish: { name: '宫保鸡丁', deletedAt: null } },
    { quantity: 2, dish: { name: '米饭', deletedAt: null } },
    // 故意混一条指向已软删菜的明细：读取侧必须把它滤掉
    { quantity: 1, dish: { name: '例汤', deletedAt: new Date() } },
  ],
}
const comboInfo = formatComboInfo(comboDish)
check(
  comboInfo.includes('¥88') && comboInfo.includes('¥120') && comboInfo.includes('省 ¥32'),
  'comboInfo 带出套餐价 / 原价 / 省多少',
  comboInfo,
)
check(
  comboInfo.includes('宫保鸡丁') && comboInfo.includes('米饭×2'),
  'comboInfo 带出套餐内容与份数（份数 >1 才标 ×N）',
)
check(!comboInfo.includes('例汤'), 'comboInfo 不含已软删的菜（读取侧过滤）')
check(
  formatComboInfo({ ...comboDish, kind: 'SINGLE' }) === '',
  '★ 单菜 → comboInfo 是**空串**（不是「本菜品不是套餐」这类占位文字，否则模型会在一道炒菜上讨论套餐）',
)
check(formatComboInfo(null) === '', '没有关联菜品 → comboInfo 是空串')
check(formatComboInfo(undefined) === '', 'undefined 也不会抛（落库路径可能给空）')
// 原价不高于套餐价（假划线价）：宁可完全不提「省」，也不要在文案里写「省 ¥-8」
check(
  !formatComboInfo({ kind: 'COMBO', priceFen: 8800, originalPriceFen: 8800, comboItems: [] }).includes('省'),
  '原价 == 套餐价 → 不说「省」（假划线价比不划线更伤信任）',
)
// 套餐没有内容是**异常**状态：整段消失会让模型自己编「包含什么」
check(
  formatComboInfo({ kind: 'COMBO', priceFen: 8800, originalPriceFen: null, comboItems: [] }).includes('还没有填'),
  '明细为空 → 明确说「还没有填」，而不是让这一段消失（否则模型会编出不存在的菜）',
)
check(
  formatComboInfo({
    kind: 'COMBO',
    priceFen: 8800,
    originalPriceFen: null,
    comboItems: [{ quantity: 1, dish: { name: '已删菜', deletedAt: new Date() } }],
  }).includes('还没有填'),
  '明细全指向已删菜 → 同样按「还没有填」处理',
)
// 没有价格时不要凭空造一个「套餐价 ¥0」
check(
  !formatComboInfo({ kind: 'COMBO', priceFen: null, originalPriceFen: null, comboItems: [{ quantity: 1, dish: { name: '米饭', deletedAt: null } }] }).includes('¥'),
  '套餐价为空 → 整段不提价格（而不是写出「套餐价 ¥0」）',
)

// ──────────────────────── ④ 真实数据链路（需要数据库） ────────────────────────
section('④ 真实数据链路：临时门店 → buildVariables → 渲染')

/** 造一家临时门店：intro / persona 由参数决定，返回所需 id */
async function makeStore(
  merchantId: bigint,
  tag: string,
  intro: string | null,
  persona: { bossTags: string | null; activity: string | null } | null,
) {
  const store = await prisma.store.create({
    data: {
      merchantId,
      name: `契约测试门店-${tag}`,
      category: '川菜',
      province: '山东省',
      city: '济南市',
      district: '历下区',
      address: '经十路100号',
      intro,
    },
  })
  if (persona) {
    await prisma.persona.create({
      data: { merchantId, storeId: store.id, bossTags: persona.bossTags, activity: persona.activity },
    })
  }
  const dish = await prisma.dish.create({
    data: { storeId: store.id, name: `契约测试菜品-${tag}`, intro: '现做现卖，出锅即上桌', sellingPoints: '分量实在 / 价格透明' },
  })
  const creation = await createCreation(prisma, merchantId, {
    storeId: store.id,
    dishId: dish.id,
    // 菜品稿三款之一：流量款已拆成话题稿（mode='TOPIC'），不再是菜品稿的款式
    track: 'PRODUCT',
    complexity: 'COMPLEX',
  })
  await prisma.creation.update({ where: { id: creation.id }, data: { copyText: '测试用口播文案正文' } })
  return { storeId: store.id, dishId: dish.id, creationId: creation.id }
}

const INTRO = '开了十二年的老川菜馆，招牌是每天现炒的辣子鸡。'
const BOSS_TAGS = '90后老板 / 退伍军人'
const ACTIVITY = '开业酬宾 8 折'
let dbReady = true
try {
  await prisma.$queryRaw`SELECT 1`
} catch (e) {
  dbReady = false
  console.log(`  ⚠ 数据库不可用，跳过真实链路（离线部分仍已校验）：${(e as Error).message.slice(0, 120)}`)
}

if (dbReady) {
  let merchantId: bigint | null = null
  try {
    const merchant = await prisma.merchant.create({ data: { phone: PHONE, nickname: '契约测试账号' } })
    merchantId = merchant.id

    // 4.1 信息填全的门店
    const full = await makeStore(merchantId, 'full', INTRO, { bossTags: BOSS_TAGS, activity: ACTIVITY })
    const v = await buildVariables(prisma, full.creationId, { track: 'PRODUCT' })
    check(v.storeIntro === INTRO, 'buildVariables 产出了门店介绍', `storeIntro=${JSON.stringify(v.storeIntro).slice(0, 40)}`)
    check(
      v.persona === `老板人设标签：${BOSS_TAGS}；最近想重点告诉顾客：${ACTIVITY}`,
      'buildVariables 产出的门店人设带标签',
      v.persona,
    )
    check(v.dishName === '契约测试菜品-full', '菜品名称仍在变量里')
    check(
      v.province === '山东省' && v.city === '济南市' && v.district === '历下区' &&
        v.address === '经十路100号' && v.fullAddress === '山东省济南市历下区经十路100号',
      '省/市/区县/详细地址及完整地址都进入变量',
      v.fullAddress,
    )
    check(v.sellingPoints === '分量实在 / 价格透明', '菜品卖点仍在变量里')
    // ★★ 2026-09-29：选了菜时，那段「空 = 这次没选具体菜品…改讲门店本身」的说明**必须消失**。
    //    它原来写死在模板里，于是菜名后面紧跟着一句「改讲门店本身」，模型照做 ⇒ 整篇改写门店介绍。
    //    实测报出菜名率因此从 92% 掉到 75%（数据见 src/lib/dish-mention.ts）。
    check(
      v.dishEmptyNote === '',
      '★★ 选了菜时「菜品空值注解」为空串（否则提示词里菜名后会跟着一句「改讲门店本身」）',
      `dishEmptyNote=${JSON.stringify(v.dishEmptyNote).slice(0, 34)}`,
    )

    // 渲染一次真模板，确认值真的落到了提示词里（而不只是变量对象里有）
    const rendered = renderTemplate(COPY_PRODUCT_PROMPT, v as unknown as Record<string, string>)
    check(rendered.includes(INTRO), '渲染后提示词含门店介绍正文')
    check(rendered.includes(BOSS_TAGS) && rendered.includes(ACTIVITY), '渲染后提示词含门店人设两字段')
    check(!rendered.includes('{{'), '渲染后提示词已无残留占位符', rendered.match(/\{\{[^}]*\}\}/g)?.join('、') ?? '')
    check(rendered.includes('【门店介绍】'), '提示词保留了【门店介绍】段落标题')
    check(rendered.includes('经十路100号') && rendered.includes('完整地址'), '文案提示词含详细地址与完整地址核对段')

    // ★ 4.1b 套餐链路：光测纯函数只能验格式，「include 有没有真把 comboItems 读出来」
    //   只有连库才测得到 —— 漏了 include 的话 comboInfo 会静默变成「（门店还没有填具体菜品）」，
    //   而那句提示看起来完全合理，没人会怀疑是代码没读。
    const comboStore = await prisma.store.create({
      data: { merchantId, name: '契约测试门店-combo', category: '川菜', city: '济南' },
    })
    const memberA = await prisma.dish.create({ data: { storeId: comboStore.id, name: '套餐里的辣子鸡' } })
    const memberB = await prisma.dish.create({ data: { storeId: comboStore.id, name: '套餐里的米饭' } })
    const combo = await prisma.dish.create({
      data: { storeId: comboStore.id, name: '契约测试套餐', kind: 'COMBO', priceFen: 8800, originalPriceFen: 12000 },
    })
    await prisma.dishComboItem.createMany({
      data: [
        { comboId: combo.id, dishId: memberA.id, quantity: 1, sort: 0 },
        { comboId: combo.id, dishId: memberB.id, quantity: 2, sort: 1 },
      ],
    })
    const comboCreation = await createCreation(prisma, merchantId, {
      storeId: comboStore.id,
      dishId: combo.id,
      track: 'PRODUCT',
      complexity: 'COMPLEX',
    })
    const vCombo = await buildVariables(prisma, comboCreation.id, { track: 'PRODUCT' })
    check(vCombo.dishName === '契约测试套餐', '选套餐时 dishName 就是套餐名（复用同一张表的直接收益）')
    check(
      vCombo.comboInfo.includes('套餐里的辣子鸡') && vCombo.comboInfo.includes('套餐里的米饭×2'),
      'buildVariables 真的读出了套餐明细（漏 include 会静默退化成「还没有填」）',
      vCombo.comboInfo,
    )
    check(vCombo.comboInfo.includes('¥88') && vCombo.comboInfo.includes('省 ¥32'), '套餐价与优惠额进了变量')
    const renderedComboCopy = renderTemplate(COPY_PRODUCT_PROMPT, vCombo as unknown as Record<string, string>)
    const renderedComboStory = renderTemplate(STORY_PROMPT, vCombo as unknown as Record<string, string>)
    check(
      renderedComboCopy.includes('套餐里的辣子鸡') && renderedComboCopy.includes('¥88'),
      '文案提示词里出现了套餐内容与价格',
    )
    // 分镜那一侧也要吃到：文案与分镜是两次独立调用，漏一个就等于「只有文案知道这是套餐」
    check(
      renderedComboStory.includes('套餐里的辣子鸡') && renderedComboStory.includes('¥88'),
      '分镜提示词里同样出现了套餐内容与价格',
    )
    check(!renderedComboCopy.includes('{{') && !renderedComboStory.includes('{{'), '套餐场景渲染后无残留占位符')
    // 反向：上面 4.1 那家门店关联的是**单菜**，它的 comboInfo 必须是空串，
    // 否则每道炒菜的提示词里都会挂一句「套餐价」，模型会把单菜写成套餐
    check(v.comboInfo === '', '★ 单菜门店的 comboInfo 是空串（反向：单菜不该带套餐信息）')

    // 4.2 什么都没有的门店：介绍为空串、人设为空串（模板会留下一行空标题，这是可接受的）
    const bare = await makeStore(merchantId, 'bare', null, null)
    const v2 = await buildVariables(prisma, bare.creationId, { track: 'PRODUCT' })
    check(v2.storeIntro === '', '未填门店介绍 → storeIntro 为空串（不会变成 undefined）')
    check(v2.persona === '', '未填人设 → persona 为空串（不留空标签）')
    const rendered2 = renderTemplate(COPY_PRODUCT_PROMPT, v2 as unknown as Record<string, string>)
    check(!rendered2.includes('老板人设标签：') && !rendered2.includes('最近想重点告诉顾客：'), '渲染后不出现空的人设标签')
    check(!rendered2.includes('{{'), '未填内容的门店渲染后同样无残留占位符')

    // ── 4.2b ★★ 「无菜品」的真实链路（2026-09-25 菜品改成可选项）──
    //   这一段是本次改动在服务端的验收核心，要同时证明五件事：
    //     ① 不传 dishId 就能创建（`mode='DISH'` 不再要求菜品）
    //     ② 菜品四项变量确实是空串 —— 关键在「没有拿菜单里的菜顶替」
    //     ③ 渲染后的文案与分镜提示词里**不出现这家店的任何菜名**（=「按无菜品的方式生成」）
    //     ④ 提示词里带着「这次没选具体菜品」的空值说明（模型看得见，而不是以为资料漏了）
    //     ⑤ 标题退回门店名，不是 undefined（否则前端 4 处兜底全显示「未命名创作」）
    //   ③ 是这里唯一有份量的断言：前四条「代码没崩」，只有③能证明 AI 不会编出一道菜。
    const noDishStore = await prisma.store.create({
      data: {
        merchantId,
        name: '契约测试门店-没选菜',
        category: '川菜',
        city: '济南',
        intro: '开了十二年的老川菜馆，招牌是每天现炒的辣子鸡。',
      },
    })
    // ★ 这家店**有菜**，而创作不引用它 —— 这样才能验「没选菜时不会拿菜单里的菜顶替」
    //   （没有这道菜的话，③ 就是一条永远为真的假断言）。
    await prisma.dish.create({ data: { storeId: noDishStore.id, name: '不该被写进文案的菜-麻婆豆腐' } })
    const noDish = await createCreation(prisma, merchantId, {
      storeId: noDishStore.id,
      track: 'PRODUCT',
      complexity: 'COMPLEX',
    })
    check(noDish.dishId === null, '★ 不选菜品也能创建（dishId 落 null，不是报错）', `dishId=${noDish.dishId}`)
    check(
      noDish.title === '契约测试门店-没选菜',
      '★ 没选菜品时标题退回门店名（留 undefined 会让前端显示「未命名创作」）',
      `title=${JSON.stringify(noDish.title)}`,
    )
    const vNoDish = await buildVariables(prisma, noDish.id, { track: 'PRODUCT' })
    check(
      vNoDish.dishName === '' && vNoDish.dishIntro === '' && vNoDish.sellingPoints === '' && vNoDish.comboInfo === '',
      '★ 没选菜品时菜品四项变量全为空串（不是那家店菜单里的第一道菜）',
      `dishName=${JSON.stringify(vNoDish.dishName)} comboInfo=${JSON.stringify(vNoDish.comboInfo)}`,
    )
    check(vNoDish.storeName === '契约测试门店-没选菜', '没选菜品不影响门店信息仍然喂进提示词')
    // ★ 反向的另一半：没选菜时那段说明**必须还在**。
    //   上面那条（选了菜 ⇒ 空串）很容易被「把变量整个删掉」满足 —— 那样没选菜的稿子会失去
    //   「改讲门店本身」的指引，模型又会去菜单里随手挑一道菜。两条一起才钉得住。
    check(
      vNoDish.dishEmptyNote === DISH_EMPTY_NOTE,
      '★ 没选菜时「菜品空值注解」仍是那段说明（空值路径与改动前逐字一致）',
      `dishEmptyNote=${JSON.stringify(vNoDish.dishEmptyNote).slice(0, 24)}…`,
    )
    const rdCopy = renderTemplate(COPY_PRODUCT_PROMPT, vNoDish as unknown as Record<string, string>)
    const rdStory = renderTemplate(STORY_PROMPT, vNoDish as unknown as Record<string, string>)
    check(!rdCopy.includes('{{') && !rdStory.includes('{{'), '没选菜品的提示词渲染后无残留占位符')
    check(
      !rdCopy.includes('不该被写进文案的菜') && !rdStory.includes('不该被写进文案的菜'),
      '★★「无菜品方式」：文案与分镜提示词里都不出现这家店的任何菜名（没选菜 ≠ 默认第一道菜）',
    )
    check(rdCopy.includes('这次没选具体菜品'), '渲染后的文案提示词带着「这次没选具体菜品」的空值说明')
    check(rdStory.includes('这次没选具体菜品'), '渲染后的分镜提示词同样带着空值说明')
    // 反向：这条创作**没选菜**，但门店本身有介绍 —— 门店资料该留着（别把「没选菜」当成
    // 「整条不涉及门店」处理，那样生出来的稿子会连自家店名都不提）。
    check(rdCopy.includes('开了十二年的老川菜馆'), '没选菜品 ≠ 不涉及门店：门店介绍仍然进提示词')

    // 4.3 后台保存场景的闸门：非法模板必须被拒，且库里内容不变
    const scene = await prisma.aiScene.findUnique({ where: { code: 'copy_traffic' } })
    if (!scene) {
      console.log('  ⚠ 库里没有 copy_traffic 场景，跳过保存闸门用例（先跑 npm run db:seed）')
    } else {
      const before = scene.promptTemplate
      const readBack = async () =>
        (await prisma.aiScene.findUniqueOrThrow({ where: { id: scene.id } })).promptTemplate
      const base = {
        code: scene.code,
        name: scene.name,
        fallbackTemplate: scene.fallbackTemplate,
        defaultModelId: scene.defaultModelId,
        fallbackModelIds: (scene.fallbackModelIds as unknown[]).map((x) => BigInt(x as string | number)),
        beanPrice: scene.beanPrice,
        timeoutMs: scene.timeoutMs,
        maxRetries: scene.maxRetries,
        temperature: scene.temperature === null ? null : Number(scene.temperature),
        maxOutputTokens: scene.maxOutputTokens,
        enabled: scene.enabled,
      }
      try {
        // 4.3.1 未支持的变量：copy_traffic 的白名单里没有 copyText（那是分镜场景才有的）
        let rejected: unknown = null
        try {
          await upsertAiScene(prisma, scene.id, { ...base, promptTemplate: `${before}\n口播文案：{{copyText}}` })
        } catch (e) {
          rejected = e
        }
        check(
          rejected instanceof AdminAiInvalidTemplateError,
          '保存含未支持变量 {{copyText}} 的模板被拒绝',
          (rejected as Error)?.message?.slice(0, 60) ?? '没有抛错',
        )
        check((await readBack()) === before, '被拒绝的模板没有写进库里')
        check(
          ((rejected as Error)?.message ?? '').includes('该场景可用变量'),
          '拒绝提示里直接给出了该场景的可用变量清单（后台不用翻文档）',
        )

        // 4.3.2 写法不合法（网关根本不会替换，会原样留在提示词里）
        let rejected2: unknown = null
        try {
          await upsertAiScene(prisma, scene.id, { ...base, promptTemplate: `${before}\n门店介绍：{{store.intro}}` })
        } catch (e) {
          rejected2 = e
        }
        check(rejected2 instanceof AdminAiInvalidTemplateError, '保存写法不正确的 {{store.intro}} 也被拒绝')
        check((await readBack()) === before, '写法不正确的模板同样没有写进库里')

        // 4.3.3 合法模板必须能存进去，否则这道闸门就是把后台锁死了
        let saved = false
        try {
          await upsertAiScene(prisma, scene.id, { ...base, promptTemplate: before })
          saved = true
        } catch {
          saved = false
        }
        check(saved, '原有的合法模板仍然可以正常保存（闸门没有误伤）')
      } finally {
        // 无论断言成败都还原：闸门用例绝不能把本地库的模板改坏
        await upsertAiScene(prisma, scene.id, { ...base, promptTemplate: before })
        check((await readBack()) === before, '用完例后 copy_traffic 模板已还原')
        if (before !== COPY_TRAFFIC_PROMPT) {
          console.log('  ℹ 库里的 copy_traffic 模板与 prisma/prompts.ts 不一致（后台改过？）→ 跑 npm run ai-prompts:sync 对齐')
        }
      }
    }

    // 4.5 ★★ 话题稿（流量款独立功能）：`mode='TOPIC'` 的真实链路。
    //     这一段是本次拆分的核心验收 —— 它要同时证明六件事：
    //       ① 不传门店也能创建（宿主门店由服务端解析）
    //       ② 门店/菜品相关变量**全是空串**（话题稿不喂它们）
    //       ③ 地域钩子来自**宿主门店档案**（不是用户填的，也不许调用方硬塞）
    //       ④ 宿主门店没填位置 ⇒ 整行不出现（不硬塞城市）
    //       ⑤ topicInfo 真的进了提示词，且提示词里不出现任何门店名/菜名
    //       ⑥ 传了门店/菜品会被拒（不是静默忽略）
    //
    // ★ 地域快照这条断言要能钉住「哪家门店当宿主」的取值规则（isDefault 优先、其次 id 最小）：
    //   所以先建一家**位置填全 + isDefault** 的门店，让结果与 fixture 的创建顺序无关。
    const locStore = await prisma.store.create({
      data: {
        merchantId,
        name: '契约测试门店-位置',
        province: '河北省',
        city: '廊坊市',
        district: '固安县',
        isDefault: true,
      },
    })
    const topicCreation = await createCreation(prisma, merchantId, {
      mode: 'TOPIC',
      complexity: 'COMPLEX',
    })
    check(
      topicCreation.mode === 'TOPIC' && topicCreation.track === TOPIC_TRACK,
      '话题稿创建成功：mode=TOPIC 且款式被强制成流量款',
      `mode=${topicCreation.mode} track=${topicCreation.track}`,
    )
    check(
      topicCreation.dishId === null && topicCreation.storeId !== null,
      '话题稿没有菜品，但挂了一家宿主门店（媒体归属要用）',
    )
    check(
      topicCreation.storeId === locStore.id,
      '宿主门店 = isDefault 那家（取值规则：isDefault 优先、其次 id 最小）',
      `storeId=${topicCreation.storeId} 期望=${locStore.id}`,
    )
    check(
      topicCreation.topicCity === '河北省廊坊市固安县',
      '★ 地域快照 = 宿主门店档案的省+市+区（服务端自取，不传参）',
      `topicCity=${JSON.stringify(topicCreation.topicCity)}`,
    )
    const vTopic = await buildVariables(prisma, topicCreation.id, {})
    check(
      vTopic.storeName === '' && vTopic.storeIntro === '' && vTopic.city === '' && vTopic.dishName === '',
      '★ 话题稿的门店/菜品变量全为空串（不喂进提示词）',
      `storeName=${JSON.stringify(vTopic.storeName)} city=${JSON.stringify(vTopic.city)} dishName=${JSON.stringify(vTopic.dishName)}`,
    )
    check(vTopic.comboInfo === '' && vTopic.persona === '', '话题稿的套餐信息与人设也是空串')
    check(vTopic.mode === 'TOPIC', 'buildVariables 带出了内容模式')
    check(vTopic.topicInfo.length > 0, '话题稿拿到了 topicInfo（今天 + 起头方向）')
    const renderedTopic = renderTemplate(COPY_TRAFFIC_PROMPT, vTopic as unknown as Record<string, string>)
    check(renderedTopic.includes('河北省廊坊市固安县'), '地域钩子进了提示词（门店档案 → topicInfo）')
    check(!renderedTopic.includes('{{'), '话题稿渲染后无残留占位符')
    check(
      !renderedTopic.includes('契约测试门店') && !renderedTopic.includes('契约测试菜品'),
      '★ 话题稿的提示词里**不出现**任何门店名与菜名',
    )

    // ★ 向后兼容：`topicCity` 已从 CreateCreationInput 删除，路由 schema 是 strip 模式，
    //   所以旧小程序包多传的它会被丢掉（不是 400，旧包不至于整条创建失败）。
    //   在 service 这一层就表现为「入参里没有这个字段」—— 这里用 as never 硬塞一个，
    //   断言它**不生效**（快照仍只认门店档案）。
    const staleParam = await createCreation(prisma, merchantId, {
      mode: 'TOPIC',
      complexity: 'SIMPLE',
      topicCity: '保定',
    } as never)
    check(
      staleParam.topicCity === '河北省廊坊市固安县',
      '★ 调用方硬塞 topicCity 不生效（地域只认门店档案，留口子会让地点无法追溯）',
      `topicCity=${JSON.stringify(staleParam.topicCity)}`,
    )

    // ★ 存量话题稿补快照：2026-09-21 之前，话题稿的城市是用户手填的，不填就落 null。
    //   改成「从门店档案取」之后，那些老稿子若不补就会**永远**少一行地域钩子，而且不报错
    //   （模型只是写得没那么接地气）。补的时机 = 下一次「保存设置」（前端点生成必走这一步）。
    await prisma.creation.update({ where: { id: topicCreation.id }, data: { topicCity: null } })
    const backfilled = await updateCreation(prisma, merchantId, topicCreation.id, {})
    check(
      backfilled.topicCity === '河北省廊坊市固安县',
      '★ 存量话题稿（快照为 null）在保存设置时自动补上地域快照',
      `topicCity=${JSON.stringify(backfilled.topicCity)}`,
    )
    // 反向：**已经取过快照的不许被改写** —— 门店改了位置不该让历史稿跟着变，
    // 否则「同一条稿重新生成结果不可复现」，用户只会觉得是玄学。
    await prisma.store.update({ where: { id: locStore.id }, data: { city: '石家庄市' } })
    const keptSnapshot = await updateCreation(prisma, merchantId, topicCreation.id, {})
    check(
      keptSnapshot.topicCity === '河北省廊坊市固安县',
      '★ 已有快照的话题稿不会被门店位置的变化改写（快照语义）',
      `topicCity=${JSON.stringify(keptSnapshot.topicCity)}`,
    )
    await prisma.store.update({ where: { id: locStore.id }, data: { city: '廊坊市' } })

    // 宿主门店一个位置字段都没填 ⇒ 地域钩子整行不出现（不硬塞城市、也不去借别的门店的位置）。
    // 直接改这家临时门店的档案再还原 —— 整个临时商户跑完就删，不会污染别的用例。
    await prisma.store.update({
      where: { id: locStore.id },
      data: { province: null, city: null, district: null },
    })
    const noLoc = await createCreation(prisma, merchantId, { mode: 'TOPIC', complexity: 'SIMPLE' })
    // 位置读**创建行**上的快照（buildVariables 不返回它 —— 它只喂进 topicInfo）
    check(noLoc.topicCity === null, '宿主门店没填位置 → 快照落 null（不是空串）')
    check(
      !(await buildVariables(prisma, noLoc.id, {})).topicInfo.includes('所在地区：'),
      '宿主门店没填位置 → topicInfo 里不出现「所在地区」行',
    )
    check(
      (await prisma.creation.findUnique({ where: { id: noLoc.id }, select: { topicCity: true } }))?.topicCity === null,
      '没填位置时库里存的也是 null（不是空串 —— 「没填」在库里只留一种形态）',
    )
    await prisma.store.update({
      where: { id: locStore.id },
      data: { province: '河北省', city: '廊坊市', district: '固安县' },
    })

    // 调用方给话题稿传门店/菜品必须被拒（静默忽略会让「以为按门店生成了」长期藏着）
    let forbidden: unknown = null
    try {
      await createCreation(prisma, merchantId, { mode: 'TOPIC', storeId: full.storeId })
    } catch (e) {
      forbidden = e
    }
    check(
      forbidden !== null && (forbidden as Error).name === 'TopicCreationStoreForbiddenError',
      '话题稿传 storeId 被拒（不是静默忽略）',
      (forbidden as Error)?.name ?? '没有抛错',
    )

    // ★ 反向：菜品稿**不许**走流量款。存量数据里有 25 条 track='TRAFFIC' 的菜品稿，
    //   而流量款模板已经不喂门店/菜品 —— 不兜底就会生成一条只字不提门店的稿子且不报错。
    const legacyish = await createCreation(prisma, merchantId, {
      storeId: full.storeId,
      dishId: full.dishId,
      mode: 'DISH',
    })
    await prisma.creation.update({ where: { id: legacyish.id }, data: { track: 'TRAFFIC' } })
    const vLegacy = await buildVariables(prisma, legacyish.id, { track: 'TRAFFIC' as never })
    check(
      vLegacy.storeName !== '' && vLegacy.dishName !== '',
      '★ 菜品稿即便 track=TRAFFIC，变量里仍有门店与菜品（生成时会走菜品款模板）',
    )

    // 4.4 ★ 白名单不能把后台锁死：库里**已存在**的合法模板必须都能过校验。
    //     这条跑红说明白名单与库里模板已经漂移（要么漏登记变量，要么模板真有错）。
    const allScenes = await prisma.aiScene.findMany({
      select: { code: true, promptTemplate: true, fallbackTemplate: true },
    })
    const registered = allScenes.filter((s) => SCENE_VARIABLES[s.code])
    check(
      registered.length > 0,
      '库里存在已登记白名单的场景',
      `${registered.length}/${allScenes.length} 个`,
    )
    for (const s of registered) {
      const p = validateTemplate(s.code, s.promptTemplate)
      check(p.length === 0, `库里 ${s.code} 的现有模板仍能通过校验（白名单没锁死后台）`, p.join('；'))
      if (s.fallbackTemplate) {
        const pf = validateTemplate(s.code, s.fallbackTemplate)
        check(pf.length === 0, `库里 ${s.code} 的兜底模板仍能通过校验`, pf.join('；'))
      }
    }

    // ── 4.5 ★★ 「不选菜品」（`mode='STYLE'`）的真实链路（2026-09-28）──
    //   需求：菜品选择器里加一档「不选菜品」，选它就**不给 AI 任何门店与菜品资料**，
    //   只按用户选的款式（人设型/知识型）写。要同时证明五件事：
    //     ① 门店**照旧必填**（创作仍挂在门店下），菜品则**不许有**
    //     ② 九项门店/菜品变量全为空串，且 topicInfo 也空（用户口径：「什么都不补」）
    //     ③ 渲染后的提示词里查不到这家店的店名/品类/城市/菜名（**人设除外**，见下方 10-21 那条）
    //     ④ 提示词里带着「门店与菜品都为空」的说明（模型不会以为资料漏了而自己编）
    //     ⑤ 标题不落 undefined；两条闸门（带菜品 / 带产品型）真的会被拒
    //   ★ ③ 是唯一有份量的那条：前四条只证明「代码没崩」，只有③能证明 AI 拿不到这家店的信息。
    const styleStore = await prisma.store.create({
      data: {
        merchantId,
        name: '契约测试门店-不选菜品',
        /**
         * ★★ 2026-10-21 品类与城市改成**绝对独特**的假值（原来是「川菜」「济南」）。
         *   原因：人设型现在会喂一篇**范文**（别的城市、别的店），范文里出现「川菜」「济南」
         *   完全合理 —— 拿泛词当「门店标识」的判据，会跟范文撞车、报出一条假红。
         *   换成独特值后，下面「渲染后不含」那条断言反而更硬：它只可能来自门店变量。
         */
        category: '契约测试品类',
        city: '契约测试城',
        intro: '契约测试介绍：这段虚构文字只用来验证「哪几项该被清空」。',
      },
    })
    // ★ 这家店**有菜、有人设、有介绍** —— 店里空着的话，③ 就成了一条永远为真的假断言
    //   （对照 4.2b 的同款做法）。门店与菜品一个都不该拿到，**人设该拿到**（见下方 10-21 那条）。
    const styleDish = await prisma.dish.create({
      data: { storeId: styleStore.id, name: '不该被款式稿提到的菜-水煮牛肉', sellingPoints: '麻辣鲜香' },
    })
    await prisma.persona.create({
      data: { merchantId, storeId: styleStore.id, bossTags: '80后老板', activity: '开业酬宾' },
    })
    const styleCre = await createCreation(prisma, merchantId, {
      storeId: styleStore.id,
      mode: 'STYLE',
      track: 'KNOWLEDGE',
      complexity: 'COMPLEX',
    })
    check(
      styleCre.mode === 'STYLE' && styleCre.track === 'KNOWLEDGE',
      '★ 款式稿按用户选的款式落库（款式是这一档唯一的驱动，不许被强制成流量型）',
      `mode=${styleCre.mode} track=${styleCre.track}`,
    )
    check(styleCre.dishId === null, '款式稿没有菜品（dishId 落 null）')
    check(
      styleCre.title === '契约测试门店-不选菜品',
      '★ 款式稿标题退回门店名（留 undefined 会让前端 4 处显示「未命名创作」）',
      `title=${JSON.stringify(styleCre.title)}`,
    )
    const vStyle = await buildVariables(prisma, styleCre.id, { track: 'KNOWLEDGE' })
    /**
     * ★★★ 2026-10-21 改回「门店与菜品全空」—— 这正是 §4.5 上面 ①②③ 写的**原始契约**。
     *   2026-09-28 中途放宽成「只清菜品、保留门店」，理由听上去合理（不给资料只能写空话），
     *   于是这条断言也跟着改成「保留门店」，等于**把偏离当契约钉住**。
     *   用户 10-21 实测踩到：关掉「菜品与套餐」开关后稿子仍念出店名
     *   （creation #261「我这店，名儿就叫大虾店」，店名逐字来自 `store.name`）。
     *
     * ★★ 同日再修一处**过度清空**：`persona` 曾一起被清掉，但按用户对「门店信息」的定义
     *   （店名 / 招牌 / 品类自称 / 城市与地址 / 门店介绍里的具体事），`persona` 表只有
     *   `boss_tags`、`activity` 两列，**没有任何一项属于门店标识**，它描述的是「老板这个人」。
     *   把它一起清掉，人设型的输入就变成**零**，模板再细也只能写通识空话
     *   （用户同一天说的「内容少」正是这个）。所以：门店清、人设留。
     */
    const STYLE_BLANKED = [
      'storeName', 'storeIntro', 'category', 'city', 'province', 'district', 'address', 'fullAddress',
      'dishName', 'dishIntro', 'sellingPoints', 'comboInfo',
    ] as const
    check(
      STYLE_BLANKED.every((k) => vStyle[k] === ''),
      '★★ 款式稿：门店资料与菜品资料全部清空（关掉开关＝一个字都不给）',
      `仍非空=${STYLE_BLANKED.filter((k) => vStyle[k] !== '').join('、')}`,
    )
    // ★★ 反向的**另一半**：门店清了，人设必须还在。
    //   没有这条，「顺手把 persona 也清掉」也能让上面全绿 —— 而人设型就再也没料可讲。
    check(
      vStyle.persona.includes('80后老板') && vStyle.persona.includes('开业酬宾'),
      '★★ 款式稿：老板人设标签与「最近想说的」照旧喂进去（它不是门店标识，是人设型唯一的原料）',
      `persona=${JSON.stringify(vStyle.persona)}`,
    )
    /**
     * ★★★ 空标签防线：门店清空后 `CONTEXT_BLOCK` 首行会渲染成「【门店】｜品类：｜城市：」。
     *   没有这条注解，模型会以为资料漏了、自己编一个店名 —— 比照实写更糟
     *   （用户投诉的是「不该带」，编出来的是「凭空带」）。
     */
    check(vStyle.storeEmptyNote.length > 0, '★ 款式稿带「门店为空」注解（否则模型会自己编店名）')
    check(vStyle.topicInfo === '', '★ 款式稿不补话题素材（topicInfo 为空串 —— 与话题稿刻意不同）')
    check(vStyle.dateInfo.length > 0, 'dateInfo 仍非空（模板那一行不会渲染成空白）')
    // ③ 两条允许的款式逐份真渲染：这家店的任何标识都不许进入提示词
    for (const code of ['copy_persona', 'copy_knowledge']) {
      const t = TEMPLATES.find((x) => x.code === code)!
      const out = renderTemplate(t.tpl, vStyle as unknown as Record<string, string>)
      check(!out.includes('{{'), `${t.label} 款式稿渲染后无残留占位符`)
      check(
        !out.includes('契约测试门店-不选菜品') &&
          !out.includes('契约测试品类') &&
          !out.includes('契约测试城') &&
          !out.includes('不该被款式稿提到的菜'),
        `★★ ${t.label} 款式稿：店名/品类/城市/菜名一个都不进入提示词`,
      )
      // ★★ 人设信息则**必须**在（见上面 STYLE_BLANKED 旁那段判据）：
      //   这一条与上一条是同一枚硬币的两面 —— 只查「不许有什么」，就会漏掉「该有的也没有」。
      check(
        out.includes('80后老板') && out.includes('开业酬宾'),
        `★★ ${t.label} 款式稿：老板人设照旧进入提示词（否则这一档没有任何可讲的具体事）`,
      )
      check(
        out.includes('这次不提供门店资料'),
        `${t.label} 款式稿：提示词在【门店】行写明「不提供门店资料」`,
      )
      check(out.includes('这次没选具体菜品'), `${t.label} 款式稿：提示词明确说明未选具体菜品`)
    }
    // ★★ 反向：**只讲门店**（同一家店、同样没选菜，但 `mode='DISH'`）必须照旧拿到门店资料。
    //   没有这条，「只要没选菜就清空门店」也能让上面全绿 —— 而那会把「只讲门店」
    //   这条既有路径悄悄改坏，正是本次最该防的回归。
    const storeOnly = await createCreation(prisma, merchantId, {
      storeId: styleStore.id,
      mode: 'DISH',
      track: 'PRODUCT',
      complexity: 'COMPLEX',
    })
    const vStoreOnly = await buildVariables(prisma, storeOnly.id, { track: 'PRODUCT' })
    check(
      vStoreOnly.storeName === '契约测试门店-不选菜品' &&
        vStoreOnly.category === '契约测试品类' &&
        vStoreOnly.dishName === '',
      '★ 反向：「只讲门店」照旧拿到门店资料、且没有菜品（没被款式稿的改动波及）',
      `storeName=${JSON.stringify(vStoreOnly.storeName)} dishName=${JSON.stringify(vStoreOnly.dishName)}`,
    )
    // ⑤ 两条闸门必须真的拒，且拒完库里不留半条记录
    const styleBefore = await prisma.creation.count({ where: { storeId: styleStore.id } })
    let dishGate = false
    try {
      await createCreation(prisma, merchantId, {
        storeId: styleStore.id,
        mode: 'STYLE',
        track: 'KNOWLEDGE',
        dishId: styleDish.id,
      })
    } catch (e) {
      dishGate = e instanceof StyleCreationDishForbiddenError
    }
    check(dishGate, '★ 「不选菜品」带菜品被拒（StyleCreationDishForbiddenError）')
    let trackGate = false
    try {
      await createCreation(prisma, merchantId, { storeId: styleStore.id, mode: 'STYLE', track: 'PRODUCT' })
    } catch (e) {
      trackGate = e instanceof StyleCreationTrackForbiddenError
    }
    check(trackGate, '★ 「不选菜品」+ 产品型被拒（它天生要讲清在售内容，这一档手里什么都没有）')
    const styleAfter = await prisma.creation.count({ where: { storeId: styleStore.id } })
    check(styleAfter === styleBefore, '★ 两次被拒都没有落库（闸门是拒，不是写一半）', `${styleBefore} → ${styleAfter}`)
    check(
      isStyleTrack('PERSONA') &&
        isStyleTrack('KNOWLEDGE') &&
        !isStyleTrack('PRODUCT') &&
        !isStyleTrack('RECOMMEND') &&
        !isStyleTrack(TOPIC_TRACK),
      '★ 允许集恰好是「人设型 + 知识型」（流量型走它自己的 TOPIC 形态，不在这里）',
      `STYLE_TRACKS=${STYLE_TRACKS.join('/')} DEFAULT=${DEFAULT_STYLE_TRACK}`,
    )
  } finally {
    if (merchantId !== null) {
      // 硬删：creation → dish → persona → store → merchant（顺序遵循外键）
      const stores = await prisma.store.findMany({ where: { merchantId }, select: { id: true } })
      const storeIds = stores.map((s) => s.id)
      await prisma.shot.deleteMany({ where: { creation: { merchantId } } })
      await prisma.creation.deleteMany({ where: { merchantId } })
      // 套餐明细先删（虽然外键 CASCADE 也会兜住，但显式删让清理顺序一眼可读）
      await prisma.dishComboItem.deleteMany({ where: { combo: { storeId: { in: storeIds } } } })
      await prisma.dish.deleteMany({ where: { storeId: { in: storeIds } } })
      await prisma.persona.deleteMany({ where: { storeId: { in: storeIds } } })
      await prisma.store.deleteMany({ where: { merchantId } })
      await prisma.merchant.delete({ where: { id: merchantId } })
      const left = await prisma.merchant.count({ where: { phone: PHONE } })
      check(left === 0, '临时商户已清理干净', `残留 ${left}`)
    }
  }
}

// ──────────────────────── ⑤ 日期 / 节气 / 节日（纯函数，不连库） ────────────────────────
section('⑤ 日期与节点变量：模型唯一的时间来源')

const at = (s: string) => new Date(s)
const info = (s: string) => formatDateInfo(at(s))

// 5.1 形态：恰好两行、第一行是「今天是 …」、没有残留占位符。
//     ★「永远非空」是这个变量的硬约束：模板里那一行渲染成空串，模型就退回瞎编状态。
for (const s of ['2026-09-20T09:00:00+08:00', '2026-12-31T23:30:00+08:00', '2027-02-05T09:00:00+08:00']) {
  const t = info(s)
  check(t.split('\n').length === 2, `${s.slice(0, 10)} 输出恰好两行`, JSON.stringify(t))
  check(t.startsWith('今天是 '), `${s.slice(0, 10)} 第一行以「今天是」开头`)
  check(!t.includes('{{'), `${s.slice(0, 10)} 输出里没有残留占位符`)
}

// 5.2 已知日期必须看到已知节点（下面这些值是实跑核对过的，改公式会当场红）
const todayInfo = info('2026-09-20T09:00:00+08:00')
check(todayInfo.includes('2026-09-20（星期日）'), '2026-09-20 认得出是星期日', todayInfo)
check(todayInfo.includes('9月23日 秋分'), '看得到 3 天后的秋分（寿星公式）')
check(todayInfo.includes('9月25日 中秋节'), '看得到 5 天后的中秋节（农历表）')
check(todayInfo.includes('10月1日 国庆节'), '看得到国庆节（公历表）')

// 5.3 节点就在当天时写「就是今天」，不能写成「0 天后」
check(
  info('2026-02-16T09:00:00+08:00').includes('除夕（就是今天）'),
  '节点就在当天时写「就是今天」',
  info('2026-02-16T09:00:00+08:00'),
)

// 5.4 ★★ 时区：同一时刻用 UTC 写法必须落到次日。
//     这条钉的是「显式按 Asia/Shanghai 取值」—— 线上 Ubuntu 默认 UTC，
//     若改用 new Date() 的本地字段，北京时间 00:00~08:00 会整体差一天（除夕当天写成「明天除夕」），
//     而且**没有任何报错**。这是本仓唯一一处对时区敏感的地方。
check(
  info('2026-06-19T23:30:00+08:00').includes('2026-06-19') && info('2026-06-19T16:30:00Z').includes('2026-06-20'),
  '按 Asia/Shanghai 取日期：同一时刻写成 UTC 会落到次日',
)

// 5.5 跨年：12 月下旬要能看到明年 1 月 1 日的元旦
//     （只扫当年会有半个月空窗期，而那正好是餐饮最忙的跨年档）
check(info('2026-12-28T09:00:00+08:00').includes('元旦'), '年末能看到跨年的元旦')

// 5.6 ★ 农历节日表的过期告警。表用完了**不会报错**，只会静静地少掉春节/中秋这些最重要的节点。
//     下面这条**会随时间自己变红** —— 红的那天就是「该补表了」，**不要把它注释掉**。
const thisYear = shanghaiYmd(new Date()).year
check(
  LUNAR_FESTIVAL_MAX_YEAR >= thisYear,
  `农历节日表覆盖到 ${LUNAR_FESTIVAL_MAX_YEAR} 年（今年 ${thisYear}）`,
  LUNAR_FESTIVAL_MAX_YEAR < thisYear
    ? '★ 表已过期：去 src/lib/festival.ts 补春节/中秋等日期（逐个查万年历，不许照抄往年）'
    : '',
)

// 5.7 节气公式回验：钉住几个公认的 2026 年节气日期（公式是近似，±1 天可接受，所以这里用精确值兜底）
const termAt = (name: string) => upcomingNodes(at('2026-01-01T09:00:00+08:00'), 400).find((n) => n.name === name)
const TERM_CASES: Array<[string, number, number]> = [
  ['立春', 2, 4],
  ['春分', 3, 20],
  ['夏至', 6, 21],
  ['立秋', 8, 7],
  ['秋分', 9, 23],
  ['冬至', 12, 22],
]
for (const [name, m, d] of TERM_CASES) {
  const n = termAt(name)
  check(n?.month === m && n?.day === d, `2026 年${name}落在 ${m} 月 ${d} 日`, `实得 ${n?.month} 月 ${n?.day} 日`)
}

// 5.8 模板侧：菜品稿引用 {{dateInfo}}；话题稿引用 {{topicInfo}}（它的第一段就是 dateInfo 的内容）。
//     「跟上节假日」这条要求对每一款都必须成立，只是来源不同 —— 不存在某一款没有时间来源。
for (const t of dishTemplates) {
  check(t.tpl.includes('{{dateInfo}}'), `${t.label} 引用了日期与节点 {{dateInfo}}`)
}
for (const t of topicTemplates) {
  check(t.tpl.includes('{{topicInfo}}'), `${t.label} 引用了话题信息 {{topicInfo}}`)
  check(
    !t.tpl.includes('{{dateInfo}}'),
    `${t.label} 不重复引用 {{dateInfo}}（topicInfo 第一段就是它，两处都引用会让同一天出现两遍）`,
  )
}
// 兜底一律不引用日期 / 话题类变量：它是静态文案、拿不到真实日期，写了只会让模型编一个节日出来
for (const t of TEMPLATES) {
  check(
    !t.fallback.includes('{{dateInfo}}') && !t.fallback.includes('{{topicInfo}}'),
    `${t.label} 兜底不引用日期 / 话题变量（静态文案拿不到真实日期，只会编一个节日出来）`,
  )
}
check(
  findUnknownPlaceholders('copy_product', '{{dateInfo}}').length === 0 &&
    findUnknownPlaceholders('storyboard_generate', '{{dateInfo}}').length === 0,
  'dateInfo 已在菜品文案与分镜两个场景的白名单里',
)
check(
  findUnknownPlaceholders('copy_traffic', '{{topicInfo}}').length === 0 &&
    findUnknownPlaceholders('copy_product', '{{topicInfo}}').length === 1,
  'topicInfo 只在话题场景的白名单里（菜品稿引用不到它）',
)

// 5.9 口语化铁律：必须挂在 5 个文案模板上，且**不许**挂到分镜上。
//     分镜输出 JSON、line 要逐字照抄文案，而铁律第 1 条是「念着别扭就重写」——
//     挂上去反而会诱导它改写文案，与「逐字照抄」自相矛盾。
for (const t of TEMPLATES.filter((x) => x.code.startsWith('copy_'))) {
  check(t.tpl.includes('【口语化铁律'), `${t.label} 挂了口语文铁律`)
}
check(
  !TEMPLATES.find((t) => t.code === 'storyboard_generate')!.tpl.includes('【口语化铁律'),
  '分镜**不**挂口语化铁律（与「逐字照抄」冲突）',
)
for (const t of TEMPLATES.filter((x) => x.code.startsWith('copy_'))) {
  check(t.tpl.includes('只能来自输入资料'), `${t.label} 明确要求业务事实来自输入资料`)
  check(t.tpl.includes('资料不足') && t.tpl.includes('短'), `${t.label} 资料不足时允许短稿，不为字数补内容`)
}
const recommendTpl = TEMPLATES.find((t) => t.code === 'copy_recommend')!.tpl
check(
  recommendTpl.includes('不冒充老板') && recommendTpl.includes('编试吃反应'),
  '★ 种草型以「来推荐的人」身份说话（不冒充老板），且不虚构试吃反应',
)
// ★★ 反向：不许再回到「由老板本人讲」那个定位 —— 那正是与界面上「达人素人视角」打架的旧形态。
//    只查正面词会漏：写成「由老板本人讲，但可以推荐」同样能通过上面那一条。
check(
  !recommendTpl.includes('由老板本人') && !recommendTpl.includes('老板本人的身份'),
  '★ 种草型不含旧版「由老板本人讲」定位（界面侧重点写的是「达人素人视角」，两处必须指向同一人）',
)
const knowledgeTpl = TEMPLATES.find((t) => t.code === 'copy_knowledge')!.tpl
check(
  knowledgeTpl.includes('通用知识要明确说成普遍做法') && knowledgeTpl.includes('不能说成这家店的秘方'),
  '知识型区分可靠通用知识与本店事实，不虚构本店工艺',
)
const personaTpl = TEMPLATES.find((t) => t.code === 'copy_persona')!.tpl
// ★★ 2026-10-21 人设型按用户 149 条真实成稿重组，这条断言**换了载体、没换需求**：
//   旧模板里写的是「不是替老板编一段人生故事 / 不制造苦难或反转」，那两句随重写消失；
//   需求本身（不许编经历）改由「事实与边界」段承担 ⇒ 断言跟着指向新句子，
//   但**不能因为旧句子没了就把这条删掉** —— 删掉等于「不许编经历」从此没人守。
check(
  personaTpl.includes('不制造苦难') && personaTpl.includes('不编转折') && personaTpl.includes('一个都不许编'),
  '人设型不补造老板经历、苦难或反转（事实只能来自资料）',
)
// ★★★ 九条选题路数是「花样多」的唯一来源：少一条，同店连写时就少一个可换的落点。
//   逐条点名而不是数个数 —— 数个数拦不住「删掉一条、把另一条改两遍」。
const PERSONA_ROUTES = [
  '人设命名型',
  '被误解自证型',
  '反常识立论型',
  '算账摊牌型',
  '自曝短板型',
  '事故复盘型',
  '一个人型',
  '从哪来型',
  '一条规矩型',
] as const
const missingRoutes = PERSONA_ROUTES.filter((r) => !personaTpl.includes(r))
check(
  missingRoutes.length === 0,
  `人设型九条选题路数逐条在位（缺：${missingRoutes.join('、') || '无'}）`,
)
check(
  personaTpl.includes('下面说的是「这一条要讲什么」，**不是句子模板**'),
  '★ 路数只给动作、不给可照抄的句子（给了示例句，模型抄的是句式，五个选项只会产出一种开头）',
)
// ★★ 这些「起手」示例**必须只是路数的示意**，不能变成唯一写法：
//   断言它们分散在不同路数里，且模板明确要求「同一路数每次都要换说法」。
check(
  personaTpl.includes('同一路数每次都要换说法') && personaTpl.includes('{{recentCopyAvoid}}'),
  '★ 人设型带「换说法」要求与近期避让变量（否则连写几条会稳定撞同一句式）',
)
// ★★★ 篇幅是这一版「内容多」的关键：上限由 PERSONA_COPY_RULES 供（110/280/400），
//   模板必须引用它，且必须有一句防「为凑字数而灌水」的反向约束。
check(
  personaTpl.includes('{{copyLengthRule}}') && personaTpl.includes('不为了填字数补编经历'),
  '★ 人设型长度走 {{copyLengthRule}}，且带「不许为凑字数补编」的反向约束',
)
// ★★★ 第四轮试跑暴露的另一个方向的问题：约束一加严，字数就从 247 掉到 173。
//   「内容多」与「不许编」必须同时成立 —— 唯一的出路是给它**不靠新事实**的加长手段。
//   这三样（当时怎么想 / 难在哪 / 后来怎么落地）全部来自这件事本身，不需要任何人、任何数。
check(
  personaTpl.includes('写不到下限') && personaTpl.includes('当时你**怎么想的**') && personaTpl.includes('后来怎么落地'),
  '★★★ 人设型给出「不靠新事实的加长手段」（否则一加严约束，字数就掉回一百多）',
)
check(
  personaTpl.includes('每讲一个结论，后面必须跟一件支撑它的事'),
  '★★ 人设型「讲满」的可执行判据在位（只给结论＝空话，这是内容虚的唯一硬判据）',
)
check(
  personaTpl.includes('不报价、不列套餐、不推销菜品') && personaTpl.includes('不许变成推荐'),
  '★ 人设型不掺卖货（卖人又卖货两头都不像）',
)
// ★★ 2026-10-23：人设型从「不推荐具体菜品」改成条件式 —— 报价/套餐/推销的禁令原样保留，
//   但**选了菜就必须报出这道菜**（它不是推荐，是这一型要讲的那件事的支点）。
//   为什么改：生产 #384 选了「招牌嫩牛肉」，`ai_call_log id=902` 里菜名在提示词第 452 字节、
//   返回稿里出现 **0** 次，正文整篇改讲门店介绍里的大虾。旧的「一律不提菜」没能
//   「卖人不卖货」，只是把用户选的那道排除在外。守护详见 scripts/verify-dish-mention.ts。
check(
  personaTpl.includes('正文里就必须出现这个菜名') && personaTpl.includes('【菜品】为空'),
  '★★ 人设型的菜品约束是**条件式**的（选了菜 ⇒ 必须报出且只报它；没选菜 ⇒ 一个字都不提菜）',
)
check(
  !personaTpl.includes('不推荐具体菜品'),
  '★★ 旧的「一律不推荐具体菜品」措辞已撤（留着它就等于让人设型继续忽略用户选的菜）',
)
// ★★★ 用户范例句「我不是瞧不起固安人的胃」的**结构**可以学，**靶子不能学**：
//   这条断言钉的是「不许把某个地方的人当靶子或把人分等」，含具体禁词才有约束力。
check(
  personaTpl.includes('绝不冲顾客') &&
    personaTpl.includes('不贬低某个地方的人的胃口') &&
    personaTpl.includes('没见过世面'),
  '★★★ 人设型的冲突不冲顾客与地域（大胆只放语气，不冲吃饭的人）',
)
check(
  personaTpl.includes('不拿「匠心」「坚守」「初心」「独家」「祖传」当内容') && personaTpl.includes('心灵鸡汤'),
  '★ 人设型不许拿「匠心/坚守/初心」当内容、不许写成鸡汤',
)
// ★★★ 2026-10-21 试跑发现的真实缺陷（不是理论问题），两轮各修一处：
//   ① 第一轮 5 条里有 1 条写了「手上这疤，就是去年灶上烫的」—— 资料里没有这个人、这个疤、这年；
//   ② 补了「不许编疤痕」之后第二轮又冒出「砍得我媳妇三天没跟我说话」「十来道一个月卖不出二十份」——
//      换成**有身份的人**和**编造的数量**，同一个毛病换个壳。
//   所以这条边界必须写成三组「允许 / 禁止」的对子，且给**可执行的判据**（能不能被当真核对）。
//   只写「不许编」拦不住 —— 模型不认为自己那是在编，它认为那是在「讲具体」。
check(
  personaTpl.includes('具体只能用资料里已经有的') &&
    personaTpl.includes('不许出现任何有身份的人') &&
    personaTpl.includes('不写身体特征、伤病、疤痕') &&
    personaTpl.includes('数量与金额**一个字都不许补**') &&
    personaTpl.includes('时间只许**模糊**') &&
    personaTpl.includes('核对不上'),
  '★★★ 人设型「具体」带边界：人只许泛指、数与时只许模糊，且给「能不能被核对」的判据',
)
check(
  personaTpl.includes('不许把**某一次具体的对话**写成一来一回') && personaTpl.includes('假设式'),
  '★ 人设型：禁「回忆某次对话」式剧本，但允许假设式（「你要问我…我就说…」——案例里全是这种写法）',
)
// ★★ 概数是这一轮实测才暴露的漏洞：模板写「数量一个字都不许补」，模型就改用
//   「备菜的上千块货架空了三分之一」—— 没有阿拉伯数字，但量级是编的。
//   这类词必须点名，否则「不许写数」只约束阿拉伯数字。
check(
  personaTpl.includes('概数也算数') && personaTpl.includes('上千块'),
  '★★ 人设型：概数（上千/上百/几十）也算编造 —— 否则「不许写数」只管住阿拉伯数字',
)
// ★★★ 第三轮试跑又抓出两处，都是「规则存在但拦不住」的典型：
//   ① 第 2 条与第 3 条开头撞了：「都说做餐饮，菜越多生意越大」/「都说菜越多，生意才越大」——
//      避让名单里明明有前一句，模型只换了词序。所以「要换句式」这句话不够，
//      必须给**并排念一遍**这种可执行动作。相似度闸门 0.066 判不出来（它看的是全篇）。
//   ② 资料写 68 道，正文写成「一百多道菜」—— 同一篇里两个矛盾的数。这是硬伤。
check(
  personaTpl.includes('开头自检') && personaTpl.includes('只差了词序') && personaTpl.includes('一个字的应答'),
  '★★★ 人设型开头带「并排念一遍」的自检（只换词序不算换路数；也不许用单字应答凑独特）',
)
check(
  personaTpl.includes('资料里给过的数字**只能原样引用**') && personaTpl.includes('不许在别处再给一个不同的数'),
  '★★ 人设型数字只许原样引用，不许另给一个矛盾的数（试跑里 68 道被写成「一百多道」）',
)
// ★★★ 第五轮试跑：第 1、2 条**开头逐字一样**（「有人说我好好的菜单砍掉二十多道，是不是脑子进水了。」）。
//   避让名单里明明有第 1 条，模型还是照抄 —— 根因不是规则缺失，是**位置**：
//   避让块原本埋在「九条路数」之后（模板 4600 字的中段），注意力早被路数摊薄了。
//   修法＝把它提到【三条铁律】正后面，并补一句「先看这一段，再往下读」。
//   这条断言钉的就是「位置」—— 挪回中段它必须变红，否则下次谁挪走都没人知道。
check(
  personaTpl.includes('先看这一段，再往下读'),
  '★★★ 近期避让块必须放在模板前段（埋在「九条路数」后面时，实测出现逐字重复的开头）',
)
check(
  personaTpl.indexOf('{{recentCopyAvoid}}') < personaTpl.indexOf('【选题路数'),
  '★★ 避让变量实际位置在【选题路数】之前（上面那条说的「前段」就是这里）',
)
// ★★★ 「模板自己跟自己打架」是这类长模板最难自查的缺陷（不报错、也不违反白名单）：
//   「具体边界」写了「时间只许模糊」，而【怎么讲满】原来把「上周三、开业第 47 天」当范例，
//   模型照着范例写，正好撞上禁令。两边都「有依据」，所以它只会照更具体的那半边执行。
check(
  !personaTpl.includes('上周三') && !personaTpl.includes('开业第 47 天'),
  '★★★ 人设型内部不许自相矛盾：「时间只许模糊」与「上周三」这种范例不能同时存在',
)
check(
  personaTpl.trimEnd().endsWith('只输出文案正文：不要标题、不要分点、不要 hashtag、不要任何解释'),
  '★ 人设型输出格式收在「只输出文案正文」（重写模板时最容易漏掉的一句）',
)

// ─────────── 5.x 人设型范文池（2026-10-21）───────────
//   用户要「从我给你的文案里随机抓一条出来做改写，单用户的生成尽可能不要重复使用」。
//   「随机」实现成**轮转**（判据见 src/lib/persona-samples.ts::personaSampleIndex），
//   所以要守两半：模板里那节约束在不在、池子本身有没有坏。
//   只守一半的代价：模板松了 ⇒ 成稿里出现别人家的城市；池子坏了 ⇒ 每次都抽同一条、没人发现。
check(
  personaTpl.includes('{{personaSample}}') && personaTpl.includes('只学样子，不搬内容'),
  '★★★ 人设型引用了范文变量，且写死「只学样子、不搬内容」',
)
check(
  personaTpl.includes('城市、店名、人名、营业额、家庭关系、菜品、经历，一个都不许出现'),
  '★★★ 范文的专有信息禁搬（范文里有别人家的城市/店名/营业额/家人，搬过来就是造谣）',
)
check(
  personaTpl.includes('不许学它的方言腔') && personaTpl.includes('不要连错字一起学'),
  '★ 范文是语音转写稿：禁学方言腔、禁抄错字',
)
// ★★★ 实测出来的坑：池子里有 478/492 字的范文，而「复杂版」正文只要 180~260 字。
//   第一版是「全池轮转 + 模板里劝一句『长度只认复杂度』」，结果 6 条里 **3 条超上限**
//   （285/286/296），中位数从 248 涨到 285 —— **劝说没用，模型照眼前的实物对齐长度**。
//   最终修法不是加话，而是**同档抽同档**（personaSamplesFor）；模板这句只是兜底。
check(
  personaTpl.includes('范文跟你这次要写的长度是**同一档**的'),
  '★★★ 范文按复杂度分档抽取（全池轮转时实测 6 条里 3 条超上限，靠模板劝不住）',
)
// ★ 分档必须真的覆盖到三档、且每档都有货 —— 某一档空了会静默退化成「全池抽」，
//   于是又回到「跟着 478 字的范文写超长」。
{
  const bands = ['simple', 'complex', 'fine'] as const
  const counts = bands.map((b) => personaSamplesFor(b).length)
  check(
    counts.every((n) => n >= 5),
    '★★ 三档范文都够抽（某档不足 5 条说明分档区间配错了，轮转很快回环）',
    `simple=${counts[0]} complex=${counts[1]} fine=${counts[2]}`,
  )
  check(
    personaSamplesFor('complex').every((s) => s.chars >= 150 && s.chars <= 310),
    '★★ 「复杂版」抽到的范文都在 150~310 字（与 180~260 的建议值同量级）',
  )
  check(
    personaBandOf('SIMPLE') === 'simple' && personaBandOf('FINE') === 'fine' && personaBandOf('COMPLEX') === 'complex',
    '复杂度 → 长度档的映射正确',
  )
}
check(
  PERSONA_SAMPLES.length >= 40,
  '★★ 范文池够大（太小 ⇒ 轮转很快回到同一条，「不要重复使用」名存实亡）',
  `当前 ${PERSONA_SAMPLES.length} 条`,
)
check(
  PERSONA_SAMPLES.every((s) => s.chars >= 120 && s.chars <= 500 && s.chars === s.text.length),
  '★★ 每条范文都在 120~500 字内，且 chars 与 text.length 一致（快照对账要靠它）',
  `越界=${PERSONA_SAMPLES.filter((s) => s.chars < 120 || s.chars > 500 || s.chars !== s.text.length).map((s) => s.id).join('、') || '无'}`,
)
check(
  PERSONA_SAMPLES.every((s, i) => s.id === i + 1),
  '★ 范文 id 连续（id 会写进日志；跳号说明有人手删过，轮转范围跟着变了却没人知道）',
)
{
  const seen = new Map<string, number>()
  const dup: string[] = []
  for (const s of PERSONA_SAMPLES) {
    const key = s.text.slice(0, 25)
    const prev = seen.get(key)
    if (prev !== undefined) dup.push(`#${prev} 与 #${s.id}`)
    else seen.set(key, s.id)
  }
  check(dup.length === 0, '★★ 范文池无重复篇目（同一篇收两次 ⇒ 轮转看着换了、其实没换）', dup.join('、'))
}
// ★★★ 轮转的**唯一**可验收判据：同一 seed 连取 total 次必须取遍全部且不重复。
//   只查「相邻两次不同」不够 —— 那会让「A,B,A,B…」这种两两交替的实现全绿。
{
  const total = PERSONA_SAMPLES.length
  const got = new Set<number>()
  for (let cursor = 0; cursor < total; cursor++) got.add(personaSampleIndex(123n, cursor))
  check(
    got.size === total,
    `★★★ 同一用户连取 ${total} 次走遍全部范文（「单用户不重复使用」是**可证**的，不是概率的）`,
    `实际取到 ${got.size} 种`,
  )
  check(
    personaSampleIndex(7n, 0) !== personaSampleIndex(8n, 0),
    '★ 不同商户起点不同（否则全网前几十条稿子会长成一个样）',
  )
  check(
    personaSampleIndex(5n, 0) === personaSampleIndex(5n, PERSONA_SAMPLES.length),
    '轮转是环：走满一圈回到起点，不会越界',
  )
}
// ★★ 泄漏检测器自己也要被测（「断言窄于标题」那类教训：检测器坏了，报警永远为空，
//   看起来一切正常）。正例、反例各给一条，缺任一条它都可能是个「永远返回空」的空壳。
{
  const sample = '我在宜春开店八年，昨天营业额只有4000多，夜里两点还在熬牛骨汤。'
  check(
    sampleLeaks(sample, '我在宜春干了八年，就认一个理。').includes(
      '照搬范文地名 宜春',
    ),
    '★ 泄漏检测：成稿抄了范文的地名 ⇒ 报出来',
  )
  check(
    sampleLeaks(sample, '最近我把菜单从68道砍到42道，砍的全是卖得少的。').length === 0,
    '★ 泄漏检测：成稿与范文无关 ⇒ 不误报（误报几次这条报警就没人看了）',
  )
  check(
    sampleLeaks(sample, '夜里两点还在熬牛骨汤，这事我干了八年。').some((s) => s.includes('8 字重合并句')),
    '★ 泄漏检测：成稿搬了范文的连续 8 字 ⇒ 报出来（相似度闸门 0.72 查不出这种短句搬用）',
  )
  check(
    sampleLeaks(sample, '昨天营业额只有4000多块钱。').some((s) => s.includes('照搬范文数字 4000')),
    '★ 泄漏检测：成稿搬了范文的数字 ⇒ 报出来',
  )
}
// ★ 2026-09-29 说话人从「老板本人」改成「来推荐的人」之后，这条断言**换了判据**：
//   原来禁的是「顾客视角」这个**定位**（当时定位是老板，写顾客视角就是跑偏）；
//   现在定位本身就是推荐者，所以不能再禁「顾客视角」四个字。
//   它真正要钉住的东西没变：**不许出现虚构消费经历** —— 这与说话人是谁无关。
//   ⚠ 禁令必须举例（「不写『我前天去吃了』」）才有约束力 ⇒ 硬约束段里**必然**含这些词。
//     所以这里查的是**硬约束段之前的正文段**：那里出现这些词，等于把模型当成了举例对象，
//     也就是在教它写假探店（那正是旧版本的毛病）。
const recommendBody = recommendTpl.slice(0, recommendTpl.indexOf('【这一型额外的硬约束】'))
check(
  recommendBody.length > 0 &&
    !/朋友带我去|我前天去吃|跟朋友来打卡|装成食客|路过这家店/.test(recommendBody),
  '★ 种草型的「写作要求」段不含虚构消费经历示例（示例只允许出现在硬约束段的禁令里）',
)
check(
  recommendTpl.includes('不许编造到店经历') && /我前天去吃了|跟朋友来打卡/.test(recommendTpl),
  '★ 「不许编造到店经历」那条禁令还在、且带着例子（去掉例子它就只剩一句空话）',
)
check(
  TEMPLATES.every((t) => !/朋友带我去|我前天去吃|人均不过几十|今天到店还有专属福利/.test(t.fallback)),
  '所有静态兜底都不含虚构探店、价格或优惠承诺',
)

// 5.10 流量款（话题稿）这一版的核心改动：靠 topicInfo 起头、不再提门店与菜品、不许编新闻
const traffic = TEMPLATES.find((t) => t.code === 'copy_traffic')!
const trafficTpl = traffic.tpl
check(trafficTpl.includes('{{topicInfo}}'), '流量款靠 {{topicInfo}} 拿「今天」与起头方向')
check(trafficTpl.includes('挑一个切口'), '流量款从话题方向选一个自然切口')
check(
  trafficTpl.includes('不介绍或推销某家店') && trafficTpl.includes('不强制提问'),
  '流量款不编店铺信息，结尾互动自然且可选',
)
check(
  trafficTpl.includes('不许') && trafficTpl.includes('热搜') && trafficTpl.includes('政策'),
  '流量款禁止编造新闻/热搜/明星/政策（没有新闻源，编了就是假热点）',
)
check(
  !trafficTpl.includes('{{storeName}}') && !trafficTpl.includes('{{dishName}}'),
  '★ 流量款不引用门店名与菜名（话题稿没有它们）',
)
check(!traffic.fallback.includes('{{'), '★ 流量款兜底是零占位符的静态句（变量全空时不会渲染出半句话）')
check(
  Object.keys(CONTENT_MODES).length === 3 &&
    CONTENT_MODES.TOPIC.label.length > 0 &&
    // ★ 2026-09-28 加的第三种形态（「不选菜品」）：三种缺任何一个都说明注册表被删过
    CONTENT_MODES.STYLE.label.length > 0 &&
    CONTENT_MODES.DISH.label.length > 0,
  '内容模式注册表含 DISH / TOPIC / STYLE 三种',
)

// 5.10.1 流量款不复制身份、区号或地名，而是让观众自然参与话题。
check(trafficTpl.includes('不冒充本地人或老乡'), '流量款不假扮本地身份')
check(trafficTpl.includes('未经输入证实的方言、暗号或区号'), '流量款不编方言、暗号或区号')

const generic = TEMPLATES.find((t) => t.code === 'copy_generate')!
check(
  generic.tpl.includes('没有真实对白就不写对白') &&
    (generic.tpl.includes('短稿优先') || generic.tpl.includes('资料支撑不了这么长') || generic.tpl.includes('资料不足就删掉')),
  '★ 通用款只用真实素材，资料不足时允许短稿',
)
check(
  generic.tpl.includes('口播长度') &&
    generic.tpl.includes('超过上限必须删减') &&
    generic.tpl.includes('不足时不要为了填字数'),
  '通用款按复杂度控制口播长度，资料不足时允许短稿',
)

// 5.11 分镜这一版的核心改动：台词逐字照抄 + 一个人能拍完 + 对空值稳健
const story = TEMPLATES.find((t) => t.code === 'storyboard_generate')!
const storyTpl = story.tpl
check(storyTpl.includes('逐字') && storyTpl.includes('一字不差'), '分镜要求 line 逐字照抄、拼回原文一字不差')
check(storyTpl.includes('一个人') && storyTpl.includes('航拍'), '分镜写明「一个人能拍完」并列出禁用设备')
// ★ 分镜在两个入口共用（菜品稿 / 话题稿），只有写清空值的含义才能一份模板两用而不漂移
check(
  storyTpl.includes('不要替它编造'),
  '★ 分镜写明「某项为空 = 这条视频不涉及它，不要替它编造」（话题稿的常态）',
)
check(
  storyTpl.includes('没有资料或现成素材支持') &&
    storyTpl.includes('不假定另有素材'),
  '分镜画面必须匹配输入素材，不机械凑齐餐饮镜头类型',
)
check(
  storyTpl.includes('若口播太短或可用画面不足，不重复镜头') && storyTpl.includes('长句应给足时间'),
  '分镜避免为凑数量重复或拆碎台词，并为长句留出可说完的时长',
)
check(
  storyTpl.includes('纯话题视频'),
  '★ 分镜区分了纯话题视频：门店/菜品全空时画面不该出现店名、招牌、菜品特写',
)
// ★★ 2026-09-29：分镜里的「老板」是**写死**的，而界面上种草型承诺的是「达人素人视角」——
//    用户看到的分镜原话就是「老板站在店内镜头前」，而口播是推荐者的口吻。
//    修法**不是**给分镜传款式变量（那会破掉「分镜款式无关」的设计，三条理由见
//    `prompt-vars.ts` 的 STORYBOARD_VARS 声明处），而是**中性化 + 一句判据**：
//    谁出镜，由 {{copyText}} 里说「我」的那个人决定。
//    ⚠ 这几条要成组看：只查「模板里有没有那段话」会假绿 —— 段落写了但正文里仍写着
//      「按一个老板…老板自拍口播」，用户看到的还是老板。所以正面与反向都要查。
check(
  !storyTpl.includes('老板自拍口播') && !storyTpl.includes('按一个老板'),
  '★ 分镜不再写死出镜人是老板（写死就会与种草型的「推荐者视角」打架）',
)
// ★★ 出镜人的称呼**不由模型推断，由服务端按款式给定** —— 实测过三版，只有这一版稳：
//   ① 中段写一段「谁出镜」说明 → 第 1 次 6/6 条对、第 2 次 5/5 条**全写「老板」**；
//   ② 挪到提示词**开头**并加「写完全部 visualReq 通读自检」→ 3 次里 2 次全对、仍有 1 次全错；
//   ③ 由 `speakerRoleFor(track)` 直接给称呼（本次采用）。
//   ⇒ 前两版失败的原因是同一个：模型不知道**这一次**是哪个款式，只能靠题材先验猜，
//     而餐饮门店视频的先验就是「老板」。**猜不准的事实，就不要让它猜。**
check(
  storyTpl.includes('{{speakerRole}}'),
  '★ 分镜用 {{speakerRole}} 拿到出镜人的称呼（不靠模型从文案里推身份）',
)
check(
  speakerRoleFor('RECOMMEND') === '出镜推荐的人' && speakerRoleFor('RECOMMEND') !== '老板',
  '★ 种草型的出镜人不是老板（与界面上那行「达人素人视角」对齐）',
)
let otherFourAreBoss = true
for (const t of ['TRAFFIC', 'PERSONA', 'KNOWLEDGE', 'PRODUCT'] as const) {
  if (speakerRoleFor(t) !== '老板') otherFourAreBoss = false
}
check(otherFourAreBoss, '★ 其余四款的出镜人仍是老板（本次只动种草型，别误伤）')
check(
  findUnknownPlaceholders('storyboard_generate', '{{speakerRole}}').length === 0 &&
    findUnknownPlaceholders('copy_product', '{{speakerRole}}').length === 1 &&
    findUnknownPlaceholders('copy_recommend', '{{speakerRole}}').length === 1,
  '★ speakerRole 只在分镜白名单里（文案场景引用不到 —— 身份写在文案正文里，两个来源必然打架）',
)
// ★ 渲染结果要真的落进提示词：只查模板串会漏掉「白名单里有、buildVariables 却没产出」
//   ⇒ 网关**静默**替换成空串 ⇒ 那句渲染成「这次出镜的人是：「」」。所以这里查渲染后的文本。
const storyWithRecRole = renderTemplate(STORY_PROMPT, { speakerRole: speakerRoleFor('RECOMMEND') })
check(
  storyWithRecRole.includes('出镜推荐的人') && !storyWithRecRole.includes('「」'),
  '★ 渲染后「出镜推荐的人」真的落在分镜提示词里（不是渲染成空串的病句）',
)
// ★ 旧版兜底引用了 {{dishName}}/{{city}}/{{storeName}}，那三个变量在话题稿里全是空串，
//   渲染出来就是「，现做现卖」「就在」这种半句话 —— 一条模板要同时服务两种稿子就不能依赖它们。
const storyFb = story.fallback
check(
  storyFb.includes('{{copyText}}') &&
    !storyFb.includes('{{dishName}}') &&
    !storyFb.includes('{{storeName}}') &&
    !storyFb.includes('{{city}}'),
  '★ 分镜兜底只引用 {{copyText}}（门店/菜品变量在话题稿里是空串，会渲染成半句话）',
)
check(
  (storyFb.match(/"line":/g) ?? []).length === 1,
  '★ 分镜兜底是单镜（line 只有一条 ⇒ 所有 line 拼起来必然等于原文）',
)
// ★★ 2026-09-29：兜底的 visualReq 原来写「**老板**用手机前置镜头自拍口播」——
//   种草型的说话人是推荐者，AI 失败时用户会拿到一条与所选款式身份不符的脚本。
check(
  !storyFb.includes('老板'),
  '★ 分镜兜底的 visualReq 不写「老板」（兜底是静态模板，没法按款式换身份 ⇒ 只能中性化）',
)
check(
  storyFb.includes('出镜的人'),
  '★ 分镜兜底的 visualReq 用中性的「出镜的人」（五个款式共用这一条兜底）',
)
// ★ 「老板」的第三个来源是镜头库那行 —— `buildShotLibraryHint` 渲染成 `code｜name（category）`，
//   所以 `shotLibrary.boss_talk` 的 name（旧值「老板口播」）会直接出现在提示词里，
//   只要模型挑到它就会看到「老板」两个字。库名已中性化为「真人口播」，这里钉住模板侧那句澄清。
check(
  storyTpl.includes('真人口播') && storyTpl.includes('不代表出镜人必须是老板'),
  '★ 分镜提示词澄清「真人口播」只是手法名、不等于出镜人是老板（库名会进提示词）',
)

// ──────────────────────── ⑥ 话题方向库（纯函数，不连库） ────────────────────────
section('⑥ 话题方向库：同一天稳定、隔天轮换、只让 14 天内的节点抢头条')

// 6.1 ★ 同一天两次调用必须**完全一致**：库里绝对不能引入随机数。
//     用户点「重新生成」时如果方向变了，他会以为「话题变了」，而实际上只是我们抖了一次骰子。
const day1 = topicDirections(at('2026-09-20T09:00:00+08:00'))
const day1b = topicDirections(at('2026-09-20T09:00:00+08:00'))
check(JSON.stringify(day1) === JSON.stringify(day1b), '同一天两次调用结果完全一致（无随机）')

// 6.2 数量：太少就永远同一句，太多模型会挑花眼
check(day1.length >= 2 && day1.length <= 6, `方向数落在 2~6 条之间（实得 ${day1.length}）`, day1.join(' ｜ '))

// 6.3 去重：节点方向与时令方向可能撞句，输出里不许有重复
check(new Set(day1).size === day1.length, '输出里没有重复方向')

// 6.4 节点驱动生效：2026-09-20 距中秋 5 天，必须给得出中秋那组里的方向。
//     ⚠ 断言用「中秋 | 月饼」而不是只认「中秋」二字：组内是按天轮转取一条的，
//       那天抽到的是「月饼现在还有人抢着买吗」。日期是钉死的，轮转结果因此是确定的，
//       所以这个并集写死不会 flaky；反过来只认「中秋」就会误判成没给。
check(day1.some((x) => x.includes('中秋') || x.includes('月饼')), '中秋前 5 天给出了中秋那组的方向', day1.join(' ｜ '))

// 6.5 ★ 窗口边界：只让 14 天内的节点抢头条。
//     2026-10-20 最近的节点是 3 天后的霜降（10/23），立冬在 11/7（18 天后）——
//     18 > 14 ⇒ 立冬那条方向**不许**出现。这条会随 WINDOW/窗口常量的改动而变红，是刻意的。
const oct = topicDirections(at('2026-10-20T09:00:00+08:00'))
check(oct.some((x) => /(霜降|降温第一天|一天比一天冷)/.test(x)), '10-20 给出 3 天后霜降的方向', oct.join(' ｜ '))
check(!oct.includes('立冬这天该吃点扎实的'), '★ 18 天后的立冬没有抢头条（14 天窗口生效）')

// 6.6 隔天轮换：同一季节相邻两天的方向不应完全一样，否则一个月里天天同一句
const day2 = topicDirections(at('2026-09-21T09:00:00+08:00'))
check(JSON.stringify(day1) !== JSON.stringify(day2), '相邻两天的方向不同（按天轮换生效）')

// 6.7 渲染形态：首行是日期、带编号列表、无残留占位符、且**永远非空**
const ti = (s: string, city = '') => formatTopicInfo(at(s), city)
for (const when of ['2026-09-20T09:00:00+08:00', '2026-01-05T09:00:00+08:00', '2027-03-01T09:00:00+08:00']) {
  const t = ti(when)
  check(t.startsWith('今天是 '), `${when.slice(0, 10)} topicInfo 以「今天是」开头`)
  check(t.includes('1. '), `${when.slice(0, 10)} topicInfo 带编号的起头方向`)
  check(t.includes('不要编造新闻'), `${when.slice(0, 10)} topicInfo 带「不许编造新闻」的禁令`)
  check(!t.includes('{{'), `${when.slice(0, 10)} topicInfo 无残留占位符`)
  check(t.length > 30, `${when.slice(0, 10)} topicInfo 非空且有实质内容（${t.length} 字符）`)
}

// 6.8 地域钩子：串是从**门店档案**拼出来的（省/市/区），空 / 纯空白 ⇒ 整行不出现。
//     ★ 这一行文案里**不许出现「门店」二字** —— 话题稿的硬约束是不出现门店，
//       写成「门店位置：」模型很容易顺手写「我们店就在XX」（对照 COPY_TRAFFIC_PROMPT 的禁令）。
const LOC = ti('2026-09-20T09:00:00+08:00', '河北省廊坊市固安县')
const locLine = LOC.split('\n').find((l) => l.startsWith('所在地区：')) ?? ''
check(LOC.includes('所在地区：河北省廊坊市固安县'), '给了位置 → 出现「所在地区：…」行')
check(locLine.length > 0 && !locLine.includes('门店'), '★ 地域钩子那一行里不出现「门店」二字', locLine.slice(0, 30))
check(locLine.includes('挑一级'), '位置是整串地址时明写「挑一级来说」（否则模型会照抄「河北省廊坊市固安县」）')
check(
  LOC.includes('不要编造具体街道'),
  '带位置时同时禁止编造具体街道/店名（有位置不等于可以编门店）',
)
check(!ti('2026-09-20T09:00:00+08:00').includes('所在地区：'), '没给位置 → 不出现「所在地区：」行')
check(
  !ti('2026-09-20T09:00:00+08:00', '   ').includes('所在地区：'),
  '★ 位置只给空白字符 → 视同没有（不许出现空的位置行）',
)

// 6.8.1 ★★ 地域例句必须**跟着位置走**，不许写死。
//   原先那两句是硬编码的「咱河北的」「咱固安的」，门店在福建时提示词里就会出现
//   一句**和自己的位置互相矛盾**的例句 —— 真跑抓到过：门店「福建省福州市台江区」，
//   提示词给的例子却是「咱固安的」。这类矛盾不报错，只会让模型偶尔跟着例句跑偏。
const FJ = ti('2026-09-21T09:00:00+08:00', '福建省福州市台江区')
check(
  FJ.includes('咱福建的') && FJ.includes('咱台江的'),
  '★ 地域例句跟着位置走（福建门店给的是「咱福建的」「咱台江的」，不是写死的河北）',
  FJ.split('\n').find((l) => l.startsWith('所在地区：')) ?? '',
)
check(
  !FJ.includes('固安') && !FJ.includes('河北'),
  '★★ 福建门店的 topicInfo 里完全不出现「河北 / 固安」（写死例句会自相矛盾）',
)
check(
  ti('2026-09-21T09:00:00+08:00', '固安县').includes('咱固安的'),
  '单级位置（只填了区县）也能取出一条例句',
)

// 6.9 ★★ 常驻基线：**地域身份线每天必出**，但**位置不限**（2026-10-12 改）。
//   为什么不再固定第 1：一份 39 条真实对标清单里，地域身份族（省级身份／老乡／本地区县／方言）
//   占「同城热点」组的 61.5%，是这一档真正的主引擎 —— 但把它钉在第 1 条、还加「主力方向」标注，
//   等于**每次都把模型推回老乡 / 家乡那道菜**，正是用户反馈「流量型老是同一个」的直接来源。
//   ⇒ 现在的契约是「每天必出（不许断档）＋ 位置由 seed 决定」，出题权交回给族轮转。
const identityIdx = (x: string[]) => x.findIndex((d) => (IDENTITY_CUTS as readonly string[]).includes(d))
check(identityIdx(day1) >= 0, '★ 地域身份线每天必出（常驻基线，不进轮转池）', day1.join(' ｜ '))
check(identityIdx(oct) >= 0, '★ 2026-10-20 那天基线同样出现', oct.join(' ｜ '))
check(
  IDENTITY_CUTS.length >= 3,
  `基线自带多个「切口」（实得 ${IDENTITY_CUTS.length} 个）—— 只写死一句会让用户连着几天看到同一句话`,
)
// 切口按天轮转：7 天里至少换过 3 种；而且**每天都必须有一条**（缺一天 = 基线断档）
const cuts7 = [0, 1, 2, 3, 4, 5, 6].map((i) => {
  const dirs = topicDirections(at(`2026-09-${String(20 + i).padStart(2, '0')}T09:00:00+08:00`))
  return dirs.find((d) => (IDENTITY_CUTS as readonly string[]).includes(d)) ?? ''
})
check(cuts7.every((d) => d !== ''), '★ 7 天里每天都有地域身份线（位置不限，但不许缺）', cuts7.join(' ｜ '))
check(
  new Set(cuts7).size >= 3,
  `★ 基线的「切口」在 7 天里至少换过 3 种（实得 ${new Set(cuts7).size} 种）`,
  cuts7.join(' ｜ '),
)

// 6.10 ★ 反向：地域身份**不许**同时留在轮转池里。
//   留在池子里 = 有的天出两条地域身份方向、有的天一条都不出，两头都不对。
const everPool = EVERGREEN_TOPICS.flat()
check(
  !everPool.some((d) => (IDENTITY_CUTS as readonly string[]).includes(d)),
  '★ 地域身份线没有同时留在轮转池里（留在池子里 = 主力方向被重新摊薄）',
)
check(
  everPool.some((d) => d.includes('区号') || d.includes('对个暗号')),
  '轮转池里有「方言验证 / 对暗号」这一族（骨架二的落点）',
)
check(
  everPool.some((d) => d.includes('老规矩') || d.includes('该退了')),
  '轮转池里有「本地老规矩 / 同城争议」这一族（骨架三的落点）',
)
// 每一句都要能当第一句话直接念 —— 写成「亲情 / 归属感」这种标签，模型只会写回播报腔，
// 而消灭播报腔正是这一档的全部目的（所以长度也一起钉：短到 4 个字的必然是标签）。
check(
  everPool.every((d) => d.length >= 8),
  '★ 每条方向都是能直接开口的句子（长度 ≥8 字），不是「亲情 / 归属感」这类标签',
  everPool.filter((d) => d.length < 8).join(' ｜ '),
)

// 6.11 ★★ 2026-10-12 起**不许**再给第 1 条加「主力方向」标注（那是单一化的直接来源），
//   改成中性的「优先挑与【近期已用文案】不重复的那一条」—— 把选择权交给**新鲜度**。
check(
  !ti('2026-09-20T09:00:00+08:00').includes('主力方向'),
  '★★ topicInfo 不许再出现「主力方向」标注（那句话每次把模型推回老乡线）',
)
check(
  ti('2026-09-20T09:00:00+08:00').includes('优先挑与'),
  '★ topicInfo 改成「优先挑与【近期已用文案】不重复的那一条」',
)
check(
  ti('2026-09-20T09:00:00+08:00', '河北省廊坊市固安县').includes('优先挑与') &&
    !ti('2026-09-20T09:00:00+08:00', '河北省廊坊市固安县').includes('{{'),
  '带位置时中性挑法同样在，且无残留占位符',
)

// 6.12 ★★「族轮转」这套机制的**承诺**（2026-10-12 新增）。
//   旧断言守的全是「第 1 条是不是老乡线」，机制一换就整片假红；下面四条守的才是新机制
//   真正要保证的东西 —— 而且每一条都能钉住一类**静默失效**。
//   a) 同一天两两不同族：这是「不再单一化」的量化判据。
const fam = day1.map((d) => topicFamilyOf(d)).filter((f) => f !== null)
check(new Set(fam).size === fam.length, '★ 同一天的几条方向两两不同族', fam.join(' ｜ '))
//   b) 一周覆盖 ≥8 族：族池取的是**连续窗口、每天平移 1 位**，7 天并集必然覆盖整个池。
//      ★ 这一条专治「大步跳」写法（`(seed + i * 3) % N`）：看着更随机，却会让某些族长期
//        落在窗外 —— 旧实现里「方言暗号」整族从未出现过，就是这一类缺陷，而且全程不报错。
const weekFams = new Set(
  [0, 1, 2, 3, 4, 5, 6]
    .flatMap((i) => topicDirections(at(`2026-10-${String(1 + i).padStart(2, '0')}T09:00:00+08:00`)))
    .map((d) => topicFamilyOf(d))
    .filter((f) => f !== null),
)
check(weekFams.size >= 8, `★ 一周内至少覆盖 8 个族（实得 ${weekFams.size} 个）`, [...weekFams].join(' ｜ '))
//   c) variant（由**创作编号**派生）：同一条创作重生成必须**完全一致**，不同创作要**错开**。
//      ★ 乘数用 `79193` 而不是 `7919`：后者 ≡ −1，相邻创作只挪 1 位，实测 4/6 条仍重合。
const dv0 = topicDirections(at('2026-09-20T09:00:00+08:00'), 0)
const dv0b = topicDirections(at('2026-09-20T09:00:00+08:00'), 0)
const dv1 = topicDirections(at('2026-09-20T09:00:00+08:00'), 1)
check(JSON.stringify(dv0) === JSON.stringify(dv0b), '★ 同一个 variant 两次调用完全一致（重生成不该换方向）')
const variantOverlap = dv0.filter((d) => dv1.includes(d)).length
check(
  variantOverlap <= dv0.length - 2,
  `★ 换一个 variant 至少换掉 2 条（实测重合 ${variantOverlap}/${dv0.length} 条）`,
  dv1.join(' ｜ '),
)
//   d) 天气族只写「天气感」，**不许报实际天气**（我们没接天气 API，写了就是编新闻）。
//      用户 2026-10-12 拍板：天气 = 只写天气感。
const weatherDirs = EVERGREEN_TOPICS.flat().filter((d) => topicFamilyOf(d) === '天气时令')
const badWeather = weatherDirs.filter((d) => /\d+\s*(度|℃)|预报|今天(有|是|会)(雨|雪|晴|阴)/.test(d))
check(
  weatherDirs.length > 0 && badWeather.length === 0,
  '★ 天气族只写「天气感」，不报实际天气（没接天气 API，写了就是编）',
  badWeather.join(' ｜ '),
)

// ───────── ⑦ 菜品可选项：不选菜品时提示词与兜底都必须成立（2026-09-25） ─────────
section('⑦ 菜品可选项：空菜名的提示词契约与兜底渲染')

/**
 * ★ 背景：菜品从「创建时必选」改成「可选、默认不选」。于是 `{{dishName}}` 为空
 *   从「数据缺失」变成了**预期状态**，而这条链路上有三处会因此静默出问题：
 *     ① 提示词那一行变成「【菜品】」后面空着 —— 模型会以为资料漏了，自己编一道菜补上
 *     ② 兜底文案（AI 挂了时渲染）里 `{{storeName}}的{{dishName}}，…` 渲染成
 *        「大帅餐饮的，具体信息以门店当前介绍为准。」—— 断在「的」后面的病句
 *     ③ 创建标题落 undefined ⇒ 前端 4 处 `title || '未命名创作'` 全显示「未命名创作」
 *   三处都**不报错、不提示降级**：②③ 用户直接看得到，① 要等成片出来才发现。
 *   所以这一段的断言都是「不许静默失效」型的，不是风格偏好。
 */

// 7.1 提示词必须写明空值语义 —— 六份共用上下文块的模板（含分镜）逐份断言。
//     用**同一句子串**断言是刻意的：两个块（CONTEXT_BLOCK 与分镜手写的那份）必须说同一件事，
//     各改各的措辞就会让「同一份资料、两个模型看到不同的空值含义」。
//
// ★★ 2026-09-29：判据从「**模板字符串**里含这句话」改成「**渲染之后**含这句话」。
//    那段空值说明已经从模板文本搬进了变量 `{{dishEmptyNote}}`（只在没选菜时才有值），
//    原因是菜品有值时它会和菜名自相矛盾（详见 src/lib/dish-mention.ts）。
//    老写法有两个毛病，换掉后都堵上了：
//      · 搬到变量后**必然假红**（模板里再也搜不到那句话）；
//      · 更糟的是**假绿** —— 产品型的硬约束段里恰好也有「老板这次没选具体菜品」这几个字，
//        所以它一直是靠那句蒙混过关的：真把资料区那段说明整段删掉，这条断言照样全绿。
for (const t of dishTemplates) {
  const rdEmpty = renderTemplate(t.tpl, { dishName: '', dishEmptyNote: DISH_EMPTY_NOTE })
  check(rdEmpty.includes('这次没选具体菜品'), `${t.label} 渲染后写明了空菜品语义（这次没选具体菜品）`)
}
// ★★ 反向的一半（新增）：**选了菜时，那一行不许再出现空值语义**。
//    只断言「没选菜时在」会把「永远打印」当成合格 —— 而那正是本次故障：
//    模型看到「锅巴土豆（空 = 这次没选具体菜品…改讲门店本身）」，整篇去写门店。
//    只查【菜品】那一行而**不查整篇**：产品型的硬约束段里本来就有一条
//    「★ 菜品资料为空时…改讲门店本身」，那是**该留**的（实测删掉反而更差，见 dish-mention.ts）。
for (const t of dishTemplates) {
  const rdDish = renderTemplate(t.tpl, { dishName: '契约测试菜品', dishEmptyNote: dishEmptyNoteFor('契约测试菜品') })
  const line = rdDish.split('\n').find((l) => l.startsWith('【菜品】')) ?? ''
  check(
    line.includes('契约测试菜品') && !line.includes('这次没选具体菜品') && !line.includes('改讲门店本身'),
    `${t.label} 选了菜时「【菜品】」那一行不带任何空值说明`,
    line.slice(0, 46),
  )
}
// 7.2 分镜还要额外区分「门店有、菜品空」与「两样都空」这两种情况：前者的画面里
//     **不该出现某道菜**，后者才是「纯话题视频」（不许出现店名/招牌）。
//     旧的注释只写了后者，而菜品可选之后前者成了最常见的一种。
check(
  storyTpl.includes('菜品为空') && storyTpl.includes('不要出现某道菜的特写或菜名'),
  '★ 分镜区分了「门店有、菜品为空」：不给某道菜特写或菜名',
)
check(
  storyTpl.includes('都为空') && storyTpl.includes('纯话题视频'),
  '分镜仍保留「两样都空 = 纯话题视频」那一档（别为新情况把它删掉）',
)

// 7.3 兜底模板**不许**引用 {{dishName}}。
//     模板没有条件语法（网关只做字符串替换），一份兜底要同时服务「选了菜」与「没选菜」；
//     引用它的那份在没选菜时必然渲染成病句。这条同时是「以后别再加回来」的闸门。
for (const t of TEMPLATES) {
  check(!t.fallback.includes('{{dishName}}'), `${t.label} 兜底不引用 {{dishName}}`)
}

/**
 * 「悬空搭配」判据：某个词后面紧跟「的」再接标点（或整句以「的」收尾）。
 * 这正是 `{{storeName}}的{{dishName}}，…` 空菜名时的形态。
 * ⚠ 它是个**启发式**判据，不是语法分析 —— 但这一档的兜底都是短句，正常写法不会触发。
 */
const DANGLING = /的[，。、；：！？·|｜]|的$/
/** 兜底渲染用的门店名：与下面 ④ 段的临时门店刻意不同名，避免误判成「读到了真门店」 */
const FB_STORE = '契约测试门店-兜底渲染'

// 7.4 真渲染一遍：不只查模板字符串，而是查**渲染结果**。
//     只查模板「有没有 {{dishName}}」是不够的 —— 那样断言窄于标题，未来有人在别处
//     拼一个同形的病句（比如 `{{storeName}}的，`）也照样全绿。这里断言的是用户会念到的那句话。
for (const t of TEMPLATES) {
  const out = renderTemplate(t.fallback, { storeName: FB_STORE, dishName: '', copyText: '测试口播文案' })
  check(!out.includes('{{'), `${t.label} 兜底渲染后无残留占位符`, out)
  check(!DANGLING.test(out), `${t.label} 兜底在「没选菜」时渲染不出悬空的「的，」`, out)
}
// 7.5 正向：菜品稿的三条兜底仍然带着门店名（不是把变量删光换来的「不悬空」）。
//     没有这条的话，把模板改成一句完全静态的话也能全绿 —— 而那丢掉了门店身份。
for (const code of ['copy_generate', 'copy_product', 'copy_recommend']) {
  const t = TEMPLATES.find((x) => x.code === code)!
  const out = renderTemplate(t.fallback, { storeName: FB_STORE, dishName: '' })
  check(out.includes(FB_STORE), `${t.label} 兜底在没选菜时仍带着门店名`, out)
  check(out.length >= 12, `${t.label} 兜底仍是一句能念的话（非空验证）`, `${out.length} 字`)
}

// 7.6 ★ 反向复现：把**旧**模板喂进判据必须被判为病句。
//     没有这条，「DANGLING 根本挡不住这次要修的东西」也会全绿（断言窄于标题）。
check(
  DANGLING.test(
    renderTemplate('{{storeName}}的{{dishName}}，具体信息以门店当前介绍为准。', { storeName: FB_STORE, dishName: '' }),
  ),
  '★ 复现：旧兜底在没选菜时确实渲染成病句（反证上面那条判据有效）',
)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exitCode = 1
await prisma.$disconnect()
