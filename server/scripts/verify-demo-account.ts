// 「演示账号（全局一次性窗口）」守护断言。纯计算 + 源码静态检查，不碰数据库、不渲染、不联网。
//                                                        （`npm run demo-account:verify`）
//
// ★★ 这里防的是四类**完全静默**的回归 —— 它们的共同特征是「不报错，只是行为变了」：
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
//   ④ **固定登录码退化成「留空即万能码」**：`login_code` 留空/写坏时若被读成「不校验」，
//      **任何 6 位码都能登进演示账号**；而码值打进日志则等于把演示号公开。
//      两个方向都不报错。见第 ⑤ 节。
//
// 所以断言分两层：
//   · **纯计算层**：直接调 `parseDemoPhones` / `parseDemoConfig` / `parseDemoLoginCode` /
//     `demoLoginCode` / `describeDemoPolicy` / `demoDeadlinePassed` /
//     `demoDeadlineMs` / `isDemoPhone` 这些真函数，看它们**算出来的结果**；
//   · **接线层**：读源码，断言「谁在什么时候调了它」—— 这一层无法靠调函数证明，
//     因为「闸门在签发 token 之前」「两边用同一个判据函数」都是调用点的属性，不在函数体内。
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEMO_DEFAULT_WINDOW_HOURS,
  demoDeadlineMs,
  demoDeadlinePassed,
  demoLoginCode,
  describeDemoPolicy,
  isDemoPhone,
  parseDemoConfig,
  parseDemoLoginCode,
  parseDemoPhones,
  type DemoPolicy,
} from '../src/lib/demo-account.js'
import { MERCHANT_DEMO_LOGIN_POLICY, adminUserKey, merchantDemoLoginKey } from '../src/lib/login-throttle.js'
import { signAccess, signRefresh, verifyToken } from '../src/lib/jwt.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const src = (rel: string) => readFile(join(here, '..', rel), 'utf8')

let pass = 0
let skipped = 0
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
 * 显式跳过（**只能**用在「本机没有权威的客户端源码」这一种情况，见下面第 ⑥ 节末）。
 * ★ 刻意做成独立的计数器并打进总结行：跳过的数量必须**看得见**。
 *   如果让「文件读不到」静默算通过，那删掉文件就能让守护变绿 —— 这是最典型的假绿。
 */
function skip(name: string, n: number): void {
  skipped += n
  console.log(`  ○ SKIP ${name}（共 ${n} 条）`)
}

