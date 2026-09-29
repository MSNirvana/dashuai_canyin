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
  buildDrawtextFilterChain,
  fitShotDurationsToTimeline,
  normalizeSubtitleSegments,
  mergeSubtitleSegments,
  segmentsToAss,
  shouldExtendForNarration,
  splitSubtitleText,
  subtitleDisplayWidth,
  SUBTITLE_BOTTOM_MARGIN,
  SUBTITLE_CAPTION_SVG_HEIGHT,
  SUBTITLE_FONT_SIZE,
  SUBTITLE_MAX_WIDTH,
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
const noNewline = (value: string) => value.replace(/\n/g, '')
const SUBTITLE_SAMPLE = '第一句话完整显示。第二句话也要单独出现，而且这一句很长不能超出屏幕。'
const subtitleChunks = splitSubtitleText(SUBTITLE_SAMPLE)
assert.ok(subtitleChunks.length >= 3, '这段文案必须被切成多条字幕')

// ★★ 2026-09-29 用户把口径换成「**去除标点符号**」（旧要求是「行内要有、只去末尾」）：
//    必须**正面**断言整条字幕不含任何标点。只断言「末尾没有标点」会漏掉
//    「只去末尾、行内逗号还在」那种实现 —— 旧实现正是如此，成片里就是「香料，香脆脆的」。
assert.ok(
  subtitleChunks.every((text) => stripAllPunctuation(noNewline(text)) === noNewline(text)),
  '★★ 整条字幕不得含任何标点（用户 2026-09-29：「去除标点符号」）',
)

// ★★ 「一句一屏 + 超长同屏两行」：一屏最多两行，且**必须真的出现过**两行 ——
//    只断言「最多两行」会被「永远只输出一行」这种退化实现骗过。
assert.ok(
  subtitleChunks.every((text) => text.split('\n').length <= 2),
  '★★ 一屏最多两行（用户：「如果超过12个字，则一句两行」）',
)
assert.ok(
  subtitleChunks.some((text) => text.includes('\n')),
  '★★ 超长的子句必须真的折成**同屏**两行，而不是被切成两屏',
)
assert.ok(
  subtitleChunks.every((text) =>
    text.split('\n').every((line) => subtitleDisplayWidth(line) <= SUBTITLE_MAX_WIDTH),
  ),
  '每条字幕的**每一行**都必须在竖屏安全宽度内',
)
assert.equal(
  stripAllPunctuation(noNewline(subtitleChunks.join(''))),
  stripAllPunctuation(SUBTITLE_SAMPLE),
  '★★ 切分不得丢字、不得重复（标点不计）—— 比「等于某个写死的数组」耐用得多',
)
// ★★ 「一句话要完整」：整句不超宽时必须原样一行、不得被切。
assert.deepEqual(splitSubtitleText('这句话本身就很完整'), ['这句话本身就很完整'], '★ 整句不超宽时不得被切分')
// ★★ 「每行 10 个字」：刚好 10 字放得下；11 字折成**同一屏的两行**（旧实现切成两屏）。
assert.deepEqual(splitSubtitleText('一二三四五六七八九十'), ['一二三四五六七八九十'], '10 个字必须能放下一行')
const elevenChars = splitSubtitleText('一二三四五六七八九十一')
assert.equal(elevenChars.length, 1, '11 个字必须留在**同一屏**（旧实现会切成两屏）')
assert.ok(elevenChars[0]!.includes('\n'), '11 个字必须用同屏两行表示')
assert.ok(
  elevenChars[0]!.split('\n').every((line) => subtitleDisplayWidth(line) <= SUBTITLE_MAX_WIDTH),
  '11 个字折出的两行各自不得超宽',
)
// ★★ 「标点即句界」：逗号处必须断开成两屏 —— 用户 2026-09-29 拍板的粒度。
//    「土豆是切块炸的，火候」这种「完整子句 ＋ 下一子句头两个字」正是旧实现按宽度装箱的产物。
assert.deepEqual(
  splitSubtitleText('土豆是切块炸的，火候要小'),
  ['土豆是切块炸的', '火候要小'],
  '★★ 逗号必须断句（用户：「禁止两句话同时出现」）',
)
assert.deepEqual(splitSubtitleText('香料，香脆脆的'), ['香料', '香脆脆的'], '★ 用户截图里的那句必须断成两屏')

