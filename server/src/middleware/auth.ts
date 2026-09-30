// JWT 鉴权中间件：解析 access token，注入 merchantId / merchantPhone
import type { NextFunction, Request, Response } from 'express'
import { verifyToken, type AccessTokenPayload } from '../lib/jwt.js'
import { DemoExpiredError, demoDeadlinePassed, demoWindowClosed, loadDemoPolicy } from '../lib/demo-account.js'
import { fail } from '../lib/result.js'
import { prisma } from '../db.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      merchantId?: bigint
      merchantPhone?: string
    }
  }
}

export async function auth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers['authorization']
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    fail(res, 1001, '未登录', 401)
    return
  }
  try {
    const p = verifyToken<AccessTokenPayload>(header.slice(7))
    if (p.typ !== 'access') throw new Error('access token required')
    /**
     * ★★ 演示账号的绝对截止（`dst`）在这里判死 —— 这是「24h 后自动退出」真正生效的地方。
     *
     * 为什么不用等 refresh：refresh 会失败（见 auth.service.ts::refresh），但用户要等到
     * access 过期（2h）才触发刷新，最坏会多活 2 小时。带 `dst` 后到点即死，零延迟。
     *
     * ★ 必须抛**具名**错误并单独捕获：落进下面那个 `catch` 会变成 1001「登录已过期，请重新登录」，
     *   而演示账号重新登录一定失败 ⇒ 用户会陷在「登了就被踢」的死循环里，看不到真正的原因。
     * ★ 判据走纯函数 `demoDeadlinePassed`（demo-account.ts），别在这里重写一遍比较。
     */
    if (demoDeadlinePassed(p.dst)) throw new DemoExpiredError()
    /**
     * ★★★ 第二条判据：**实时**窗口是不是还开着（`demoWindowClosed`，judge 见 demo-account.ts）。
     *
     * 为什么非有不可：上面那条只看 `dst`，而 `dst` 是**签发时烙进 token 的值**。
     * 管理员在后台点「立即收回」（把 `activated_at` 改成 1970）时，**已发出的 token 里那个
     * `dst` 完全不变** ⇒ 旧会话会一直活到 access 自己过期（最长 2h）才被刷新的失败踢掉。
     * 加了这一条，收回 / 清空即刻生效；「重开窗口」不会误伤（实时截止在未来 ⇒ 放行）。
     *
     * ★★ 只在 `p.dst` 存在时查 —— 也就是**只有演示号的 token 走这条路**。
     *   普通账号的 token 不带 `dst`，判据与开销**都**和以前一模一样（不进这个分支）。
     * ★ 不做进程内缓存：缓存会把「收回」延迟一个 TTL，正好把这个改动的意义抵消掉。
     */
    if (p.dst !== undefined && demoWindowClosed(await loadDemoPolicy(prisma))) {
      throw new DemoExpiredError()
    }
    const merchant = await prisma.merchant.findUnique({ where: { id: BigInt(p.mid) }, select: { status: true } })
    if (!merchant || merchant.status !== 'ACTIVE') throw new Error('merchant unavailable')
    req.merchantId = BigInt(p.mid)
    req.merchantPhone = p.phone
    next()
  } catch (e) {
    if (e instanceof DemoExpiredError) {
      fail(res, 1006, e.message, 401)
      return
    }
    fail(res, 1001, '登录已过期，请重新登录', 401)
  }
}
