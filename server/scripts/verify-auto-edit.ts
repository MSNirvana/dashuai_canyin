import assert from 'node:assert/strict'
import {
  applyAutoEditPlan,
  buildAutoEditPlan,
  inferAutoEditProfile,
  resolveAutoChatcutOptions,
  validateOutputQuality,
  type AutoEditProfile,
} from '../src/render/auto-edit.js'
import { DEFAULT_CHATCUT_OPTIONS } from '../src/render/chatcut.js'
import {
  buildCaptionSvg,
  fitShotDurationsToTimeline,
  normalizeSubtitleSegments,
  mergeSubtitleSegments,
  segmentsToAss,
  shouldExtendForNarration,
  splitSubtitleText,
  stripTrailingPunctuation,
  subtitleDisplayWidth,
  SUBTITLE_BOTTOM_MARGIN,
  SUBTITLE_CAPTION_SVG_HEIGHT,
  SUBTITLE_FONT_SIZE,
  SUBTITLE_MAX_WIDTH,
  SUBTITLE_OUTLINE,
} from '../src/render/synthesis.js'
import type { RenderClip } from '../src/services/render.service.js'

function clip(index: number, overrides: Partial<RenderClip> = {}): RenderClip {
  return {
    shotId: String(index),
    assetId: `asset-${index}`,
    cosKey: `uploads/${index}.mp4`,
    coverKey: `uploads/${index}.jpg`,
    trimStartMs: 0,
    trimEndMs: null,
    durationMs: 6_000,
    line: null,
    ...overrides,
  }
}

const dish = [
  clip(1, { shotType: '成品特写', line: '这一口现做现吃，外酥里嫩。' }),
  clip(2, { shotType: '制作过程', line: '每天选用新鲜食材现场制作。' }),
  clip(3, { shotType: '门店环境', line: '店里空间宽敞，适合朋友聚餐。' }),
]
assert.equal(inferAutoEditProfile(dish).profile, 'DISH')
const plan = buildAutoEditPlan(dish, undefined, 12_000)
assert.equal(plan.profile, 'DISH')
assert.ok(plan.candidates.length >= 2)
assert.ok(plan.targetDurationMs <= 12_000)
assert.deepEqual(plan.candidates.map((item) => item.sourceIndex), [0, 1])
const appliedPlan = applyAutoEditPlan(plan)
assert.equal(appliedPlan.length, plan.candidates.length)
assert.ok(appliedPlan.every((item) => item.trimEndMs === null), '默认模式不得按文案估时截断原素材')
const autoOptions = resolveAutoChatcutOptions({ ...DEFAULT_CHATCUT_OPTIONS, transitions: 'SMOOTH' }, 'DISH', dish)
assert.equal(autoOptions.voiceId, 'none')
assert.equal(autoOptions.subtitles, true)
assert.equal(autoOptions.subtitleMode, 'SOURCE_AUDIO')
assert.equal(autoOptions.bgm, 'UPBEAT')
assert.equal(autoOptions.removeSilence, false)
assert.equal(autoOptions.pacing, 'NATURAL')
assert.equal(autoOptions.transitions, 'CLEAN')

const talking = [
  clip(1, { shotType: '口播', line: '大家好，今天带大家看看我们店里最受欢迎的招牌菜。' }),
  clip(2, { shotType: '口播', line: '这道菜每天限量制作，建议提前预订。' }),
]
assert.equal(inferAutoEditProfile(talking).profile, 'TALKING_HEAD')
const talkingPlan = buildAutoEditPlan(talking, 'TALKING_HEAD' satisfies AutoEditProfile, 60_000)
assert.deepEqual(talkingPlan.candidates.map((item) => item.sourceIndex), [0, 1])

const aligned = fitShotDurationsToTimeline([
  { line: '第一句', durationMs: 3_000 },
  { line: '第二句', durationMs: 4_000 },
  { line: '第三句', durationMs: 5_000 },
], 11_300)
assert.deepEqual(aligned.map((item) => item.durationMs), [2_650, 3_650, 5_000])
assert.equal(aligned.reduce((sum, item) => sum + item.durationMs, 0), 11_300)

