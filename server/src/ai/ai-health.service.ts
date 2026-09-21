// AI 通道健康体检：30 分钟一轮探活 → 连续失败自动停用 → 探测恢复后自动启用。
//
// ────────────────────────── 它和现有熔断器的分工 ──────────────────────────
// · `circuit-breaker.ts` 是**请求路径上**的短时熔断（秒~分钟级）：只回答「这个通道
//   此刻还能不能立刻用」，用来把一次坏调用立刻换成备用通道；
// · 本 sweeper 是**库存层面**的可用性判定（30 分钟级）：决定一个通道在后台是否被
//   显示成「已停用」，并且是**可自动恢复**的。它真正补的是「**安静通道**」这个盲区 ——
//   没有流量时熔断器永远不会打开，等到流量来了，第一个请求先白吃一次超时。
// 两者最终都通过 `enabled` / `healthStatus` 影响 gateway 的候选跳过，但本 sweeper
// 只动这两列（外加自己拥有的 `autoDisabled`）—— **绝不改 `priority`、绝不重排候选链**。
//
// ★ 为什么明令禁止在这里重排候选链（哪怕需求原话里有「调节优先级顺序」）：
//   候选顺序由 `ai_scene.default_model_id + fallback_model_ids` 决定，`ai_provider.priority`
//   **完全不参与故障转移**（只用于后台列表排序）。所以「按可用性重排优先级」在实现上
//   等价于「改 ai_scene 的候选链」，那会：
//     ① 让刚修好的分镜链（DeepSeek→Claude，150s，禁用 GPT）被静默改回去；
//     ② 让前端超时算错（前端超时 = 候选数 × 单候选超时 × (maxRetries+1)，链路一变就得同步重算）；
//     ③ 把一次「探测抖动」放大成长期路由变化，且没有任何审计痕迹。
//   停用/启用已经能达到「不可用的通道不被使用」这个唯一目的，且是可逆、可审计的单列写入。
//
// ────────────────────────── 判据：真实证据优先，合成探测只补沉默 ──────────────────────────
// ★★ 这是本模块最要紧的一条设计，理由是被实测逼出来的：
//   合成探活**测不出「慢」与「死」的边界**。实测 tokenbox-gpt 对一个 30 字的概括请求：
//     35.7s 成功 / 36.2s 成功 / 52.4s 成功 / 一次 > 120s 超时。
//   也就是说，任何固定超时都会**随机**把它判成死；而它是 9 个文案场景的默认模型，
//   一旦被误停用，流量会全数落到成本更高的备用通道（单次 116~156 分 vs 售价 62.5 分）。
//   所以判据分层：
//     ① `ai_call_log` 里最近 EVIDENCE_MS 内有**真实调用成功**（status = SUCCESS 或
//        FALLBACK_USED）⇒ 视为可用，**连探活都不做**（零成本、零误判）。
//        真实证据永远压过合成探测 —— 它才是「这个通道能不能干活」的直接测量。
//     ② 没有真实证据（安静通道 / 真的挂了）才做探活。此时合成探测是唯一可得的信息，
//        用它做判据是合理的，因为没有任何反证。
//     ③ 探活失败也**不立刻停用**：还要「除它之外至少还有一条通道开着」（拒绝自锁）。
//   ⚠ 注意 `status='TEST'` 的行**不构成证据**：那是后台手动测试 / 探活自己写的，
//     让合成成功变成证据会让这套分层失去意义（所以证据查询显式只认 SUCCESS / FALLBACK_USED）。
//
// ────────────────────────── 两个必须绕开的坑 ──────────────────────────
// ① `gateway.ts` 的候选跳过里有 `if (!provider.enabled || ...) continue`
//    ⇒ 被本 sweeper 停用的通道在**请求路径**上不会再被探到。
//    所以扫描候选集必须自己写成 `enabled = 1 OR auto_disabled = 1`，不能只看 enabled ——
//    否则「下次检测通过自动开启」永远不会发生（这正是需求第 2 条的后半句）。
// ② 探活请求体必须是**内容型**提示词（health-probe.ts），不能用 'ping'：
//    中转会对短输入探测返回 400，把可用通道判成死。
//
// ────────────────────────── 为什么探测是「串行 + 间隔」而不是并发 ──────────────────────────
// 线上三条通道（tokenbox-gpt / claude / deepseek）**共用同一个上游网关**。
// 并发探活会在同一个瞬间给这个网关打 3 个请求，一旦它此刻正在限流，我们就会
// 自己把三条通道同时判死 —— 一次「自己制造的全面停用」。所以逐个探、中间留间隔。
//
// ────────────────────────── 耗时上限（为什么这些数字是这些数字） ──────────────────────────
// 单通道最坏 = (1 + RETRY_ROUNDS) × PROBE_TIMEOUT_MS + RETRY_ROUNDS × RETRY_DELAY_MS
//            = 4 × 90s + 3 × 3s = 369s
// 3 条都在挂 = 约 18.5 分钟 < 30 分钟周期 ⇒ 不会与下一轮重叠（另有 `running` 闸门兜底）。
// 全部被停用之后，每轮只剩「恢复探测」（每条 1 轮）= 3 × 90s = 4.5 分钟，稳态开销可接受。
import type { PrismaClient } from '@prisma/client'
import { normalizeModelCapability } from './model-capabilities.js'

