// 口播文案分段的守护断言（`npm run copy-paragraphs:verify`）。
//
// 为什么需要它：分段**切错了不会报任何错**，只会让口播文案读起来别扭 ——
// 典型失效有三种，都是静默的：
//   ① 丢字（切句时把某个片段吞掉）；
//   ② 切在句子中间（不是标点后切开）⇒ 念的时候断气；
//   ③ `……` 这种连续标点被切碎 ⇒ 段落以标点开头。
//
// 全是对纯函数的断言，不碰小程序运行时，所以用 node 直接跑 TS 即可（零依赖）：
//   node --experimental-strip-types scripts/verify-copy-paragraphs.ts
import { splitCopyParagraphs, copyTextParagraphs } from '../src/utils/copy-text.ts'

let pass = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

const HARD = '。！？!?…'
const SOFT = '；;，,、'
const PUNCT = HARD + SOFT

const stripWs = (s: string) => s.replace(/\s/g, '')
const paragraphsOf = (s: string) => splitCopyParagraphs(s)

/** 通用不变量：不丢字 + 只在标点后切 + 段首不是标点 + 段内没有换行 */
function assertInvariants(label: string, source: string, out: string[], expectEnderSet: string): void {
  check(`[${label}] 至少分出一段`, out.length > 0)
  check(
    `[${label}] 不丢字（去空白后与原文完全一致）`,
    stripWs(out.join('')) === stripWs(source),
    `原文 ${stripWs(source).length} 字 / 结果 ${stripWs(out.join('')).length} 字`,
  )
  const badEnd = out.slice(0, -1).filter((p) => !expectEnderSet.includes(p.charAt(p.length - 1)))
  check(
    `[${label}] 每个非末段都切在标点之后（没有切断句子）`,
    badEnd.length === 0,
    badEnd.length ? `问题段落：${badEnd.map((p) => p.slice(-8)).join(' | ')}` : '',
  )
  const badStart = out.filter((p) => PUNCT.includes(p.charAt(0)))
  check(
    `[${label}] 没有段落以标点开头（连续标点没被切碎）`,
    badStart.length === 0,
    badStart.length ? badStart.join(' | ') : '',
  )
  check(`[${label}] 段内不含换行`, out.every((p) => !p.includes('\n')))
  check(`[${label}] 没有空段落`, out.every((p) => p.trim().length > 0))
}

// ───────────── ① 空输入 ─────────────

console.log('\n① 空输入：必须返回空数组（调用方据此走「未生成」分支）')
check('空串 → []', splitCopyParagraphs('').length === 0)
check('null → []', splitCopyParagraphs(null).length === 0)
check('undefined → []', splitCopyParagraphs(undefined).length === 0)
check('纯空白（含全角空格）→ []', splitCopyParagraphs('  \u3000 \n \t ').length === 0)

// ───────────── ② 短文本不该被硬凑分段 ─────────────

console.log('\n② 短文本：不该为了「多分几段」而硬拆')
{
  const short = '今天新到了一批春笋，脆得很。'
  const out = paragraphsOf(short)
  check('40 字以内的文案仍是 1 段', out.length === 1, `实际 ${out.length} 段`)
  const mid = '招牌酸菜鱼今天开始做活动了。两个人吃刚好，三个人管饱，米饭无限续。'
  check('约 70 字的两句文案仍是 1 段（低于目标字数）', paragraphsOf(mid).length === 1, `实际 ${paragraphsOf(mid).length} 段`)
  check('1 段时不丢字', stripWs(out.join('')) === stripWs(short))
}

// ───────────── ③ 真实文案：80~150 字应当分成 2~3 段 ─────────────

console.log('\n③ 真实文案（80~150 字）：应当自然分成 2~3 段')
{
  const samples: Array<[string, string]> = [
    [
      '流量款',
      '凌晨四点还在排队的老字号，今天我把后厨拍给你看。老板说这条街他守了二十三年，锅底每天现熬，绝不留到第二天。第一锅中午十二点出锅，前三十位来的都有免费小菜。评论区扣个 1，我把定位直接发给你。',
    ],
    [
      '介绍款',
      '这是一份两个人吃刚好、三个人管饱的招牌套餐。主菜是现杀活鱼做的酸菜鱼，配一份手撕包菜、一份凉拌木耳，还有可以无限续的米饭。鱼片薄到透光，酸辣开胃，汤底可以直接喝。人均不到五十，工作日中午过来基本不用等位，想吃的到店点一份试试。',
    ],
    [
      '质量款',
      '我们家的牛骨汤，凌晨四点开始吊，八个小时中途不加水。牛骨只用当天现宰的，骨髓饱满，汤色奶白。不加味精，不放浓汤宝，靠的是时间和火候。老板说，做吃的骗不了人，你喝一口就知道。懂吃的人，来尝尝。',
    ],
  ]
  for (const [label, text] of samples) {
    const out = paragraphsOf(text)
    check(`[${label}] 分成 2~3 段`, out.length >= 2 && out.length <= 3, `实际 ${out.length} 段：${out.map((p) => p.length).join('/')}`)
    assertInvariants(label, text, out, HARD)
    // 均衡性：最长段不该超过最短段的两倍（否则「均衡切」形同虚设）
    const lens = out.map((p) => p.length)
    check(
      `[${label}] 段落长度基本均衡（最长 ≤ 最短×2）`,
      Math.max(...lens) <= Math.min(...lens) * 2,
      `实际 ${lens.join('/')}`,
    )
  }
}