// ★★ 「空白不得显形在字幕上」—— 2026-09-29 真机转录实测出来的缺陷：
//    源文本里的空格（ASR 转写会在数字/字母两侧塞空格，口播文案也可能带）旧版会被
//    `SUBTITLE_PUNCT_ONLY` 当成标点**粘到前一个词的尾巴**上，后果是两个：
//      ① 成片字幕上真的多了一个空格：`廊坊想吃火锅的千万\N别 划走这盘牛肚`；
//      ② 那个原子按 `1 + 0.55 = 1.55` 字算宽，把本该在行尾的「千万别」挤到下一行
//         ⇒ 第一行只剩 **9 个字**（用户要的是 10 个字）。
//    判据不是「无脑丢空格」：CJK 相邻的丢，两侧都是 ASCII 的保留（那是有意义的文本）。
assert.deepEqual(
  splitSubtitleText('廊坊想吃火锅的千万别 划走这盘牛肚'),
  ['廊坊想吃火锅的千万别\n划走这盘牛肚'],
  '★★ CJK 相邻的空格必须丢掉：既不显形、也不占行宽（旧版第一行只有 9 个字）',
)
assert.deepEqual(splitSubtitleText('128 元一份'), ['128元一份'], '★ 数字与汉字之间的空格同样是噪声')
assert.deepEqual(splitSubtitleText('iPhone 15'), ['iPhone 15'], '★ 两侧都是 ASCII 时空格有意义，必须保留')
// ASCII 空格是**粘在前一个词尾巴**上的 ⇒ 断行正好落在它之后就成 `iPhone 15 `（行末空格）。
// 出口逐行 trim 是这条的唯一防线。
for (const text of ['iPhone 15 Pro 128 GB', '廊坊想吃火锅的千万别 划走这盘牛肚']) {
  for (const cue of splitSubtitleText(text)) {
    for (const line of cue.split('\n')) {
      assert.equal(line, line.trim(), `★★ 每一行都不许以空格开头/结尾：${JSON.stringify(line)}`)
      assert.ok(!/[\u4e00-\u9fff]\s|\s[\u4e00-\u9fff]/.test(line), `★★ 汉字旁的空白必须已被清掉：${JSON.stringify(line)}`)
    }
  }
}

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
const realCues = normalizeSubtitleSegments(REAL_ASR_SEGMENTS).map((cue) => cue.text)
assert.ok(realCues.length >= 8, '真机回归样本必须确实被切成多条字幕')

// ★★ 2026-09-29：「一句两行」用 `\n` 表示 ⇒ 先展开成**视觉行**再做几何断言。
const realLines = realCues.flatMap((text) => text.split('\n'))

// ★★ 行首绝不能是标点 —— 旧实现正是在这里产出过「，我敢说不是动货」。
//    新实现整条字幕不含标点 ⇒ 这条断言变得**更强**（任何位置都没有标点）。
assert.ok(
  realLines.every((line) => !/[，、。！？；：,.;:!?]/.test(line)),
  '★★ 字幕不得含任何标点（旧实现产出过「，我敢说不是动货」「香料，香脆脆的」）',
)
// ★★ 真机样本全是中文，任何一处空白都是缺陷 ⇒ 逐行断言（比「整体不合规」好定位）。
assert.ok(
  realLines.every((line) => !/\s/.test(line)),
  '★★ 字幕里不得出现任何空白字符（空白既不显形、也不该占行宽）',
)