/** 扫描周期：默认 30 分钟（需求原话）。下限 60s 防止误配置把上游打爆。 */
const SWEEP_INTERVAL_MS = Math.max(60_000, Number(process.env.AI_HEALTH_SWEEP_MS ?? 1_800_000))
/**
 * 单次探活超时。★ 见文件头「合成探活测不出慢与死的边界」：
 * 90s 覆盖了实测到的全部成功样本（35.7 / 36.2 / 52.4s），宁可放过「慢」，不可错杀「慢」。
 */
const PROBE_TIMEOUT_MS = Math.max(5_000, Number(process.env.AI_HEALTH_PROBE_TIMEOUT_MS ?? 90_000))
/** 首次失败后再复检的轮数；这几轮**全失败**才可能停用。 */
const RETRY_ROUNDS = Math.max(0, Number(process.env.AI_HEALTH_RETRY_ROUNDS ?? 3))
/** 复检之间的间隔，让上游的瞬时抖动（429 / 网络闪断）有时间自己过去。 */
const RETRY_DELAY_MS = Math.max(0, Number(process.env.AI_HEALTH_RETRY_DELAY_MS ?? 3_000))
/** 通道之间的间隔（见文件头「串行 + 间隔」）。 */
const GAP_MS = Math.max(0, Number(process.env.AI_HEALTH_GAP_MS ?? 1_000))
/**
 * 启动后首次执行的延迟。
 * ★ 不照抄 ai-recovery 的「启动即跑一轮」：线上每次部署都会重启 PM2，而部署后那几十秒
 *   上游可能还在预热/刚刚切换实例，这时立刻体检容易拿到假失败。健康数据最多 30 分钟旧，
 *   不值得为「快一点」引入误判。要马上看结果，走后台的「立即体检」。
 */
const FIRST_RUN_DELAY_MS = Math.max(0, Number(process.env.AI_HEALTH_FIRST_DELAY_MS ?? 120_000))
/**
 * 真实证据窗口：这么久之内有过一次真实调用成功，就不再对这条通道做合成探活、也不停用它。
 * 24h 是折中 —— 真的坏掉的通道在一天内必然停止产出成功记录（它的请求会失败），
 * 于是判据自然交回给探活；而偶发使用的通道不会因为「今天恰好没人用 + 探测恰好慢」被误停。
 */
const EVIDENCE_MS = Math.max(60_000, Number(process.env.AI_HEALTH_EVIDENCE_MS ?? 86_400_000))

