// 运维告警出口 —— 支付链路上「只能靠人发现」的异常的唯一去处。
//
// 背景：这个仓库的代码里到处写着同一句话 —— 「没有任何告警」。
//   · pay-reconcile.service.ts ：「没有报错、没有告警，只有用户投诉『付了钱没到账』」
//   · wxpay.ts                 ：「用户付了钱却拿不到权益，而且两边都没有告警」
//   · routes/render-capabilities.ts：「商户点提交 → 冻结积分 → 才在 worker 里失败，且没有任何告警」
// 这些注释描述的都是真实状态：出问题时结论只写进 pm2 控制台，而**没有人会去看 pm2 控制台**。
// 本模块把「告警」这件事兑现成两件事同时发生：
//   ① 落库（`ops_alert`）—— 事实。可逐笔查证、可标记已处理、可看见处理人。
//   ② 推送（企业微信群机器人）—— 触达。能到手机上。
//
// ★ 本模块的核心契约：**绝不抛错**。
//   它被调用在支付结算的路径上（回调、查单、对账），任何一次告警失败
//   —— webhook 超时、DB 抖动、URL 配错 —— 都**不允许**影响主交易。
//   所以 `raiseOpsAlert()` 全函数包 try/catch，失败只写一行日志就返回。
//   代价是「告警可能丢」，因此落库这一层必须存在：丢的是推送，不是事实。
//
// ★ 去重是必须的，不是优化。
//   对账 sweeper 每 5 分钟一轮。一个持久故障（例如某档会员套餐被误停用
//   导致所有该档订单结算失败）若每轮都推一次，运营两小时后就会把告警群静音 ——
//   那时真出事也没人看。所以同一 `dedupeKey` 在窗口内只推一次，其余只累加 `occurrences`。
//   刻意保留 `occurrences`：它把「偶发一次」和「持续失败 200 次」区分开，
//   这个数字比任何措辞都更能说明严重程度。
import type { PrismaClient } from '@prisma/client'

export type OpsAlertSeverity = 'CRITICAL' | 'WARN'

/** 同一 dedupeKey 在此窗口内重复触发只累加次数，不重复推送 */
const DEDUPE_MINUTES = Math.max(1, Number(process.env.OPS_ALERT_DEDUPE_MINUTES ?? 30))
/** 单次推送超时。必须短 —— 它跑在请求路径上（结算失败后立即告警） */
const PUSH_TIMEOUT_MS = Math.max(1000, Number(process.env.OPS_ALERT_TIMEOUT_MS ?? 5000))
/**
 * 每分钟最多推送条数。
 *
 * ★ 这是防「告警风暴把机器人打死」的护栏，不是节流优化：
 *   企业微信群机器人有频率限制，**超限会被停用**。一旦被停用，
 *   之后所有告警（包括真的资金问题）都发不出来了 —— 为了多发几条假警报
 *   而失去唯一的触达通道，是明显不划算的。超限的告警仍然**照常落库**。
 */
const MAX_PUSH_PER_MINUTE = Math.max(1, Number(process.env.OPS_ALERT_MAX_PUSH_PER_MINUTE ?? 10))

export interface RaiseOpsAlertInput {
  /** 稳定类型标识，代码里判断用，如 PAY_AMOUNT_MISMATCH */
  code: string
  /** 缺省 WARN。涉及资金、必须人工介入的用 CRITICAL */
  severity?: OpsAlertSeverity
  title: string
  detail?: string
  refType?: string
  refId?: string
  /**
   * 去重键。缺省 `code:refId`。
   * 想让「同一类问题跨订单合并成一条」就显式传更粗的键（例如只给 code）。
   */
  dedupeKey?: string
}

export interface OpsAlertDeps {
  now?: Date
  /** 注入推送实现 —— 验证脚本靠它完全不联网 */
  push?: (content: string) => Promise<{ ok: boolean; note: string }>
  dedupeMinutes?: number
  /** 注入每分钟推送上限，便于测试限流分支 */
  maxPushPerMinute?: number
}

