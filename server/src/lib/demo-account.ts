// 演示账号（demo account）：**多端可登录**，但整个账号只有一段**全局一次性**的可用窗口。
//
// ── 语义（产品口径，2026-09-29 与需求方确认）────────────────────────
//   · 窗口从「**首次使用**」算，**不是**从每次登录算。任一设备第一次登录演示账号那一刻
//     激活窗口；此后窗口内所有设备都能登录；窗口一过，**任何设备都无法再登录**，
//     必须人工重置（把 `demo.config` 的 window 重新对齐 / 改 `demo.activated_at` /
//     删掉 `demo.activated_at` 那一行 = 下次登录重新激活）。
//   · 多端登录**不需要**额外支持：本项目的 JWT 是无状态的（见 lib/jwt.ts），服务端
//     不存会话 —— 同一账号本来就允许多端同时在线，服务端**也没有踢人能力**。
//     所以「到点自动退出」不能靠服务端主动踢，只能靠「token 里带绝对截止 + 每次请求校验」。
//
// ── ★★ 固定登录验证码（`login_code`）：演示号**不需要点「获取验证码」**────────────
//   演示账号是发给客户当场试的，让他去等一条短信（签名没过审还根本发不出来）是纯粹的阻力。
//   所以 `demo.config` 里多一个 `login_code`：配了它，**白名单号**就能用这枚码直接登录，
//   且 `sendCode()` 对该号**不发短信、不落记录**。
//
//   ★★ 它与短信验证码的语义**相反**，这是本设计最要紧的一点：
//       短信码 = 一次性（`smsCode.usedAt` 用掉即废、5 分钟过期、错 5 次作废）；
//       演示码 = **可重复使用的共享码**（同一个码要给多个试用者、在整段窗口内反复用）。
//     ⇒ 它**绝不能**走 `smsCode` 表。想「复用短信流程、只是把码值换成固定的」是不行的：
//       那样第一次登录就把记录消费掉了，第二次又得去点「获取验证码」—— 正是要避免的事。
//       （对照：`SMS_TEST_CODE` 后门就是「只换码值、仍要求先发码」，所以它解决不了这个需求。）
//
//   ★★ 因此**必须**配失败限速：6 位固定码不限速就是「10^6 次以内必中」。
//       策略在 `lib/login-throttle.ts` 的 `MERCHANT_DEMO_LOGIN_POLICY`，
//       判据接在 `auth.service.ts::loginByPhone`（那里也写了为什么只对演示号生效）。
//
//   ★ 三道闸门，缺一即关（与 `SMS_TEST_CODE` 同一套纪律）：
//       ① 白名单命中（`phones` 解析后为空 ⇒ 整体关闭，绝不是「所有号」）；
//       ② 码必须是**恰好 6 位数字**（留空 / 5 位 / `true` / 带空格 一律作废）；
//       ③ 两者**同时**成立才生效 —— 缺任一条 ⇒ 该号回落到正常短信验证码。
//     ⇒ 「留空 = 万能码」「任意号输固定码就登」这两件事在本设计里**表达不出来**。
//
//   ★ 它**不豁免**窗口：码对了照样要走 `buildLoginResult()` 里那道 `dst` 闸门。
//     两个机制是叠加的 —— 码让人进得来，窗口保证他待不久。
//
//   ⚠ 演示号一旦配了 `login_code`，**真实短信码对它不再生效**（分支不再查 `smsCode` 表）。
//     这是刻意的：否则「固定码 + 短信码」两条路并存，限速就被绕过了一半。
//     想让某个号改回短信登录：把 `login_code` 留空即可。
//
// ── 为什么截止时间写进 token（`dst` claim），而不是每次查库 ─────────────
//   ① 鉴权中间件零额外查询即可判死（merchant 表那次查询本来就有，不该再加一次设置读取）；
//   ② 不受 settings 的 60s 进程内缓存影响 ⇒ 到点**立即**生效，不会出现「缓存还没过期所以还能用」。
//   ⚠ 代价：窗口内改配置或重置 `activated_at`，只影响**此后新签发**的 token；
//     已签发的 token 仍按旧截止执行。这是刻意的 —— 否则运营误改一次会让在线的演示端忽活忽死。
//
// ── ★★ 为什么必须是「绝对截止」而不是「滑动过期」────────────────────
//   原会话是 access 2h / refresh 30d，而 `/auth/refresh` 每次都换发新的 refresh
//   （见 auth.service.ts::buildLoginResult）⇒ 只要 30 天内有**一次**活跃，会话就能
//   **无限续下去**，实质是永不过期。演示账号若沿用滑动过期，
//   「24h 后自动退出」永远不会发生。所以截止时刻只能由「激活时刻 + 窗口」算出来，
//   refresh 只是重签同一个截止时刻，**不能把它往后推**。
//
// ── 为什么存 system_setting，而不是给 merchant 加字段 ───────────────────
//   `demo.config` 是配置（后台「系统配置」页直接改）；`demo.activated_at` 是
//   **运行时状态**（首次登录时由代码写入）。放 system_setting 的代价是「状态与配置混在
//   一张表」，换来的是**零 schema 迁移** —— 本项目 schema 变更要走 db-baseline + deploy.sh，
//   对一个演示账号不成比例。
//
// ── ★★ 为什么配置是**一条 JSON** 而不是两条 STRING ─────────────────────
//   与「首页轮播图」「联系我们」同一个理由（见 prisma/seed.ts 里的长注释）：
//   后台写配置走 `POST|PUT /admin/api/v1/settings`，其 schema 是 `settingVal: z.string().min(1)`
//   —— **不允许存空串**。若 `phones` 单独一行，运营想「关掉演示」就只能存空串 ⇒ 400，
//   页面上只显示「保存失败」而看不出原因。一条 JSON 天然没有这个洞：
//   清空后是 `{"phones":[],"window_hours":24}`，长度远大于 1。

