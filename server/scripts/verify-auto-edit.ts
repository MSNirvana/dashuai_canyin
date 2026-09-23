import assert from 'node:assert/strict'
import {
  applyAutoEditPlan,
  buildAutoEditPlan,
  inferAutoEditProfile,
  validateOutputQuality,
  type AutoEditProfile,
} from '../src/render/auto-edit.js'
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
assert.equal(applyAutoEditPlan(plan).length, plan.candidates.length)

const talking = [
  clip(1, { shotType: '口播', line: '大家好，今天带大家看看我们店里最受欢迎的招牌菜。' }),
  clip(2, { shotType: '口播', line: '这道菜每天限量制作，建议提前预订。' }),
]
assert.equal(inferAutoEditProfile(talking).profile, 'TALKING_HEAD')
const talkingPlan = buildAutoEditPlan(talking, 'TALKING_HEAD' satisfies AutoEditProfile, 60_000)
assert.deepEqual(talkingPlan.candidates.map((item) => item.sourceIndex), [0, 1])

assert.equal(validateOutputQuality({ ok: true, width: 1080, height: 1920, durationMs: 15_000 }).ok, true)
assert.equal(validateOutputQuality({ ok: true, width: 1920, height: 1080, durationMs: 15_000 }).ok, false)
assert.equal(validateOutputQuality({ ok: false, width: null, height: null, durationMs: null, reason: 'bad file' }).ok, false)

console.log('auto-edit verification passed')

