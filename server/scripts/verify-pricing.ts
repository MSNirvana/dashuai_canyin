// 计价回归：精确十进制 vs 旧浮点实现
//
// 用途：任何改动 beansFromCost / 合成计费 / computeCostFen 之后跑一次，
// 防止浮点误差重新引入「凭空多扣 1 积分」。
//
// 跑法：npm run pricing:verify
//
// ★ 2026-09-30：合成计费口径从「时长 × 每秒价 × 档位系数」改成「按档位固定价」，
//   第 4 节随之重写。这里**直接调生产代码里的 renderAmountBeans**，
//   不再像以前那样在脚本里复制一份公式 —— 复制出来的那份改口径时不会跟着变，
//   守护照样全绿，那是最坏的一种「假安全」。
import {
  decFromString,
  decFromNumber,
  decMulCeil,
  ceilDiv,
  floorDiv,
  type Dec,
} from '../src/lib/decimal.js'
import { computeCostFen, computeCostMicroFen } from '../src/ai/gateway.js'
import {
  GRADE_BEANS_DEFAULT,
  gradeBeansKey,
  renderAmountBeans,
} from '../src/render/grade-pricing.js'

let failed = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected)
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  实际=${actual} 期望=${expected}`}`)
}

/** Dec 含 bigint，不能用 JSON.stringify，手工格式化 */
function fmt(d: Dec | null): string {
  return d === null ? 'null' : `{num:${d.num}n,exp:${d.exp}}`
}

console.log('=== 1) Dec 解析 ===')
check('decFromString("2.5")', fmt(decFromString('2.5')), '{num:25n,exp:1}')
check('decFromString("100")', fmt(decFromString('100')), '{num:100n,exp:0}')
check('decFromString("0.5")', fmt(decFromString('0.5')), '{num:5n,exp:1}')
check('decFromString("007")', fmt(decFromString('007')), '{num:7n,exp:0}')
check('decFromString("-1.25")', fmt(decFromString('-1.25')), '{num:-125n,exp:2}')
check('decFromString("abc") 非法', fmt(decFromString('abc')), 'null')
check('decFromString("1e5") 拒绝科学计数法', fmt(decFromString('1e5')), 'null')
check('decFromNumber(0.1) 取十进制语义', fmt(decFromNumber(0.1)), '{num:1n,exp:1}')
check('decFromNumber(NaN)', fmt(decFromNumber(NaN)), 'null')

console.log('\n=== 2) 除法取整 ===')
check('ceilDiv(7, 2)', ceilDiv(7n, 2n), '4')
check('ceilDiv(8, 2)', ceilDiv(8n, 2n), '4')
check('ceilDiv(-7, 2)', ceilDiv(-7n, 2n), '-3')
check('floorDiv(7, 2)', floorDiv(7n, 2n), '3')
check('floorDiv(-7, 2)', floorDiv(-7n, 2n), '-4')

console.log('\n=== 3) 新实现 vs 旧浮点实现：AI 扣积分 ===')
// 新：ceil(costFen × 100 × 4 / 100) = costFen × 4
function newBeans(costFen: number): bigint {
  return decMulCeil([decFromNumber(costFen)!, decFromString('100')!, decFromString('4')!], 100n)
}
// 旧：BigInt(Math.ceil((costFen / 100) * 100 * 4))
function oldBeans(costFen: number): bigint {
  return BigInt(Math.ceil((costFen / 100) * 100 * 4))
}

check('costFen=7  新实现', newBeans(7), '28')
check('costFen=7  旧实现（+1 积分 bug）', oldBeans(7), '29')
check('costFen=14 新实现', newBeans(14), '56')
check('costFen=2  新实现', newBeans(2), '8')

