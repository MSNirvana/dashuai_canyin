// AI 字幕分行（`subtitle_split`）守护 —— 纯函数级，不需要数据库、不需要 AI 通道。
//
// ★★ AI 分行是当前字幕质量的必要步骤：失败必须让渲染任务失败并进入可重试状态，
//    不能静默退回本地分条；本守护同时钉住 AI 行的接线与逐字质量判据。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  allocateSubtitleDurations,
  mergeSubtitleSegments,
  normalizeSubtitleSegments,
  splitSubtitleText,
  subtitleDisplayWidth,
  SUBTITLE_MAX_WIDTH,
  type SubtitleLineSplitter,
} from '../src/render/synthesis.js'
import { acceptLines, boundaryHitRate, buildLineInput, rebalanceWeakLines } from '../src/render/subtitle-split.service.js'
import { LIVE_SCENE_CODES, SCENE } from '../src/ai/scene-codes.js'
import { SCENE_VARIABLES, validateTemplate } from '../src/ai/prompt-vars.js'
import { SUBTITLE_SPLIT_PROMPT, SUBTITLE_SPLIT_SCENE } from '../prisma/prompts.js'

// ── ① 接线：AI 分的行必须**原样上屏**，且**不许被二次归一化合回去** ──────────────
// 用户这条成片的真实 ASR 原句（2026-09-29 取证，真打过一次线上 ASR）
const REAL_TEXT = '廊坊想吃火锅的千万别划走这盘牛肚'
// 人工认可的断行：在「呼语」与「谓语」之间断，而不是按宽度凑满 10 字
const REAL_LINES = ['廊坊想吃火锅的', '千万别划走这盘牛肚']

const asrSegments = [{ startMs: 0, endMs: 2_000, text: REAL_TEXT }]
const aiSplit: SubtitleLineSplitter = (text) => (text === REAL_TEXT ? REAL_LINES : null)

const withAi = normalizeSubtitleSegments(asrSegments, aiSplit)
assert.deepEqual(
  withAi.map((cue) => cue.text),
  REAL_LINES,
  '★★ AI 分的行必须原样上屏（不是内建算法给的那两条）',
)
assert.ok(
  withAi.every((cue) => subtitleDisplayWidth(cue.text) <= SUBTITLE_MAX_WIDTH),
  '★ 每一行都不得超宽',
)
assert.ok(
  withAi.every((cue) => cue.text.includes('\n') === false),
  '★ 每一行都必须是一行（不是同屏两行）',
)

/**
 * ★★ 二次归一化幂等 —— 这一条是**整个功能的命门**。
 *
 * `segmentsToAss` 内部会**再跑一次** `normalizeSubtitleSegments`（历史遗留的双重归一化，
 * 见 `segmentsToAss` 的调用点）。AI 分的行首尾紧接（gap = 0）、又不带句末标点，
 * 正好满足 `mergeSubtitleSegments` 的合并条件 ⇒ 会被**合回一大段**再按宽度重切，
 * 于是 AI 分好的行在最后一刻被自己人抹掉、而且**不报错**。
 * 靠的是 cue 上的 `locked` 标记挡住合并。
 */
// ⚠⚠ 第二次调用**必须不传 `splitter`** —— 生产里 `segmentsToAss` 就是这么调的。
//   一开始这里又传了一遍 `aiSplit`，结果**假绿**（变异测试实测：摘掉 `locked` 标记也照样通过）：
//   那条 splitter 会把「被合回一大段」的文本重新切成同样的两行，把 bug 完整掩盖掉。
const twice = normalizeSubtitleSegments(withAi)
assert.deepEqual(
  twice.map((cue) => cue.text),
  withAi.map((cue) => cue.text),
  '★★ 二次归一化必须幂等：否则 `segmentsToAss` 会把 AI 分好的行悄悄合回一大段',
)

