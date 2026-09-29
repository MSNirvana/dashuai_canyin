// 「演示账号（全局一次性窗口）」守护断言。纯计算 + 源码静态检查，不碰数据库、不渲染、不联网。
//                                                        （`npm run demo-account:verify`）
//
// ★★ 这里防的是三类**完全静默**的回归 —— 它们的共同特征是「不报错，只是行为变了」：
//
//   ① **「空 = 所有号」**：白名单解析退回「没配就放过」。演示账号会变成**谁都是演示账号**，
//      窗口一生效就会把正常用户整批踢下线；而窗口若不生效，则等于给全站开了一个
//      永久免退出的口子。两个方向都不会有任何报错。
//      （同一类教训：固定测试码后门的白名单「留空」也曾被误读成「所有号」。）
//   ② **截止时间退回「滑动过期」**：只要 refresh 还能把时间往后推，「24h 自动退出」
//      就**永远不会发生**。这是最容易犯的 —— 改的人只想着「登录时判一下」，
//      忘了 `/auth/refresh` 才是续命通道（它每次都换发新 refresh）。
//   ③ **单位错位**（`dst` 秒 vs `Date.now()` 毫秒）：判据本身没写错，只是拿毫秒去比。
//      方向是「`dst * 1000` 变成天文数字 ⇒ 永远判不出过期」⇒ 演示窗口静默失效，
//      而不是「立刻过期」。这种错只能靠钉住单位来防。
//
// 所以断言分两层：
//   · **纯计算层**：直接调 `parseDemoPhones` / `parseDemoConfig` / `demoDeadlinePassed` /
//     `demoDeadlineMs` / `isDemoPhone` 这些真函数，看它们**算出来的结果**；
//   · **接线层**：读源码，断言「谁在什么时候调了它」—— 这一层无法靠调函数证明，
//     因为「闸门在签发 token 之前」是调用点的顺序属性，不在函数体内。
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEMO_DEFAULT_WINDOW_HOURS,
  demoDeadlineMs,
  demoDeadlinePassed,
  isDemoPhone,
  parseDemoConfig,
  parseDemoPhones,
  type DemoPolicy,
} from '../src/lib/demo-account.js'
import { signAccess, signRefresh, verifyToken } from '../src/lib/jwt.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const src = (rel: string) => readFile(join(here, '..', rel), 'utf8')
const file = (rel: string) => readFile(join(repo, rel), 'utf8')

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

/**
 * 抠出一个**函数声明**的函数体（按花括号配平）。
 *
 * ⚠ 不能直接取「声明之后第一个 `{`」—— 参数表里可能有内联对象类型
 *   （`processTask(task: { id: bigint; ... })`），那会把参数类型当成函数体，
 *   于是断言在几行片段上跑：「能定位到函数」通过、**实际什么都没查**。
 *   正解：先跳过参数表到**配平的右括号**，再从返回类型里找函数体的 `{`。
 */
function fnBody(text: string, decl: string): string | null {
  const at = text.indexOf(decl)
  if (at < 0) return null
  const openParen = text.indexOf('(', at)
  if (openParen < 0) return null
  let depth = 0
  let i = openParen
  for (; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) break
    }
  }
  const tail = /^\s*(?::\s*[^{]*)?\{/.exec(text.slice(i + 1))
  if (!tail) return null
  const brace = i + 1 + tail[0].length - 1
  depth = 0
  for (let j = brace; j < text.length; j++) {
    const ch = text[j]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(brace, j + 1)
    }
  }
  return null
}

const policy = (activatedAt: Date | null, windowHours = 24, phones = ['13800000000']): DemoPolicy => ({
  phones: new Set(phones),
  windowHours,
  activatedAt,
})

// ───────────── ① 白名单解析：空 ≠ 所有号 ─────────────

