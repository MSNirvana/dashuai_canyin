/**
 * 文案多样性离线守护：精确重复、中文字符 n-gram 高相似与主题轮换。
 * 不调用上游模型，不连库；只钉住生成后守卫使用的纯函数和流量方向库。
 */
import {
  COMPLEXITIES,
  copyCharCount,
  copyExceedsComplexityLimit,
  copyFingerprint,
  copySimilarity,
  normalizeCopyForCompare,
} from '../src/services/creation.service.js'
import { topicDirections } from '../src/lib/topic.js'

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
check(all.some((text) => /天凉|降温|下雨|秋天/.test(text)), '方向库仍保留时令主题，但不独占')

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail) process.exitCode = 1
