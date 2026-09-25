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
  SUBTITLE_MIN_TAIL_WIDTH,
  SUBTITLE_OUTLINE,
  SUBTITLE_SIDE_MARGIN,
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

// ── 字幕：行内标点 / 行末无标点 / 每行字数 / 整句优先 / 不留孤字 ──────────────────
const stripAllPunctuation = (value: string) => value.replace(/[。．，、；：！？…⋯·,;:!?.～~]/gu, '')
const SUBTITLE_SAMPLE = '第一句话完整显示。第二句话也要单独出现，而且这一句很长不能超出屏幕。'
const subtitleChunks = splitSubtitleText(SUBTITLE_SAMPLE)
assert.ok(subtitleChunks.length >= 3, '这段文案必须被切成多条字幕')
assert.ok(
  subtitleChunks.every((text) => stripTrailingPunctuation(text) === text),
  '★ 每行**末尾**不得留标点（用户 2026-09-25 要求①）',
)
// ★★ 用户同一天又补了「中间还是要有」⇒ 必须**正面**断言行内标点被保留。
//    只断言「末尾没有标点」会漏掉「实现把标点全删了」这种错法 —— 它同样能满足末尾无标点。
assert.ok(
  splitSubtitleText('大家好，今天带大家看看我们店里最受欢迎的招牌菜').some((text) => /[，、：]/.test(text)),
  '★★ 行内标点必须保留（用户 2026-09-25 要求②）—— 改成「只按整句拆」就是为这条',
)
assert.equal(
  stripAllPunctuation(subtitleChunks.join('')),
  stripAllPunctuation(SUBTITLE_SAMPLE),
  '★★ 切分不得丢字、不得重复（标点不计）—— 比「等于某个写死的数组」耐用得多',
)
assert.ok(
  subtitleChunks.every((text) => subtitleDisplayWidth(text) <= SUBTITLE_MAX_WIDTH),
  '每条字幕必须在竖屏安全宽度内',
)
// ★★ 「不要剩一个字留在下一句的开头」＝ 切点必须落在**词边界**上（见下面的真机回归块）。
assert.ok(
  subtitleChunks.every((text) => subtitleDisplayWidth(text) >= 2),
  '★ 不得出现只剩 1 个字的孤儿行',
)
// ★★ 「一句话要完整」：整句不超宽时必须原样一行、不得被切。
assert.deepEqual(splitSubtitleText('这句话本身就很完整'), ['这句话本身就很完整'], '★ 整句不超宽时不得被切分')
// ★★ 「每行 10 个字」：刚好 10 字放得下、11 字要折两行。用**行为**钉住，不写死常量。
assert.deepEqual(splitSubtitleText('一二三四五六七八九十'), ['一二三四五六七八九十'], '10 个字必须能放下一行')
assert.equal(splitSubtitleText('一二三四五六七八九十一').length, 2, '11 个字必须折成两行')

// ── ★★ 2026-09-25 第二轮：真机回归 ────────────────────────────────────────────────
// 下面这段 ASR 原文**就是用户成片里出问题的那一版**：在服务器上用项目自己的
// `transcribeAudio` 对成片音轨实跑得到，逐条与成片字幕一致。
// 旧实现（先算块数 n=ceil(总宽/10) 再按 总宽/n 均分）在这段文本上的产出是：
//   `廊坊想吃火锅的千 / 万别划走这盘牛肚 / ，我敢说不是动货`   ← 千万被劈开、逗号跑到行首
//   `沾上老板这个秘制香 / 油啊，又脆又爆汁`                    ← 香油被劈开
//   `那个部分红油七上 / 八下只涮15秒`                          ← 七上八下被劈开
// 用户原话：「一句话的最后一个字跑到下一行字幕的第一个字了，类似这样的情况肯定是不行的。」
const REAL_ASR_SEGMENTS = [
  { startMs: 1_300, endMs: 6_050, text: '廊坊想吃火锅的千万别划走这盘牛肚，' },
  { startMs: 6_050, endMs: 7_700, text: '我敢说不是动货。' },
  { startMs: 8_000, endMs: 9_350, text: '6小时到店，' },
  { startMs: 9_500, endMs: 10_650, text: '0°锁鲜，' },
  { startMs: 12_050, endMs: 13_150, text: '只取牛胃，' },
  { startMs: 13_150, endMs: 18_150, text: '最后的那个部分红油七上八下只涮15秒。' },
  { startMs: 18_750, endMs: 19_350, text: '哎呀，' },
  { startMs: 19_350, endMs: 20_225, text: '卷边了，' },
  { startMs: 20_225, endMs: 21_650, text: '卷边就捞出来，' },
  { startMs: 23_250, endMs: 25_350, text: '沾上老板这个秘制香油啊，' },
  { startMs: 25_350, endMs: 26_500, text: '又脆又爆汁，' },
  { startMs: 27_450, endMs: 28_175, text: '哎呀，' },
  { startMs: 28_175, endMs: 29_150, text: '太香了，' },
  { startMs: 29_300, endMs: 31_550, text: '想听这个脆的有多脆的，' },
  { startMs: 31_550, endMs: 32_700, text: '评论区扣一。' },
]
const realLines = normalizeSubtitleSegments(REAL_ASR_SEGMENTS).map((cue) => cue.text)
assert.ok(realLines.length >= 8, '真机回归样本必须确实被切成多条字幕')