// ── ② 反向断言：`locked` 必须真的有作用（否则「标记永远不管用」这条实现照样全绿） ──
const lockedCues = [
  { startMs: 0, endMs: 1_000, text: '廊坊想吃火锅的', locked: true },
  { startMs: 1_000, endMs: 2_000, text: '千万别划走这盘牛肚', locked: true },
]
const mergedLocked = mergeSubtitleSegments(lockedCues)
assert.equal(mergedLocked.length, 2, '★★ 带 `locked` 的两行绝不能再被合并')
assert.ok(
  mergedLocked.every((cue) => cue.locked === true),
  '★ `locked` 必须穿过 `mergeSubtitleSegments` 的对象重建（在那里丢字段 = 静默失效）',
)
// 反向：去掉标记后**必须**被合并 —— 证明上面两条不是在测一个永远为真的东西
const mergedPlain = mergeSubtitleSegments(lockedCues.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })))
assert.equal(mergedPlain.length, 1, '★ 反向：没有 `locked` 时就该合并（证明上一条有区分度）')

// ── ③ 内建路径**不能**被迫改行为：不该出现 locked，且结果与改动前一致 ────────────
const builtIn = normalizeSubtitleSegments(asrSegments)
assert.ok(builtIn.every((cue) => cue.locked !== true), '★ 内建算法产出的 cue 不许带 `locked`')
assert.deepEqual(
  builtIn.map((cue) => cue.text),
  ['廊坊想吃火锅的千万别', '划走这盘牛肚'],
  '★★ 内建算法的老行为必须一字不变（AI 分行是**新增**分支，不是替换）',
)

// ── ④ 校验判据：丢字 / 加字 / 改字 / 超宽 **一律拒绝** ────────────────────────────
const ACCEPT_CASES: ReadonlyArray<readonly [string, unknown, string[] | null]> = [
  ['合法两行', ['廊坊想吃火锅的', '千万别划走这盘牛肚'], REAL_LINES],
  // ★「一行放得下 16 个字」本身就是超宽 ⇒ 必须拒绝；单行合法的情形另有用例（见下）
  ['把 16 字硬塞成一行', [REAL_TEXT], null],
  ['超宽（12 字）', ['廊坊想吃火锅的千万别划'], null],
  ['丢字', ['廊坊想吃火锅的', '千万别划走'], null],
  ['加字', ['廊坊想吃火锅的哦', '千万别划走这盘牛肚'], null],
  ['改字', ['廊坊想吃火锅呢', '千万别划走这盘牛肚'], null],
  ['换序', ['千万别划走这盘牛肚', '廊坊想吃火锅的'], null],
  ['带标点（提示词要求不输出，不能静默擦除后放行）', ['廊坊想吃火锅的，', '千万别划走这盘牛肚。'], null],
  ['空行', ['廊坊想吃火锅的', ''], null],
  ['只有空白', ['廊坊想吃火锅的', '   '], null],
  ['不是字符串', ['廊坊想吃火锅的', 123], null],
  ['空数组', [], null],
  ['不是数组', '廊坊想吃火锅的', null],
]
for (const [label, raw, expected] of ACCEPT_CASES) {
  assert.deepEqual(acceptLines(raw, REAL_TEXT, SUBTITLE_MAX_WIDTH), expected, `★ 校验判据：${label}`)
}
// 单行合法：文本本身就放得下一行 ⇒ `acceptLines` 不许强行拆行
assert.deepEqual(
  acceptLines(['我敢说不是冻货'], '我敢说不是冻货', SUBTITLE_MAX_WIDTH),
  ['我敢说不是冻货'],
  '★ 放得下就只给一行（不要为了「看起来满」把短句拆开）',
)