import type { Prisma } from '@prisma/client'
import { getString, invalidate } from './settings.js'

/** settings 读取所需的数据库能力。与 lib/settings.ts 同一口径：PrismaClient 是它的结构超集。 */
type DemoDb = Prisma.TransactionClient

export const DEMO_GROUP = 'demo'
export const DEMO_CONFIG_KEY = 'config'
export const DEMO_ACTIVATED_AT_KEY = 'activated_at'

/** 演示窗口默认时长（小时）。仅当配置缺失/非法时兜底。 */
export const DEMO_DEFAULT_WINDOW_HOURS = 24

/**
 * 演示账号已到期。
 *
 * ★★ 必须是能被**单独识别**的错误，路由层要把它映射成 **1006**，绝不能并进 1001
 *   「登录已过期，请重新登录」—— 那句话会让用户去重新登录，而重新登录也**一定**失败
 *   （窗口是全局一次性的）⇒ 用户陷在「登了就被踢」的死循环里，永远看不到真正的原因。
 */
export class DemoExpiredError extends Error {
  readonly code = 'DEMO_EXPIRED'
  constructor() {
    super('演示账号已到期，请联系管理员')
    this.name = 'DemoExpiredError'
  }
}

/**
 * 演示账号的**固定登录码**猜错次数过多，被限速锁住。
 *
 * ★ 为什么不能让它安静地返回 1002「验证码错误」：固定码是 6 位且**可重复使用**的，
 *   没限速就是「穷举必中」。这条错误让「被锁住」与「码输错了」在客户端可区分，
 *   否则试用者会一直重试、永远不知道为什么那个明明正确的码突然不管用了。
 * ★ 文案里**必须带还要等多久**：只报「失败」会让人立刻再试一次。
 */
export class DemoLoginThrottledError extends Error {
  readonly code = 'DEMO_LOGIN_THROTTLED'
  constructor(readonly retryAfterSec: number) {
    const minutes = Math.max(1, Math.ceil(retryAfterSec / 60))
    super(`验证码错误次数过多，请 ${minutes} 分钟后再试`)
    this.name = 'DemoLoginThrottledError'
  }
}

export interface DemoPolicy {
  /**
   * 白名单手机号（已解析、去重）。
   * ★★ **空集合 = 演示功能整体关闭**，绝不等价于「所有号都算演示账号」。
   *   （同类教训：固定测试码后门的白名单「留空」也曾被误读成「所有号」。）
   */
  phones: Set<string>
  windowHours: number
  /** 窗口启用时刻；null = 尚未启用（第一台设备登录演示账号时才激活） */
  activatedAt: Date | null
  /**
   * 演示号的**固定登录验证码**；null = 未配置 ⇒ 该号仍走正常短信验证码。
   *
   * ★★ 这是一枚**可重复使用的共享码**，与一次性短信码的语义相反 ——
   *   所以本文件只负责「这一号该不该用固定码」，真正的比对与限速在
   *   `auth.service.ts::loginByPhone`，**不经过 smsCode 表**。
   */
  loginCode: string | null
}

