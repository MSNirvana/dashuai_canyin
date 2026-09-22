/**
 * AI 档（ChatCut）镜头时长规划的守护 —— 「先用后声明」（TDZ）与时长口径的离线闸门。
 *
 * ★★ 为什么需要它（2026-09-22 线上事故，任务 errorCode=CHATCUT_FAILED）：
 *   `chatcut-driver.ts` 里那串时长闭包在 `const fps = input.output.fps` **之前**就被
 *   `clips.map()` 求值：slotMs → scaledShotMs → rawShotMs → handleMsOf → `… / fps`。
 *   于是**每一次** AI 档合成都抛 `Cannot access 'fps' before initialization`。
 *     · typecheck **不报**（闭包内引用后面声明的变量，静态无法判定是否会先执行）
 *     · 构建、部署全都成功
 *     · **只有真实跑一次任务才炸** ⇒ 上线后才被发现，且表现为「所有人都出不了片」
 *   ⇒ 唯一守得住的办法：把那套计算抽成纯函数（`src/render/chatcut-timing.ts`）并**真的算一遍**。
 *
 * 六节：① 9 种档位组合都能算完（**含 CLEAN** —— 事故正是它出的）
 *      ② 素材口径（真实探测值 vs 客户端上报取整值）③ 转场余量
 *      ④ 节奏档位（只缩短不拉长）⑤ 返回数组可被后续改写 ⑥ 帧换算边界
 *
 * 运行：cd server && npx tsx scripts/verify-chatcut-timing.ts
 * ⚠ 纯函数、零 I/O、零数据库 ⇒ 本脚本**不连库、不连 Redis**，也不该引入任何连接。
 */
import { framesOf, planShotTiming, TRANSITION_HANDLE_MAX_RATIO } from '../src/render/chatcut-timing.js'

let pass = 0
let fail = 0

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const hit =
    Object.is(actual, expected) ||
    (typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) < 1e-6)
  ok(label, hit, `期望 ${String(expected)}，实得 ${String(actual)}`)
}

function near(label: string, actual: number, expected: number): void {
  ok(label, Math.abs(actual - expected) < 1e-6, `期望 ≈${expected}，实得 ${actual}`)
}

const FPS = 30
const TRANSITIONS = ['CLEAN', 'SMOOTH', 'DYNAMIC'] as const
const PACINGS = ['NATURAL', 'FAST', 'STORY'] as const

/**
 * 与 `chatcut.ts` 的 TRANSITION_PLANS / PACING_PLANS **同值**的测试夹具。
 * ★ 抄一份值是**故意的**：它是「档位表被人改了」的探针 —— chatcut.ts 一改，这里的期望值就失配，
 *   逼你回来看一眼。⚠ 但别把**档位表本身**搬进来，生产代码只认 chatcut.ts 那一份。
 * （`npm run chatcut-timing:verify` 失败时，第一个该看的就是这个夹具与 chatcut.ts 是否还同值）
 */
const HANDLE_WANTED: Record<(typeof TRANSITIONS)[number], number> = { CLEAN: 0, SMOOTH: 6, DYNAMIC: 8 }
const PACING_VALUE: Record<(typeof PACINGS)[number], { shotScale: number; minShotMs: number }> = {
  NATURAL: { shotScale: 1, minShotMs: 0 },
  FAST: { shotScale: 0.78, minShotMs: 1200 },
  STORY: { shotScale: 1, minShotMs: 0 },
}

/**
 * 三镜头夹具：
 *   0 号：探测到真实 4000ms
 *   1 号：**探测到 2968ms、客户端上报 3000ms** —— 经典「上报取整值」陷阱
 *   2 号：超短镜头 800ms（触发「余量不足 2 帧 ⇒ 记 0」）
 */
const CLIPS = [
  { durationMs: 4000, trimStartMs: 0 },
  { durationMs: 3000, trimStartMs: 0 },
  { durationMs: 800, trimStartMs: 0 },
]
const ASSET_MS = [4000, 2968, 800]

function plan(transition: (typeof TRANSITIONS)[number], pacing: (typeof PACINGS)[number]) {
  return planShotTiming({
    clips: CLIPS,
    clipAssetMs: ASSET_MS,
    fps: FPS,
    transitionHandleFrames: HANDLE_WANTED[transition],
    pacingShotScale: PACING_VALUE[pacing].shotScale,
    pacingMinShotMs: PACING_VALUE[pacing].minShotMs,
  })
}

