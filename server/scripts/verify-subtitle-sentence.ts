/**
 * 字幕「按停顿自动分句」的守护闸门（2026-09-29）。
 *
 * ★★ 为什么单独一个脚本，而不是把那几条断言塞进 `verify-speech-range.ts`：
 *   那边测的是**纯函数** `speech-range.ts`（零依赖）；这边要真的调用
 *   `transcription.ts::alignPunctuatedAsrText` —— **接线**本身也要被测到。
 *   只测纯函数会出现「断言窄于标题」：函数对了，但没人保证它真的被接到字幕链上。
 *
 * ★★ 用**真实形状**的输入，不用「刚好能过」的构造：
 *   词表就是线上那条素材实测的 25 个词（与 `verify-speech-range.ts` 同一份），
 *   配上 ASR 会返回的带标点 `Result`。于是这里验的是「真数据走真函数」。
 *
 * 改之前的行为（对照）：只认 `/[。！？!?；;，、,:：]/` —— **逗号也算句界**，
 * 于是「咱固安的老乡，在外头待久了，」被切成两条 cue，一串连贯的话被打碎。
 */
import { alignPunctuatedAsrText } from '../src/render/transcription.js'

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

/** 线上那条素材的 25 个词（服务器真实 ASR，`WordInfo: 1`），一个数都没改。 */
const REAL_WORDS = [
  { Word: '你是', StartTime: 1550, EndTime: 2025 },
  { Word: '哪里', StartTime: 2025, EndTime: 2275 },
  { Word: '人', StartTime: 2275, EndTime: 2550 },
  { Word: '咱', StartTime: 5000, EndTime: 5275 },
  { Word: '固安', StartTime: 5275, EndTime: 5575 },
  { Word: '的', StartTime: 5575, EndTime: 5725 },
  { Word: '老乡', StartTime: 5725, EndTime: 6300 },
  { Word: '在外', StartTime: 6350, EndTime: 6825 },
  { Word: '头', StartTime: 6825, EndTime: 7000 },
  { Word: '待', StartTime: 7000, EndTime: 7225 },
  { Word: '久了', StartTime: 7225, EndTime: 7700 },
  { Word: '是不是', StartTime: 9400, EndTime: 9925 },
  { Word: '就', StartTime: 9925, EndTime: 10125 },
  { Word: '馋', StartTime: 10125, EndTime: 10325 },
  { Word: '那', StartTime: 10325, EndTime: 10450 },
  { Word: '一口', StartTime: 10450, EndTime: 10800 },
  { Word: '炖菜', StartTime: 10800, EndTime: 11400 },
  { Word: '碗', StartTime: 14350, EndTime: 14675 },
  { Word: '棒子', StartTime: 14675, EndTime: 14975 },
  { Word: '面儿', StartTime: 14975, EndTime: 15250 },
  { Word: '粥', StartTime: 15250, EndTime: 15600 },
  { Word: '多久', StartTime: 17250, EndTime: 17725 },
  { Word: '没', StartTime: 17725, EndTime: 17875 },
  { Word: '吃着', StartTime: 17875, EndTime: 18350 },
  { Word: '了', StartTime: 18350, EndTime: 18650 },
]
/** 同一条素材的时长（ms）。 */
const REAL_DURATION_MS = 19411

// ── ① 真实形状：改前 6 条、改后 5 条 ────────────────────────────────────────
console.log('\n① 真实形状（线上那条素材的 25 个词 + ASR 会返回的带标点整句）')
{
  const RESULT = '你是哪里人？咱固安的老乡，在外头待久了，是不是就馋那一口炖菜？碗棒子面儿粥，多久没吃着了？'
  const segments = alignPunctuatedAsrText(RESULT, REAL_WORDS, REAL_DURATION_MS)
  ok('能对齐（不是 null）', segments !== null)
  if (segments) {
    // 改前：逗号也算句界 ⇒ 「咱固安的老乡，」「在外头待久了，」各占一条 ⇒ 6 条
    eq('★★ 只切出 5 条（改前是 6 条：逗号把第 2 句劈成了两条）', segments.length, 5)
    eq('第 1 句 = 你是哪里人？', segments[0]!.text, '你是哪里人？')
    eq(
      '★★ 第 2 句把「咱固安的老乡，在外头待久了，」合成**一整条**（这就是「不被切成好几条」）',
      segments[1]!.text,
      '咱固安的老乡，在外头待久了，',
    )
    eq('第 3 句 = 是不是就馋那一口炖菜？', segments[2]!.text, '是不是就馋那一口炖菜？')
    eq('第 4 句 = 碗棒子面儿粥，', segments[3]!.text, '碗棒子面儿粥，')
    eq('第 5 句 = 多久没吃着了？', segments[4]!.text, '多久没吃着了？')
    ok(
      '★ 逗号从不成为某条 cue 的**开头**（标点永远挂在前一句尾巴上）',
      segments.every((segment) => !/^[，。！？；、：]/.test(segment.text)),
    )
    ok(
      '★ 一个字都没丢、也没重复（拼回去 === 原句去掉标点后的样子）',
      segments.map((s) => s.text).join('').replace(/[，。！？；、：]/g, '') ===
        RESULT.replace(/[，。！？；、：]/g, ''),
    )

    // ── 时间轴：必须来自真实词边界，而不是「按字数摊分」
    eq('第 1 句起点 = 首词真起点 1550', segments[0]!.startMs, 1550)
    eq('  └ 终点 = 末字 2550（句末标点自己没时间轴，沿用末字）', segments[0]!.endMs, 2550)
    eq('★ 第 2 句起点 = 5000（跨过 2450ms 的那处大停顿）', segments[1]!.startMs, 5000)
    eq('★ 第 2 句终点 = 7700（下一句 9400 起 = 1700ms 停顿处断的句）', segments[1]!.endMs, 7700)
    eq('★ 第 3 句起点 = 9400（1700ms 停顿之后）', segments[2]!.startMs, 9400)
    ok(
      '每句都是正长度、升序、不重叠（下游按它布时）',
      segments.every((segment, index) => {
        if (segment.endMs <= segment.startMs) return false
        const previous = segments[index - 1]
        return !previous || segment.startMs >= previous.endMs
      }),
    )
  }
}

