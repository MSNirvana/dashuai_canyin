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
  fitShotDurationsToTimeline,
  normalizeSubtitleSegments,
  splitSubtitleText,
  subtitleDisplayWidth,
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

const subtitleChunks = splitSubtitleText('第一句话完整显示。第二句话也要单独出现，而且这一句很长不能超出屏幕。')
assert.deepEqual(subtitleChunks.slice(0, 2), ['第一句话完整显示。', '第二句话也要单独出现，'])
assert.ok(subtitleChunks.every((text) => subtitleDisplayWidth(text) <= 14), '每条字幕必须在竖屏安全宽度内')
const subtitleCues = normalizeSubtitleSegments([
  { startMs: 0, endMs: 5_000, text: '第一句话完整显示。第二句话也要单独出现。' },
])
assert.ok(subtitleCues.length >= 2)
assert.equal(subtitleCues[0]?.text, '第一句话完整显示。')
assert.ok(subtitleCues.every((cue, index) => index === 0 || cue.startMs >= subtitleCues[index - 1]!.endMs), '字幕不能重叠堆积')

assert.equal(validateOutputQuality({ ok: true, width: 1080, height: 1920, durationMs: 15_000 }).ok, true)
assert.equal(validateOutputQuality({ ok: true, width: 1920, height: 1080, durationMs: 15_000 }).ok, false)
assert.equal(validateOutputQuality({ ok: false, width: null, height: null, durationMs: null, reason: 'bad file' }).ok, false)

console.log('auto-edit verification passed')