type TimingResult = ReturnType<typeof planShotTiming>

// ── ① 档位组合闸门 ──────────────────────────────────────────────────────────
console.log('\n① 档位组合闸门（9 种组合都必须「算得完」—— 本轮事故就死在这里）')
for (const transition of TRANSITIONS) {
  for (const pacing of PACINGS) {
    let error: Error | null = null
    let result: TimingResult | null = null
    try {
      result = plan(transition, pacing)
    } catch (caught) {
      error = caught as Error
    }
    const tdz = Boolean(error && /before initialization/.test(error.message))
    ok(
      `${transition} × ${pacing}`,
      error === null,
      tdz
        ? `★★ TDZ 回归！${error!.message} —— 「先用后声明」又出现了，去看 chatcut-timing.ts 头部注释`
        : `抛错：${error?.message ?? ''}`,
    )
    if (!result) continue
    // ★ 时长必须有限非负：NaN 会静默排出一堆 0 帧的轨道（比抛错更难查）
    ok(
      '  └ slotMs 全部有限非负',
      result.slotMs.every((value) => Number.isFinite(value) && value >= 0),
      JSON.stringify(result.slotMs),
    )
  }
}

// ── ② 素材口径 ──────────────────────────────────────────────────────────────
console.log('\n② 素材口径（必须按探测到的真实时长排帧）')
{
  const result = plan('CLEAN', 'NATURAL')
  eq('1 号镜头用探测值 2968ms（不是上报的 3000ms）', result.slotMs[1], 2968)
  eq('  └ 换帧 = 89（误用 3000 会得 90 ⇒ 被 ChatCut 拒单）', framesOf(result.slotMs[1]!, FPS), 89)
  eq('  └ 反证：上报值确实是 90 帧', framesOf(3000, FPS), 90)
  eq('0 号 4000ms ⇒ 120 帧', framesOf(result.slotMs[0]!, FPS), 120)
}
{
  const result = planShotTiming({
    clips: [{ durationMs: 3000, trimStartMs: 0 }],
    clipAssetMs: [null],
    fps: FPS,
    transitionHandleFrames: 0,
    pacingShotScale: 1,
    pacingMinShotMs: 0,
  })
  eq('探测失败（null）⇒ 才允许退回上报值 3000ms', result.slotMs[0], 3000)
}
{
  const result = planShotTiming({
    clips: [{ durationMs: 5000, trimStartMs: 1000, trimEndMs: 3200 }],
    clipAssetMs: [4000],
    fps: FPS,
    transitionHandleFrames: 0,
    pacingShotScale: 1,
    pacingMinShotMs: 0,
  })
  eq('trim [1000, 3200) ⇒ 可用 2200ms', result.slotMs[0], 2200)
}