export type OpsAlertPushStatus = 'SENT' | 'SKIPPED' | 'FAILED' | 'NOT_ATTEMPTED'

export interface OpsAlertResult {
  /** 落库行的 id；连落库都失败时为 null */
  id: bigint | null
  /** true = 命中去重窗口，只累加了次数，本次**没有推送** */
  merged: boolean
  pushStatus: OpsAlertPushStatus
  /** 落库本身是否成功。false 时调用方应当知道「这条告警只进了日志」 */
  persisted: boolean
}

/** 未配置推送渠道时只提醒一次，避免每笔订单刷一行日志 */
let warnedNoWebhook = false
/** 进程内推送时间戳环，用于每分钟限流 */
const pushTimestamps: number[] = []

function webhookUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPS_ALERT_WEBHOOK ?? '').trim()
}

/** 企业微信群机器人：POST {msgtype:'markdown', markdown:{content}} */
function buildMarkdown(input: Required<Pick<RaiseOpsAlertInput, 'code' | 'title'>> & {
  severity: OpsAlertSeverity
  detail?: string
  refType?: string
  refId?: string
  occurrences: number
}): string {
  // 企业微信 markdown 支持 <font color="warning|comment|info">
  const head = input.severity === 'CRITICAL' ? '# 🔴 支付风控告警' : '# 🟡 支付告警'
  const lines = [
    head,
    `> 类型：<font color="comment">${input.code}</font>`,
    `> 标题：**${input.title}**`,
  ]
  if (input.detail) lines.push(`> 详情：${input.detail}`)
  if (input.refType && input.refId) lines.push(`> 关联：${input.refType} \`${input.refId}\``)
  if (input.occurrences > 1) lines.push(`> 累计出现：**${input.occurrences}** 次（同一问题已被去重合并）`)
  lines.push('> 处理入口：后台「异常告警」，或 `POST /admin/api/v1/ops-alerts/:id/ack` 标记已处理')
  return lines.join('\n')
}

async function defaultPush(content: string, url: string): Promise<{ ok: boolean; note: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) return { ok: false, note: `HTTP ${res.status} ${text.slice(0, 200)}` }
    return { ok: true, note: `HTTP ${res.status} ${text.slice(0, 200)}` }
  } catch (e) {
    return { ok: false, note: (e as Error).message }
  }
}

/** 每分钟推送次数是否已超限；顺带清理过期时间戳（数组最多留 1 分钟的量） */
function takePushSlot(now: number, limit: number): boolean {
  const floor = now - 60_000
  while (pushTimestamps.length > 0 && pushTimestamps[0]! < floor) pushTimestamps.shift()
  if (pushTimestamps.length >= limit) return false
  pushTimestamps.push(now)
  return true
}

/** 只给验证脚本用：把限流窗口清空，避免用例之间互相影响 */
export function __resetOpsAlertThrottle(): void {
  pushTimestamps.length = 0
  warnedNoWebhook = false
}

/**
 * 记录并推送一条运维告警。**永不抛错**（见文件头契约）。
 *
 * 返回 `persisted=false` 表示连落库都失败 —— 此时只有日志留下了这条告警，
 * 调用方（`pay-risk.service.ts` 的统计）会把它计入，让「告警系统自己坏了」可见。
 */
