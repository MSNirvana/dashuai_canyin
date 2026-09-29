// 登录失败限速（Redis 计数窗口）。
//
// ★ 为什么需要它：后台登录原先没有任何失败限制 —— 只要网络通就可以不限次数地猜密码。
//   `POST /admin/api/v1/auth/login` 是**未鉴权**的路由，正是最该限速的那一类：
//   一次成功的猜测就能拿到积分调账、AI 供应商密钥、套餐价格的完整权限。
//
// 判据选择上的两个刻意取舍：
//
// 1. **按用户名计数，不按 IP。** 本服务跑在 nginx 后面，而 app 没有设 `trust proxy`，
//    此时 `req.ip` 拿到的是**反代自己的地址** —— 用它做维度会让所有人挤进同一个桶
//    （一个攻击者就能把正常管理员锁死），而一旦为了修这个把 `trust proxy` 打开又没配对，
//    客户端就能用 `X-Forwarded-For` 伪造 IP 把限速完全绕过。两边都是坑，
//    所以这里不用 IP 维度，改用「用户名 + 全局」两个计数器：
//    前者挡住针对某个账号的爆破，后者挡住「换着用户名乱试」的喷洒。
//
// 2. **窗口本身就是锁定期。** 不做「先限速、再单独锁定 N 分钟」两段式：
//    两段式的锁定时刻要靠另一个键来记，多一个键就多一种不同步的形态，
//    而这里要的只是「短时间内猜不了太多次」，单键的 TTL 已经完整表达了这个约束。
import type { Redis } from 'ioredis'

export interface LoginThrottlePolicy {
  /** 允许的连续失败次数，达到即进入锁定（含第 N 次失败） */
  maxFailures: number
  /** 计数窗口 = 锁定时长（秒） */
  windowSec: number
}

/** 后台登录：单个用户名 15 分钟内最多失败 5 次；全局 15 分钟内最多失败 30 次 */
export const ADMIN_LOGIN_POLICY: LoginThrottlePolicy = { maxFailures: 5, windowSec: 15 * 60 }
export const ADMIN_LOGIN_GLOBAL_POLICY: LoginThrottlePolicy = { maxFailures: 30, windowSec: 15 * 60 }

/**
 * 商家端「演示账号固定登录码」的失败限速。
 *
 * ★ 为什么只有这一条路需要它（普通的短信验证码登录不需要）：
 *   · 短信码是**一次性**的，`verifyCode()` 自带「同一条记录错 5 次即作废」+ 5 分钟 TTL
 *     ⇒ 本来就猜不动；
 *   · 演示固定码是**可重复使用的共享码**、没有 TTL、也没有「用掉即废」——
 *     不限速就是「10^6 次以内必中」。限速是它唯一真正的防线。
 *
 * ★ 为什么是 10 次 / 15 分钟（而不是像后台登录那样 5 次）：
 *   这一枚码是**发给多个试用者共用**的。5 次会把「一个人手滑」升级成
 *   「所有人都进不来 15 分钟」。10 次 / 15 分钟下，穷举完 10^6 约需 2.85 年，
 *   同时给试用者留出打错字的余地；再加上演示窗口本身只有 N 小时，时间预算远远不够。
 *
 * ★ 按**手机号**计数、不按 IP：与后台登录同样的理由（本服务在 nginx 后面而没有
 *   `trust proxy`，`req.ip` 拿到的是反代自己的地址，用它做维度会把所有人挤进同一个桶）。
 *   而演示号只有一个、且本来就是公开的 ⇒ 按号计数不会误伤别人。
 */
export const MERCHANT_DEMO_LOGIN_POLICY: LoginThrottlePolicy = { maxFailures: 10, windowSec: 15 * 60 }

export interface ThrottleVerdict {
  allowed: boolean
  /** 还需等待的秒数（allowed=false 时才有意义） */
  retryAfterSec: number
}

