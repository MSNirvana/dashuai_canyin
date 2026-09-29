/**
 * 「哪一段有人在说话 → 哪些区间该保留」的守护闸门。
 *
 * ★★ 为什么需要它（2026-09-29）：AI 剪辑不删废片。实测那条素材 19.48s 里 **11.06s 是空白**
 *   （头 1.55s、尾 0.76s、中间还有 4 处 1.65~2.95s 的大停顿），全部被原样保留进了成片。
 *   ⇒ 判据从「音量阈值」换成「词级时间戳」（详见 `src/render/speech-range.ts` 头部）。
 *
 * ★★ 这个脚本守的**不是**「剪得够狠」，而是**保守边界**：
 *   错误方向有两种，危害完全不同 ——
 *     · 剪少了：废片留着，用户看得到，还能反馈（＝本次要修的问题）
 *     · **剪多了：把纯环境音素材剪成空、把正常换气剪掉、把一句话从中间剁开**
 *       —— 这是**静默的生产事故**，出片成功、时长短了，但内容坏了
 *   所以下面②节全部在验「什么情况下必须**什么都不做**（返回 null）」。
 *
 * 六节：① 真实样本回归（线上那条素材的 25 个词，实测值）② 必须返回 null 的保守边界
 *      ③ 停顿聚合与 pad 合并 ④ 窗口夹取 ⑤ 补集（要删的区间）+ 素材分段
 *      ⑥ 落库计划的解析（版本 / 参数指纹 / 形状）
 *
 * 运行：cd server && npx tsx scripts/verify-speech-range.ts
 * ⚠ 纯函数、零 I/O ⇒ 不连库、不连 Redis、不调 ASR。别往这里加任何网络调用。
 */
import {
  cutRangesInWindow,
  isSentenceBoundary,
  parseShotSpeechPlan,
  sliceKeepRanges,
  speechKeepRanges,
  toSourceSegments,
  SHOT_SPEECH_VERSION,
  SPEECH_MIN_GAIN_MS,
  SPEECH_MIN_SENTENCE_CHARS,
  SPEECH_PAD_MS,
  SPEECH_PAUSE_MS,
  type SpeechWordSpan,
} from '../src/render/speech-range.js'

let pass = 0
let fail = 0

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  ok(label, Object.is(actual, expected), `期望 ${String(expected)}，实得 ${String(actual)}`)
}

function near(label: string, actual: number, expected: number): void {
  ok(label, Math.abs(actual - expected) < 1e-6, `期望 ${expected}，实得 ${actual}`)
}

/**
 * ★★ 真实样本：2026-09-29 在服务器用**线上真实 ASR 配置**（`16k_zh` + `WordInfo: 1`）
 *    对用户那条素材跑出来的词级时间戳，一个数都没改。
 *    ⚠ 改动 `speech-range.ts` 后这一段必须仍然成立 —— 它是「判据还认得出这条素材」的回归锚点。
 */
const REAL_WORDS: SpeechWordSpan[] = [
  { startMs: 1550, endMs: 2025, word: '你是' },
  { startMs: 2025, endMs: 2275, word: '哪里' },
  { startMs: 2275, endMs: 2550, word: '人' },
  { startMs: 5000, endMs: 5275, word: '咱' },
  { startMs: 5275, endMs: 5575, word: '固安' },
  { startMs: 5575, endMs: 5725, word: '的' },
  { startMs: 5725, endMs: 6300, word: '老乡' },
  { startMs: 6350, endMs: 6825, word: '在外' },
  { startMs: 6825, endMs: 7000, word: '头' },
  { startMs: 7000, endMs: 7225, word: '待' },
  { startMs: 7225, endMs: 7700, word: '久了' },
  { startMs: 9400, endMs: 9925, word: '是不是' },
  { startMs: 9925, endMs: 10125, word: '就' },
  { startMs: 10125, endMs: 10325, word: '馋' },
  { startMs: 10325, endMs: 10450, word: '那' },
  { startMs: 10450, endMs: 10800, word: '一口' },
  { startMs: 10800, endMs: 11400, word: '炖菜' },
  { startMs: 14350, endMs: 14675, word: '碗' },
  { startMs: 14675, endMs: 14975, word: '棒子' },
  { startMs: 14975, endMs: 15250, word: '面儿' },
  { startMs: 15250, endMs: 15600, word: '粥' },
  { startMs: 17250, endMs: 17725, word: '多久' },
  { startMs: 17725, endMs: 17875, word: '没' },
  { startMs: 17875, endMs: 18350, word: '吃着' },
  { startMs: 18350, endMs: 18650, word: '了' },
]
const REAL_DURATION_MS = 19411