// ★★ 「禁止两句话同时出现」的**结构性**判据：每个 cue 必须整体落在**同一个子句**里。
//    做法：把原文按标点切成子句，任何 cue 都必须能被某个子句包含 ——
//    跨子句拼出来的 cue（旧的「土豆是切块炸的，火候」）在这个判据下必然失败。
const realClauses = REAL_ASR_SEGMENTS
  .map((segment) => segment.text)
  .join('')
  .split(/[。．，、；：！？…⋯·!?～~]+/u)
  .map((clause) => clause.replace(/\s+/g, ''))
  .filter(Boolean)
assert.ok(
  realCues.every((cue) => realClauses.some((clause) => clause.includes(noNewline(cue)))),
  '★★ 每个 cue 必须整体落在同一个子句内（跨子句＝「两句话同时出现」）',
)

// ★★ 「断行不得落在词中间」。**不能**用 `join('')` 去查子串来验这条 —— 劈开再拼回去
//    照样相等，那种写法对这个问题是**假绿**。必须检查**每一对相邻行的接缝**：
//    接缝两侧的字如果正好是一个词，就说明这个词被劈开了。
//    ⚠ 2026-09-29：接缝只能取**同一屏内**的（同屏两行之间）。跨屏的接缝不算 ——
//      那是「断句」不是「断行」，两个句子本来就不该连读。
const seams: string[] = []
for (const cue of realCues) {
  const lines = cue.split('\n')
  for (let index = 1; index < lines.length; index += 1) {
    const previous = [...(lines[index - 1] ?? '')]
    seams.push(`${previous[previous.length - 1] ?? ''}${[...(lines[index] ?? '')][0] ?? ''}`)
  }
}
for (const word of ['千万', '香油', '七上', '八下', '火锅', '划走', '部分', '评论', '牛肚']) {
  assert.ok(
    !seams.includes(word),
    `★★ 断行不得把词劈开：${word}（用户原话「最后一个字跑到下一行字幕的第一个字了」）`,
  )
}

// ★★ 「合并连续语流」不得把句界吃掉 —— 2026-09-29 复核探针里那条 `6小时到店0°锁鲜` 时确认：
//    `mergeSubtitleSegments` 会把「6小时到店，」「0°锁鲜，」合成一份文本（无句末标点 +
//    间隔 150ms），但合并**只拼不改**、逗号仍留在文本里 ⇒ 下游照样断成两屏。
//    这条断言就是钉住「合并不会让逗号断句失效」—— 少了它，将来谁把合并改成「顺便清标点」
//    （或把 `splitSubtitleText` 挪到合并之前）就会静默退化成「两句话同屏」。
assert.deepEqual(
  normalizeSubtitleSegments([
    { startMs: 8_000, endMs: 9_350, text: '6小时到店，' },
    { startMs: 9_500, endMs: 10_650, text: '0°锁鲜，' },
  ]).map((cue) => cue.text),
  ['6小时到店', '0°锁鲜'],
  '★★ 合并连续语流之后逗号仍是句界（合并只拼不改，不得吃掉标点）',
)