// ★★ 行首绝不能是标点 —— 旧实现正是在这里产出过「，我敢说不是动货」。
assert.ok(
  realLines.every((line) => !/^[，、。！？；：,.;:!?]/.test(line)),
  '★★ 行首绝不能是标点（旧实现产出过「，我敢说不是动货」）',
)

// ★★ 「断行不得落在词中间」。**不能**用 `join('')` 去查子串来验这条 —— 劈开再拼回去
//    照样相等，那种写法对这个问题是**假绿**。必须检查**每一对相邻行的接缝**：
//    接缝两侧的字如果正好是一个词，就说明这个词被劈开了。
const seamPairs = realLines.slice(1).map((line, index) => {
  const previous = [...(realLines[index] ?? '')]
  return `${previous[previous.length - 1] ?? ''}${[...line][0] ?? ''}`
})
for (const word of ['千万', '香油', '七上', '八下', '火锅', '划走', '部分', '评论', '牛肚']) {
  assert.ok(
    !seamPairs.includes(word),
    `★★ 断行不得把词劈开：${word}（用户原话「最后一个字跑到下一行字幕的第一个字了」）`,
  )
}

assert.ok(
  realLines.every((line) => subtitleDisplayWidth(line) <= SUBTITLE_MAX_WIDTH),
  '★ 每行都必须在竖屏安全宽度内',
)
// ★★ 「不要剩残句」：末行也要够长（旧实现里末行常常只有 2~3 个字，一闪而过）。
assert.ok(
  realLines.every((line) => subtitleDisplayWidth(line) >= SUBTITLE_MIN_TAIL_WIDTH),
  '★★ 不得留残句：每行宽度不得低于 SUBTITLE_MIN_TAIL_WIDTH',
)
// ★★ 「还是 8 个字不是 10 个字」：必须真的出现「填满 10 字」的行。
//    旧实现按 总宽/n 均分 ⇒ 常见单元（17~25 字）算出来每行 7~9 字，一行都填不满。
assert.ok(
  realLines.filter((line) => subtitleDisplayWidth(line) >= SUBTITLE_MAX_WIDTH).length >= 3,
  '★★ 必须出现多行「填满 10 字」—— 旧实现按 总宽/n 均分，一行都填不满',
)
// ★★ 字数 × 字号 ＋ 描边 必须留在画布内。`WrapStyle: 2` 不自动折行 ⇒ 超了不会被折到第二行，
//    只会把两头的字裁掉（静默、且只在成片里看得见）。
assert.ok(
  SUBTITLE_MAX_WIDTH * SUBTITLE_FONT_SIZE + 2 * SUBTITLE_OUTLINE <= 1080,
  '★★ 字幕块像素宽 ＋ 描边不得超过 1080 画布（超了不会折行，只会被裁边）',
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
  new RegExp(`,1,${SUBTITLE_OUTLINE},0,2,${SUBTITLE_SIDE_MARGIN},${SUBTITLE_SIDE_MARGIN},${SUBTITLE_BOTTOM_MARGIN},1`, 'm'),
  'ASS 样式里的描边、左右边距与底边距必须由常量拼出，不能写死',
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