export async function raiseOpsAlert(
  prisma: PrismaClient,
  input: RaiseOpsAlertInput,
  deps: OpsAlertDeps = {},
): Promise<OpsAlertResult> {
  const severity: OpsAlertSeverity = input.severity ?? 'WARN'
  try {
    const now = deps.now ?? new Date()
    const dedupeKey = (input.dedupeKey ?? `${input.code}:${input.refId ?? '-'}`).slice(0, 160)
    const dedupeMs = (deps.dedupeMinutes ?? DEDUPE_MINUTES) * 60_000
    const windowStart = new Date(now.getTime() - dedupeMs)

    // ── 去重：窗口内**未处理**的同键告警合并进已有行 ──
    // ackedAt: null 是刻意的：已标记处理过的键再次出现必须新开一条（问题复发要重新提醒）。
    const existing = await prisma.opsAlert.findFirst({
      where: { dedupeKey, ackedAt: null, lastSeenAt: { gte: windowStart } },
      orderBy: { id: 'desc' },
      select: { id: true, occurrences: true },
    })
    if (existing) {
      // ★ 合并时**刷新 detail**（title/code/severity 保持首次值）：
      //   一条被合并了 137 次的告警，若 detail 永远停在第一次的原因，
      //   运维看到的就是「一个已经不存在的原因 + 一个很大的数字」，反而无法定位。
      //   现在的语义是：`occurrences`/`firstSeenAt` 说明「持续了多久、发生了多少次」，
      //   `detail` 说明「最近一次是什么原因」。两者结合才是完整的。
      await prisma.opsAlert.update({
        where: { id: existing.id },
        data: {
          occurrences: { increment: 1 },
          lastSeenAt: now,
          ...(input.detail ? { detail: input.detail } : {}),
          ...(input.refId ? { refId: input.refId.slice(0, 64) } : {}),
        },
      })
      console.log(
        `[ops-alert][${severity}] ${input.code} 合并进 #${existing.id}（累计 ${existing.occurrences + 1} 次，本次不推送）：${input.title}`,
      )
      return { id: existing.id, merged: true, pushStatus: 'NOT_ATTEMPTED', persisted: true }
    }

    const row = await prisma.opsAlert.create({
      data: {
        code: input.code.slice(0, 48),
        severity,
        title: input.title.slice(0, 200),
        detail: input.detail ?? null,
        refType: input.refType?.slice(0, 32) ?? null,
        refId: input.refId?.slice(0, 64) ?? null,
        dedupeKey,
        occurrences: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        pushStatus: 'PENDING',
      },
      select: { id: true },
    })

    // ── 推送（失败绝不影响主流程；落库已完成，事实不会丢）──
    // ★ 渠道判定顺序：**显式注入的实现 > OPS_ALERT_WEBHOOK > 没有渠道**。
    //   注入优先是必须的 —— 否则在不配 webhook 的环境（本机、CI）里，
    //   「推送成功 / 失败」这两条分支永远走不到，等于把最有价值的一半逻辑测没了。
    const url = webhookUrl()
    const pushImpl: ((content: string) => Promise<{ ok: boolean; note: string }>) | null =
      deps.push ?? (url ? (content: string) => defaultPush(content, url) : null)

    if (!pushImpl) {
      await prisma.opsAlert
        .update({ where: { id: row.id }, data: { pushStatus: 'SKIPPED' } })
        .catch(() => undefined)
      if (!warnedNoWebhook) {
        warnedNoWebhook = true
        console.warn(
          '[ops-alert] ⚠ 未配置 OPS_ALERT_WEBHOOK —— 告警只落库、不会推送到手机。' +
            '请在后台「异常告警」查看，或配置企业微信群机器人 webhook 后重启。',
        )
      }
      console.log(`[ops-alert][${severity}] ${input.code} #${row.id}（未配置推送渠道）：${input.title}`)
      return { id: row.id, merged: false, pushStatus: 'SKIPPED', persisted: true }
    }

    if (!takePushSlot(now.getTime(), deps.maxPushPerMinute ?? MAX_PUSH_PER_MINUTE)) {
      // 拿到这里说明一分钟内已经推了太多条 —— 保留落库，标记为限流跳过
      const note = `超过每分钟推送上限 ${deps.maxPushPerMinute ?? MAX_PUSH_PER_MINUTE} 条，本条只落库未推送`
      await prisma.opsAlert
        .update({ where: { id: row.id }, data: { pushStatus: 'SKIPPED', pushError: note.slice(0, 500) } })
        .catch(() => undefined)
      console.warn(`[ops-alert][${severity}] ${input.code} #${row.id} ${note}：${input.title}`)
      return { id: row.id, merged: false, pushStatus: 'SKIPPED', persisted: true }
    }

    const content = buildMarkdown({
      code: input.code,
      title: input.title,
      severity,
      detail: input.detail,
      refType: input.refType,
      refId: input.refId,
      occurrences: 1,
    })
    const pushed = await pushImpl(content)

    await prisma.opsAlert
      .update({
        where: { id: row.id },
        data: pushed.ok
          ? { pushStatus: 'SENT', pushError: null }
          : { pushStatus: 'FAILED', pushError: pushed.note.slice(0, 500) },
      })
      .catch(() => undefined)

    console.log(
      `[ops-alert][${severity}] ${input.code} #${row.id} 推送${pushed.ok ? '成功' : `失败(${pushed.note})`}：${input.title}`,
    )
    return { id: row.id, merged: false, pushStatus: pushed.ok ? 'SENT' : 'FAILED', persisted: true }
  } catch (e) {
    // ★ 到这里的唯一后果是「这条告警只剩日志」。绝不能向上抛。
    console.error(
      `[ops-alert][${severity}] ${input.code} 记录失败（不影响主流程）：${(e as Error).message}｜${input.title}`,
    )
    return { id: null, merged: false, pushStatus: 'FAILED', persisted: false }
  }
}

