/**
 * 文案多样性离线守护：精确重复、中文字符 n-gram 高相似与主题轮换。
 * 不调用上游模型，不连库；只钉住生成后守卫使用的纯函数和流量方向库。
 */
import {
  COMPLEXITIES,
  buildRecentCopyAvoidPrompt,
  copyCharCount,
  copyExceedsComplexityLimit,
  copyFingerprint,
  copyOpeningLine,
  copySimilarity,
  normalizeCopyForCompare,
} from '../src/services/creation.service.js'
import { topicDirections, topicFamilyOf } from '../src/lib/topic.js'

let pass = 0
let fail = 0
function check(ok: boolean, label: string) {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
  }
}

const same = '天凉了，想念家乡的那口热菜。'
const punctOnly = '天凉了 想念家乡的那口热菜！'
const changed = '今晚下班后，你更想一个人安静吃饭，还是找朋友坐一会儿？'

check(normalizeCopyForCompare(same) === normalizeCopyForCompare(punctOnly), '空格和标点变化会被视为同一文案')
check(copyFingerprint(same) === copyFingerprint(punctOnly), '规范化后精确重复指纹一致')
check(copySimilarity(same, punctOnly) === 1, '精确重复的 n-gram 相似度为 1')
check(copySimilarity(same, changed) < 0.72, '明显不同主题不会误判为高相似')

/**
 * ★★★ 2026-10-19 新增：避让块里的「开头句」。
 * 为什么专门钉它：用户要求「每次都不能重复」，而模型实际只看得到避让块这一处。
 * 这里取错（取成整篇、或把句末问号吃掉），避让块就退化成「15 段长文」/「15 句光秃秃的话」——
 * 模型看不出「上面已经问过三次」，重复照旧，**而且不报错**。所以它必须被守护盯住。
 */
check(
  copyOpeningLine(same) === '天凉了，想念家乡的那口热菜。',
  '开头句按句末标点切出第一句（带句号）',
)
const questionOpening = '你真知道几个人点几个菜够吃吗？'
check(copyOpeningLine(questionOpening) === questionOpening, '问句开头保留问号，模型才看得出上一稿是问句')
// ★ 超长时从逗号处断，也要补 `…`：不补就切出一句「看着像完整陈述」的半句，
//   模型读不出这是被截断的，会把半句当成上一稿的原话。
const longOpening = `${'这道菜的做法说起来简单'.repeat(4)}，其实最难的是火候。后面还有一长段。`
check(
  copyOpeningLine(longOpening).endsWith('…') && copyOpeningLine(longOpening).length <= 27,
  '过长的开头句会截断成一句，不把整篇带进避让名单',
)
check(
  copyOpeningLine(changed).endsWith('…'),
  '逗号处断开的截断句也带省略号（模型才知道那不是完整一句）',
)

/**
 * ★★★ 避让块本身：它是「每次不能重复」在提示词里唯一的着力点。
 * 空历史必须渲染成**空串**（不然首条稿子会看到「近期用过的开头：」下面一片空白，
 * 模型会以为资料不全而保守化）；有历史时每条开头都要出现。
 */
check(buildRecentCopyAvoidPrompt([]) === '', '避让块在空历史时渲染成空串')
const avoidBlock = buildRecentCopyAvoidPrompt([same, changed])
check(
  avoidBlock.includes(copyOpeningLine(same)) && avoidBlock.includes(copyOpeningLine(changed)),
  '避让块包含每条历史文案的开头句',
)
check(avoidBlock.includes('换**路数**'), '避让块明确要求换路数（不是换同义词）')
check(
  buildRecentCopyAvoidPrompt([same, same]).match(/天凉了/g)?.length === 1,
  '同一开头只列一次（历史里重复的稿子不会把名单灌满）',
)

const simpleWithin = '这道菜先讲一个重点，口感和做法都说清楚。'
const simpleTooLong = `${simpleWithin}超过简单版口播上限后必须重新生成，不能把长稿硬塞进两个镜头里。`
check(copyCharCount(simpleWithin) <= COMPLEXITIES.SIMPLE.maxCopyChars, '简单版正常口播处于长度上限内')
check(!copyExceedsComplexityLimit(simpleWithin, 'SIMPLE'), '简单版正常口播不会触发超长守卫')
check(copyExceedsComplexityLimit(simpleTooLong, 'SIMPLE'), '简单版长口播会触发超长守卫')
check(COMPLEXITIES.SIMPLE.copyRule.includes('20~45 字'), '简单版规则明确为 20~45 字')
check(COMPLEXITIES.COMPLEX.maxCopyChars > COMPLEXITIES.SIMPLE.maxCopyChars, '复杂版允许的口播长度高于简单版')

const dates = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i, 4)))
const firstCuts = dates.map((date) => topicDirections(date)[0] ?? '')
check(new Set(firstCuts).size >= 3, '7 天内地域基线至少轮换 3 个切口')
check(firstCuts.every((text) => !/家乡那一口|老家来的那口|家里哪道菜|最想家里哪道菜/.test(text)), '默认地域切口不再固定落到“想念家乡哪道菜”')

const all = dates.flatMap((date) => topicDirections(date))
check(all.some((text) => /彩礼|房租|加班|朋友|暗号|规矩|一桌人/.test(text)), '方向库覆盖关系、人情、生活选择等非菜品主题')
// ★ 2026-10-12 判据从「文本里出现某个词」换成「**族**还在」：时令已独立成「天气时令」一族、
//   按窗口轮转取材 —— 某个 7 天窗口里抽到的那几条未必正好含这些词，按词判会假红（当天踩到过）。
check(
  all.some((text) => topicFamilyOf(text) === '天气时令'),
  '方向库仍保留时令主题，但不独占',
)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail) process.exitCode = 1