// ── ⑤ 任务 #52 真实坏例：孤立口水词/两字尾巴必须被重新均分 ────────────────────
const task52Middle = rebalanceWeakLines(
  ['哎呀', '卷边了卷边就捞出来', '蘸上老板这个秘制', '香油啊又脆又爆汁'],
  '哎呀，卷边了，卷边就捞出来，蘸上老板这个秘制香油啊，又脆又爆汁，',
  SUBTITLE_MAX_WIDTH,
)
assert.deepEqual(
  task52Middle,
  ['哎呀卷边了', '卷边就捞出来', '蘸上老板这个秘制', '香油啊又脆又爆汁'],
  '★★ 任务 #52：不能让“哎呀”独占一屏，应与后文重排且不丢字',
)
const task52Ending = acceptLines(
  ['哎呀太香了想听这个', '脆的有多脆的评论区', '扣一'],
  '哎呀，太香了，想听这个脆的有多脆的，评论区扣一。',
  SUBTITLE_MAX_WIDTH,
)
assert.deepEqual(
  task52Ending,
  ['哎呀太香了想听这个', '脆的有多脆的', '评论区扣一'],
  '★★ 任务 #52：两字尾巴“扣一”必须并回 CTA，且原声字符一个不能丢',
)
assert.ok(task52Ending?.every((line) => subtitleDisplayWidth(line) >= 4), '★ 修复后每条至少有可读信息量')
assert.deepEqual(
  acceptLines(['吃虾', '我每回都会点一份'], '吃虾我每回都会点一份', SUBTITLE_MAX_WIDTH),
  ['吃虾', '我每回都会点一份'],
  '★ 两字完整短语不因宽度阈值被一刀切拒绝；语义质量由提示词约束',
)
const repairedFiller = acceptLines(['嗯', '我每回都会点一份'], '嗯我每回都会点一份', SUBTITLE_MAX_WIDTH)
assert.ok(
  repairedFiller !== null && repairedFiller[0] !== '嗯' && repairedFiller.join('') === '嗯我每回都会点一份',
  '★ 明确的口水词不得独占一屏：能无损重排时应修好，而不是机械整条拒绝',
)

// 时长分配：总时长充足时每条至少 700ms；不足时仍要严格守住原段总时长。
assert.deepEqual(allocateSubtitleDurations(2_100, [1, 8, 8]), [700, 700, 700], '★ 三条字幕各至少 700ms')
// ── ⑤c ★★★ 2026-10-14 事故回归：弱行的「最优切点」就是它自己 ⇒ 必须收敛，不许原地打转 ──
/**
 * 真因（线上快照 `ai_call_log id=514` / requestId `subtitle-split-74`，2026-10-14 14:45:36）：
 *   模型第一行给的是「吃虾」（当时旧判据宽度 ≤2 ⇒ 弱行），而它正好落在原句逗号之后。
 *   `bestSplit` 给「标点边界」−100 的权重 ⇒ 它选出的最优切点**就是这条弱行自己的边界**
 *   ⇒ `splice` 换回原样、`index` 被倒回原处 ⇒ 那个 for 循环再也不前进。
 *   后果不是「这条字幕难看」，而是**整个 Node 事件循环被占满**：所有接口一起超时
 *   （后台连登录都登不上），pm2 仍报 online、日志停在进函数之前、没有任何报错。
 *
 * ⚠⚠ 这条断言**回归时的现象是「脚本卡死」而不是红灯**（同步死循环会占满事件循环，
 *   连 `setTimeout` 都不会触发）—— 所以请用 `timeout 60 npm run subtitle-split:verify` 跑。
 *   为了让「把出口判据删掉」这件事至少有红灯，下面另有一条**源码级**断言先钉住它。
 */
const T74_ORIGINAL = '吃虾，我每回都会点一份他家的花青素组合，紫白菜、紫花菜、紫玉米，'
const T74_LINES = ['吃虾', '我每回都会点', '一份他家的', '花青素组合', '紫白菜', '紫花菜', '紫玉米']