// ───────────── ④ ★ 连续标点：`……` 不能被切碎 ─────────────

console.log('\n④ ★ 连续标点：`……`、`!?` 必须整体保留')
{
  const text = '他说了一句很轻的话……然后转身回了后厨。那一刻我突然明白，这家店为什么能开二十三年。'
  const out = paragraphsOf(text)
  check('`……` 完整保留（原文含 1 处）', out.join('').includes('……'), out.join('').slice(0, 40))
  check('没有被拆成「…」+「…」两段', out.every((p) => !p.startsWith('…')))
  assertInvariants('省略号', text, out, HARD)

  const mixed = '真的假的!?这也太夸张了。我当场就拍了视频，明天就发出来给大家看。'
  const out2 = paragraphsOf(mixed)
  check('`!?` 完整保留', out2.join('').includes('!?'), out2.join(''))
  assertInvariants('问叹连用', mixed, out2, HARD)
}

// ───────────── ⑤ 已有换行：必须尊重作者/模型的分段意图 ─────────────

console.log('\n⑤ 已有换行：尊重它，不重排')
{
  const text = '第一段就是这一句。\n\n第二段有两句。这里还有一句。\n第三段收尾。'
  const out = paragraphsOf(text)
  check('段数 === 非空行数', out.length === 3, `实际 ${out.length} 段`)
  check('第一段内容原样', out[0] === '第一段就是这一句。', out[0])
  check('第三段内容原样', out[2] === '第三段收尾。', out[2])
  check('没有把空行留成空段落', out.every((p) => p.length > 0))
  check('多余空行被折叠', paragraphsOf('A。\n\n\n\nB。').length === 2)

  const crlf = '甲段。\r\n乙段。'
  check('`\\r\\n` 与 `\\n` 同口径', paragraphsOf(crlf).length === 2, `实际 ${paragraphsOf(crlf).length} 段`)
}

// ───────────── ⑥ 没有任何句末标点：长文本才用停顿标点兜底 ─────────────

console.log('\n⑥ 无句末标点：够长才兜底用停顿标点，短的原样返回')
{
  const longSoft = '我们家的招牌菜是现杀现做的酸菜鱼，鱼片薄到透光，酸辣开胃，汤底能直接喝，配菜有手撕包菜和凉拌木耳，米饭无限续，人均不到五十块钱，工作日中午过来基本不用等位'
  const out = paragraphsOf(longSoft)
  check('无句末标点的长文本仍切成 ≥2 段', out.length >= 2, `实际 ${out.length} 段`)
  assertInvariants('停顿兜底', longSoft, out, SOFT)

  const shortSoft = '招牌菜是酸菜鱼，鱼片薄到透光，汤底能直接喝'
  const out2 = paragraphsOf(shortSoft)
  check('无句末标点的短文本不硬拆（保持 1 段）', out2.length === 1, `实际 ${out2.length} 段`)
  check('不硬拆时也不丢字', stripWs(out2.join('')) === stripWs(shortSoft))
}

// ───────────── ⑦ 参数与确定性 ─────────────

console.log('\n⑦ 参数与确定性')
{
  const text = '凌晨四点还在排队的老字号，今天我把后厨拍给你看。老板说这条街他守了二十三年。第一锅中午十二点出锅，前三十位来的都有免费小菜。评论区扣个 1，我把定位直接发给你。'
  check('同一输入两次结果完全一致（纯函数）',
    JSON.stringify(paragraphsOf(text)) === JSON.stringify(paragraphsOf(text)))
  check('maxParagraphs=1 时不分段', splitCopyParagraphs(text, { maxParagraphs: 1 }).length === 1)
  check('maxParagraphs=2 时最多 2 段', splitCopyParagraphs(text, { maxParagraphs: 2 }).length <= 2)
  check('段数永不超过句子数',
    splitCopyParagraphs('只有一句。', { maxParagraphs: 3 }).length === 1)
  const big = paragraphsOf(text)
  check('默认上限 3 段', big.length <= 3, `实际 ${big.length}`)
}

// ───────────── ⑧ 「复制」与屏幕显示必须一致 ─────────────

console.log('\n⑧ 复制用的文案：与屏幕上的分段一致')
{
  const text = '凌晨四点还在排队的老字号，今天我把后厨拍给你看。老板说这条街他守了二十三年。第一锅中午十二点出锅，前三十位来的都有免费小菜。'
  const paras = paragraphsOf(text)
  check('join(\'\\n\\n\') === copyTextParagraphs()', paras.join('\n\n') === copyTextParagraphs(text))
  check('复制内容按空行分段（段数 = 段数组长度）', copyTextParagraphs(text).split('\n\n').length === paras.length)
  check('复制内容不丢字', stripWs(copyTextParagraphs(text)) === stripWs(text))
  check('空文案复制出来是空串', copyTextParagraphs('') === '')
}

console.log(`\n通过 ${pass} · 失败 ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exitCode = 1
}