// ── ① 真实样本回归 ──────────────────────────────────────────────────────────
console.log('\n① 真实样本回归（线上那条素材的 25 个词，实测值）')
{
  const plan = speechKeepRanges({ durationMs: REAL_DURATION_MS, words: REAL_WORDS })
  ok('能算出结果（不是 null）', plan !== null)
  if (plan) {
    eq('保留区间数 = 5 段', plan.ranges.length, 5)
    eq('★ 首词开口位置 = 1550ms（首部废片就是它）', plan.speechStartMs, 1550)
    eq('★ 末词收口位置 = 18650ms（尾部废片就是它之后）', plan.speechEndMs, 18650)
    eq('识别出 4 处内部长停顿', plan.pauses.length, 4)
    // 5 段各自前后扩 200ms pad：1350-2750 / 4800-7900 / 9200-11600 / 14150-15800 / 17050-18850
    eq('首段起点 = 1550 − 200(pad)', plan.ranges[0]!.startMs, 1350)
    eq('末段终点 = 18650 + 200(pad)', plan.ranges[plan.ranges.length - 1]!.endMs, 18850)
    eq('保留总时长 = 10350ms', plan.keptMs, 10350)
    eq('可剪总时长 = 9061ms', plan.cutMs, 9061)
    ok(
      '★ 剪掉接近一半（9061 / 19411 ≈ 47%）—— 用户看到的「卡顿」主要就在这些空白里',
      plan.cutMs / REAL_DURATION_MS > 0.4,
      `实得 ${(plan.cutMs / REAL_DURATION_MS).toFixed(3)}`,
    )
    ok(
      '每段都是正长度、升序、不重叠',
      plan.ranges.every((range, index) => {
        if (range.endMs <= range.startMs) return false
        const previous = plan.ranges[index - 1]
        return !previous || range.startMs >= previous.endMs
      }),
    )
    ok('4 处停顿的间隔与逐词实测一致', plan.pauses.every((pause) => {
      const gaps = [2450, 1700, 2950, 1650]
      return gaps.includes(pause.endMs - pause.startMs)
    }), JSON.stringify(plan.pauses.map((p) => p.endMs - p.startMs)))
  }
}

