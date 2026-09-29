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

function parseIso(raw: string): Date | null {
  if (!raw || !raw.trim()) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t) : null
}

/**
 * 解析 `demo.config`。
 *
 * ★ 容错口径（宁可多认一点，也不要静默失效）：
 *   · 合法 JSON 对象 ⇒ 读 `phones` / `window_hours`；
 *   · **整串不是 JSON** ⇒ 把整串当手机号列表（运营很可能只填一串号）；
 *   · `window_hours` 非正数/非数字 ⇒ 回落默认 24。
 */
export function parseDemoConfig(raw: string): { phones: Set<string>; windowHours: number } {
  let obj: unknown = null
  try {
    obj = JSON.parse(raw)
  } catch {
    // 不是 JSON：整串当手机号列表（`parseDemoPhones` 会把非法片段全部丢掉）
    return { phones: parseDemoPhones(raw), windowHours: DEMO_DEFAULT_WINDOW_HOURS }
  }
  const rec = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {}
  const phones = parseDemoPhones(
    Array.isArray(rec.phones) || typeof rec.phones === 'string' ? (rec.phones as string | unknown[]) : '',
  )
  const hours = Number(rec.window_hours)
  return {
    phones,
    windowHours: Number.isFinite(hours) && hours > 0 ? hours : DEMO_DEFAULT_WINDOW_HOURS,
  }
}

export async function loadDemoPolicy(prisma: DemoDb): Promise<DemoPolicy> {
  const [rawConfig, rawActivated] = await Promise.all([
    getString(prisma, DEMO_GROUP, DEMO_CONFIG_KEY, ''),
    getString(prisma, DEMO_GROUP, DEMO_ACTIVATED_AT_KEY, ''),
  ])
  const { phones, windowHours } = parseDemoConfig(rawConfig)
  return {
    phones,
    windowHours,
    // ★★ 值填坏了（非空但解析不出时间）⇒ 当作**早已过期**（拒绝登录），而不是当作
    //   「未激活」。后者会让一次手抖写错的配置把演示账号**永久开放**，
    //   而且没有任何日志会提示。默认值必须落在「更保守 / 会被发现」的那一侧。
    activatedAt: parseIso(rawActivated) ?? (rawActivated.trim() ? new Date(0) : null),
  }
}

export function isDemoPhone(policy: DemoPolicy, phone: string | null | undefined): boolean {
  return !!phone && policy.phones.has(phone)
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
  if (policy.phones.size === 0) return '演示账号：未配置（phones 解析后为空 ⇒ 功能关闭）'
  const deadline = demoDeadlineMs(policy)
  if (deadline === null) return `演示账号：已配置 ${policy.phones.size} 个号，窗口 ${policy.windowHours}h，尚未启用`
  const left = deadline - nowMs
  return `演示账号：已配置 ${policy.phones.size} 个号，窗口 ${policy.windowHours}h，${
    left > 0 ? `剩余 ${(left / 3600_000).toFixed(2)}h` : `已过期 ${(-left / 3600_000).toFixed(2)}h`
  }`
}