// ── ② 逗号处停顿很短 ⇒ 绝不切断（改的核心）────────────────────────────────
console.log('\n② 逗号只停 50ms ⇒ 整句攒成一条（改前会在此切断）')
{
  const words = [
    { Word: '今天', StartTime: 0, EndTime: 400 },
    { Word: '天气', StartTime: 400, EndTime: 800 },
    { Word: '不错', StartTime: 800, EndTime: 1200 },
    { Word: '我们', StartTime: 1250, EndTime: 1650 },
    { Word: '出去', StartTime: 1650, EndTime: 2050 },
    { Word: '走走', StartTime: 2050, EndTime: 2450 },
    { Word: '吧', StartTime: 2450, EndTime: 2650 },
  ]
  const segments = alignPunctuatedAsrText('今天天气不错，我们出去走走吧。', words, 3000)
  eq('整句一条 cue', segments?.length, 1)
  eq('  └ 行内标点原样保留（用户要的「一行里面要有标点」）', segments?.[0]?.text, '今天天气不错，我们出去走走吧。')
}

// ── ③ 没有标点、但有真停顿 ⇒ 照样断句（字幕跟上口播节奏）──────────────────
console.log('\n③ 没有标点、只有停顿：500ms 处必须断（认的是停顿，不是标点）')
{
  const words = [
    { Word: '我先', StartTime: 0, EndTime: 200 },
    { Word: '说', StartTime: 200, EndTime: 300 },
    { Word: '第一', StartTime: 300, EndTime: 500 },
    { Word: '件事', StartTime: 500, EndTime: 700 },
    { Word: '然后', StartTime: 1200, EndTime: 1400 },
    { Word: '说', StartTime: 1400, EndTime: 1500 },
    { Word: '第二', StartTime: 1500, EndTime: 1700 },
    { Word: '件事', StartTime: 1700, EndTime: 1900 },
  ]
  const segments = alignPunctuatedAsrText('我先说第一件事然后说第二件事', words, 2000)
  eq('断成 2 条', segments?.length, 2)
  eq('  └ 第 1 条', segments?.[0]?.text, '我先说第一件事')
  eq('  └ 第 2 条', segments?.[1]?.text, '然后说第二件事')
  eq('  └ 断点落在停顿处：第 2 条起点 = 1200', segments?.[1]?.startMs, 1200)
  ok(
    '拼回去 === 原句（断句不许吃掉字）',
    segments?.map((s) => s.text).join('') === '我先说第一件事然后说第二件事',
  )
}

// ── ④ 最短句长保护：3 个字不成句 ──────────────────────────────────────────
console.log('\n④ 停顿够大，但前一句只有 2 个字 ⇒ 不断（防「好的」单独占一条字幕）')
{
  const words = [
    { Word: '好的', StartTime: 0, EndTime: 300 },
    { Word: '我', StartTime: 900, EndTime: 1000 },
    { Word: '知道', StartTime: 1000, EndTime: 1300 },
    { Word: '了', StartTime: 1300, EndTime: 1400 },
    { Word: '没', StartTime: 2100, EndTime: 2200 },
    { Word: '问题', StartTime: 2200, EndTime: 2600 },
  ]
  const segments = alignPunctuatedAsrText('好的我知道了没问题', words, 3000)
  eq('断成 2 条（不是 3 条）', segments?.length, 2)
  eq('  └ 第 1 条把「好的」并进来', segments?.[0]?.text, '好的我知道了')
  eq('  └ 第 2 条', segments?.[1]?.text, '没问题')
}

// ── ⑤ 对齐失败必须返回 null（交给调用方回退，不许给半成品）───────────────
console.log('\n⑤ 文本与词表对不上 ⇒ 返回 null')
{
  ok(
    '音频念的字与 Result 不同',
    alignPunctuatedAsrText('完全不一样的内容', [{ Word: '你是', StartTime: 0, EndTime: 300 }], 1000) === null,
  )
  ok('空文本', alignPunctuatedAsrText('', [{ Word: '你', StartTime: 0, EndTime: 300 }], 1000) === null)
  ok('空词表', alignPunctuatedAsrText('你是哪里人', [], 1000) === null)
  ok('词表缺一半（只消费了不到 90% 的字）⇒ 不给残缺结果', alignPunctuatedAsrText('你是哪里人', [{ Word: '你是', StartTime: 0, EndTime: 800 }], 1000) === null)
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