assert.deepEqual(
  rebalanceWeakLines(T74_LINES, T74_ORIGINAL, SUBTITLE_MAX_WIDTH),
  T74_LINES,
  '★★★ task 74：「吃虾」的最优切点就是它自己 ⇒ 修不动就**原样返回**（绝不许原地打转）',
)
assert.deepEqual(
  acceptLines(T74_LINES, T74_ORIGINAL, SUBTITLE_MAX_WIDTH),
  T74_LINES,
  '★ task 74：终止性回归仍保留，但两字完整词不再由机械宽度阈值整条拒绝',
)
// ★ 源码级判据：把「原地踏步就放弃」的出口删掉 = 死循环 ⇒ 必须先在文本上钉住它（见上面 ⚠⚠）
const SUBTITLE_SPLIT_SRC = readFileSync(
  new URL('../src/render/subtitle-split.service.ts', import.meta.url),
  'utf8',
)
const SYNTHESIS_SRC = readFileSync(new URL('../src/render/synthesis.ts', import.meta.url), 'utf8')
const WORKER_SRC = readFileSync(new URL('../src/render/worker.ts', import.meta.url), 'utf8')
const SUBTITLE_SERVICE_SRC = SUBTITLE_SPLIT_SRC
assert.ok(
  SUBTITLE_SPLIT_SRC.includes("return failed('AI 分行走了兜底模板')")
    && SUBTITLE_SPLIT_SRC.includes('return failed(`AI 分行调用失败'),
  '★★ AI 通道/兜底模板失败必须标成 failed，不能返回普通空 Map',
)
assert.ok(
  SYNTHESIS_SRC.includes('if (outcome.failed) throw new Error(outcome.notice)')
    && !SYNTHESIS_SRC.includes('AI 分行失败，改用内建分条算法'),
  '★★ AI 分行失败必须抛给渲染任务，不能在 synthesis 层吞错后退回本地算法',
)
assert.ok(
  WORKER_SRC.includes('return outcome'),
  '★ worker 必须把 failed 状态完整传给 synthesis，不能只返回 lines 丢失失败信号',
)
assert.ok(
  SUBTITLE_SERVICE_SRC.includes("const requestId = reusePrevious")
    && SUBTITLE_SERVICE_SRC.includes("baseRequestId}-r${Date.now()}"),
  '★★ 字幕 AI 上一次 FAILED 后，重试必须换新 requestId，不能再次命中旧失败终态',
)
assert.ok(
  SUBTITLE_SPLIT_SRC.includes('split[0] === result[firstIndex] && split[1] === result[firstIndex + 1]'),
  '★★★ `rebalanceWeakLines` 必须有「切分结果与当前两行逐字相同 ⇒ 放弃」这条判据：'
    + '它是死循环的唯一出口（2026-10-14 事故把整个后端卡死）。重构它可以，但改完必须重新论证终止性',
)

const tightDurations = allocateSubtitleDurations(1_200, [2, 8])
assert.equal(tightDurations.reduce((sum, value) => sum + value, 0), 1_200, '★★ 分配后总时长不得漂移')
assert.ok(tightDurations.every((value) => value > 0), '★ 总时长不足时按权重退化，但不能出现零时长')

// ── ⑤b 断点质量度量（**只度量，不拒绝**）───────────────────────────────────────
/**
 * ★★ 2026-10-01：用户拍板字幕口径是「按**语义**停顿断」（不按语气停顿、也不强制标点边界）。
 *   语义**没有**可校验的形式判据 ⇒ `acceptLines` 不能拿它当拒绝条件 ——
 *   硬拒绝会把好结果一起拒掉、退回更差的内建算法（用户明确接受了「不可验证」这个代价）。
 *   所以这一节能断言的只有**度量本身算得对**，以及它**对真实坏例有区分度**。
 * ★ 用例取自 task 60 的线上快照（`ai_call_log.prompt_snapshot / response_snapshot`）——
 *   用户那句「一半一半」的量化形式，就是 hits = 0。
 */
const T60_ORIGINAL = '咱固安这地界儿啊，秋天一凉，你心里啊，最惦记老家哪一口吃的'

// 模型当时实际给出的三行：两个断点**一个都没落在**语义停顿处
assert.deepEqual(
  boundaryHitRate(['咱固安这地界儿啊秋天', '一凉你心里啊最惦记', '老家哪一口吃的'], T60_ORIGINAL),
  { hits: 0, total: 2 },
  '★★ task 60：模型的两个断点全都不在停顿处（这就是「一半一半」的量化形式）',
)
// ★ 反向对照：同一条原话按子句切，三个断点**全部**落在停顿处 ⇒ 证明这个度量有区分度
assert.deepEqual(
  boundaryHitRate(['咱固安这地界儿啊', '秋天一凉', '你心里啊', '最惦记老家哪一口吃的'], T60_ORIGINAL),
  { hits: 3, total: 3 },
  '★ 反向：按子句切时断点全部命中（否则这个度量对任何输入都给 0，等于一条死断言）',
)
// 单行没有断点 ⇒ total = 0；调用方据此**不打印**比例，避免出现 0/0 这种噪声
assert.deepEqual(
  boundaryHitRate(['咱固安这地界儿啊秋天一凉你心里啊'], T60_ORIGINAL),
  { hits: 0, total: 0 },
  '★ 单行没有断点：total = 0（调用方据此跳过打印）',
)