/**
 * 抠出一个**函数声明**的函数体（按花括号配平）。
 *
 * ⚠ 不能直接取「声明之后第一个 `{`」—— 参数表里可能有内联对象类型
 *   （`processTask(task: { id: bigint; ... })`），那会把参数类型当成函数体，
 *   于是断言在几行片段上跑：「能定位到函数」通过、**实际什么都没查**。
 *   正解：先跳过参数表到**配平的右括号**，再从返回类型里找函数体的 `{`。
 *
 * ⚠⚠ 只看「第一个 `{`」还不够：**返回类型自己也可能带花括号**。本项目就有一例 ——
 *   `sendCode(...): Promise<{ cooldownSec: number; demoLogin?: boolean }>`。
 *   第一版在这里用了一条正则 `^\s*(?::\s*[^{]*)?\{`，它会在 `Promise<` 之后就撞上那个 `{`
 *   ⇒ `fnBody` 返回的是**内联对象类型** `{ cooldownSec: number; demoLogin?: boolean }`：
 *   非 null（所以「能定位到函数体」一栏通过），但内容完全不对（真正的断言全落空）。
 *   这就是「守护看似在跑、其实什么都没查」的典型形态。
 *   现在改为**跟踪尖括号深度**：只有深度回到 0 之后的 `{` 才是函数体。
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
  let angle = 0
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j]
    if (ch === '<') angle++
    else if (ch === '>') {
      // `=>` 是箭头函数的箭头，不是泛型定界符
      if (text[j - 1] === '=') continue
      angle--
    } else if (ch === ';' && angle <= 0) {
      // 只有类型、没有函数体（`declare function` / 重载签名）
      return null
    } else if (ch === '{' && angle <= 0) {
      let d = 0
      for (let k = j; k < text.length; k++) {
        const c = text[k]
        if (c === '{') d++
        else if (c === '}') {
          d--
          if (d === 0) return text.slice(j, k + 1)
        }
      }
      return null
    }
  }
  return null
}

const policy = (
  activatedAt: Date | null,
  windowHours = 24,
  phones = ['13800000000'],
  loginCode: string | null = null,
): DemoPolicy => ({
  phones: new Set(phones),
  windowHours,
  activatedAt,
  loginCode,
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

  // ── 固定登录码（`login_code`）也属于「配置解析」──────────────────────
  check(
    '★ login_code 是 6 位数字 ⇒ 保留',
    parseDemoConfig(JSON.stringify({ phones: ['13800000000'], login_code: '654321' })).loginCode === '654321',
  )
  check(
    '★★ 没配 login_code ⇒ null（**不是**「任何码都行」）',
    parseDemoConfig(JSON.stringify({ phones: ['13800000000'] })).loginCode === null,
  )
  check(
    '★★ login_code 留空 ⇒ null（空串不许被当成「不校验」）',
    parseDemoConfig(JSON.stringify({ phones: ['13800000000'], login_code: '' })).loginCode === null,
  )
  check(
    '★ 整串不是 JSON（只填手机号列表）⇒ 无固定码',
    parseDemoConfig('13800000000').loginCode === null,
  )
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

// ───────────── ⑤ 固定登录码：形态 / 生效条件 / 不泄漏 / 限速 ─────────────

console.log('\n⑤ 固定登录码（★★ 它是可重复使用的共享码，与一次性短信码的语义相反）')
{
  /**
   * ★★ 这一节的四条断言各自对应一种**不报错的坏结果**：
   *   · 留空被当成「不校验」⇒ 任何 6 位码都能登进演示账号（最坏）；
   *   · 超长/带空格被接受 ⇒ 配了却永远匹配不上，运营只看到「验证码错误」；
   *   · 码值被打进日志 ⇒ 谁看得见日志谁就能用演示号（describer 会写进日志）；
   *   · 没有限速 ⇒ 6 位固定码「10^6 次以内必中」，窗口期内是可以穷举完的。
   */
  for (const junk of ['', '   ', '12345', '1234567', 'abcdef', 'true', '12 456', '12345a', '０１２３４５', 'null']) {
    check(`形态非法 ${JSON.stringify(junk)} ⇒ null（回落短信验证码）`, parseDemoLoginCode(junk) === null)
  }
  check('legit：6 位数字保留', parseDemoLoginCode('123456') === '123456')
  check('legit：两端空格被 trim 后保留（后台粘贴常态）', parseDemoLoginCode(' 123456 ') === '123456')
  check('undefined / null 入参 ⇒ null（不抛异常）', parseDemoLoginCode(undefined) === null && parseDemoLoginCode(null) === null)
  check('数字类型入参 123456（JSON 里写成数字）⇒ 保留', parseDemoLoginCode(123456) === '123456')

  // ── 生效条件：两条**同时**成立 ────────────────────────────────────────
  const on = policy(null, 24, ['13800000000'], '654321')
  check('★★ 白名单命中 ∧ 已配码 ⇒ 该号用固定码', demoLoginCode(on, '13800000000') === '654321')
  check('★ 白名单外的号 ⇒ null（普通号零行为变化）', demoLoginCode(on, '13900000000') === null)
  check('★★ 白名单为空 ⇒ null（空 ≠ 所有号，与 phones 的老口径一致）', demoLoginCode(policy(null, 24, [], '654321'), '13800000000') === null)
  check('★★ 没配码 ⇒ null（不会退化成「什么码都收」）', demoLoginCode(policy(null, 24, ['13800000000'], null), '13800000000') === null)
  check('空手机号 / undefined ⇒ null', demoLoginCode(on, '') === null && demoLoginCode(on, undefined) === null)

  // ── 绝不泄漏码值：describeDemoPolicy 的产物会被写进日志 ────────────────
  const FAKE = '987654'
  const labelNotStarted = describeDemoPolicy(policy(null, 24, ['13800000000'], FAKE))
  const labelRunning = describeDemoPolicy(policy(new Date(), 24, ['13800000000'], FAKE))
  const labelNoPhones = describeDemoPolicy(policy(null, 24, [], FAKE))
  const leaky = [labelNotStarted, labelRunning, labelNoPhones]
  check('★★ describeDemoPolicy 只说「有没有配」、**绝不打印码值**（它会被写进日志）', leaky.every((s) => !s.includes(FAKE)), leaky.join(' | '))
  check('describeDemoPolicy：配了码 ⇒ 有「已配置」字样', labelNotStarted.includes('固定登录码已配置'))
  check('describeDemoPolicy：没配码 ⇒ 有「无固定登录码」字样', describeDemoPolicy(policy(null)).includes('无固定登录码'))

  // ── 限速策略（★ 直接读真常量，不比字符串）────────────────────────────
  check(
    '★ 演示固定码有独立限速策略（不是靠短信那条路自带的 5 次作废）',
    !!MERCHANT_DEMO_LOGIN_POLICY && typeof MERCHANT_DEMO_LOGIN_POLICY.maxFailures === 'number',
  )
  check(
    `★ 阈值落在 [5,50] 之间（现值 ${MERCHANT_DEMO_LOGIN_POLICY.maxFailures}）：太低会让「一个人手滑」锁住所有试用者，太高则穷举可行`,
    MERCHANT_DEMO_LOGIN_POLICY.maxFailures >= 5 && MERCHANT_DEMO_LOGIN_POLICY.maxFailures <= 50,
  )
  check('★ 窗口有明确长度（= 锁定时长）', MERCHANT_DEMO_LOGIN_POLICY.windowSec > 0 && MERCHANT_DEMO_LOGIN_POLICY.windowSec <= 3600)
  check(
    '★★ 计数键按**手机号**、且与后台登录的键名**不同**（拿错 helper 会静默清不掉）',
    merchantDemoLoginKey('13800000000').includes('13800000000') &&
      merchantDemoLoginKey('13800000000') !== adminUserKey('13800000000'),
  )
}