/** 构成「真实成功」的证据状态。★ 不含 'TEST'（探活/后台测试自己写的行）。 */
const REAL_SUCCESS_STATUSES = ['SUCCESS', 'FALLBACK_USED']

export interface HealthProbeResult {
  ok: boolean
  latencyMs: number
  errorMsg?: string
}

export type HealthProbe = (args: {
  providerId: string
  modelCode: string
  timeoutMs: number
}) => Promise<HealthProbeResult>

export type HealthAction = 'DISABLE' | 'ENABLE' | 'KEEP' | 'KEEP_EVIDENCE' | 'REFUSE_LAST'

/**
 * 纯决策：给定「这轮探活整体是成功还是失败」「它是不是 sweeper 自己停用的」
 * 「最近有没有真实调用成功过」「除它之外还有几条通道开着」，决定要不要动它的开关。
 *
 * 抽成纯函数是为了能被脚本无网络、无数据库地回归（scripts/verify-ai-health.ts）——
 * 这段逻辑一旦判错，后果是「生产上某个通道被静默关掉/打开」，光靠读代码看不出问题。
 */
export function decideHealthAction(a: {
  /** 该行当前的 enabled=false 是不是 sweeper 自己写的 */
  wasAutoDisabled: boolean
  /** 本轮所有探测轮次里是否存在至少一次成功（没探活时为 false） */
  anySuccess: boolean
  /** 除本条之外，还有几条通道是 enabled=true */
  otherEnabledProviderCount: number
  /** 最近 EVIDENCE_MS 内有没有真实调用成功（真实证据压过合成探测） */
  hasRecentRealSuccess: boolean
}): HealthAction {
  // ★ 两种证据合并成一个「健康」判断，但**谁是主判据要能追溯**：
  //   探测成功 → KEEP；只有真实证据 → KEEP_EVIDENCE（后台据此显示「因真实调用成功而免检」）。
  const evidenceHealthy = a.anySuccess || a.hasRecentRealSuccess
  if (evidenceHealthy) {
    // 我们自己之前关掉的 → 现在有证据说它能干活，打开。
    // ⚠ 这条**必须**排在「wasAutoDisabled 且没探通 → KEEP」之前：否则会出现一个死结 ——
    //   通道在 T 时刻被停用，而它在 [T-24h, T] 里本来有过一次真实成功，
    //   于是之后每轮体检都被「有真实证据 ⇒ 免探测」跳过，同时又因「已停用且没探通 ⇒ KEEP」
    //   而永远不打开 —— 白白停用最多 24 小时。
    if (a.wasAutoDisabled) return 'ENABLE'
    return a.anySuccess ? 'KEEP' : 'KEEP_EVIDENCE'
  }
  if (a.wasAutoDisabled) return 'KEEP' // 已经是停用态，不需要重复写（避免每 30 分钟刷一次 updatedAt）
  if (a.otherEnabledProviderCount <= 0) {
    // ★ 拒绝自锁：把最后一条通道也关掉，等于让**所有** AI 场景直接落到兜底模板，
    //   而运营完全不知道发生了什么（页面一切正常，只是内容永远不再由 AI 生成）。
    //   此时的正确取舍是「留着它、让真实调用去承担超时代价」，并把它标成不健康。
    return 'REFUSE_LAST'
  }
  return 'DISABLE'
}

export interface ProviderHealthOutcome {
  providerId: string
  code: string
  name: string
  /** 是否因为「最近有真实调用成功」而跳过探活 */
  skippedByEvidence: boolean
  /** 实际探测轮数（首次 + 复检）；跳过探活时为 0 */
  rounds: number
  /** 每轮是否成功 */
  results: boolean[]
  action: HealthAction
  /** 最后一次探测的错误（成功/未探测时为 undefined） */
  lastError?: string
  /** action 为 KEEP_EVIDENCE / REFUSE_LAST / 未写库时的原因说明 */
  note?: string
}