// ── ③ 转场余量 ──────────────────────────────────────────────────────────────
console.log('\n③ 转场余量（比例上限 / 不足 2 帧记 0 / 余量 0 时完全不改时长）')
{
  const clean = plan('CLEAN', 'NATURAL')
  ok('CLEAN：handleFrames 全 0', clean.handleFrames.every((v) => v === 0), JSON.stringify(clean.handleFrames))
  ok('CLEAN：handleMsOf 全 0', CLIPS.map((_, i) => clean.handleMsOf(i)).every((v) => v === 0))
  ok(
    '★ CLEAN：slotMs === 真实可用时长（余量 0 ⇒ 完全不改时长，行为与本段引入前一致）',
    clean.slotMs.every((value, index) => value === ASSET_MS[index]!),
    JSON.stringify(clean.slotMs),
  )
}
{
  const smooth = plan('SMOOTH', 'NATURAL')
  eq('SMOOTH：4000ms ⇒ 预留 6 帧（受 wanted 约束）', smooth.handleFrames[0], 6)
  eq('SMOOTH：2968ms ⇒ 预留 6 帧', smooth.handleFrames[1], 6)
  eq('SMOOTH：800ms ⇒ 预留 3 帧（15% 比例封顶生效）', smooth.handleFrames[2], 3)
  near('SMOOTH：4000ms 首尾各扣 6 帧 ⇒ raw = 3600ms', smooth.rawShotMs(0), 3600)
  near('SMOOTH：handleMsOf = 6/30*1000 = 200ms', smooth.handleMsOf(0), 200)
}
{
  const dynamic = plan('DYNAMIC', 'NATURAL')
  eq('DYNAMIC：4000ms ⇒ 预留 8 帧', dynamic.handleFrames[0], 8)
  ok(
    '比例上限生效：预留 ≤ floor(镜头帧数 × 0.15)',
    dynamic.handleFrames.every(
      (value, index) => value <= Math.floor(framesOf(ASSET_MS[index]!, FPS) * TRANSITION_HANDLE_MAX_RATIO),
    ),
    JSON.stringify(dynamic.handleFrames),
  )
}
{
  const result = planShotTiming({
    clips: [{ durationMs: 400, trimStartMs: 0 }],
    clipAssetMs: [400],
    fps: FPS,
    transitionHandleFrames: 6,
    pacingShotScale: 1,
    pacingMinShotMs: 0,
  })
  eq('极短镜头（400ms ⇒ 12 帧，15% = 1 帧）⇒ 余量记 0（该接缝走硬切）', result.handleFrames[0], 0)
  eq('  └ 于是时长不被扣减：raw = 400ms', result.rawShotMs(0), 400)
}

// ── ④ 节奏档位 ──────────────────────────────────────────────────────────────
console.log('\n④ 节奏档位（只缩短不拉长）')
{
  const fast = plan('CLEAN', 'FAST') // CLEAN ⇒ raw 就是真实可用时长
  eq('FAST：4000ms × 0.78 = 3120ms', fast.slotMs[0], 3120)
  eq('FAST：2200ms × 0.78 = 1716ms > 下限 1200 ⇒ 1716ms', fast.slotMs[1], Math.round(2968 * 0.78))
  eq('FAST：800ms × 0.78 = 624ms 被下限顶到 1200 ⇒ 不超原始 800 ⇒ 800ms', fast.slotMs[2], 800)
}
{
  const story = plan('CLEAN', 'STORY')
  ok(
    'STORY / NATURAL（shotScale=1）：时长不变',
    story.slotMs.every((value, index) => value === ASSET_MS[index]!),
    JSON.stringify(story.slotMs),
  )
}
{
  // 「绝不超过原始时长」在三种节奏 × 三种转场下都成立（否则排帧必超素材 ⇒ 被 ChatCut 拒单）
  let worst: string | null = null
  for (const transition of TRANSITIONS) {
    for (const pacing of PACINGS) {
      const result = plan(transition, pacing)
      for (let index = 0; index < CLIPS.length; index += 1) {
        if (result.slotMs[index]! > result.rawShotMs(index) + 1e-6) {
          worst = `${transition} × ${pacing} #${index}：slot ${result.slotMs[index]} > raw ${result.rawShotMs(index)}`
        }
      }
    }
  }
  ok('★ 全部 9 种组合：目标时长 ≤ 原始时长（排帧不会超素材）', worst === null, worst ?? '')
}

// ── ⑤ 返回数组可被后续改写（TTS 抬高镜头时长依赖这个引用）──────────────────
console.log('\n⑤ 返回的 slotMs 可被按下标改写（TTS 段靠它抬高镜头）')
{
  const result = plan('CLEAN', 'NATURAL')
  result.slotMs[0] = 5000
  eq('改写后读回是新值', result.slotMs[0], 5000)
  eq('  └ 数组长度与镜头数一致', result.slotMs.length, CLIPS.length)
}

// ── ⑥ 帧换算边界 ────────────────────────────────────────────────────────────
console.log('\n⑥ 帧换算边界（向下取整、至少 1 帧）')
eq('framesOf(2968, 30) = 89（向下取整）', framesOf(2968, FPS), 89)
eq('framesOf(0, 30) = 1（保底 1 帧）', framesOf(0, FPS), 1)
eq('framesOf(33, 30) = 1（不足 1 帧也保底）', framesOf(33, FPS), 1)
eq('framesOf(40, 25) = 1', framesOf(40, 25), 1)
eq('framesOf(1000, 25) = 25', framesOf(1000, 25), 25)

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