/**
 * 解析手机号白名单（接受数组，也接受逗号分隔的长串）。
 *
 * ★ 同时吃中文逗号 / 分号 / 换行：后台是人工填的，中英文标点混用是常态。
 *   只认英文逗号会得到「配了却不生效、且毫无提示」——最典型的静默失效。
 * ★ 只认 11 位手机号：任何非法片段（`-`、`none`、空串、多余空格）都不构成白名单项，
 *   所以把 phones 改成任意非手机号文本就等于**关掉演示**。
 */
export function parseDemoPhones(raw: string | unknown[]): Set<string> {
  const text = Array.isArray(raw) ? raw.join(',') : String(raw ?? '')
  const out = new Set<string>()
  for (const part of text.split(/[,，;；\s]+/)) {
    const p = part.trim()
    if (/^1\d{10}$/.test(p)) out.add(p)
  }
  return out
}

/**
 * 解析固定登录码。
 *
 * ★★ **恰好 6 位数字**，别的什么都不认。这是安全判据、不是格式洁癖：
 *   `''` / `'  '` / `'12345'` / `'1234567'` / `'abcdef'` / `'true'` / `12 456`
 *   全都必须落成 `null`（= 该号回落到短信验证码）。否则会出现两种都不报错的坏结果：
 *   · 留空被当成「不校验」⇒ **任何 6 位码都能登进演示账号**（最坏的一种）；
 *   · 超长 / 带空格的码永远匹配不上 ⇒ 配了却登不进，运营只看到「验证码错误」。
 *   （同 `SMS_TEST_CODE` 的老教训：码值形态必须自己判，别指望配置的人写对。）
 */
export function parseDemoLoginCode(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  return /^\d{6}$/.test(s) ? s : null
}

function parseIso(raw: string): Date | null {
  if (!raw || !raw.trim()) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t) : null
}

/**
 * 解析 `demo.config`。
 *
 * ★ 容错口径（宁可多认一点，也不要静默失效）：
 *   · 合法 JSON 对象 ⇒ 读 `phones` / `window_hours` / `login_code`；
 *   · **整串不是 JSON** ⇒ 把整串当手机号列表（运营很可能只填一串号）；
 *   · `window_hours` 非正数/非数字 ⇒ 回落默认 24；
 *   · `login_code` 形态不合法 ⇒ null（该号回落短信验证码，见 parseDemoLoginCode）。
 */
export function parseDemoConfig(raw: string): {
  phones: Set<string>
  windowHours: number
  loginCode: string | null
} {
  let obj: unknown = null
  try {
    obj = JSON.parse(raw)
  } catch {
    // 不是 JSON：整串当手机号列表（`parseDemoPhones` 会把非法片段全部丢掉）
    return { phones: parseDemoPhones(raw), windowHours: DEMO_DEFAULT_WINDOW_HOURS, loginCode: null }
  }
  const rec = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {}
  const phones = parseDemoPhones(
    Array.isArray(rec.phones) || typeof rec.phones === 'string' ? (rec.phones as string | unknown[]) : '',
  )
  const hours = Number(rec.window_hours)
  return {
    phones,
    windowHours: Number.isFinite(hours) && hours > 0 ? hours : DEMO_DEFAULT_WINDOW_HOURS,
    loginCode: parseDemoLoginCode(rec.login_code),
  }
}

/** 把两条原始配置串装配成策略。两个 loader 共用，免得「解析规则」出现第二份。 */
function buildDemoPolicy(rawConfig: string, rawActivated: string): DemoPolicy {
  const { phones, windowHours, loginCode } = parseDemoConfig(rawConfig)
  return {
    phones,
    windowHours,
    loginCode,
    // ★★ 值填坏了（非空但解析不出时间）⇒ 当作**早已过期**（拒绝登录），而不是当作
    //   「未激活」。后者会让一次手抖写错的配置把演示账号**永久开放**，
    //   而且没有任何日志会提示。默认值必须落在「更保守 / 会被发现」的那一侧。
    activatedAt: parseIso(rawActivated) ?? (rawActivated.trim() ? new Date(0) : null),
  }
}

export async function loadDemoPolicy(prisma: DemoDb): Promise<DemoPolicy> {
  const [rawConfig, rawActivated] = await Promise.all([
    getString(prisma, DEMO_GROUP, DEMO_CONFIG_KEY, ''),
    getString(prisma, DEMO_GROUP, DEMO_ACTIVATED_AT_KEY, ''),
  ])
  return buildDemoPolicy(rawConfig, rawActivated)
}