export interface AiHealthSweepResult {
  /** 候选集大小（enabled=true 或 auto_disabled=true） */
  scanned: number
  /** 真正发了探测请求的条数 */
  probed: number
  /** 因「最近有真实调用成功」而免探测的条数 */
  skipByEvidence: number
  disabled: number
  enabled: number
  refused: number
  /** 没有可用模型（配置缺失，不当成「不健康」处理）而跳过的条数 */
  noModel: number
  outcomes: ProviderHealthOutcome[]
}

const defaultProbe: HealthProbe = async ({ providerId, modelCode, timeoutMs }) => {
  // ★ 动态 import 而不是模块顶层 import：
  //   gateway-instance 会连带加载 `src/db.js`（构造 ioredis 连接）。体检的**决策逻辑**
  //   需要能被离线回归（scripts/verify-ai-health.ts 注入自己的 probe，完全不碰网络/DB），
  //   顶层 import 会让那个脚本一启动就去连 Redis。模块缓存保证这里不会有额外开销。
  const { aiGateway } = await import('./gateway-instance.js')
  const r = await aiGateway.testProvider(BigInt(providerId), modelCode, {
    timeoutMs,
    writeLog: false, // 见 gateway.testProvider 的注释：常驻体检不刷调用日志
  })
  return { ok: r.status === 'SUCCESS', latencyMs: r.latencyMs, errorMsg: r.errorMsg }
}

/**
 * 跑一轮体检。幂等：重复调用不会造成额外状态（已停用再失败不会重复写库）。
 * 可注入 `probe` / `sleep` 以便离线回归；`now` / `evidenceMs` 便于验证证据窗口。
 */
