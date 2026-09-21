/**
 * AI 通道健康体检（30 分钟自动停用/启用）的离线回归。
 *
 * ★ 为什么必须有一个**不连数据库、不发网络请求**的回归：
 *   这段逻辑判错的后果是「生产上某个通道被静默关掉」或「运营故意关掉的通道被自动打开」，
 *   而两种情况在页面上都只表现为「AI 变慢/变贵」，**没有任何报错**会指过来。
 *   靠读代码回归不了「下一轮探活还会不会发生」这种事 —— 必须跑。
 *
 * 手法：给 `sweepAiProviderHealth` 注入一个内存版 prisma + 可编程 probe + 零延迟 sleep，
 *   于是能精确构造「手工停用 / 自动停用 / 唯一启用 / 中途恢复 / 有真实调用证据」
 *   这些在真库上不好复现的组合。
 *
 * 用例：
 *   ① decideHealthAction 真值表
 *   ② ★ 候选集必须是 `enabled=1 OR auto_disabled=1`：
 *      自动停用的通道在 gateway 的请求路径上会被 `!provider.enabled` 跳过、
 *      因而**再也不会被请求探到** —— 如果候选集只查 enabled=1，
 *      「下次检测通过自动开启」就永远不会发生（这是需求第 2 条的后半句）。
 *      同时手工停用的通道必须**不在**候选集里（否则体检会把运营的决定撤销）。
 *   ③ 全失败 + 还有别的通道开着 + 无真实证据 → 停用，且三个字段一起写
 *   ④ 全失败 + 它是唯一启用通道（且无证据）→ **拒绝停用**（否则所有 AI 场景静默落兜底模板）
 *   ⑤ 自动停用的通道探测通过 → 自动启用
 *   ⑥ ★ 已自动停用的通道每轮只探 **1 轮**（不给它做 4 轮复检，否则每 30 分钟白烧 6 分钟）
 *   ⑦ 复检轮数：首次失败才复检、任一轮成功即停、全失败才停用
 *   ⑧ 没有可用模型 → 跳过且不写库（属配置缺失，不是不健康）
 *   ⑨ 探活模型优先 TEXT 能力（不拿 IMAGE 模型去判业务可用性）
 *   ⑩ ★ 真实调用证据优先：24h 内有真实成功 ⇒ **一次都不探**、不停用
 *   ⑪ ★ `status='TEST'` 的行**不构成证据**（否则合成成功会把自己变成免检理由）
 *   ⑫ ★ 证据窗口外的旧成功不算证据
 *   ⑬ ★ 免探测 + 已自动停用 + 有证据 ⇒ 重新启用（否则会死锁：既免探测又不开，白停 24 小时）
 *   ⑭ 探活超时必须够长（gpt 实测 36~52s）——这是配置回归，防止有人调回 10s
 *   ⑮ ★ 图像通道必须用**图像适配器**探活。用 chat 适配器去探 gpt-image-2 必然拿到
 *      上游 400「This model is not supported on the Chat Completions endpoint」——
 *      一次与被探通道是否可用**完全无关**的失败 ⇒ 出图通道每 30 分钟被判死一次、
 *      自动停用 ⇒ 封面全落兜底模板（2026-09-21 生产事故根因，用户可见症状是
 *      「标题文案都生成了，封面没出来」）。这条是配置回归：防止有人把它改回 chat。
 *   ⑯ ★ 「拒绝自锁」的计数必须按**能力**算：库里 3 条通道全在用、其中只有 1 条挂图像模型时，
 *      全局计数（旧实现）会允许把这条唯一的图像通道停用。
 *   ⑰ ★ 图像通道的探活**要花真钱**（实测一张 $0.10 / 35.7s）⇒ 距上次探活不足
 *      IMAGE_PROBE_INTERVAL_MS 就免探，且只探 1 轮；文本通道不受这两条影响。
 *   ⑱ ★ 但**已自动停用的**图像通道不受节流：它的 last_test_at 正是那次失败的探活，
 *      再叠加节流就会让「自动恢复」与「24h 真实证据」两条路一起堵死。
 *
 * 跑法：npx tsx scripts/verify-ai-health.ts
 */
import {
  decideHealthAction,
  sweepAiProviderHealth,
  type HealthProbe,
  type HealthProbeResult,
} from '../src/ai/ai-health.service.js'
import { HEALTH_PROBE_PROMPT, HEALTH_PROBE_MAX_OUTPUT_TOKENS } from '../src/ai/health-probe.js'
import type { PrismaClient } from '@prisma/client'

