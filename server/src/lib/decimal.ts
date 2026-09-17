// 精确十进制运算：用于所有「钱/积分」相关计算。
//
// 为什么不能用 Math.ceil(a/100*b*c)：
//   IEEE754 下 7/100 = 0.07 → *100 = 7.000000000000001 → ceil = 8，凭空空扣 1 个积分。
//   实测：成本乘数=4 时，1~20000 分里有 1148 个取值（5.74%）会被多扣 1 积分，且只会多扣不会少扣。
//   涉及扣费的地方一律走大整数 + 10 的幂缩放，全程不出现浮点。
//
// 表示法：Dec = { num: bigint, exp: number }，实际值 = num / 10^exp
//   例：2.5 → { num: 25n, exp: 1 }；100 → { num: 100n, exp: 0 }

export interface Dec {
  /** 十进制有效数字（含符号） */
  num: bigint
  /** 小数位数 */
  exp: number
}

/** 从字符串解析精确十进制。非法返回 null。不接受科学计数法（配置里不该出现）。 */
export function decFromString(input: string): Dec | null {
  const s = input.trim()
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s)
  if (!m) return null
  const sign = m[1] === '-' ? -1n : 1n
  const intPart = m[2] ?? ''
  const fracPart = m[3] ?? ''
  if (intPart === '' && fracPart === '') return null
  const digits = (intPart + fracPart).replace(/^0+/, '') || '0'
  return { num: sign * BigInt(digits), exp: fracPart.length }
}

/**
 * 从 number 解析精确十进制。
 * 走 String(n)（最短往返表示），所以 2.5 → {25n,1}、0.1 → {1n,1}，
 * 而不是 double 的精确值 0.10000000000000000555…；这符合配置里写 0.1 的语义。
 * 仅当出现科学计数法（极小/极大值）时回退到 toFixed 展开。非有限数返回 null。
 */
export function decFromNumber(n: number): Dec | null {
  if (!Number.isFinite(n)) return null
  const s = n.toString()
  if (!s.includes('e') && !s.includes('E')) return decFromString(s)
  // 科学计数法：展开为普通十进制
  const expanded = n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '')
  return decFromString(expanded)
}

/** 乘法：指数相加，有效数字相乘，全程整数 */
export function decMul(a: Dec, b: Dec): Dec {
  return { num: a.num * b.num, exp: a.exp + b.exp }
}

/** 向下取整除法（b 必须为正）；对负数向零取整 */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('floorDiv: divisor must be positive')
  const q = a / b
  // BigInt 除法对负数是向零截断；需要向下取整时再减 1
  return a < 0n && q * b !== a ? q - 1n : q
}

/** 向上取整除法（b 必须为正） */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv: divisor must be positive')
  if (a >= 0n) return (a + b - 1n) / b
  return -((-a) / b)
}

/** 10 的 n 次幂 */
function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`pow10: invalid exponent ${n}`)
  return 10n ** BigInt(n)
}

/**
 * 把若干 Dec 相乘后除以一个整数分母，向上取整。
 * result = ceil( (d1 × d2 × … ) / denom )
 */
export function decMulCeil(factors: Dec[], denom: bigint): bigint {
  if (denom <= 0n) throw new RangeError('decMulCeil: denom must be positive')
  let num = 1n
  let exp = 0
  for (const f of factors) {
    num *= f.num
    exp += f.exp
  }
  return ceilDiv(num, denom * pow10(exp))
}

/** 把 Dec 转成 number（仅用于展示/日志，不要用于计费） */
export function decToNumber(d: Dec): number {
  return Number(d.num) / Number(pow10(d.exp))
}

/**
 * 取两个 Dec 的公共指数下的整数比，便于比较大小。
 * 返回 [a', b'] 使得 a'/b' === a.num/b.num 且两者同为整数缩放。
 */
export function decCommonScale(a: Dec, b: Dec): [bigint, bigint] {
  const exp = Math.max(a.exp, b.exp)
  return [a.num * pow10(exp - a.exp), b.num * pow10(exp - b.exp)]
}