export async function sweepAiProviderHealth(
  prisma: PrismaClient,
  deps: {
    probe?: HealthProbe
    sleep?: (ms: number) => Promise<void>
    timeoutMs?: number
    retryRounds?: number
    retryDelayMs?: number
    gapMs?: number
    evidenceMs?: number
    now?: Date
  } = {},
): Promise<AiHealthSweepResult> {
  const probe = deps.probe ?? defaultProbe
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS
  const retryRounds = deps.retryRounds ?? RETRY_ROUNDS
  const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS
  const gapMs = deps.gapMs ?? GAP_MS
  const evidenceMs = deps.evidenceMs ?? EVIDENCE_MS
  const now = deps.now ?? new Date()

  // 候选集 = enabled=true（体检它的健康）∪ auto_disabled=true（体检它能不能恢复）。
  // ★ 见文件头坑 ①：第二个分支就是「下次检测通过再自动开启」的唯一入口。
  // 手工停用的行（enabled=false 且 auto_disabled=false）**永远不在**候选集里。
  const providers = await prisma.aiProvider.findMany({
    where: { OR: [{ enabled: true }, { autoDisabled: true }] },
    include: {
      models: { where: { enabled: true }, orderBy: { modelCode: 'asc' } },
    },
    orderBy: [{ enabled: 'desc' }, { priority: 'asc' }],
  })

  const result: AiHealthSweepResult = {
    scanned: providers.length,
    probed: 0,
    skipByEvidence: 0,
    disabled: 0,
    enabled: 0,
    refused: 0,
    noModel: 0,
    outcomes: [],
  }
  if (providers.length === 0) return result

  // 真实证据：一次查询拿全（`distinct` 让每个通道最多一行）。
  // ★ 只在窗口内取 SUCCESS / FALLBACK_USED —— 'TEST'（探活与后台测试）不算证据，
  //   否则「合成成功」会把自己变成免检理由，分层判据就失效了。
  const evidenceRows = await prisma.aiCallLog.findMany({
    where: {
      providerId: { in: providers.map((p) => p.id) },
      createdAt: { gte: new Date(now.getTime() - evidenceMs) },
      status: { in: REAL_SUCCESS_STATUSES },
    },
    select: { providerId: true },
    distinct: ['providerId'],
  })
  const withEvidence = new Set(evidenceRows.map((r) => r.providerId.toString()))

  // 当前 enabled=true 的集合（用于「拒绝自锁」判定），随本轮停用作实时更新。
  const enabledIds = new Set<string>(providers.filter((p) => p.enabled).map((p) => p.id.toString()))

  let first = true
  for (const p of providers) {
    const providerId = p.id.toString()
    // 只挑文本能力模型探活：探一个出图/向量模型得到的结果与业务可用性无关。
    // 找不到 TEXT 才退回第一个可用模型（老行 capability 可能是自由文本，normalize 兜住）。
    const model =
      p.models.find((m) => normalizeModelCapability(m.capability) === 'TEXT') ?? p.models[0]
    if (!model) {
      result.noModel += 1
      result.outcomes.push({
        providerId,
        code: p.code,
        name: p.name,
        skippedByEvidence: false,
        rounds: 0,
        results: [],
        action: 'KEEP',
        note: '没有启用中的模型，跳过（属配置缺失，不算不健康）',
      })
      continue
    }

    const hasRecentRealSuccess = withEvidence.has(providerId)

    // 一次都不探：**已经 autoDisabled 的行只做 1 轮**——它只需要发现「恢复了没有」，
    // 4 轮复检只会在一个持续挂掉的通道上每 30 分钟白烧 6 分钟。
    const roundsToDo = p.autoDisabled ? 0 : retryRounds
    const results: boolean[] = []
    let lastError: string | undefined
    let latencyMs = 0

    if (!hasRecentRealSuccess) {
      if (!first && gapMs > 0) await sleep(gapMs)
      first = false
      for (let round = 0; round <= roundsToDo; round++) {
        if (round > 0 && retryDelayMs > 0) await sleep(retryDelayMs)
        let r: HealthProbeResult
        try {
          r = await probe({ providerId, modelCode: model.modelCode, timeoutMs })
        } catch (e) {
          // probe 自身抛错（数据库写失败等）不该让整轮体检挂掉，按一次失败计。
          r = { ok: false, latencyMs: 0, errorMsg: (e as Error).message }
        }
        results.push(r.ok)
        latencyMs = r.latencyMs
        result.probed += 1
        if (r.ok) break
        lastError = r.errorMsg
      }
    } else {
      result.skipByEvidence += 1
    }

    const anySuccess = results.some(Boolean)
    const action = decideHealthAction({
      wasAutoDisabled: p.autoDisabled,
      anySuccess,
      otherEnabledProviderCount: enabledIds.size - (enabledIds.has(providerId) ? 1 : 0),
      hasRecentRealSuccess,
    })

    const outcome: ProviderHealthOutcome = {
      providerId,
      code: p.code,
      name: p.name,
      skippedByEvidence: hasRecentRealSuccess,
      rounds: results.length,
      results,
      action,
      ...(lastError ? { lastError } : {}),
    }
    const evidenceHours = Math.round(evidenceMs / 3_600_000)

    try {
      if (action === 'DISABLE') {
        await prisma.aiProvider.update({
          where: { id: p.id },
          data: { enabled: false, autoDisabled: true, healthStatus: 'DOWN' },
        })
        enabledIds.delete(providerId)
        result.disabled += 1
      } else if (action === 'ENABLE') {
        await prisma.aiProvider.update({
          where: { id: p.id },
          data: { enabled: true, autoDisabled: false, healthStatus: 'HEALTHY' },
        })
        enabledIds.add(providerId)
        result.enabled += 1
        outcome.note = hasRecentRealSuccess
          ? `最近 ${evidenceHours} 小时内有真实调用成功，据此重新启用（无需探测）`
          : '探测恢复，自动重新启用'
        console.warn(
          `[ai-health] 通道 ${p.code} 已自动重新启用（曾连续失败被自动停用）`,
        )
      } else if (action === 'REFUSE_LAST') {
        result.refused += 1
        outcome.note = '它是当前唯一启用的通道，拒绝停用（否则所有 AI 场景会静默落到兜底模板）'
        console.error(`[ai-health] 通道 ${p.code} 探测失败，但它是最后一条启用通道 —— 保留并继续告警`)
      } else if (!p.autoDisabled && anySuccess && p.healthStatus !== 'HEALTHY') {
        // 探测通了但标记还是非健康（例如被别的机制写成 DEGRADED/DOWN）→ 把标记纠正回来。
        await prisma.aiProvider.update({
          where: { id: p.id },
          data: { healthStatus: 'HEALTHY' },
        })
        outcome.note = `探测通过，healthStatus ${p.healthStatus} → HEALTHY`
      }
    } catch (e) {
      outcome.note = `写库失败：${(e as Error).message}`
      console.error(`[ai-health] 写回通道 ${p.code} 状态失败:`, (e as Error).message)
    }

    if (hasRecentRealSuccess && !outcome.note) {
      outcome.note = `最近 ${evidenceHours} 小时内有真实调用成功，免探测、不停用`
    }
    if (anySuccess && !outcome.note) outcome.note = `探测通过（${latencyMs}ms）`
    result.outcomes.push(outcome)
  }

  return result
}

