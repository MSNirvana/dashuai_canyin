// 参数 ID 解析：把散落各处的 BigInt(...) 裸解析收敛到这里（路径参数 / 查询参数 / 请求体字段通用）。
//
// 为什么需要它：BigInt('abc') 抛 SyntaxError。裸写法在 async handler 里没人接管，
// 配上 Express 4 不处理 Promise rejection，会让整个进程退出（已实测：GET /stores/abc）。
// 即使被 try/catch 兜住，也只能返回 500「查询失败」，语义是错的——应该是 400「参数错误」。
import { z } from 'zod'

/** 参数不是合法 ID。由 lib/errors.ts 映射为 400。 */
export class InvalidIdParamError extends Error {
  readonly code = 'INVALID_ID_PARAM'
  constructor(
    readonly param: string,
    readonly value: unknown,
  ) {
    super(`参数 ${param} 不是合法的 ID`)
    this.name = 'InvalidIdParamError'
  }
}

/**
 * 合法 ID 形态：1~19 位纯数字字符串，或与之等价的非负安全整数。
 * 19 位是 BIGINT 有符号上限位数；库字段为 UnsignedBigInt，但实际 id 不会到 20 位，收紧更安全。
 * 显式排除前导 0、负号、小数、科学计数法、空串。
 */
const idStrSchema = z.string().regex(/^\d{1,19}$/)
const idNumSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/**
 * 把路径参数 / 查询参数 / 请求体字段解析为 bigint。
 * 非法值抛 InvalidIdParamError（→ 400），不返回 null、不返回 0，避免把错误静默带进查询。
 */
export function idParam(value: unknown, param = 'id'): bigint {
  if (typeof value === 'number') {
    const n = idNumSchema.safeParse(value)
    if (!n.success) throw new InvalidIdParamError(param, value)
    return BigInt(n.data)
  }
  const s = idStrSchema.safeParse(value)
  if (!s.success) throw new InvalidIdParamError(param, value)
  return BigInt(s.data)
}

/** 可选版本：用于 query / body 里可缺省的 ID 字段 */
export function optionalIdParam(value: unknown, param = 'id'): bigint | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return idParam(value, param)
}
