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

// ★★ 「一句一行 · 超长连播」：**每一条字幕只占一行**，长句拆成**先后紧接的多条**。
//    ⚠ 2026-09-29 用户**第二次更正**：第一版按「同屏两行」做（用 `\n`），用户看过成片后说
//      「我说的一句话是逗号就算分割了，直接就跳下一个字幕了，**而不是分成两行**」。
//      ⇒ 断言口径从「一屏最多两行」改成「**每条只有一行**」。
//    ★ 必须**正面**断言「不含 `\n`」，而不是只查「行数 ≤ 1」：后者会被
//      「`\n` 后接空串」这类畸形输出骗过，而成片里那是一次行高的跳变。
assert.ok(
  subtitleChunks.every((text) => !text.includes('\n')),
  '★★ 每条字幕只占一行（用户：「而不是分成两行」）—— 主路径不得再产出 \\n',
)
assert.ok(
  subtitleChunks.every((text) => subtitleDisplayWidth(text) <= SUBTITLE_MAX_WIDTH),
  '每条字幕都必须在竖屏安全宽度内',
)
assert.equal(
  stripAllPunctuation(noNewline(subtitleChunks.join(''))),
  stripAllPunctuation(SUBTITLE_SAMPLE),
  '★★ 切分不得丢字、不得重复（标点不计）—— 比「等于某个写死的数组」耐用得多',
)
// ★★ 「一句话要完整」：整句不超宽时必须原样一行、不得被切。
assert.deepEqual(splitSubtitleText('这句话本身就很完整'), ['这句话本身就很完整'], '★ 整句不超宽时不得被切分')
// ★★ 「每行 10 个字」：刚好 10 字放得下；11 字拆成**两条连播**（每条仍只有一行）。
assert.deepEqual(splitSubtitleText('一二三四五六七八九十'), ['一二三四五六七八九十'], '10 个字必须能放下一行')
const elevenChars = splitSubtitleText('一二三四五六七八九十一')
assert.equal(elevenChars.length, 2, '★★ 11 个字必须拆成**两条**（用户：「而不是分成两行」）')
assert.ok(elevenChars.every((text) => !text.includes('\n')), '★★ 拆出的每一条都必须是一行，不得含 \\n')
assert.ok(
  elevenChars.every((text) => subtitleDisplayWidth(text) <= SUBTITLE_MAX_WIDTH),
  '11 个字拆出的每一条都不得超宽',
)
assert.equal(elevenChars.join(''), '一二三四五六七八九十一', '★ 拆条不得丢字、不得重字')
// ★★ 「标点即句界」：逗号处必须断开成两条 —— 用户 2026-09-29 拍板的粒度。
//    「土豆是切块炸的，火候」这种「完整子句 ＋ 下一子句头两个字」正是旧实现按宽度装箱的产物。
assert.deepEqual(
  splitSubtitleText('土豆是切块炸的，火候要小'),
  ['土豆是切块炸的', '火候要小'],
  '★★ 逗号必须断句（用户：「禁止两句话同时出现」）',
)
assert.deepEqual(splitSubtitleText('香料，香脆脆的'), ['香料', '香脆脆的'], '★ 用户截图里的那句必须断成两条')