console.log('\n① 白名单解析（★★ 「空 = 所有号」是本功能最危险的回归）')
{
  check('★ 空串 ⇒ 空集合（**不是**「所有号」）', parseDemoPhones('').size === 0)
  for (const junk of ['-', 'none', '   ', '0', '1380000000', '138000000000', 'abc']) {
    check(`非法片段 ${JSON.stringify(junk)} 不构成白名单项`, parseDemoPhones(junk).size === 0)
  }
  const one = parseDemoPhones('13800000000')
  check('单个 11 位号可解析', one.size === 1 && one.has('13800000000'))
  const mixed = parseDemoPhones('13800000000，13900000000; 13700000000\n13600000000')
  check('中英文逗号 / 分号 / 换行混用都能解析（人工填写必然混用）', mixed.size === 4, [...mixed].join(','))
  check('合法号保留、非法片段丢弃', parseDemoPhones('13800000000, -, 13900000000').size === 2)
  check('重复号去重', parseDemoPhones('13800000000,13800000000').size === 1)
  check('数组形式也能解析', parseDemoPhones(['13800000000', '13900000000']).size === 2)
}

// ───────────── ② 配置解析：容错但不放过 ─────────────

console.log('\n② 配置解析（`demo.config` 一条 JSON）')
{
  const ok = parseDemoConfig(JSON.stringify({ phones: ['13800000000'], window_hours: 48 }))
  check('合法 JSON ⇒ phones 与 window_hours', ok.phones.has('13800000000') && ok.windowHours === 48)
  check(
    'phones 写成逗号长串也能解析',
    parseDemoConfig(JSON.stringify({ phones: '13800000000,13900000000', window_hours: 24 })).phones.size === 2,
  )
  const raw = parseDemoConfig('13800000000,13900000000')
  check('★ 整串不是 JSON ⇒ 当手机号列表（**不静默关闭**）', raw.phones.size === 2)
  check(`非 JSON 时 window 回落 ${DEMO_DEFAULT_WINDOW_HOURS}h`, raw.windowHours === DEMO_DEFAULT_WINDOW_HOURS)
  for (const h of [0, -1, 'abc', null, NaN]) {
    const c = parseDemoConfig(JSON.stringify({ phones: ['13800000000'], window_hours: h }))
    check(`window_hours=${JSON.stringify(h)} ⇒ 回落 ${DEMO_DEFAULT_WINDOW_HOURS}h`, c.windowHours === DEMO_DEFAULT_WINDOW_HOURS)
  }
  check('空配置串 ⇒ 空集合（功能关闭，不报错）', parseDemoConfig('').phones.size === 0)
  check('phones 缺失 ⇒ 空集合', parseDemoConfig(JSON.stringify({ window_hours: 24 })).phones.size === 0)
  check('配置填成数组（形状错）⇒ 空集合，不抛异常', parseDemoConfig('[1,2]').phones.size === 0)
}

// ───────────── ③ 截止判据：单位必须是秒 ─────────────

console.log('\n③ 截止判据（★★ 单位错位的方向是「永不退出」，不是「立刻过期」）')
{
  const now = Date.now()
  const nowSec = Math.floor(now / 1000)
  check('未来 1h ⇒ 未过期', demoDeadlinePassed(nowSec + 3600, now) === false)
  check('过去 1h ⇒ 已过期', demoDeadlinePassed(nowSec - 3600, now) === true)
  check('刚好到点 ⇒ 已过期（判据是 >=，不是 >）', demoDeadlinePassed(nowSec, now) === true)
  for (const v of [undefined, null, 'x', 0, -1, NaN, {}, []]) {
    check(`无有效 dst（${String(v)}）⇒ 不判过期（普通账号零行为变化）`, demoDeadlinePassed(v, now) === false)
  }
  /**
   * ★★ 把单位钉死。这两条必须**同时**成立才算单位正确：
   *   · 传「秒」的现在时刻 ⇒ 过期（③ 里已断言）
   *   · 传「毫秒」的现在时刻 ⇒ **不过期**（`dst * 1000` 成了天文数字）
   *   第二条看着像废话，但它正是「有人把 `Date.now()` 直接塞进 dst」时的真实结果
   *   —— 演示窗口从此永远关不上。把它写成断言，改动者一跑就知道单位不能换。
   */
  check('★★ 误传毫秒会被判成「还没到期」⇒ 钉住 dst 必须是秒', demoDeadlinePassed(now, now) === false)
}

// ───────────── ④ 到期语义：绝对截止，不是滑动过期 ─────────────