// ── ② 必须返回 null 的保守边界（这一节比①重要）──────────────────────────────
console.log('\n② 保守边界：以下每一种情况都必须「什么都不做」')
{
  const cases: Array<{ label: string; durationMs: number; words: SpeechWordSpan[]; why: string }> = [
    { label: '空词表', durationMs: 10_000, words: [], why: '没识别出词 ⇒ 不能剪' },
    {
      label: '★ 纯环境音素材（B-roll / 空镜，一个词都没有）',
      durationMs: 8000,
      words: [],
      why: '餐饮 B-roll 本来就没有人声，「没人说话」是它的正常状态',
    },
    {
      label: '★ 人声覆盖率过低（8s 里只说了 0.3s）',
      durationMs: 8000,
      words: [{ startMs: 4000, endMs: 4300, word: '呃' }],
      why: '像环境音里混进了一声人声 ⇒ 不能当口播素材处理',
    },
    {
      label: '词铺满整段（没有废片）',
      durationMs: 3000,
      words: [
        { startMs: 0, endMs: 1000 },
        { startMs: 1000, endMs: 2000 },
        { startMs: 2000, endMs: 3000 },
      ],
      why: '没有可剪的，返回 null 而不是「零收益的裁剪方案」',
    },
    {
      label: `收益小于下限（${SPEECH_MIN_GAIN_MS}ms）`,
      durationMs: 3000,
      words: [
        { startMs: 300, endMs: 1500 },
        { startMs: 1800, endMs: 2900 },
      ],
      why: '只省下 100ms ⇒ 不值得为它重构整条时间轴',
    },
  ]
  for (const item of cases) {
    const plan = speechKeepRanges({ durationMs: item.durationMs, words: item.words })
    ok(item.label, plan === null, `期望 null，实得 ${JSON.stringify(plan)}（${item.why}）`)
  }
}
{
  const plan = speechKeepRanges({ durationMs: 0, words: REAL_WORDS })
  eq('素材时长为 0 ⇒ null', plan, null)
  const bad = speechKeepRanges({
    durationMs: Number.NaN,
    words: REAL_WORDS,
  })
  eq('素材时长 NaN ⇒ null（NaN 会静默排出 0 帧轨道，比抛错更难查）', bad, null)
}
{
  // ★ 脏词表：ASR 偶尔给零长度词 / NaN。零长度词若被当成一个「锚点」留下，
  //   会在聚合阶段凭空造出一个 200ms 的头碎片段（pad 拉出来的），进而多切一刀。
  const plan = speechKeepRanges({
    durationMs: 3000,
    words: [
      { startMs: 0, endMs: 0, word: '零长度' } as SpeechWordSpan,
      { startMs: Number.NaN, endMs: 100, word: 'NaN' } as SpeechWordSpan,
      { startMs: 1200, endMs: 1700 },
      { startMs: 2200, endMs: 2700 },
    ],
  })
  ok('脏词被丢掉后仍能算出结果', plan !== null)
  eq('★ 零长度词没有制造出「头碎片段」', plan?.ranges[0]!.startMs, 1000)
  eq('  └ 正规段数 = 2（不是 3）', plan?.ranges.length, 2)
  ok(
    '所有区间都是正长度、升序、不重叠',
    (plan?.ranges ?? []).every((range, index) => {
      if (range.endMs <= range.startMs) return false
      const previous = plan!.ranges[index - 1]
      return !previous || range.startMs >= previous.endMs
    }),
  )
}

// ── ③ 停顿聚合与 pad 合并 ───────────────────────────────────────────────────
console.log('\n③ 停顿聚合（自然呼吸必须留、pad 造成的贴合段必须并回）')
{
  // 词间 300ms（<500）⇒ 视为同一段，只有首尾被剪
  const plan = speechKeepRanges({
    durationMs: 6000,
    words: [
      { startMs: 600, endMs: 1600 },
      { startMs: 1900, endMs: 2900 },
      { startMs: 3200, endMs: 4200 },
    ],
  })
  ok('300ms 的词间空白不断段（正常换气）', plan !== null && plan.ranges.length === 1, JSON.stringify(plan?.ranges))
  eq('  └ 只有首尾被剪：保留 [400, 4400) = 4000ms', plan?.keptMs, 4000)
  eq('  └ 首段起点 = 600 − 200', plan?.ranges[0]!.startMs, 400)
}
{
  // 520ms（>500）⇒ 断段；而 pad 两侧各 200ms 只有 400ms，填不满 520 的缝 ⇒ 仍是 2 段
  const plan = speechKeepRanges({
    durationMs: 6000,
    words: [
      { startMs: 1000, endMs: 2000 },
      { startMs: 2520, endMs: 3520 },
    ],
  })
  eq('520ms 停顿断成 2 段（pad 400ms 填不满 520 的缝）', plan?.ranges.length, 2)
  ok(
    '  └ 两段不重叠，且中间留出了 [2200, 2320) 的真实间隙',
    plan!.ranges[0]!.endMs <= plan!.ranges[1]!.startMs,
    JSON.stringify(plan?.ranges),
  )
}
{
  // ★ 停顿阈值 < 2×pad 时，pad 会把两段撑到贴合 ⇒ 必须并回一段，否则造出无意义的碎片段
  const plan = speechKeepRanges({
    durationMs: 6000,
    words: [
      { startMs: 1000, endMs: 2000 },
      { startMs: 2350, endMs: 3350 },
    ],
    options: { pauseMs: 300, padMs: 200 },
  })
  eq('停顿 350ms ≥ 阈值 300 ⇒ 断段，但 pad 撑到贴合 ⇒ 并回 1 段', plan?.ranges.length, 1)
  eq('  └ 并回后保留 [800, 3550) = 2750ms', plan?.keptMs, 2750)
}
{
  // pad = 0：切口紧贴词边界，验证 padMs 旋钮真的生效
  const plan = speechKeepRanges({
    durationMs: 6000,
    words: [
      { startMs: 1000, endMs: 2000 },
      { startMs: 4000, endMs: 5000 },
    ],
    options: { padMs: 0 },
  })
  eq('padMs=0 ⇒ 首段起点就是词起点', plan?.ranges[0]!.startMs, 1000)
  eq('padMs=0 ⇒ 断成 2 段', plan?.ranges.length, 2)
}
{
  // 阈值旋钮：把 pauseMs 提到 3000，那 2000ms 的停顿就不再算废片
  const words = [
    { startMs: 1000, endMs: 2000 },
    { startMs: 4000, endMs: 5000 },
  ]
  const strict = speechKeepRanges({ durationMs: 6000, words, options: { pauseMs: 1000 } })
  const loose = speechKeepRanges({ durationMs: 6000, words, options: { pauseMs: 3000 } })
  eq('pauseMs=1000 ⇒ 中间 2000ms 停顿被剪（2 段）', strict?.ranges.length, 2)
  eq('pauseMs=3000 ⇒ 同一处停顿不算废片（并回 1 段）', loose?.ranges.length, 1)
}
eq('默认句界阈值 = 300ms（用户 2026-09-29 拍板「判句更细、剪得更狠」）', SPEECH_PAUSE_MS, 300)
eq('默认 pad = 200ms', SPEECH_PAD_MS, 200)
eq('最短句长 = 4 字（字幕断句专用，剪废片不受它约束）', SPEECH_MIN_SENTENCE_CHARS, 4)
eq('落库版本 = 2（v1 那批 500ms 的结论必须作废重算）', SHOT_SPEECH_VERSION, 2)