/**
 * ★★★ **无缓存**的配置读取：直接 `findUnique`，既不读也不写 `lib/settings.ts` 那个
 *   60 秒进程内缓存。
 *
 * 为什么不用现成的 `getString`：那层缓存的失效**依赖「写的人记得调 `invalidate()`」**。
 *   · 后台三个写配置接口（`routes/admin.ts` 的 POST/PUT/DELETE `/settings`）确实调了
 *     ⇒ 从后台点「立即收回」是即时的；
 *   · 但运维排障时**直接改库**不会让它失效 ⇒ 授权决策最多多给 60 秒（线上实测复现过）；
 *   · 将来若上 cluster 多实例，`invalidate()` 只清**当前进程**，其余实例各自陈旧 60s。
 *   而「立即收回」的语义恰恰是**不许有任何残留窗口** ⇒ 这条**授权**路径不能挂在
 *   别的模块的副作用上，自己读库。
 * ★ 只用在这一处低频、正确性优先于开销的判据读取上（演示号只有一两个）。
 */
async function readDemoSettingRaw(prisma: DemoDb, key: string): Promise<string> {
  const row = await prisma.systemSetting.findUnique({
    where: { groupKey_settingKey: { groupKey: DEMO_GROUP, settingKey: key } },
  })
  return row?.settingVal ?? ''
}

/**
 * 同 `loadDemoPolicy`，但**绕开 settings 的 60 秒缓存**（`readDemoSettingRaw`）。
 *
 * ★ 鉴权中间件必须用这个：授权决策不能吃陈旧值。判定理由见 `readDemoSettingRaw` 的说明。
 * ★ 开销只落在**演示号**身上（中间件仅在 token 带 `dst` 时才调它），普通账号零感知。
 */
export async function loadDemoPolicyFresh(prisma: DemoDb): Promise<DemoPolicy> {
  const [rawConfig, rawActivated] = await Promise.all([
    readDemoSettingRaw(prisma, DEMO_CONFIG_KEY),
    readDemoSettingRaw(prisma, DEMO_ACTIVATED_AT_KEY),
  ])
  return buildDemoPolicy(rawConfig, rawActivated)
}

export function isDemoPhone(policy: DemoPolicy, phone: string | null | undefined): boolean {
  return !!phone && policy.phones.has(phone)
}

/**
 * 该手机号本次登录**应当使用的固定码**；不适用时返回 `null`（⇒ 调用方回落到短信验证码）。
 *
 * ★ 判据是两条**同时**成立：白名单命中 ∧ 已配置合法固定码。
 *   缺任何一条都返回 null，于是：
 *   · 白名单空 ⇒ 功能整体关闭（同 `phones` 的老口径：空 ≠ 全部放行）；
 *   · 码没配 / 配坏 ⇒ 该号走正常短信，而不是「任何码都行」。
 * ★ 纯函数，且 `loginByPhone` 与 `sendCode` **都**拿它做同一个判断 ——
 *   否则会出现「发码那边认为该号用固定码、登录那边认为不用」这种两边不一致的静默故障
 *   （表现为：不发短信，且输什么码都登不进）。
 */
export function demoLoginCode(policy: DemoPolicy, phone: string | null | undefined): string | null {
  if (!policy.loginCode) return null
  return isDemoPhone(policy, phone) ? policy.loginCode : null
}

/** 窗口截止时刻（毫秒）；未启用时返回 null。 */
export function demoDeadlineMs(policy: DemoPolicy): number | null {
  if (!policy.activatedAt) return null
  return policy.activatedAt.getTime() + policy.windowHours * 3600_000
}

/**
 * ★ 纯函数：判 token 里的 `dst`（unix **秒**）是否已经过期。
 *
 * 鉴权中间件与守护脚本都调它，避免「两处各写一遍判据」之后悄悄漂移
 * （`dst` 是秒、`Date.now()` 是毫秒，这种单位错位靠肉眼看代码是看不出来的）。
 * 非数字 / 缺失 / ≤0 一律视为「没有这个声明」⇒ 不过期（普通账号行为不变）。
 */
export function demoDeadlinePassed(dst: unknown, nowMs: number = Date.now()): boolean {
  if (typeof dst !== 'number' || !Number.isFinite(dst) || dst <= 0) return false
  return nowMs >= dst * 1000
}

