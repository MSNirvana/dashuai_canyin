// AI 字幕分行（`subtitle_split`）守护 —— 纯函数级，不需要数据库、不需要 AI 通道。
//
// ★★ 这个功能最危险的失效方式是「**静默退回内建算法**」：用户看到的还是老样子，
//    日志里也没有异常，无从判断是「模型没切好」还是「接线断了」。
//    所以本守护把**接线**（AI 的行真的上了屏、真的没被二次归一化合回去）
//    和**判据**（丢字/加字/改字/超宽一律拒绝）分开断言。
import assert from 'node:assert/strict'
import {
  mergeSubtitleSegments,
  normalizeSubtitleSegments,
  splitSubtitleText,
  subtitleDisplayWidth,
  SUBTITLE_MAX_WIDTH,
  type SubtitleLineSplitter,
} from '../src/render/synthesis.js'
import { acceptLines, buildLineInput } from '../src/render/subtitle-split.service.js'
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
  ['带标点（去标点后逐字相同 ⇒ 放行）', ['廊坊想吃火锅的，', '千万别划走这盘牛肚。'], REAL_LINES],
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

// ── ⑤ 提示词 / 场景契约 ────────────────────────────────────────────────────────
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

// ── ⑥ 记录「AI 到底比内建多了什么」——把它钉成断言，防止有人以为两者等价 ──────────
assert.deepEqual(
  splitSubtitleText(REAL_TEXT),
  ['廊坊想吃火锅的千万别', '划走这盘牛肚'],
  '★ 内建算法在这条上会切在「千万别划走」中间；这正是 AI 分行存在的理由',
)
assert.notDeepEqual(splitSubtitleText(REAL_TEXT), REAL_LINES, '★ 两者必须确实不同（否则这个场景没有存在价值）')

console.log('subtitle-split verification passed')