/** key 前缀固定，便于运维直接 `redis-cli keys` 排查 */
const PREFIX = 'login:fail'
export const adminUserKey = (username: string): string => `${PREFIX}:admin:user:${username.toLowerCase()}`
export const adminGlobalKey = (): string => `${PREFIX}:admin:global`

/** 演示账号固定登录码的失败计数键（按手机号，见 MERCHANT_DEMO_LOGIN_POLICY） */
export const merchantDemoLoginKey = (phone: string): string => `${PREFIX}:merchant:demo:phone:${phone}`

/**
 * 原子自增并只在**第一次**设置 TTL。
 *
 * ★ 为什么用 Lua 而不是 `incr` 之后再 `expire`：那两步之间进程一旦挂掉（或被 kill），
 *   键就**永远没有 TTL**，计数器只增不减 ⇒ 该用户名被永久锁死，而且 `keys` 里看得到、
 *   日志里查不出是谁干的。用 `SET NX EX` + `INCR` 也救不了它（NX 失败那次不设 TTL）。
 *   这条脚本里 INCR 与 EXPIRE 是一次调用，不存在中间态。
 */
const INCR_WITH_TTL = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`

async function bump(redis: Redis, key: string, windowSec: number): Promise<number> {
  return Number(await redis.eval(INCR_WITH_TTL, 1, key, String(windowSec)))
}

/**
 * 判定是否放行。**在做密码校验之前调用** —— 已经被锁的请求不该再去查库比对密码。
 * 多个维度取「最严的那个」：任一把锁生效就拦。
 */
export async function checkLoginAllowed(
  redis: Redis,
  checks: { key: string; policy: LoginThrottlePolicy }[],
): Promise<ThrottleVerdict> {
  let worst = 0
  for (const { key, policy } of checks) {
    const n = Number(await redis.get(key)) || 0
    if (n < policy.maxFailures) continue
    // 计数已达标 ⇒ 锁定中。剩余时长取该键的 TTL（正是它与达标点之间的距离）
    const ttl = await redis.ttl(key)
    // ttl < 0 表示键没有过期时间（不该发生，见 INCR_WITH_TTL）：
    // 这时不能返回「立刻可重试」，那等于把锁悄悄关掉；按整个窗口封顶，宁可多锁一会儿。
    worst = Math.max(worst, ttl > 0 ? ttl : policy.windowSec)
  }
  if (worst === 0) return { allowed: true, retryAfterSec: 0 }
  return { allowed: false, retryAfterSec: worst }
}

/** 记一次失败。返回是否**因此**刚好达到锁定阈值（用于提示语区分「最后一次」还是「已被锁」） */
export async function recordLoginFailure(
  redis: Redis,
  checks: { key: string; policy: LoginThrottlePolicy }[],
): Promise<boolean> {
  let reached = false
  for (const { key, policy } of checks) {
    const n = await bump(redis, key, policy.windowSec)
    if (n >= policy.maxFailures) reached = true
  }
  return reached
}

/**
 * 登录成功时清空计数器。
 * 只清**这个用户名**的锁，不动全局计数：全局桶的意义是「近期整站失败了多少次」，
 * 一次成功登录取消掉它，会让「喷洒 + 偶然猜中一次」把整站的失败记录洗白。
 */
export async function clearLoginFailures(redis: Redis, username: string): Promise<void> {
  await redis.del(adminUserKey(username))
}

/**
 * 演示号登录成功后清空**它自己**的失败计数。
 *
 * ★ 单独一个函数而不是复用 `clearLoginFailures`：那个按**后台用户名**建键，
 *   拿它去清手机号的桶会键名不符、静默清不掉（下一次失败继续累加，
 *   表现为「明明登成功了，再错一次就被锁」）。键必须从同一个 helper 来。
 */
export async function clearDemoLoginFailures(redis: Redis, phone: string): Promise<void> {
  await redis.del(merchantDemoLoginKey(phone))
}