// ★★ 「空白不得显形在字幕上」—— 2026-09-29 真机转录实测出来的缺陷：
//    源文本里的空格（ASR 转写会在数字/字母两侧塞空格，口播文案也可能带）旧版会被
//    `SUBTITLE_PUNCT_ONLY` 当成标点**粘到前一个词的尾巴**上，后果是两个：
//      ① 成片字幕上真的多了一个空格：`廊坊想吃火锅的千万\N别 划走这盘牛肚`；
//      ② 那个原子按 `1 + 0.55 = 1.55` 字算宽，把本该在行尾的「千万别」挤到下一行
//         ⇒ 第一行只剩 **9 个字**（用户要的是 10 个字）。
//    判据不是「无脑丢空格」：CJK 相邻的丢，两侧都是 ASCII 的保留（那是有意义的文本）。
assert.deepEqual(
  splitSubtitleText('廊坊想吃火锅的千万别 划走这盘牛肚'),
  ['廊坊想吃火锅的千万别', '划走这盘牛肚'],
  '★★ CJK 相邻的空格必须丢掉：既不显形、也不占行宽（旧版第一行只有 9 个字）；且拆成两条单行连播',
)
assert.deepEqual(splitSubtitleText('128 元一份'), ['128元一份'], '★ 数字与汉字之间的空格同样是噪声')
assert.deepEqual(splitSubtitleText('iPhone 15'), ['iPhone 15'], '★ 两侧都是 ASCII 时空格有意义，必须保留')
// ASCII 空格是**粘在前一个词尾巴**上的 ⇒ 断行正好落在它之后就成 `iPhone 15 `（行末空格）。
// 出口逐条 trim 是这条的唯一防线。
for (const text of ['iPhone 15 Pro 128 GB', '廊坊想吃火锅的千万别 划走这盘牛肚']) {
  for (const cue of splitSubtitleText(text)) {
    assert.equal(cue, cue.trim(), `★★ 每一条都不许以空格开头/结尾：${JSON.stringify(cue)}`)
    assert.ok(!/[\u4e00-\u9fff]\s|\s[\u4e00-\u9fff]/.test(cue), `★★ 汉字旁的空白必须已被清掉：${JSON.stringify(cue)}`)
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

// ★★ 2026-09-29 第二版：主路径不再产出 `\n`（每条只有一行）⇒ `realLines` 与 `realCues`
//    一一对应。仍保留 `flatMap` 展开：这是**结构性**写法 —— 将来万一又有哪条路径产出多行，
//    也能照样被下面的几何断言覆盖，不会出现「多行绕过宽度检查」。
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
//    照样相等，那种写法对这个问题是**假绿**。必须检查**每一对相邻条的接缝**：
//    接缝两侧的字如果正好是一个词，就说明这个词被劈开了。
//    ⚠ 2026-09-29 第二版：主路径改成「长句拆成先后紧接的多条」⇒ 劈词风险从「同屏两行之间」
//      搬到了**同一个子句拆出的相邻两条之间**。跨子句的接缝不算 —— 那是「断句」不是「断行」，
//      两句话本来就不该连读（`别划` 这类假阳性正是从这里来的）。
//    做法：给每个 cue 标出它所属的子句下标，只拼接**同子句**的相邻条。
const cueClause = realCues.map((cue) => realClauses.findIndex((clause) => clause.includes(noNewline(cue))))
const seams: string[] = []
for (let index = 1; index < realCues.length; index += 1) {
  if (cueClause[index] === undefined || cueClause[index] !== cueClause[index - 1]) continue
  const previous = [...(realCues[index - 1] ?? '')]
  seams.push(`${previous[previous.length - 1] ?? ''}${[...(realCues[index] ?? '')][0] ?? ''}`)
}
for (const word of ['千万', '香油', '七上', '八下', '火锅', '划走', '部分', '评论', '牛肚']) {
  assert.ok(
    !seams.includes(word),
    `★★ 断行不得把词劈开：${word}（用户原话「最后一个字跑到下一行字幕的第一个字了」）`,
  )
}

// ★★ 2026-09-29 第三版：**末行过短 ⇒ 整个子句重新均分**（不再从上一行搬词）。
//    走过两条弯路，下面这组样本把它们各自的失败形态都钉住：
//      ① 初版「搬词补短」：搬的单位是**分词原子**，而 ICU 的原子 ≠ 词 ——
//         它把 `秘制` 切成 `秘`|`制`，于是搬走 1 个字的碎片
//         ⇒ 成片出过 `蘸上老板这个秘` / `制香油啊`（**劈词**）。
//      ② 次版加闸门「1 个字的原子不许搬」：`秘制` 是修好了，却**踩坏另一类** ——
//         末行只剩 `一口` 时本该把 `第` 搬下去拼回 `第一口`，闸门一挡就成
//         `来大帅火锅旗舰店试第` / `一口`（**劈词 ＋ 末条只剩 2 字宽**，两个问题一起来）。
//    ⇒ 根本矛盾：「这个 1 字碎片该不该搬」在宽度与原子粒度上**完全无法区分**（两种场景同形）。
//      正解是不再逐个搬，而是把**整个子句**按 `总量 / 行数` 在**词边界**上重新均分。
//    ⚠ 判据取 `秘制` 而不是 `制香`：正确输出的接缝本来就可能出现 `制香`
//      （`制` 是「秘制」的尾、`香` 是「香油」的头，本就是两个词）—— 拿它当判据会**假红**。
const seamOf = (pieces: string[]): string[] =>
  pieces.slice(1).map((text, index) => {
    const previous = [...(pieces[index] ?? '')]
    return `${previous[previous.length - 1] ?? ''}${[...text][0] ?? ''}`
  })
const REBALANCE_CASES: ReadonlyArray<readonly [string, readonly string[], string]> = [
  ['蘸上老板这个秘制香油啊', ['蘸上老板这个', '秘制香油啊'], '秘制'],
  ['沾上老板这个秘制香油啊', ['沾上老板这个', '秘制香油啊'], '秘制'],
  ['来大帅火锅旗舰店试第一口', ['来大帅火锅旗舰店', '试第一口'], '试第'],
]
for (const [clause, expected, forbiddenSeam] of REBALANCE_CASES) {
  const pieces = splitSubtitleText(clause)
  assert.deepEqual(pieces, [...expected], `★★ 末行过短必须重新均分：${clause}`)
  assert.equal(pieces.join(''), clause, '★ 拆条不得丢字、不得重字')
  assert.ok(pieces.every((text) => !text.includes('\n')), '★ 拆出的每一条都必须是一行')
  assert.ok(
    pieces.every((text) => subtitleDisplayWidth(text) <= SUBTITLE_MAX_WIDTH),
    '★ 重排后的每一条都不得超宽',
  )
  assert.ok(
    !seamOf(pieces).includes(forbiddenSeam),
    `★★ 不得把词劈在接缝上：${forbiddenSeam}（实得 ${JSON.stringify(pieces)}）`,
  )
}
// ★ 反向：**不能**把「末行过短才重排」扩大成「一律均分」——
//   用户 09-25 明确要过「每行尽量填满」，24 字那种 `10+10+4`（末行 4 ≥ 阈值）必须原样不动。
assert.deepEqual(
  splitSubtitleText('廊坊想吃火锅的千万别划走这盘牛肚'),
  ['廊坊想吃火锅的千万别', '划走这盘牛肚'],
  '★ 末行够长时**不得**重排：仍要填满 10 字（用户 09-25 的口径）',
)

// ★★ 「合并连续语流」不得把句界吃掉 —— 2026-09-29 复核探针里那条 `6小时到店0°锁鲜` 时确认：
//    `mergeSubtitleSegments` 会把「6小时到店，」「0°锁鲜，」合成一份文本（无句末标点 +
//    间隔 150ms），但合并**只拼不改**、逗号仍留在文本里 ⇒ 下游照样断成两条。
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
// ★★ 「每条只有一行」：主路径不得再产出 `\n`（用户第二次更正：「而不是分成两行」）。
assert.ok(
  realCues.every((cue) => !cue.includes('\n')),
  '★★ 真机样本的每一条字幕都必须是一行（不得含 \\n）',
)
assert.ok(
  realCues.every((cue) => subtitleDisplayWidth(cue) <= SUBTITLE_MAX_WIDTH),
  '★ 每一条的宽度都不得超过单行上限',
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
// ★★ 2026-09-29 第二版：断言从「最多两行（`\N`）」改回「**每条都不含 `\N`**」——
//    主路径改成「长句连播多条单行」之后，ASS 里不该再出现任何 `\N`。
//    ★ 宽度断言保留，但改成对**整条**：防止有人靠「用 `\N` 折行」绕过画布限制 ——
//      那样每一行单看都没超，两行加起来却已经出画布。
const assDialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'))
assert.ok(assDialogues.length > 0, 'ASS 必须真的产出 Dialogue 行')
assert.ok(
  assDialogues.every((line) => !line.includes('\\N')),
  '★★ ASS 不得再产出 \\N（用户：「而不是分成两行」）—— 长句是连播多条，不是同屏两行',
)
assert.ok(
  assDialogues.every((line) => {
    const text = line.slice(line.lastIndexOf(',,') + 2)
    return subtitleDisplayWidth(text) <= SUBTITLE_MAX_WIDTH
  }),
  '★ ASS 的每一条都必须在安全宽度内',
)
// ★★ 放大字号最容易漏、而且**不会报错**的一处：Sharp 回退路径的 SVG 画布尺寸。
//    画布不够高 ⇒ 字形被 sharp 裁掉，成片里只是「字少了半个」，日志里什么都没有。
const captionSvg = buildCaptionSvg('测试字幕', 'Noto Sans CJK SC')
assert.match(captionSvg, new RegExp(`height="${SUBTITLE_CAPTION_SVG_HEIGHT}"`), 'SVG 画布高度必须由字号推导')
assert.ok(SUBTITLE_CAPTION_SVG_HEIGHT >= SUBTITLE_FONT_SIZE, '★★ SVG 画布必须装得下字号，否则字形被裁')
// ★★ 2026-09-29：`buildCaptionSvg` 仍**必须**支持两行（画布高度翻倍）—— 只加 `<text>` 却不改
//    height，第二行会被画布裁掉（同样不报错，成片里只是少了一行字）。
//    ⚠ 这是**兜底能力**的验证：主路径（`splitSubtitleText`）已改成逐条单行、不再产出 `\n`，
//      但历史字幕数据/外部输入里仍可能有 `\n`，这条路径就不能是坏的。
const captionSvgTwoRows = buildCaptionSvg('第一行\n第二行', 'Noto Sans CJK SC')
assert.match(
  captionSvgTwoRows,
  new RegExp(`height="${SUBTITLE_CAPTION_SVG_HEIGHT * 2}"`),
  '★★ 同屏两行时 SVG 画布高度必须翻倍，否则第二行被裁',
)
assert.equal((captionSvgTwoRows.match(/<text /g) ?? []).length, 2, '★ 两行必须真的画两个 <text>')
// ★★ drawtext 回退路径（**只有 libass 不可用时才启用**）：两行必须真的是
//    **两个 drawtext 串联**、且第二行往上挪一个行高。这段逻辑原先埋在 `muxWithDrawtext`
//    里 —— 不真跑一次 ffmpeg 就永远走不到，等于**从没被验证过**；而它写错是静默的
//    （两行粘成一行 / 第二行压在第一行上），只有成片里看得见。
//    ⚠ 与上面 SVG 同理：这是**兜底能力**，主路径已不产出 `\n`，但这条路径不能是坏的。
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