// ── 字幕：末端标点、安全宽度、以及字号与各烧录路径的耦合 ────────────────────────
const SUBTITLE_SAMPLE = '第一句话完整显示。第二句话也要单独出现，而且这一句很长不能超出屏幕。'
const subtitleChunks = splitSubtitleText(SUBTITLE_SAMPLE)
assert.ok(subtitleChunks.length >= 5, '这段文案必须被切成多条字幕')
assert.ok(
  subtitleChunks.every((text) => stripTrailingPunctuation(text) === text),
  '★ 每句字幕末尾不得留标点（用户 2026-09-25 明确要求）',
)
assert.equal(
  subtitleChunks.join(''),
  SUBTITLE_SAMPLE.replace(/[。．，、；：！？…⋯·,;:!?.～~]/gu, ''),
  '★★ 切分只允许去掉标点，不得丢字、不得重复 —— 比「等于某个写死的数组」耐用得多',
)
assert.ok(
  subtitleChunks.every((text) => subtitleDisplayWidth(text) <= SUBTITLE_MAX_WIDTH),
  '每条字幕必须在竖屏安全宽度内',
)
// ★★ 字号与「每行放几个字」是同一件事的两面：字号翻倍而这里不跟着收紧，字幕就会冲出
//    1080 画布（被裁掉、或被 libass 折成两行）。这条断言专防「只改字号、忘了改宽度」。
assert.ok(
  SUBTITLE_MAX_WIDTH * SUBTITLE_FONT_SIZE <= 1080 - 72 * 2,
  '字幕块像素宽不得超过画布可用宽（ASS 左右各留 72px）',
)
const subtitleCues = normalizeSubtitleSegments([
  { startMs: 0, endMs: 5_000, text: '第一句话完整显示。第二句话也要单独出现。' },
])
assert.ok(subtitleCues.length >= 2)
assert.equal(subtitleCues[0]?.text, '第一句话完整显示')
assert.ok(subtitleCues.every((cue, index) => index === 0 || cue.startMs >= subtitleCues[index - 1]!.endMs), '字幕不能重叠堆积')
const ass = segmentsToAss(subtitleCues)
assert.match(ass, /PlayResX: 1080/)
assert.match(ass, /PlayResY: 1920/)
assert.match(ass, /WrapStyle: 2/)
// ★ 断言用常量拼，避免再出现「常量改了、断言里还写死 52」这种两套标准。
assert.match(ass, new RegExp(`Style: Default,Noto Sans CJK SC,${SUBTITLE_FONT_SIZE},`))
assert.match(
  ass,
  new RegExp(`,1,${SUBTITLE_OUTLINE},0,2,72,72,${SUBTITLE_BOTTOM_MARGIN},1`, 'm'),
  'ASS 样式里的描边与底边距必须由常量拼出，不能写死',
)
assert.ok(ass.split('\n').filter((line) => line.startsWith('Dialogue:')).every((line) => !line.includes('\\N')), 'ASS 字幕必须保持单行')
// ★★ 放大字号最容易漏、而且**不会报错**的一处：Sharp 回退路径的 SVG 画布尺寸。
//    画布不够高 ⇒ 字形被 sharp 裁掉，成片里只是「字少了半个」，日志里什么都没有。
const captionSvg = buildCaptionSvg('测试字幕', 'Noto Sans CJK SC')
assert.match(captionSvg, new RegExp(`height="${SUBTITLE_CAPTION_SVG_HEIGHT}"`), 'SVG 画布高度必须由字号推导')
assert.ok(SUBTITLE_CAPTION_SVG_HEIGHT >= SUBTITLE_FONT_SIZE, '★★ SVG 画布必须装得下字号，否则字形被裁')
assert.equal(shouldExtendForNarration(false, '默认模式有文案但不配音', 2_000, 4_000), false, '无配音时不得补静止尾帧')
assert.equal(shouldExtendForNarration(true, '高级模式配音', 2_000, 4_000), true)
const mergedSubtitleCues = mergeSubtitleSegments([
  { startMs: 0, endMs: 900, text: '说不是冻货' },
  { startMs: 920, endMs: 1_800, text: '6小时到店' },
  { startMs: 1_820, endMs: 2_600, text: '锁鲜只' },
  { startMs: 2_620, endMs: 3_000, text: '有完整语句。' },
])
assert.equal(mergedSubtitleCues.length, 1, '无标点的连续 ASR 片段应先合并')
assert.equal(mergedSubtitleCues[0]?.text, '说不是冻货6小时到店锁鲜只有完整语句。')

assert.equal(validateOutputQuality({ ok: true, width: 1080, height: 1920, durationMs: 15_000 }).ok, true)
assert.equal(validateOutputQuality({ ok: true, width: 1920, height: 1080, durationMs: 15_000 }).ok, false)
assert.equal(validateOutputQuality({ ok: false, width: null, height: null, durationMs: null, reason: 'bad file' }).ok, false)

console.log('auto-edit verification passed')