// ──────────────────────── 调度器（照抄 ai-recovery / grant-expiry 骨架） ────────────────────────

let timer: NodeJS.Timeout | undefined
let firstTimer: NodeJS.Timeout | undefined
let running = false

/** 供后台「立即体检」端点判断是否已在跑（避免叠加、也让运营知道为什么点了没反应） */
export function isHealthSweepRunning(): boolean {
  return running
}

async function tick(prisma: PrismaClient): Promise<void> {
  if (running) return // 上一轮未结束则跳过本轮，避免叠加
  running = true
  try {
    const r = await sweepAiProviderHealth(prisma)
    if (r.scanned > 0) {
      console.log(
        `[ai-health] 体检 ${r.scanned} 条通道：停用 ${r.disabled} / 启用 ${r.enabled} / 拒绝停用 ${r.refused}` +
          `（真实证据免测 ${r.skipByEvidence}，无模型跳过 ${r.noModel}，共探测 ${r.probed} 次）`,
      )
    }
  } catch (e) {
    console.error('[ai-health] 体检失败:', (e as Error).message)
  } finally {
    running = false
  }
}

/**
 * 手动触发一轮（后台「立即体检」按钮）。
 * ★ 以**异步**方式跑：一轮体检最坏约 18.5 分钟，远超 nginx 的 proxy_read_timeout(300s)，
 *   同步等只会得到一个 504，而通道其实已经被改了状态 —— 那比不做还糟（运营会以为没生效）。
 *   返回是否成功启动；结果通过 provider 的 last_test_* 与列表里的启用状态呈现。
 */
export function triggerHealthSweep(prisma: PrismaClient): { started: boolean; reason?: string } {
  if (running) return { started: false, reason: '体检已在进行中，请稍后刷新列表查看结果' }
  void tick(prisma)
  return { started: true }
}

export function startAiHealthSweeper(prisma: PrismaClient): void {
  if (timer || firstTimer) return
  firstTimer = setTimeout(() => {
    firstTimer = undefined
    void tick(prisma)
  }, FIRST_RUN_DELAY_MS)
  firstTimer.unref()
  timer = setInterval(() => void tick(prisma), SWEEP_INTERVAL_MS)
  timer.unref()
  console.log(
    `[ai-health] started (interval=${SWEEP_INTERVAL_MS}ms, first=${FIRST_RUN_DELAY_MS}ms, ` +
      `probeTimeout=${PROBE_TIMEOUT_MS}ms, retryRounds=${RETRY_ROUNDS}, retryDelay=${RETRY_DELAY_MS}ms, ` +
      `gap=${GAP_MS}ms, evidence=${EVIDENCE_MS}ms)`,
  )
}

export function stopAiHealthSweeper(): void {
  if (timer) clearInterval(timer)
  if (firstTimer) clearTimeout(firstTimer)
  timer = undefined
  firstTimer = undefined
}