// ── ⑥ 提示词 / 场景契约 ────────────────────────────────────────────────────────
assert.ok(LIVE_SCENE_CODES.includes(SCENE.subtitle_split), '★ `subtitle_split` 必须在「已接入」清单里')
assert.equal(SUBTITLE_SPLIT_SCENE.code, 'subtitle_split')
assert.equal(SUBTITLE_SPLIT_SCENE.kind, 'TEXT', '★ 它是文本场景（走 chat/completions），不能进图像场景表')
assert.deepEqual(
  validateTemplate('subtitle_split', SUBTITLE_SPLIT_PROMPT),
  [],
  '★★ 提示词占位符必须全在白名单里 —— 否则运行时会被**静默替换成空串**，而模板校验照过',
)
assert.equal(
  SCENE_VARIABLES.subtitle_split?.includes('maxWidth'),
  true,
  '★ `maxWidth` 必须在白名单里（它承载的是画布像素算出来的硬约束）',
)
assert.equal(
  SCENE_VARIABLES.subtitle_split?.includes('storeName'),
  false,
  '★★ 不许放开门店/菜品变量：渲染期根本拿不到，放开只会让模型自己编一个店名',
)
assert.equal(buildLineInput(['甲', '乙']), '0｜甲\n1｜乙', '★ 编号清单格式（模型要按编号一一对应回填）')

/**
 * ★★ 提示词契约（2026-10-01）—— 守的是**这次故障的真因**。
 *
 * 旧提示词第 7 条写着「**行数越少越好**：能在上限内一次放下就只给一行」。
 * 在那一条的驱使下，模型的目标函数里根本没有「按意思断」，它只会「尽量少切几刀」，
 * 于是把「上半句的尾巴 ＋ 下半句的开头」拼成一条 —— 它**完全满足了旧提示词的每一条**，
 * 却正好是用户不要的（线上取证：`咱固安这地界儿啊秋天` / `一凉你心里啊最惦记`）。
 * ⇒ 这四条断言守的就是：**总目标不许再被删掉，贪心倾向不许再被写回来。**
 */
assert.ok(
  SUBTITLE_SPLIT_PROMPT.includes('一个把意思说得完整的小单元'),
  '★★ 提示词必须给出「一条 = 一个完整意思单元」这个总目标（缺了它，模型只剩一堆局部约束可依）',
)
assert.ok(
  !SUBTITLE_SPLIT_PROMPT.includes('行数越少越好'),
  '★★★ 不许把「行数越少越好」写回去 —— 它不是中性建议，而是把模型拉向贪心填满的那只手',
)
assert.ok(
  SUBTITLE_SPLIT_PROMPT.includes('意思完整 > 词语完整 > 不出现孤词碎片 > 各行宽度均衡'),
  '★★ 冲突时必须有明确优先级，否则同一输入会在「语义完整」与「凑宽度」之间随机摇摆',
)
assert.ok(
  SUBTITLE_SPLIT_PROMPT.includes('两边都成立才可以切'),
  '★ 语义要求必须落成可执行的切点检查，而不是只写一句抽象口号',
)
assert.ok(
  SUBTITLE_SPLIT_PROMPT.includes('多数行以 6～9 个字为宜'),
  '★ 必须给出目标宽度区间，避免模型把每行都贴着硬上限填满',
)
assert.ok(
  SUBTITLE_SPLIT_PROMPT.includes('你知道') && SUBTITLE_SPLIT_PROMPT.includes('吃虾'),
  '★ 必须用真实故障同型的孤短语示例约束模型，但不得照抄完整生产句',
)
assert.ok(
  !SUBTITLE_SPLIT_PROMPT.includes('廊坊想吃火锅的'),
  '★★ 举例不许用生产里真实出现过的整句：模型会**照抄**它（2026-09-29 实测），等于给标准答案',
)

// ── ⑥ 记录「AI 到底比内建多了什么」——把它钉成断言，防止有人以为两者等价 ──────────
assert.deepEqual(
  splitSubtitleText(REAL_TEXT),
  ['廊坊想吃火锅的千万别', '划走这盘牛肚'],
  '★ 内建算法在这条上会切在「千万别划走」中间；这正是 AI 分行存在的理由',
)
assert.notDeepEqual(splitSubtitleText(REAL_TEXT), REAL_LINES, '★ 两者必须确实不同（否则这个场景没有存在价值）')

console.log('subtitle-split verification passed')
