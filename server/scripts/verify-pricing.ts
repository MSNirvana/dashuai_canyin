// 计价回归：精确十进制 vs 旧浮点实现
//
// 用途：任何改动 beansFromCost / render amount / computeCostFen 之后跑一次，
// 防止浮点误差重新引入「凭空多扣 1 豆」。
//
// 跑法：npm run pricing:verify
import {
  decFromString,
  decFromNumber,
  decMulCeil,
  ceilDiv,
  floorDiv,
  type Dec,
} from '../src/lib/decimal.js'
import { computeCostFen } from '../src/ai/gateway.js'

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

console.log('\n=== 3) 新实现 vs 旧浮点实现：AI 扣豆 ===')
// 新：ceil(costFen × 100 × 4 / 100) = costFen × 4
function newBeans(costFen: number): bigint {
  return decMulCeil([decFromNumber(costFen)!, decFromString('100')!, decFromString('4')!], 100n)
}
// 旧：BigInt(Math.ceil((costFen / 100) * 100 * 4))
function oldBeans(costFen: number): bigint {
  return BigInt(Math.ceil((costFen / 100) * 100 * 4))
}

check('costFen=7  新实现', newBeans(7), '28')
check('costFen=7  旧实现（+1 豆 bug）', oldBeans(7), '29')
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
console.log(`\n  costFen 1~20000（1元=100豆、乘数4）：`)
console.log(`    新实现算错：${newWrong} 个`)
console.log(`    旧实现算错：${oldWrong} 个（累计多扣 ${overcharge} 豆，只会多扣不会少扣）`)
check('新实现零误差', newWrong, '0')
check('旧实现确实有误差（复现基线）', oldWrong > 0, 'true')

console.log('\n=== 4) 小数字段：合成分成（档位系数 1.5 / recolor 0.5）===')
function newAmount(totalMs: number, pps: string, gr: string, rr: string): bigint {
  const v = decMulCeil(
    [decFromNumber(totalMs)!, decFromString(pps)!, decFromString(gr)!, decFromString(rr)!],
    1000n,
  )
  return v < 1n ? 1n : v
}
check('3000ms × AI(1.5)', newAmount(3000, '1', '1.5', '1'), '5')   // 4.5 → 5
check('2000ms × BASIC(1)', newAmount(2000, '1', '1', '1'), '2')
check('2000ms × BASIC(1) RECOLOR(0.5)', newAmount(2000, '1', '1', '0.5'), '1')
check('6000ms × AI(1.5)', newAmount(6000, '1', '1.5', '1'), '9')   // 9 恰为整数
check('3333ms × AI(1.5)', newAmount(3333, '1', '1.5', '1'), '5')   // 4.9995 → 5
check('最低收 1 豆（1ms）', newAmount(1, '1', '1', '1'), '1')
check('小数 point_per_sec=0.1, 10000ms', newAmount(10000, '0.1', '1', '1'), '1')

console.log('\n=== 5) computeCostFen ===')
check('1000 in + 500 out（1/2 分每百万）', computeCostFen(1000, 500, 1, 2), '2')
check('整数边界 2000000 tokens × 1 分/百万', computeCostFen(2_000_000, 0, 1, 0), '2')
check('零 tokens', computeCostFen(0, 0, 100, 400), '0')
check('负数/NaN 归零防御', computeCostFen(-5, Number.NaN, 100, 400), '0')
check('mock-chat 3e4 in + 1e4 out（100/400 分每百万）', computeCostFen(30_000, 10_000, 100, 400), '7')

console.log(`\n${failed ? `★ ${failed} 项未通过` : '★ 全部通过'}`)
process.exitCode = failed ? 1 : 0