// ──────────────────────── 后台查询 / 人工处理 ────────────────────────

export interface OpsAlertView {
  id: string
  code: string
  severity: string
  title: string
  detail: string | null
  refType: string | null
  refId: string | null
  occurrences: number
  firstSeenAt: string
  lastSeenAt: string
  pushStatus: string
  pushError: string | null
  ackedAt: string | null
  ackedBy: string | null
  ackNote: string | null
}

export async function listOpsAlerts(
  prisma: PrismaClient,
  opts: { status?: 'OPEN' | 'ACKED' | 'ALL'; code?: string; severity?: OpsAlertSeverity; limit?: number } = {},
): Promise<{ items: OpsAlertView[]; openCount: number }> {
  const status = opts.status ?? 'OPEN'
  const where: Record<string, unknown> = {}
  if (status === 'OPEN') where.ackedAt = null
  else if (status === 'ACKED') where.ackedAt = { not: null }
  if (opts.code) where.code = opts.code
  if (opts.severity) where.severity = opts.severity

  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200)
  const [rows, openCount] = await Promise.all([
    prisma.opsAlert.findMany({ where, orderBy: { id: 'desc' }, take: limit }),
    prisma.opsAlert.count({ where: { ackedAt: null } }),
  ])
  return {
    items: rows.map((r) => ({
      id: r.id.toString(),
      code: r.code,
      severity: r.severity,
      title: r.title,
      detail: r.detail,
      refType: r.refType,
      refId: r.refId,
      occurrences: r.occurrences,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      pushStatus: r.pushStatus,
      pushError: r.pushError,
      ackedAt: r.ackedAt?.toISOString() ?? null,
      ackedBy: r.ackedBy?.toString() ?? null,
      ackNote: r.ackNote,
    })),
    openCount,
  }
}

export class OpsAlertNotFoundError extends Error {
  constructor() {
    super('告警不存在或已处理')
    this.name = 'OpsAlertNotFoundError'
  }
}

/** 标记已处理。只允许 ack 未处理的（重复 ack 视为不存在，避免覆盖首次处理人） */
export async function ackOpsAlert(
  prisma: PrismaClient,
  id: bigint,
  operatorId: bigint,
  note?: string,
): Promise<OpsAlertView> {
  const updated = await prisma.opsAlert.updateMany({
    where: { id, ackedAt: null },
    data: { ackedAt: new Date(), ackedBy: operatorId, ackNote: note?.trim() ? note.trim().slice(0, 255) : null },
  })
  if (updated.count === 0) throw new OpsAlertNotFoundError()
  const r = await prisma.opsAlert.findUniqueOrThrow({ where: { id } })
  return {
    id: r.id.toString(),
    code: r.code,
    severity: r.severity,
    title: r.title,
    detail: r.detail,
    refType: r.refType,
    refId: r.refId,
    occurrences: r.occurrences,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    pushStatus: r.pushStatus,
    pushError: r.pushError,
    ackedAt: r.ackedAt?.toISOString() ?? null,
    ackedBy: r.ackedBy?.toString() ?? null,
    ackNote: r.ackNote,
  }
}