/**
 * ★★ 「更狠」的**实测边界**（诚实记录，别把它说成大改）：
 *   把阈值 500 → 300，对线上那条真实素材**一点变化都没有** ——
 *   它的词间空白只有一处 50ms（其余全是 0），另加 4 处 1.65~2.95s 的大停顿；
 *   50 < 300 ⇒ 同样不算句界。真正的差别只会出现在「词间有 300~500ms 小停顿」的素材上。
 */
{
  const at500 = speechKeepRanges({ durationMs: REAL_DURATION_MS, words: REAL_WORDS, options: { pauseMs: 500 } })!
  const at300 = speechKeepRanges({ durationMs: REAL_DURATION_MS, words: REAL_WORDS })!
  eq('★ 500 → 300 在这条素材上段数不变（它本来就没有 300~500ms 的小停顿）', at300.ranges.length, at500.ranges.length)
  eq('  └ 剪掉时长也不变', at300.cutMs, at500.cutMs)
  eq('  └ 句子数报出来（= 保留区间数）', at300.sentenceCount, at300.ranges.length)
  const smallGap = [
    { startMs: 1000, endMs: 2000 },
    { startMs: 2450, endMs: 3450 },
  ]
  const strict = speechKeepRanges({ durationMs: 6000, words: smallGap, options: { pauseMs: 500 } })
  const loose = speechKeepRanges({ durationMs: 6000, words: smallGap })
  ok(
    '★ 而 300 确实更狠：词间 450ms 的小停顿，500 留着、300 剪掉',
    strict?.ranges.length === 1 && loose?.ranges.length === 2,
    `500⇒${strict?.ranges.length} 段、300⇒${loose?.ranges.length} 段`,
  )
}