/**
 * ★★ 纯函数：**实时**窗口是否已经关闭（过期 / 被收回 / 被清空）。
 *
 * 与 `demoDeadlinePassed(dst)` 的分工，是这里最要紧的一点：
 *   - `demoDeadlinePassed(dst)` 看的是 **token 里烙死的值**（签发那一刻算出的绝对截止）：
 *     零延迟、不查库，负责「到点即死」。
 *   - 本函数看的是 **当前配置**：负责「管理员在后台改了/收回了窗口 ⇒ 旧 token 立刻失效」。
 *
 * ★★★ 只有前者是不够的，会留下一个真实缺口：管理员点「立即收回」只是把
 *   `activated_at` 改成 1970，而**已经发出去的 token 里那个 `dst` 纹丝不动**，
 *   于是旧会话要一直活到 access token 自己过期（最长 2 小时）才被刷新的失败踢掉。
 *   后台那句「已登录的端在下次请求时也会被拦下」在那之前是**不成立**的。
 *
 * `activatedAt` 为空 ⇒ 关（管理员点了「清除启用记录」）。
 * ★ 这与 `loadDemoPolicy` 把「值填坏了」当作 `new Date(0)` 的兜底语义一致：都落在「关」这一侧。
 */
export function demoWindowClosed(policy: DemoPolicy, nowMs: number = Date.now()): boolean {
  const live = demoDeadlineMs(policy)
  return live === null || nowMs >= live
}

/** 首次登录时写入启用时刻（幂等；已激活则原样返回）。 */
async function activateDemoWindowIfNeeded(prisma: DemoDb, policy: DemoPolicy): Promise<DemoPolicy> {
  if (policy.activatedAt) return policy
  try {
    await prisma.systemSetting.create({
      data: {
        groupKey: DEMO_GROUP,
        settingKey: DEMO_ACTIVATED_AT_KEY,
        settingVal: new Date().toISOString(),
        valueType: 'STRING',
        displayName: '演示窗口启用时刻',
        description:
          '运行时状态：首次登录演示账号时自动写入，请勿手工维护。改成当前时间＝重开一段窗口；删掉这一行＝下次登录重新激活',
        sort: 0,
        isPublic: false,
      },
    })
  } catch {
    // 并发首登（两端几乎同时按下）：唯一索引 (group_key, setting_key) 会拒绝第二次 create。
    // 这不是错误 —— 对面已经写入了启用时刻，下面读回同一份即可。
  }
  invalidate(DEMO_GROUP, DEMO_ACTIVATED_AT_KEY)
  return loadDemoPolicy(prisma)
}

/**
 * 演示账号登录闸门 —— **所有签发 token 的路径都必须过这里**（登录 / 微信一键 / 刷新 / 开发登录）。
 *
 * 返回该 session 的绝对截止（unix 秒），调用方必须把它写进 access 与 refresh 的 `dst`。
 * 非演示账号返回 `undefined`（零行为变化）。
 *
 * ★ 判据顺序刻意是「先激活、再判过期」：窗口是**全局一次性**的，第一次登录即激活，
 *   所以首次登录必然在窗口内；而窗口一过，这里抛错且**不会**重新激活
 *   （想重开窗口只能人工改配置 —— 否则「一次性」就退化成「每次登录都重置」）。
 */
export async function demoSessionDeadline(prisma: DemoDb, phone: string): Promise<number | undefined> {
  const policy0 = await loadDemoPolicy(prisma)
  if (!isDemoPhone(policy0, phone)) return undefined

  const policy = policy0.activatedAt ? policy0 : await activateDemoWindowIfNeeded(prisma, policy0)
  const deadline = demoDeadlineMs(policy)
  if (deadline === null) return undefined // 上面已保证激活，这里只是类型收窄
  if (Date.now() >= deadline) throw new DemoExpiredError()
  return Math.floor(deadline / 1000)
}

/** 供守护脚本 / 排障使用：把一个策略渲染成一句人话。 */
export function describeDemoPolicy(policy: DemoPolicy, nowMs: number = Date.now()): string {
  // ★ 只说「有没有配」，**绝不打印码值本身** —— 这句话会被写进日志。
  const codeState = policy.loginCode ? '固定登录码已配置' : '无固定登录码'
  if (policy.phones.size === 0) return '演示账号：未配置（phones 解析后为空 ⇒ 功能关闭）'
  const deadline = demoDeadlineMs(policy)
  if (deadline === null) {
    return `演示账号：已配置 ${policy.phones.size} 个号，窗口 ${policy.windowHours}h，尚未启用，${codeState}`
  }
  const left = deadline - nowMs
  return `演示账号：已配置 ${policy.phones.size} 个号，窗口 ${policy.windowHours}h，${codeState}，${
    left > 0 ? `剩余 ${(left / 3600_000).toFixed(2)}h` : `已过期 ${(-left / 3600_000).toFixed(2)}h`
  }`
}