assert.ok(
  realLines.every((line) => subtitleDisplayWidth(line) <= SUBTITLE_MAX_WIDTH),
  '★ 每一行都必须在竖屏安全宽度内',
)
// ★★ 「一句两行」的上界：一屏最多两行，且一屏总宽不超过两行的上限。
assert.ok(realCues.every((cue) => cue.split('\n').length <= 2), '★★ 一屏最多两行')
assert.ok(
  realCues.every((cue) => subtitleDisplayWidth(cue) <= SUBTITLE_MAX_WIDTH * 2),
  '★ 一屏总宽度不得超过两行的上限',
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
// ★★ 2026-09-29：断言从「必须单行」改成「**最多两行**」——
//    `\N` 现在是「一句两行」唯一的写法（`WrapStyle: 2` 不会自动折行）。
//    ⚠ 但不能因此放开宽度：换出来的**每一行**仍必须落在安全宽度内，
//      否则就成了「靠折行绕过画布限制」，字照样被裁。
const assDialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'))
assert.ok(assDialogues.length > 0, 'ASS 必须真的产出 Dialogue 行')
assert.ok(
  assDialogues.every((line) => line.split('\\N').length <= 2),
  '★ ASS 一屏最多两行（不含 \\N 时＝单行）',
)
assert.ok(
  assDialogues.every((line) => {
    const text = line.slice(line.lastIndexOf(',,') + 2)
    return text.split('\\N').every((row) => subtitleDisplayWidth(row) <= SUBTITLE_MAX_WIDTH)
  }),
  '★ ASS 的每一行都必须在安全宽度内（换行不得用来绕过画布限制）',
)
// ★★ 放大字号最容易漏、而且**不会报错**的一处：Sharp 回退路径的 SVG 画布尺寸。
//    画布不够高 ⇒ 字形被 sharp 裁掉，成片里只是「字少了半个」，日志里什么都没有。
const captionSvg = buildCaptionSvg('测试字幕', 'Noto Sans CJK SC')
assert.match(captionSvg, new RegExp(`height="${SUBTITLE_CAPTION_SVG_HEIGHT}"`), 'SVG 画布高度必须由字号推导')
assert.ok(SUBTITLE_CAPTION_SVG_HEIGHT >= SUBTITLE_FONT_SIZE, '★★ SVG 画布必须装得下字号，否则字形被裁')
// ★★ 2026-09-29：两行时必须把画布高度**翻倍** —— 只加 `<text>` 却不改 height，
//    第二行会被画布裁掉（同样不报错，成片里只是少了一行字）。
const captionSvgTwoRows = buildCaptionSvg('第一行\n第二行', 'Noto Sans CJK SC')
assert.match(
  captionSvgTwoRows,
  new RegExp(`height="${SUBTITLE_CAPTION_SVG_HEIGHT * 2}"`),
  '★★ 同屏两行时 SVG 画布高度必须翻倍，否则第二行被裁',
)
assert.equal((captionSvgTwoRows.match(/<text /g) ?? []).length, 2, '★ 两行必须真的画两个 <text>')
// ★★ drawtext 回退路径（**只有 libass 不可用时才启用**）：「一句两行」必须真的是
//    **两个 drawtext 串联**、且第二行往上挪一个行高。这段逻辑原先埋在 `muxWithDrawtext`
//    里 —— 不真跑一次 ffmpeg 就永远走不到，等于**从没被验证过**；而它写错是静默的
//    （两行粘成一行 / 第二行压在第一行上），只有成片里看得见。
const twoRowChain = buildDrawtextFilterChain([{ startMs: 1_000, endMs: 3_000, text: '第一行\n第二行' }], '/tmp/font.ttf')
assert.equal(twoRowChain.filters.length, 2, '★★ 两行字幕必须产出两个 drawtext（一个 drawtext 装不下两行）')
assert.match(twoRowChain.filters[0]!, /^\[0:v\]drawtext=/, '★ 第一个 drawtext 必须从视频流入口接起')
assert.match(twoRowChain.filters[1]!, /^\[dt0_0\]drawtext=/, '★ 第二个 drawtext 必须串在第一个之后')
assert.ok(
  twoRowChain.filters.every((filter) => !filter.includes('\n')),
  '★★ 滤镜串里不得出现裸换行 —— 它要过 shell 与 filtergraph 两层转义，写错了不报错、只会粘成一行',
)
const drawtextY = (filter: string): number => Number(/y=h-text_h-(\d+)/.exec(filter)?.[1] ?? Number.NaN)
assert.equal(
  drawtextY(twoRowChain.filters[1]!) - drawtextY(twoRowChain.filters[0]!),
  Math.round(SUBTITLE_FONT_SIZE * 1.25),
  '★ 第二行必须比第一行**高一个行高**（否则两行重叠）',
)
assert.equal(twoRowChain.lastNode, 'dt0_1', '★ 末端节点名要交给 `null[v]` 收口')
assert.equal(
  buildDrawtextFilterChain([{ startMs: 0, endMs: 1_000, text: '只有一行' }], '/tmp/font.ttf').filters.length,
  1,
  '★ 单行字幕仍然只画一个 drawtext',
)
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