// ── ③′ 句界判据（剪废片与字幕断句共用的**唯一**判据）──────────────────────────
console.log('\n③′ 句界判据 isSentenceBoundary（剪辑与字幕必须按同一个「句界」行事）')
{
  ok('句末标点无条件断：。', isSentenceBoundary({ char: '。' }))
  ok('句末标点无条件断：？', isSentenceBoundary({ char: '？' }))
  ok('句末标点无条件断：；', isSentenceBoundary({ char: '；' }))
  ok('★ 句末标点即使句很短也断（标点是比停顿更强的信号）', isSentenceBoundary({ char: '。', chars: 1 }))
  ok(
    '★★ 逗号**本身不构成**句界 —— 这正是「一串连贯的话被切成好几条短字幕」的根因',
    !isSentenceBoundary({ char: '，', gapMs: 50, chars: 20 }),
  )
  ok('  └ 顿号同理', !isSentenceBoundary({ char: '、', gapMs: 50, chars: 20 }))
  ok('  └ 冒号同理', !isSentenceBoundary({ char: '：', gapMs: 50, chars: 20 }))
  ok(
    '  └ 但逗号处若真有长停顿（≥ 阈值）照样断 —— 认的是**停顿**，不是标点',
    isSentenceBoundary({ char: '，', gapMs: 900, chars: 20 }),
  )
  ok('停顿够大且已攒够字 ⇒ 断', isSentenceBoundary({ gapMs: 300, chars: 8 }))
  ok('  └ 恰好等于阈值就断（边界含等）', isSentenceBoundary({ gapMs: 300, chars: 4 }))
  ok('停顿差 1ms 就不算', !isSentenceBoundary({ gapMs: 299, chars: 8 }))
  ok('★ 停顿够大但只攒了 3 个字 ⇒ 不断（防「好」「嗯」各占一条字幕）', !isSentenceBoundary({ gapMs: 2000, chars: 3 }))
  ok('攒够 4 个字就断', isSentenceBoundary({ gapMs: 2000, chars: 4 }))
  ok('阈值可覆盖：pauseMs=1000 时 300ms 不算句界', !isSentenceBoundary({ gapMs: 300, chars: 8, pauseMs: 1000 }))
  ok('最短句长可覆盖', isSentenceBoundary({ gapMs: 300, chars: 2, minChars: 2 }))
  ok('全空入参 ⇒ 不断（判据不凭空制造句界）', !isSentenceBoundary({}))
  ok('gapMs 是 NaN ⇒ 不断（脏数据不能拿来断句）', !isSentenceBoundary({ gapMs: Number.NaN, chars: 10 }))
}

// ── ④ 窗口夹取 ─────────────────────────────────────────────────────────────
console.log('\n④ 窗口夹取（语音区间不能越过上游已经选好的时间窗）')
{
  const plan = speechKeepRanges({ durationMs: REAL_DURATION_MS, words: REAL_WORDS })!
  const sliced = sliceKeepRanges(plan.ranges, 4000, 12_000)
  ok('夹到 [4000, 12000) 后所有区间都在窗内', sliced.every((r) => r.startMs >= 4000 && r.endMs <= 12_000), JSON.stringify(sliced))
  eq('窗内应剩 2 段（4800-7900 / 9200-11600）', sliced.length, 2)
  eq('  └ 首段被窗裁掉左边', sliced[0]!.startMs, 4800)
}
{
  const plan = speechKeepRanges({ durationMs: REAL_DURATION_MS, words: REAL_WORDS })!
  // 窗口整个落在废片里（2750~4800 是停顿）⇒ 夹完为空，调用方必须处理
  const empty = sliceKeepRanges(plan.ranges, 2900, 4700)
  eq('窗口整段落在废片里 ⇒ 空数组（调用方必须处理，不能当「保留 0 帧」）', empty.length, 0)
}
{
  const plan = speechKeepRanges({ durationMs: REAL_DURATION_MS, words: REAL_WORDS })!
  const cut = cutRangesInWindow(plan.ranges, 0, REAL_DURATION_MS)
  eq('全窗口补集 = 6 段（头 + 4 处停顿 + 尾）', cut.length, 6)
  eq('  └ 首段补集 [0, 1350)', cut[0]!.startMs, 0)
  eq('  └ 首段补集右端', cut[0]!.endMs, 1350)
  eq('  └ 尾段补集右端 = 素材时长', cut[cut.length - 1]!.endMs, REAL_DURATION_MS)
  const total = cut.reduce((sum, range) => sum + (range.endMs - range.startMs), 0)
  eq('★ 补集总时长 === cutMs（两边必须自洽）', total, plan.cutMs)
}
{
  const plan = speechKeepRanges({ durationMs: REAL_DURATION_MS, words: REAL_WORDS })!
  const sliced = sliceKeepRanges(plan.ranges, 4000, 12_000)
  const cut = cutRangesInWindow(sliced, 4000, 12_000)
  eq('★ 窗口内补集坐标是**相对窗口**的（本地 ffmpeg 先裁窗口再挖洞）', cut[0]!.startMs, 0)
  eq('  └ 第一段要删的是窗口头 [0, 800)', cut[0]!.endMs, 4800 - 4000)
  const windowMs = 12_000 - 4000
  const kept = sliced.reduce((sum, range) => sum + (range.endMs - range.startMs), 0)
  const cutMs = cut.reduce((sum, range) => sum + (range.endMs - range.startMs), 0)
  eq('★ 窗口内「保留 + 删除」必须正好等于窗口长度（不能凭空多/少时间）', kept + cutMs, windowMs)
}