console.log('\n④ 窗口语义（「全局一次性」＝绝对截止）')
{
  check('未启用 ⇒ 截止为 null', demoDeadlineMs(policy(null)) === null)
  check(
    '★ 启用时刻填坏被当成「早已过期」（默认落在更保守的一侧）',
    (demoDeadlineMs(policy(new Date(0))) ?? 0) < Date.now(),
  )
  const t0 = new Date('2026-09-29T10:00:00Z')
  const d1 = demoDeadlineMs(policy(t0))
  const d2 = demoDeadlineMs(policy(t0))
  check('★★ 同一策略两次求值相同 ⇒ 截止时刻与「现在」无关（refresh 推不动它）', d1 === d2)
  check('截止 = 激活时刻 + 窗口（24h）', d1 === t0.getTime() + 24 * 3600_000)
  check('窗口时长按配置生效（48h）', demoDeadlineMs(policy(t0, 48)) === t0.getTime() + 48 * 3600_000)
  check('isDemoPhone：白名单号 ⇒ true', isDemoPhone(policy(t0), '13800000000') === true)
  check('isDemoPhone：非白名单号 ⇒ false', isDemoPhone(policy(t0), '13900000000') === false)
  check('isDemoPhone：空串 / undefined ⇒ false', isDemoPhone(policy(t0), '') === false && isDemoPhone(policy(t0), undefined) === false)
  check('★★ 空白名单 ⇒ 任何号都不是演示号（空 ≠ 所有号）', isDemoPhone(policy(t0, 24, []), '13800000000') === false)
}

// ───────────── ⑤ 接线态：谁能签发 token，谁就必须过闸门 ─────────────