let oldWrong = 0
let newWrong = 0
let overcharge = 0n
for (let c = 1; c <= 20000; c++) {
  const exact = BigInt(c) * 4n
  if (newBeans(c) !== exact) newWrong++
  if (oldBeans(c) !== exact) {
    oldWrong++
    overcharge += oldBeans(c) - exact
  }
}
console.log(`\n  costFen 1~20000（1元=100积分、乘数4）：`)
console.log(`    新实现算错：${newWrong} 个`)
console.log(`    旧实现算错：${oldWrong} 个（累计多扣 ${overcharge} 积分，只会多扣不会少扣）`)
check('新实现零误差', newWrong, '0')
check('旧实现确实有误差（复现基线）', oldWrong > 0, 'true')

console.log('\n=== 4) 合成计费：按档位固定价（2026-09-30 起，**与时长无关**）===')
const d = (s: string): Dec => {
  const v = decFromString(s)
  if (!v) throw new Error(`用例里的字面量写错了：${s}`)
  return v
}
// ── 后台可配的键名与兜底值（改口径时最容易被悄悄改坏的两处）──
check('配置键：AI', gradeBeansKey('AI'), 'grade_beans_ai')
check('配置键：精品', gradeBeansKey('PREMIUM'), 'grade_beans_premium')
check('配置键：基础', gradeBeansKey('BASIC'), 'grade_beans_basic')
check(
  '三个键互不相同（撞键会让两档共用一个价）',
  new Set([gradeBeansKey('BASIC'), gradeBeansKey('AI'), gradeBeansKey('PREMIUM')]).size,
  '3',
)
// ★ 这里钉的是**兜底默认值**（库里没有该行时才用到的数），也就是 2026-09-30 与用户约定的 500 / 5000。
//   线上真实价存在 `system_setting` 的 render 组里，改价改的是库、不是这里。
check('兜底默认：AI = 500', GRADE_BEANS_DEFAULT.AI, '500')
check('兜底默认：精品 = 5000', GRADE_BEANS_DEFAULT.PREMIUM, '5000')

// ── 纯函数本身：固定价、向上取整、最低 1、RECOLOR 打折 ──
check('AI 档 500（FULL，不打折）', renderAmountBeans(d('500')), '500')
check('精品档 5000（FULL）', renderAmountBeans(d('5000')), '5000')
check('AI 档 500 × RECOLOR 0.5', renderAmountBeans(d('500'), d('0.5')), '250')
check('精品档 5000 × RECOLOR 0.5', renderAmountBeans(d('5000'), d('0.5')), '2500')
check('价配成小数 500.5 向上取整', renderAmountBeans(d('500.5')), '501')
check('价配成 0 ⇒ 最低收 1（防免费出片）', renderAmountBeans(d('0')), '1')
check('RECOLOR 折到不足 1 也收 1', renderAmountBeans(d('1'), d('0.1')), '1')

// ⚠ 这里**刻意不写**「旧键不再被读取」那类断言。它只能靠 grep 源码实现，
//   而注释里必然要提到这些键名（否则后人查不到来龙去脉）⇒ 一改注释就假红。
//   那条不变量的落点是**代码结构**：`renderAmountBeans` 的签名里没有时长参数，
//   想按时长收费就必须先改签名，typecheck 会先炸。

console.log('\n=== 5) computeCostFen ===')
check('1000 in + 500 out（1/2 分每百万）', computeCostFen(1000, 500, 1, 2), '2')
check('整数边界 2000000 tokens × 1 分/百万', computeCostFen(2_000_000, 0, 1, 0), '2')
check('零 tokens', computeCostFen(0, 0, 100, 400), '0')
check('负数/NaN 归零防御', computeCostFen(-5, Number.NaN, 100, 400), '0')
check('mock-chat 3e4 in + 1e4 out（100/400 分每百万）', computeCostFen(30_000, 10_000, 100, 400), '7')
check('精确成本 1000 in + 500 out（1/2 分每百万）', computeCostMicroFen(1000, 500, 1, 2), '2000')
check('精确成本不对输入/输出分项向上取整', computeCostMicroFen(1, 1, 1, 1), '2')

console.log(`\n${failed ? `★ ${failed} 项未通过` : '★ 全部通过'}`)
process.exitCode = failed ? 1 : 0