// ── ⑤ 素材分段（ChatCut 排轨用）─────────────────────────────────────────────
console.log('\n⑤ 素材分段（ChatCut 的 clip 是单区间 ⇒ 一段素材要排 N 条 adds）')
{
  const plan = speechKeepRanges({ durationMs: REAL_DURATION_MS, words: REAL_WORDS })!
  const segments = toSourceSegments(plan.ranges)
  eq('5 段保留区间 ⇒ 5 条素材分段', segments.length, 5)
  eq('  └ 首段素材起点 = 1350ms', segments[0]!.sourceStartMs, 1350)
  eq('  └ 首段时长 = 1400ms', segments[0]!.durationMs, 1400)
  const total = segments.reduce((sum, segment) => sum + segment.durationMs, 0)
  eq('★ 分段时长之和 === keptMs', total, plan.keptMs)
  ok(
    '每条分段都在素材范围内（否则 ChatCut 判 Source range exceeds video asset duration）',
    segments.every((segment) => segment.sourceStartMs + segment.durationMs <= REAL_DURATION_MS),
  )
  eq('碎片段（<100ms）被丢掉', toSourceSegments([{ startMs: 0, endMs: 60 }, { startMs: 200, endMs: 900 }]).length, 1)
}

// ── ⑥ 落库计划的解析（拿旧结论之前必须先验一遍）────────────────────────────
console.log('\n⑥ 落库计划解析（版本 / 参数指纹 / 形状，任一条不符都必须重算）')
{
  const options = { pauseMs: 500, padMs: 200, minGainMs: 400, minSpeechRatio: 0.12 }
  const good = {
    v: SHOT_SPEECH_VERSION,
    ranges: [{ startMs: 1350, endMs: 2750 }, { startMs: 4800, endMs: 7900 }],
    pauseMs: options.pauseMs,
    padMs: options.padMs,
    durationMs: 19411,
    text: '你是哪里人',
  }
  ok('正常计划可解析', parseShotSpeechPlan(good, options) !== null)
  ok('  └ 区间原样读回', parseShotSpeechPlan(good, options)?.ranges.length === 2)
  eq('null ⇒ 未探测过（会去探一次）', parseShotSpeechPlan(null, options), null)
  eq('undefined ⇒ 未探测过', parseShotSpeechPlan(undefined, options), null)
  eq('★ 版本不符 ⇒ 判定作废（判据改过，旧结论不能再信）', parseShotSpeechPlan({ ...good, v: 0 }, options), null)
  eq(
    '★★ 阈值指纹不符 ⇒ 判定作废（用户改了阈值，线上必须有反应）',
    parseShotSpeechPlan({ ...good, pauseMs: 800 }, options),
    null,
  )
  eq('pad 指纹不符同理', parseShotSpeechPlan({ ...good, padMs: 0 }, options), null)
  eq('ranges 不是数组 ⇒ 作废', parseShotSpeechPlan({ ...good, ranges: 'x' }, options), null)
  eq(
    '★ 区间脏（end ≤ start）⇒ 作废，不能拿半坏的计划去剪',
    parseShotSpeechPlan({ ...good, ranges: [{ startMs: 900, endMs: 900 }] }, options),
    null,
  )
  eq('区间含 NaN ⇒ 作废', parseShotSpeechPlan({ ...good, ranges: [{ startMs: Number.NaN, endMs: 100 }] }, options), null)
  eq('数组整体 ⇒ 作废（形状必须是对象）', parseShotSpeechPlan([1, 2], options), null)
  ok(
    '★ 空区间数组是**有效**结论（探测过、没什么可剪）—— 别把它当成「没探测过」',
    parseShotSpeechPlan({ ...good, ranges: [] }, options) !== null,
  )
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