console.log('\n⑤ 接线态（读源码：闸门必须在签发之前，且 refresh 也得过）')
{
  const svc = await src('src/auth/auth.service.ts')
  const mw = await src('src/middleware/auth.ts')
  const routes = await src('src/routes/auth.ts')
  const jwtSrc = await src('src/lib/jwt.ts')

  check('jwt：AccessTokenPayload 带 dst 声明', /interface AccessTokenPayload[\s\S]{0,600}?dst\?: number/.test(jwtSrc))
  check('jwt：signRefresh 接受 dst 形参', /export function signRefresh\([^)]*dst\?: number/.test(jwtSrc))
  check(
    'jwt：signRefresh 把 dst 写进 payload（★★ 漏了它 refresh 就能突破窗口）',
    /typ: 'refresh'[\s\S]{0,80}?\.\.\.\(dst \? \{ dst \}/.test(jwtSrc),
  )

  const body = fnBody(svc, 'async function buildLoginResult')
  check('auth.service：能定位到 buildLoginResult 函数体', !!body)
  check(
    'auth.service：buildLoginResult 过演示闸门',
    !!body && body.includes('demoSessionDeadline(prisma, merchant.phone)'),
  )
  check(
    'auth.service：★★ 闸门排在 signAccess **之前**（否则会发出 dst 早已过期的 token）',
    !!body && body.indexOf('demoSessionDeadline') >= 0 && body.indexOf('demoSessionDeadline') < body.indexOf('signAccess('),
  )
  check('auth.service：dst 真写进了 access（不是算完就丢）', !!body && /signAccess\(\{[\s\S]{0,240}?dst: demoDst/.test(body))
  check('auth.service：dst 真写进了 refresh', !!body && /signRefresh\(merchant\.id, demoDst\)/.test(body))
  const sinks = svc.split('return buildLoginResult(prisma, merchant)').length - 1
  check(
    'auth.service：四条签发路径全汇入 buildLoginResult（微信 / 短信 / 刷新 / 开发登录）',
    sinks >= 4,
    `实际 ${sinks} 处`,
  )
  check('auth.service：★ 只有 buildLoginResult 一处签发 token（别处不得签）', (svc.match(/signAccess\(/g) ?? []).length === 1)

  check('middleware：调 demoDeadlinePassed 判死', mw.includes('demoDeadlinePassed(p.dst)'))
  check(
    'middleware：DemoExpiredError 单独回 1006（不并进 1001）',
    /instanceof DemoExpiredError[\s\S]{0,200}?fail\(res, 1006/.test(mw),
  )
  check(
    'middleware：1006 的分支排在通用 1001 兜底之前',
    mw.indexOf('1006') > 0 && mw.indexOf('1006') < mw.lastIndexOf("fail(res, 1001"),
  )

  const n1006 = routes.split('fail(res, 1006').length - 1
  check('routes/auth：四条入口都把 DemoExpiredError 映射成 1006', n1006 === 4, `实际 ${n1006}`)
  check(
    'routes/auth：/login 不再把一切都吞成 1002',
    /instanceof DemoExpiredError[\s\S]{0,200}?1002/.test(routes),
  )
  check(
    'routes/auth：/refresh 也认这个错（★ 续命通道是重点）',
    /auth\/refresh|refresh\(prisma, refreshToken\)[\s\S]{0,600}?1006/.test(routes),
  )

  const miniReq = await file('apps/mini/src/services/request.ts')
  check('mini：ERROR_TEXT 里有 1006 的文案', /1006: '[^']+'/.test(miniReq))
  check('mini：1006 分支清本地登录态', /code === 1006[\s\S]{0,400}?clearLoginState\(\)/.test(miniReq))
  check('mini：1006 分支回登录页', /code === 1006[\s\S]{0,500}?redirectToLogin\(\)/.test(miniReq))
  check(
    'mini：1006 分支排在「code === 0 直接返回」之前（否则永远走不到）',
    miniReq.indexOf('code === 1006') >= 0 &&
      miniReq.indexOf('code === 1006') < miniReq.indexOf('if (body?.code === 0) return body.data as T'),
  )
}

// ───────────── ⑥ 业务码不冲突：1006 只属于演示账号 ─────────────

console.log('\n⑥ 业务码归属（1006 只允许出现在演示账号这条线上）')
{
  const allowed = new Set([
    'src/routes/auth.ts',
    'src/middleware/auth.ts',
    'src/lib/demo-account.ts',
    'src/auth/auth.service.ts',
  ])
  const hits: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(join(here, '..', dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) await walk(rel)
      else if (e.name.endsWith('.ts')) {
        const text = await src(rel)
        if (/\b1006\b/.test(text)) hits.push(rel)
      }
    }
  }
  await walk('src')
  const unexpected = hits.filter((h) => !allowed.has(h))
  check('server/src 里 1006 只出现在演示账号相关的 4 个文件', unexpected.length === 0, unexpected.join(', '))
  check('1006 确实已经接线（不是只写在注释里）', hits.length >= 3, hits.join(', '))
}

// ───────────── ⑦ 运行时真调 JWT：dst 能往返、普通账号不带 ─────────────

console.log('\n⑦ 运行时真调（token 里的 dst 必须能往返，普通账号必须不受影响）')
{
  const demo = verifyToken<{ mid: string; dst?: number }>(signAccess({ mid: '42', phone: '13800000000', dst: 2_000_000_000 }))
  check('access token 的 dst 能往返', demo.dst === 2_000_000_000)
  const plain = verifyToken<{ mid: string; dst?: number }>(signAccess({ mid: '42', phone: '13800000000' }))
  check('★ 普通账号的 access token **不带** dst（零行为变化）', plain.dst === undefined)
  check('refresh token 的 dst 能往返', verifyToken<{ dst?: number }>(signRefresh(42, 2_000_000_000)).dst === 2_000_000_000)
  check('★ 普通账号的 refresh token 不带 dst', verifyToken<{ dst?: number }>(signRefresh(42)).dst === undefined)

  const pastDst = Math.floor(Date.now() / 1000) - 1
  const past = verifyToken<{ dst?: number }>(signAccess({ mid: '42', phone: '13800000000', dst: pastDst }))
  check('端到端：已过去的 dst ⇒ 判为过期（中间件据此回 1006）', demoDeadlinePassed(past.dst) === true)
  const futureDst = Math.floor(Date.now() / 1000) + 3600
  const future = verifyToken<{ dst?: number }>(signAccess({ mid: '42', phone: '13800000000', dst: futureDst }))
  check('端到端：未到点的 dst ⇒ 不判过期', demoDeadlinePassed(future.dst) === false)
}

console.log(`\n通过 ${pass} · 失败 ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exitCode = 1
}