let pass = 0
let fail = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? `  ${extra}` : ''}`)
  }
}

// ──────────────────────── 内存版 prisma（只实现体检用到的方法） ────────────────────────

interface StubRow {
  id: bigint
  code: string
  name: string
  enabled: boolean
  autoDisabled: boolean
  healthStatus: string
  priority: number
  models: { modelCode: string; capability: string; enabled: boolean }[]
  /** 上次探活时间（图像通道的节流判据） */
  lastTestAt?: Date
}

/** 一条 ai_call_log 的「证据」行 */
interface StubLog {
  providerId: bigint
  status: string
  createdAt: Date
}

interface UpdateCall {
  id: string
  data: Record<string, unknown>
}

/**
 * 极简 where 求值：只支持体检真正用到的那一种形状（可选 OR 分支 + 等值比较）。
 * 故意做得笨 —— 它不是为了替代 Prisma，而是为了让「哪几行会被探到」这件事
 * 在测试里**真的发生**，而不是靠断言 SQL 字符串。
 * 同时下面还会断言原始 where 子句本身（双保险：求值器太窄会自曝）。
 */
function matchesWhere(row: StubRow, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true
  if (Array.isArray(where.OR)) {
    return (where.OR as Record<string, unknown>[]).some((w) => matchesWhere(row, w))
  }
  return Object.entries(where).every(
    ([k, v]) => (row as unknown as Record<string, unknown>)[k] === v,
  )
}

function makeFakePrisma(rows: StubRow[], logs: StubLog[] = []) {
  const state = new Map<string, StubRow>(rows.map((r) => [r.id.toString(), r]))
  const calls: {
    findManyArgs?: Record<string, unknown>
    evidenceArgs?: Record<string, unknown>
    updates: UpdateCall[]
  } = { updates: [] }
  const db = {
    aiProvider: {
      async findMany(args: { where?: Record<string, unknown> }) {
        calls.findManyArgs = args as unknown as Record<string, unknown>
        return [...state.values()]
          .filter((r) => matchesWhere(r, args?.where))
          .map((r) => ({ ...r, models: r.models.map((m) => ({ ...m })) }))
      },
      async update(args: { where: { id: bigint }; data: Record<string, unknown> }) {
        const id = args.where.id.toString()
        const row = state.get(id)
        if (!row) throw new Error(`stub: 行 ${id} 不存在`)
        Object.assign(row, args.data)
        calls.updates.push({ id, data: args.data })
        return { ...row }
      },
    },
    aiCallLog: {
      async findMany(args: {
        where: {
          providerId: { in: bigint[] }
          createdAt: { gte: Date }
          status: { in: string[] }
        }
      }) {
        calls.evidenceArgs = args as unknown as Record<string, unknown>
        const w = args.where
        const seen = new Set<string>()
        const out: { providerId: bigint }[] = []
        for (const l of logs) {
          if (!w.providerId.in.some((x) => x.toString() === l.providerId.toString())) continue
          if (!w.status.in.includes(l.status)) continue
          if (l.createdAt.getTime() < w.createdAt.gte.getTime()) continue
          const key = l.providerId.toString()
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ providerId: l.providerId })
        }
        return out
      },
    },
  }
  return { prisma: db as unknown as PrismaClient, state, calls }
}

/** 固定返回同一个结果的 probe，并按 provider 记录被调用次数 */
function probeAlways(
  ok: boolean,
  errorMsg = 'stub: 探测失败',
): { probe: HealthProbe; calls: { providerId: string; modelCode: string }[] } {
  const calls: { providerId: string; modelCode: string }[] = []
  return {
    calls,
    probe: async ({ providerId, modelCode }): Promise<HealthProbeResult> => {
      calls.push({ providerId, modelCode })
      return { ok, latencyMs: ok ? 1234 : 90000, ...(ok ? {} : { errorMsg }) }
    },
  }
}

/** 按序返回预设结果的 probe（最后一次结果会被重复使用） */
function probeSequence(seq: boolean[]): { probe: HealthProbe; calls: number } {
  const st = { calls: 0 }
  return {
    get calls() {
      return st.calls
    },
    probe: async (): Promise<HealthProbeResult> => {
      const ok = seq[Math.min(st.calls, seq.length - 1)]!
      st.calls++
      return { ok, latencyMs: 100, ...(ok ? {} : { errorMsg: 'stub: 第 ' + st.calls + ' 轮失败' }) }
    },
  }
}

const noSleep = async () => {}
const MODEL = (code = 'stub-model'): { modelCode: string; capability: string; enabled: boolean } => ({
  modelCode: code,
  capability: 'TEXT',
  enabled: true,
})
/** 只挂图像模型的通道（现实里就是 tokenbox-image / gpt-image-2） */
const IMAGE_MODEL = (
  code = 'stub-image',
): { modelCode: string; capability: string; enabled: boolean } => ({
  modelCode: code,
  capability: 'IMAGE',
  enabled: true,
})
const ROW = (
  id: number,
  code: string,
  extra: Partial<StubRow> = {},
): StubRow => ({
  id: BigInt(id),
  code,
  name: code,
  enabled: true,
  autoDisabled: false,
  healthStatus: 'HEALTHY',
  priority: id * 10,
  models: [MODEL()],
  ...extra,
})
const HOUR = 3_600_000

// ──────────────────────── ① 纯决策真值表 ────────────────────────
console.log('\n=== ① decideHealthAction 真值表 ===')
{
  const cases: Array<[boolean, boolean, number, boolean, string]> = [
    // wasAutoDisabled, anySuccess, otherEnabled, hasRecentRealSuccess, 期望
    [false, true, 2, false, 'KEEP'],
    [false, true, 0, true, 'KEEP'],
    [false, false, 2, false, 'DISABLE'],
    [false, false, 1, false, 'DISABLE'],
    [false, false, 0, false, 'REFUSE_LAST'], // ★ 唯一通道全失败 → 拒绝自锁
    [false, false, 2, true, 'KEEP_EVIDENCE'], // ★ 有真实证据 → 不停用
    [false, false, 0, true, 'KEEP_EVIDENCE'],
    [true, true, 2, false, 'ENABLE'], // ★ 自动停用的通道探测恢复 → 自动启用
    [true, true, 0, false, 'ENABLE'],
    [true, false, 2, false, 'KEEP'], // 自动停用且仍失败 → 保持停用（不重复写库）
    [true, false, 2, true, 'ENABLE'], // ★ 免探测 + 有证据 ⇒ 必须打开（否则死锁 24h）
  ]
  for (const [
    wasAutoDisabled,
    anySuccess,
    otherEnabledProviderCount,
    hasRecentRealSuccess,
    want,
  ] of cases) {
    const got = decideHealthAction({
      wasAutoDisabled,
      anySuccess,
      otherEnabledProviderCount,
      hasRecentRealSuccess,
    })
    check(
      got === want,
      `autoOff=${wasAutoDisabled} 探通=${anySuccess} 其它在用=${otherEnabledProviderCount} 有证据=${hasRecentRealSuccess} → ${want}`,
      got === want ? '' : `实际 ${got}`,
    )
  }
}

// ──────────────────────── ② 候选集与 ③ 停用 ────────────────────────
console.log('\n=== ② 候选集 = enabled ∪ autoDisabled ===')
{
  const { prisma, calls } = makeFakePrisma([
    ROW(1, 'manual-off', { enabled: false, autoDisabled: false }),
    ROW(2, 'auto-off', { enabled: false, autoDisabled: true, healthStatus: 'DOWN' }),
    ROW(3, 'live-a'),
    ROW(4, 'live-b'),
  ])
  const { probe } = probeAlways(true)
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 0 })

  check(r.scanned === 3, '候选集 = 3 条（排除人工停用那条）', `实际 ${r.scanned}`)
  const codes = r.outcomes.map((o) => o.code).sort().join(',')
  check(codes === 'auto-off,live-a,live-b', '被探到的正好是「自动停用 + 两条在用」', `实际 ${codes}`)
  check(!r.outcomes.some((o) => o.code === 'manual-off'), '★ 人工停用的通道不在候选集里（体检绝不会打开它）')

  // 断言原始 where 子句：防止以后有人把它简化成 `{ enabled: true }`
  const where = calls.findManyArgs?.where as { OR?: Record<string, unknown>[] } | undefined
  const orBranches = where?.OR ?? []
  check(
    orBranches.some((b) => b.enabled === true) && orBranches.some((b) => b.autoDisabled === true),
    '★ 查询条件是 OR[{enabled:true},{autoDisabled:true}]（漏掉第二支 = 自动停用的通道永远不会被恢复）',
    JSON.stringify(where),
  )
}

console.log('\n=== ③ 全失败 + 还有别的通道 + 无证据 → 停用 ===')
{
  const { prisma, calls } = makeFakePrisma([ROW(1, 'bad'), ROW(2, 'good')])
  const { probe, calls: probeCalls } = probeAlways(false, 'request timeout after 90000ms')
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 3 })

  const bad = r.outcomes.find((o) => o.code === 'bad')!
  check(bad.action === 'DISABLE', '坏通道 → DISABLE', `实际 ${bad.action}`)
  check(bad.rounds === 4, '首次 + 3 轮复检 = 4 轮', `实际 ${bad.rounds}`)
  check(
    probeCalls.filter((c) => c.providerId === '1').length === 4,
    '坏通道确实被探了 4 次',
    `实际 ${probeCalls.filter((c) => c.providerId === '1').length}`,
  )

  const upd = calls.updates.find((u) => u.id === '1')
  check(!!upd, '坏通道被写过库')
  check(
    upd?.data.enabled === false && upd?.data.autoDisabled === true && upd?.data.healthStatus === 'DOWN',
    '★ 三个字段一起写：enabled=false + autoDisabled=true + healthStatus=DOWN',
    JSON.stringify(upd?.data),
  )
  check(!calls.updates.some((u) => u.id === '2'), '好通道没被写库')
  check(r.disabled === 1, '汇总 disabled = 1', `实际 ${r.disabled}`)
}

console.log('\n=== ④ 唯一启用通道全失败（且无证据）→ 拒绝停用（不自锁） ===')
{
  const { prisma, calls } = makeFakePrisma([
    ROW(1, 'only'),
    ROW(2, 'auto-off', { enabled: false, autoDisabled: true, healthStatus: 'DOWN' }),
  ])
  const { probe } = probeAlways(false, 'connect ECONNREFUSED')
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 1 })

  const only = r.outcomes.find((o) => o.code === 'only')!
  check(only.action === 'REFUSE_LAST', '唯一启用通道 → REFUSE_LAST', `实际 ${only.action}`)
  check(!calls.updates.some((u) => u.id === '1'), '★ 没有把它写停用（否则所有 AI 场景静默落兜底模板）')
  check(r.refused === 1 && r.disabled === 0, '汇总 refused=1 / disabled=0', `refused=${r.refused} disabled=${r.disabled}`)
  check(!!only.note, '给出了原因说明，便于后台展示', only.note ?? '')
}

console.log('\n=== ⑤/⑥ 自动停用的通道：探通即启用；且每轮只探 1 轮 ===')
{
  const { prisma, calls } = makeFakePrisma([
    ROW(1, 'recovered', { enabled: false, autoDisabled: true, healthStatus: 'DOWN' }),
    ROW(2, 'live'),
  ])
  const { probe, calls: probeCalls } = probeAlways(true)
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 3 })

  const rec = r.outcomes.find((o) => o.code === 'recovered')!
  check(rec.action === 'ENABLE', '自动停用的通道 → ENABLE', `实际 ${rec.action}`)
  check(rec.rounds === 1, '一次探通就结束', `实际 ${rec.rounds}`)
  const upd = calls.updates.find((u) => u.id === '1')
  check(
    upd?.data.enabled === true && upd?.data.autoDisabled === false && upd?.data.healthStatus === 'HEALTHY',
    '★ 三个字段一起写：enabled=true + autoDisabled=false + healthStatus=HEALTHY',
    JSON.stringify(upd?.data),
  )
  check(r.enabled === 1, '汇总 enabled = 1', `实际 ${r.enabled}`)

  // ⑥ 已停用 + 探不通 ⇒ 只探 1 轮（不做 4 轮复检，避免每 30 分钟白烧 6 分钟）
  const { prisma: p6, calls: c6 } = makeFakePrisma([
    ROW(1, 'still-down', { enabled: false, autoDisabled: true, healthStatus: 'DOWN' }),
    ROW(2, 'live'),
  ])
  const s6 = probeAlways(false)
  const r6 = await sweepAiProviderHealth(p6, { probe: s6.probe, sleep: noSleep, retryRounds: 3 })
  const sd = r6.outcomes.find((o) => o.code === 'still-down')!
  check(sd.rounds === 1 && sd.action === 'KEEP', '仍挂着的已停用通道：只探 1 轮 + KEEP', `rounds=${sd.rounds} action=${sd.action}`)
  check(
    s6.calls.filter((c) => c.providerId === '1').length === 1,
    '★ 没有对它做 4 轮复检',
    `实际 ${s6.calls.filter((c) => c.providerId === '1').length} 次`,
  )
  check(!c6.updates.some((u) => u.id === '1'), '没有重复写库（updatedAt 不被每 30 分钟刷一次）')
}

console.log('\n=== ⑦ 复检轮数：任一轮成功即停、全失败才停用 ===')
{
  const { prisma: p1, calls: c1 } = makeFakePrisma([ROW(1, 'flaky'), ROW(2, 'live')])
  const s1 = probeSequence([false, true, false, false])
  const r1 = await sweepAiProviderHealth(p1, { probe: s1.probe, sleep: noSleep, retryRounds: 3 })
  const flaky = r1.outcomes.find((o) => o.code === 'flaky')!
  check(flaky.rounds === 2 && flaky.action === 'KEEP', '第 2 轮成功 → 探 2 轮、判 KEEP', `rounds=${flaky.rounds} action=${flaky.action}`)
  check(!c1.updates.some((u) => u.id === '1'), '抖动通道没有被停用')

  const { prisma: p2 } = makeFakePrisma([ROW(1, 'ok'), ROW(2, 'live')])
  const s2 = probeSequence([true])
  const r2 = await sweepAiProviderHealth(p2, { probe: s2.probe, sleep: noSleep, retryRounds: 3 })
  const ok = r2.outcomes.find((o) => o.code === 'ok')!
  check(ok.rounds === 1, '首次成功 → 只探 1 轮', `实际 ${ok.rounds}`)
}

console.log('\n=== ⑧ 没有可用模型 → 跳过且不写库 ===')
{
  const { prisma, calls } = makeFakePrisma([ROW(1, 'nomodel', { models: [] }), ROW(2, 'live')])
  const { probe } = probeAlways(true)
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 0 })
  const nm = r.outcomes.find((o) => o.code === 'nomodel')!
  check(nm.rounds === 0 && nm.action === 'KEEP', '无模型通道：0 轮探测、KEEP', `rounds=${nm.rounds} action=${nm.action}`)
  check(r.noModel === 1, '汇总 noModel = 1', `实际 ${r.noModel}`)
  check(!calls.updates.some((u) => u.id === '1'), '无模型通道没有被停用（属配置缺失，不是不健康）')
}

console.log('\n=== ⑨ 探活模型挑选：优先 TEXT 能力 ===')
{
  const { prisma } = makeFakePrisma([
    ROW(1, 'multi', {
      models: [
        // 按 modelCode 升序后 image 在前 —— 不能拿它探活（出图模型的结果与业务可用性无关）
        { modelCode: 'a-image-model', capability: 'IMAGE', enabled: true },
        { modelCode: 'z-text-model', capability: 'TEXT', enabled: true },
      ],
    }),
    ROW(2, 'live'),
  ])
  const seen: string[] = []
  const probe: HealthProbe = async ({ modelCode }) => {
    seen.push(modelCode)
    return { ok: true, latencyMs: 10 }
  }
  await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 0 })
  check(seen.includes('z-text-model'), '挑中的是 TEXT 模型', seen.join(','))
  check(!seen.includes('a-image-model'), '没有拿 IMAGE 模型去探活')
}

console.log('\n=== ⑩ 真实调用证据优先：24h 内有成功 ⇒ 一次都不探、不停用 ===')
{
  const now = new Date('2026-09-21T12:00:00Z')
  const { prisma, calls } = makeFakePrisma(
    [ROW(1, 'busy'), ROW(2, 'quiet')],
    [
      { providerId: 1n, status: 'SUCCESS', createdAt: new Date(now.getTime() - 2 * HOUR) },
      { providerId: 1n, status: 'FALLBACK_USED', createdAt: new Date(now.getTime() - 5 * HOUR) },
    ],
  )
  const { probe, calls: probeCalls } = probeAlways(false, 'request timeout after 90000ms')
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 3, now })

  const busy = r.outcomes.find((o) => o.code === 'busy')!
  check(busy.rounds === 0 && busy.skippedByEvidence, '有证据的通道：0 轮探测、标记 skippedByEvidence', `rounds=${busy.rounds}`)
  check(busy.action === 'KEEP_EVIDENCE', '★ 有真实证据 → KEEP_EVIDENCE（不因合成探测失败而停用）', `实际 ${busy.action}`)
  check(!probeCalls.some((c) => c.providerId === '1'), '★ 一次都没探它（零成本、零误判）')
  check(!calls.updates.some((u) => u.id === '1'), '没有写库')
  check(r.skipByEvidence === 1, '汇总 skipByEvidence = 1', `实际 ${r.skipByEvidence}`)

  const quiet = r.outcomes.find((o) => o.code === 'quiet')!
  check(quiet.rounds === 4 && quiet.action === 'DISABLE', '没证据的通道照常复检并停用', `rounds=${quiet.rounds} action=${quiet.action}`)
}

console.log('\n=== ⑪ TEST 日志不构成证据 ===')
{
  const now = new Date('2026-09-21T12:00:00Z')
  const { prisma, calls } = makeFakePrisma(
    [ROW(1, 'only-test'), ROW(2, 'live')],
    [{ providerId: 1n, status: 'TEST', createdAt: new Date(now.getTime() - HOUR) }],
  )
  const { probe } = probeAlways(false, 'HTTP 400')
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 1, now })

  const t = r.outcomes.find((o) => o.code === 'only-test')!
  check(t.rounds > 0, '只有 TEST 日志的通道仍会被探活', `rounds=${t.rounds}`)
  check(t.action === 'DISABLE', '★ TEST 日志不算证据 → 仍会被停用', `实际 ${t.action}`)

  const evArgs = calls.evidenceArgs as { where?: { status?: { in?: string[] } } } | undefined
  const statuses = evArgs?.where?.status?.in ?? []
  check(
    statuses.length > 0 && !statuses.includes('TEST') && statuses.includes('SUCCESS') && statuses.includes('FALLBACK_USED'),
    '★ 证据查询的 status 白名单 = [SUCCESS, FALLBACK_USED]，显式不含 TEST',
    JSON.stringify(statuses),
  )
}

console.log('\n=== ⑫ 证据窗口外的旧成功不算证据 ===')
{
  const now = new Date('2026-09-21T12:00:00Z')
  const { prisma } = makeFakePrisma(
    [ROW(1, 'stale'), ROW(2, 'live')],
    // 26 小时前的成功：超出默认 24h 窗口
    [{ providerId: 1n, status: 'SUCCESS', createdAt: new Date(now.getTime() - 26 * HOUR) }],
  )
  const { probe, calls: probeCalls } = probeAlways(false, 'HTTP 524')
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 1, now })
  const stale = r.outcomes.find((o) => o.code === 'stale')!
  check(stale.rounds === 2 && stale.action === 'DISABLE', '过期的成功不算证据 → 正常探活并停用', `rounds=${stale.rounds} action=${stale.action}`)
  check(probeCalls.some((c) => c.providerId === '1'), '确实探了它')
}

console.log('\n=== ⑬ 免探测 + 已自动停用 + 有证据 ⇒ 重新启用（防 24h 死锁） ===')
{
  const now = new Date('2026-09-21T12:00:00Z')
  const { prisma, calls } = makeFakePrisma(
    [ROW(1, 'auto-off-but-ok', { enabled: false, autoDisabled: true, healthStatus: 'DOWN' }), ROW(2, 'live')],
    [{ providerId: 1n, status: 'SUCCESS', createdAt: new Date(now.getTime() - 3 * HOUR) }],
  )
  const { probe, calls: probeCalls } = probeAlways(false)
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 3, now })
  const row = r.outcomes.find((o) => o.code === 'auto-off-but-ok')!
  check(row.action === 'ENABLE', '★ 有真实证据 ⇒ ENABLE', `实际 ${row.action}`)
  check(row.rounds === 0, '且不需要探测', `rounds=${row.rounds}`)
  check(!probeCalls.some((c) => c.providerId === '1'), '没有探它')
  const upd = calls.updates.find((u) => u.id === '1')
  check(
    upd?.data.enabled === true && upd?.data.autoDisabled === false && upd?.data.healthStatus === 'HEALTHY',
    '写回 enabled=true + autoDisabled=false + healthStatus=HEALTHY',
    JSON.stringify(upd?.data),
  )
}

console.log('\n=== ⑭ 探活请求体与超时的配置回归 ===')
{
  check(
    HEALTH_PROBE_PROMPT.length > 60 && !/^ping$/i.test(HEALTH_PROBE_PROMPT.trim()),
    '★ 探活提示词是内容型（不能用 "ping"：那个请求体的读数不可复现，实测有 200/4.9s、400、200 但耗 90s）',
    `长度 ${HEALTH_PROBE_PROMPT.length}`,
  )
  check(
    HEALTH_PROBE_MAX_OUTPUT_TOKENS >= 32,
    'maxOutputTokens ≥ 32（16 会被推理模型的思考吃光，得到空正文假失败）',
    `实际 ${HEALTH_PROBE_MAX_OUTPUT_TOKENS}`,
  )
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/ai/ai-health.service.ts', import.meta.url), 'utf8'),
  )
  const m = /AI_HEALTH_PROBE_TIMEOUT_MS \?\? ([\d_]+)/.exec(src)
  const timeout = Number((m?.[1] ?? '0').replace(/_/g, ''))
  check(
    timeout >= 60_000,
    '★ 默认探活超时 ≥ 60s（gpt-5.5 实测 36~52s 才回完，10s 会假失败）',
    `实际 ${timeout}ms`,
  )
}

console.log('\n=== ⑮ 图像通道必须用图像适配器探活（2026-09-21 封面事故的根因回归） ===')
{
  const fs = await import('node:fs')
  const gw = fs.readFileSync(new URL('../src/ai/gateway.ts', import.meta.url), 'utf8')
  check(
    /const wantImage = normalizeModelCapability\(model\.capability\) === 'IMAGE'/.test(gw),
    '★ testProvider 按模型能力判定 wantImage',
  )
  check(
    /const adapter = wantImage \? openaiImage : getAdapter\(provider\.protocol\)/.test(gw),
    '★★ 探活适配器按能力选择（写成 chat 会让图像通道必然 400 → 自动停用 → 封面全挂）',
  )
  check(
    /openaiImage/.test(gw.slice(0, gw.indexOf('export class AiGateway'))),
    'openaiImage 确实被 import 进来了（不是只改了个假分支）',
  )
  const hp = fs.readFileSync(new URL('../src/ai/health-probe.ts', import.meta.url), 'utf8')
  check(
    /HEALTH_PROBE_IMAGE_PROMPT/.test(hp) && /HEALTH_PROBE_IMAGE_PROMPT/.test(gw),
    '图像探活有独立的画面描述提示词（不能拿文本探活提示词当画面描述）',
  )
}

console.log('\n=== ⑯ 拒绝自锁按能力算：唯一的图像通道失败也不停用 ===')
{
  const { prisma, calls } = makeFakePrisma([
    ROW(1, 'img-only', { models: [IMAGE_MODEL('gpt-image-2')] }),
    ROW(2, 'txt-a'),
    ROW(3, 'txt-b'),
  ])
  const { probe } = probeAlways(false, 'HTTP 400 upstream')
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 0 })

  const img = r.outcomes.find((o) => o.code === 'img-only')!
  check(
    img.action === 'REFUSE_LAST',
    '★ 唯一的图像通道探测失败 → REFUSE_LAST（旧的全局计数会给出 =2 于是把它停用）',
    `实际 ${img.action}`,
  )
  check(
    !calls.updates.some((u) => u.id === '1'),
    '★ 没有停用它，也没有写 healthStatus=DOWN（那在 gateway 里等同于停用，护栏会形同虚设）',
  )
  check(img.note?.includes('IMAGE') === true, '原因说明里点明了能力维度，便于后台展示', img.note ?? '')
  check(
    r.disabled === 1 && r.refused >= 1,
    '★ 本轮只停用了 1 条文本通道：护栏按**实时**状态逐条判定 —— txt-a 被停用后，' +
      'txt-b 就成为最后一条 TEXT 通道并被拒绝（若按本轮开始时的快照算，两条都会被停光 ⇒ 文本场景全落兜底模板）',
    `disabled=${r.disabled} refused=${r.refused}`,
  )

  // 对照组：文本通道之间仍然互为顶替关系 ⇒ 照常停用（护栏没有扩大成"谁都不能停"）
  const txtA = r.outcomes.find((o) => o.code === 'txt-a')!
  check(txtA.action === 'DISABLE', '文本通道有同能力顶替者 → 照常 DISABLE', `实际 ${txtA.action}`)
}

console.log('\n=== ⑰ 图像通道探活节流 + 只探 1 轮（探一次要花一张图的真钱） ===')
{
  const now = new Date('2026-09-21T12:00:00Z')
  const { prisma, calls } = makeFakePrisma([
    // 1h 前刚探过 → 本轮免探
    ROW(1, 'img-recent', { models: [IMAGE_MODEL()], lastTestAt: new Date(now.getTime() - 1 * HOUR) }),
    // 7h 前探过（超出默认 6h 节流窗口）→ 该探了；且图像通道只探 1 轮
    ROW(2, 'img-stale', { models: [IMAGE_MODEL()], lastTestAt: new Date(now.getTime() - 7 * HOUR) }),
    // 文本通道即使刚探过也**不受**节流，照常按 retryRounds 探
    ROW(3, 'txt-recent', { lastTestAt: new Date(now.getTime() - 1 * HOUR) }),
  ])
  const { probe, calls: probeCalls } = probeAlways(false, 'HTTP 524')
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 3, now })

  const recent = r.outcomes.find((o) => o.code === 'img-recent')!
  check(
    recent.rounds === 0 && recent.action === 'KEEP',
    '★ 刚探过的图像通道：0 轮探测 + KEEP',
    `rounds=${recent.rounds} action=${recent.action}`,
  )
  check(
    !probeCalls.some((c) => c.providerId === '1'),
    '★ 没有探它（出图探活一张约 $0.1，30 分钟一轮 = $144/月）',
  )
  check(
    !calls.updates.some((u) => u.id === '1'),
    '节流是成本控制、不是健康判据 ⇒ 不动它的任何状态',
  )
  check(recent.note?.includes('节流') === true, '给出了节流说明（不与「探测通过/真实证据」混淆）', recent.note ?? '')
  check(r.throttled === 1, '汇总 throttled = 1（与 skipByEvidence 分开计）', `实际 ${r.throttled}`)

  const stale = r.outcomes.find((o) => o.code === 'img-stale')!
  check(
    stale.rounds === 1,
    '★ 超出节流窗口的图像通道：只探 1 轮（出图读数是 HTTP 码，没有文本那种慢/死歧义，复检只是多买废图）',
    `rounds=${stale.rounds}`,
  )

  const txt = r.outcomes.find((o) => o.code === 'txt-recent')!
  check(txt.rounds === 4, '★ 文本通道不受节流影响，仍按 retryRounds 复检', `rounds=${txt.rounds}`)

  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/ai/ai-health.service.ts', import.meta.url), 'utf8')
  const iv = Number((/AI_HEALTH_IMAGE_PROBE_MS \?\? ([\d_]+)/.exec(src)?.[1] ?? '0').replace(/_/g, ''))
  check(
    iv >= 3_600_000,
    '★ 图像探活节流默认 ≥ 1 小时（调成 30 分钟 = 每天 48 张图 ≈ $4.8/天，比业务花费还高）',
    `实际 ${iv}ms`,
  )
  const it = Number(
    (/AI_HEALTH_IMAGE_PROBE_TIMEOUT_MS \?\? ([\d_]+)/.exec(src)?.[1] ?? '0').replace(/_/g, ''),
  )
  check(
    it >= 120_000,
    '★ 图像探活超时 ≥ 120s（实测 35.7s 只是典型值；探活失败会停掉唯一候选，宁可多等）',
    `实际 ${it}ms`,
  )
}

console.log('\n=== ⑱ 已自动停用的图像通道不受节流（否则它永远无法自动恢复） ===')
{
  const now = new Date('2026-09-21T12:00:00Z')
  const { prisma, calls } = makeFakePrisma([
    ROW(1, 'img-auto-off', {
      enabled: false,
      autoDisabled: true,
      healthStatus: 'DOWN',
      models: [IMAGE_MODEL()],
      // ★ 它就是「被那次失败的探活停用」的通道：last_test_at 正好是刚失败的这次探活。
      //   若节流对它也生效，就会出现「刚被误停用 ⇒ 6 小时内不再探 ⇒ 无法自动恢复」，
      //   而另一条恢复路径（24h 真实证据）也断了：通道已停用 ⇒ 没有真实调用 ⇒ 攒不出证据。
      lastTestAt: new Date(now.getTime() - 5 * 60_000),
    }),
  ])
  const { probe, calls: probeCalls } = probeAlways(true)
  const r = await sweepAiProviderHealth(prisma, { probe, sleep: noSleep, retryRounds: 3, now })

  const row = r.outcomes.find((o) => o.code === 'img-auto-off')!
  check(row.rounds === 1, '★ 距上次（失败的）探活只有 5 分钟，仍然探了 1 轮', `rounds=${row.rounds}`)
  check(probeCalls.some((c) => c.providerId === '1'), '确实探了它（节流豁免）')
  check(row.action === 'ENABLE', '★ 探通即自动恢复启用', `实际 ${row.action}`)
  check(r.throttled === 0, '不计入节流汇总', `实际 ${r.throttled}`)
  check(
    calls.updates.some((u) => u.id === '1' && u.data.enabled === true),
    '写回 enabled=true',
  )
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