// ───────────── ⑥ 接线态：谁能签发 token，谁就必须过闸门 ─────────────

console.log('\n⑤ 接线态（读源码：闸门必须在签发之前，且 refresh 也得过）')
{
  const svc = await src('src/auth/auth.service.ts')
  const mw = await src('src/middleware/auth.ts')
  const routes = await src('src/routes/auth.ts')
  const jwtSrc = await src('src/lib/jwt.ts')

  /**
   * ★★ 先把 `fnBody` 自己钉住。
   *
   * 这一条是**被真实事故逼出来的**：`sendCode` 的返回类型是 `Promise<{ cooldownSec: number }>`，
   * 而老版 `fnBody` 会在这里返回那个**内联对象类型**（非 null ⇒「能定位到函数体」通过，
   * 但下面所有断言都跑在几行类型声明上 ⇒ 全部落空）。守护看上去全绿、实际一条没查。
   * 所以这里用一段最小样本把「返回类型带内联对象」这一形态固定下来。
   */
  const fnSample = 'export async function f(a: number): Promise<{ x: number }> { return { x: a } }'
  check(
    '★★ fnBody 自检：返回类型是 `Promise<{...}>` 时也要取到**函数体**，不能取到那个内联对象类型',
    fnBody(fnSample, 'export async function f') === '{ return { x: a } }',
    String(fnBody(fnSample, 'export async function f')),
  )
  check(
    '★ fnBody 自检：参数表里的内联对象类型不许被当成函数体',
    fnBody('export function g(t: { id: string }): number { return 1 }', 'export function g') === '{ return 1 }',
  )
  check(
    '★ fnBody 自检：`=>` 里的 `>` 不参与尖括号计数（箭头函数不能把身体切错）',
    fnBody('export const h = (n: number): string => { return String(n) }', 'export const h') === '{ return String(n) }',
  )

  /**
   * `/login` 那一段的源码切片。**只在这一段里**断言，避免「同名串在别处也命中」
   * （例如 `DemoExpiredError` 出现在 import 行里，用全文 `indexOf` 比较顺序会假绿）。
   */
  const loginRouteFrom = routes.indexOf("router.post('/login'")
  const loginRouteTo = routes.indexOf("router.post('/wechat-login'")
  const loginRoute =
    loginRouteFrom >= 0 && loginRouteTo > loginRouteFrom ? routes.slice(loginRouteFrom, loginRouteTo) : ''

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
    'routes/auth：★ /login 里到期错误**单独判**（1006 在前、1002 只作兜底），不再一并吞成 1002',
    /instanceof DemoExpiredError[\s\S]{0,80}?fail\(res, 1006/.test(loginRoute) &&
      loginRoute.lastIndexOf('fail(res, 1002') > loginRoute.indexOf('instanceof DemoExpiredError'),
  )
  check(
    'routes/auth：/refresh 也认这个错（★ 续命通道是重点）',
    /auth\/refresh|refresh\(prisma, refreshToken\)[\s\S]{0,600}?1006/.test(routes),
  )

  /**
   * ── 固定登录码的接线 ────────────────────────────────────────────────
   *
   * ★★ 这一组里最要紧的是**两处用同一个函数**（`demoLoginCode`）。
   *   若 `sendCode` 与 `loginByPhone` 各写一份判断，就会出现最典型的静默死锁：
   *   发码那边认为「这个号用固定码」于是不发短信，登录那边认为「不用固定码」
   *   于是去查 `smsCode` 表 —— 表里空 ⇒ 用户看到「验证码错误或已过期」，
   *   而**没有任何一处代码看起来是错的**。
   */
  const sms = await src('src/auth/sms.ts')

  const loginFn = fnBody(svc, 'export async function loginByPhone')
  check('auth.service：能定位到 loginByPhone 函数体', !!loginFn)
  check('auth.service：★ loginByPhone 接入 demoLoginCode', !!loginFn && loginFn.includes('demoLoginCode('))
  check(
    'auth.service：★★ 短信 verifyCode 排在固定码分支**之后**（固定码是主路、短信是回落）',
    !!loginFn && loginFn.indexOf('verifyCode(') > loginFn.indexOf('if (demoCode)'),
  )
  check(
    'auth.service：★★ 固定码这条路**完全不碰 smsCode 表**（那是「用掉即废」的一次性表，演示码要反复用）',
    !!loginFn && !loginFn.includes('smsCode'),
  )
  check(
    'auth.service：★ 先查限速、再比对码值（已锁住的请求不去比对）',
    !!loginFn && loginFn.indexOf('checkLoginAllowed(') < loginFn.indexOf('code !== demoCode'),
  )
  check(
    'auth.service：★★ 码错 ⇒ recordLoginFailure；码对 ⇒ clearDemoLoginFailures（★ 不清零会「明明登成功了却越试越紧」）',
    !!loginFn &&
      loginFn.indexOf('recordLoginFailure(') > loginFn.indexOf('code !== demoCode') &&
      loginFn.indexOf('clearDemoLoginFailures(') > loginFn.indexOf('code !== demoCode'),
  )
  check(
    'auth.service：限速用的是演示码专属策略（不是后台登录那套阈值）',
    !!loginFn && loginFn.includes('MERCHANT_DEMO_LOGIN_POLICY'),
  )

  const sendFn = fnBody(sms, 'export async function sendCode')
  check('sms：能定位到 sendCode 函数体', !!sendFn)
  check('sms：★ sendCode 也接入 demoLoginCode（★★ 两处必须是同一个函数）', !!sendFn && sendFn.includes('demoLoginCode('))
  check(
    'sms：★★ 演示号在**建 smsCode 记录之前**返回（否则白白占配额、还可能真发一条用不上的短信）',
    !!sendFn && sendFn.indexOf('if (demoCode)') > 0 && sendFn.indexOf('if (demoCode)') < sendFn.indexOf('smsCode.create'),
  )

  // ── /login 路由：补传 redis、并把「被锁」映射成 1003 ─────────────────
  check('routes/auth：能定位到 /login 处理器', loginRoute.length > 0)
  check(
    '★ routes/auth：/login 把 redis 传给了 loginByPhone（固定码限速需要它）',
    /loginByPhone\(prisma,\s*redis,/.test(loginRoute),
  )
  check(
    'routes/auth：★★ DemoLoginThrottledError 单独映射（不并进 1002，否则用户以为只是码打错了）',
    /instanceof DemoLoginThrottledError[\s\S]{0,200}?fail\(res, 1003/.test(loginRoute),
  )
  check(
    'routes/auth：★★ 「已到期」(1006) 判在「被锁」(1003) **之前**（窗口关了就该说到期，别让人白等一轮限速）',
    loginRoute.indexOf('instanceof DemoExpiredError') >= 0 &&
      loginRoute.indexOf('instanceof DemoExpiredError') < loginRoute.indexOf('instanceof DemoLoginThrottledError'),
  )
  check(
    'routes/auth：两个分支都排在 1002 兜底之前（否则永远走不到）',
    loginRoute.indexOf('instanceof DemoLoginThrottledError') > 0 &&
      loginRoute.indexOf('instanceof DemoLoginThrottledError') < loginRoute.lastIndexOf('fail(res, 1002'),
  )

  /**
   * ── 客户端那一半：**只在源码权威时才判** ──────────────────────────────
   *
   * ★ 这个守护跨了两个包（server + apps/mini），而**部署机上的 apps/mini 只是一份滞后副本**：
   *   小程序包是在开发机 `build:weapp:prod` 打好之后整包上传的，部署机的源码树从来不跟着走。
   *   第一版把它们写成无条件断言 ⇒ 在服务器上跑必然红 4 条，而那是**假报警**：
   *   它报的不是「客户端漏改了」，而是「这台机器上没有权威的客户端源码」。
   *   守护一旦出现固定的假红，就会被人忽略 —— 比没有守护更糟。
   *
   * ★ 所以判据分三层，且**跳过的条件必须窄到只有"源码不权威"这一种**：
   *   ① 客户端源码不存在 ⇒ 跳过（部署机上确实可能没有 apps/）；
   *   ② 存在但没有 1006 ⇒ 用 **mtime** 分辨：客户端文件比本特性的服务端模块**还旧** ⇒ 滞后副本，跳过；
   *      比它**新**却仍无 1006 ⇒ **真的漏改了**，判红（这是唯一能让跳过程序退化成红的分支，
   *      所以 mtime 只在"要不要跳过"这一处使用，且默认倒向"判红"）。
   *   ③ 存在且有 1006 ⇒ 严格断言（正常情况，本机就是这一支）。
   */
  // ★ `DEMO_GUARD_MINI` 只为**测试「跳过 / 判红」这两个分支**而存在（见下面三层的说明）：
  //   否则「客户端漏改 1006 ⇒ 判红」这条唯一真正的防线**没有办法被验证**，
  //   一条没被验证过的分支等于没有。它只改**读哪个文件**，不改任何判据。
  const miniPath = process.env.DEMO_GUARD_MINI ?? join(repo, 'apps/mini/src/services/request.ts')
  let miniReq: string | null = null
  try {
    miniReq = await readFile(miniPath, 'utf8')
  } catch {
    miniReq = null
  }

  /** 客户端侧的四条断言（只在源码权威时执行） */
  const miniChecks = (): Array<[string, boolean]> => [
    ['mini：ERROR_TEXT 里有 1006 的文案', /1006: '[^']+'/.test(miniReq ?? '')],
    ['mini：1006 分支清本地登录态', /code === 1006[\s\S]{0,400}?clearLoginState\(\)/.test(miniReq ?? '')],
    ['mini：1006 分支回登录页', /code === 1006[\s\S]{0,500}?redirectToLogin\(\)/.test(miniReq ?? '')],
    [
      'mini：1006 分支排在「code === 0 直接返回」之前（否则永远走不到）',
      (miniReq ?? '').indexOf('code === 1006') >= 0 &&
        (miniReq ?? '').indexOf('code === 1006') < (miniReq ?? '').indexOf('if (body?.code === 0) return body.data as T'),
    ],
  ]

  if (miniReq === null) {
    skip('客户端源码不存在（本机没有 apps/mini：守护跨 server + mini，只能在完整仓库根判定）', 4)
  } else if (!miniReq.includes('1006')) {
    const [clientStat, featureStat] = await Promise.all([
      stat(miniPath),
      stat(join(here, '..', 'src/lib/demo-account.ts')),
    ])
    if (clientStat.mtimeMs < featureStat.mtimeMs) {
      skip('客户端源码比本特性更旧（部署机上的滞后副本，包在开发机打好后整包上传）', 4)
    } else {
      for (const [name, cond] of miniChecks()) check(name, cond, '客户端比服务端模块新，却仍然没有 1006 ⇒ 真的漏改了')
    }
  } else {
    for (const [name, cond] of miniChecks()) check(name, cond)
  }
}

// ───────────── ⑦ 业务码不冲突：1006 只属于演示账号 ─────────────

console.log('\n⑦ 业务码归属（1006 只允许出现在演示账号这条线上）')
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

// ───────────── ⑧ 运行时真调 JWT：dst 能往返、普通账号不带 ─────────────

console.log('\n⑧ 运行时真调（token 里的 dst 必须能往返，普通账号必须不受影响）')
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

console.log(`\n通过 ${pass} · 失败 ${failures.length}${skipped ? ` · 跳过 ${skipped}` : ''}`)
if (skipped) {
  // ★ 跳过必须**看得见**，并且只在「本机没有权威的客户端源码」时允许。
  //   如果你正在改客户端，这个跳过必须变成 PASS —— 否则它就是一块遮住真问题的布。
  console.log(`※ 跳过 ${skipped} 条：本机的客户端源码不是权威副本（部署机上 apps/mini 是滞后副本）。`)
  console.log('  在完整仓库根（同时有 server/ 与 apps/mini/ 的那台机器）上跑，应当 0 跳过。')
}
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exitCode = 1
}
