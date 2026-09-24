/**
 * 「AI 剪辑决策（EDL）」的守护 —— 让模型直接出剪辑参数的离线闸门。
 *
 * ★★ 为什么需要它：EDL 是本项目**第一个「模型直接驱动剪辑工具」**的特性，它同时引入
 *    两类全新的、编译期完全看不见的风险：
 *
 *   ① **模型输出是自由文本**。实测会带 ```json 围栏、前后废话、尾逗号、把 `shots` 写成对象、
 *      把 `targetMs` 写成字符串……每一条都要有**确定的**处置，而且处置错了**不会报错**
 *      —— 只会安静地退回面板档位，出片从「AI 剪的」变成「模板套的」，没人会发现。
 *
 *   ② **时长必须夹两道**：粗夹（800~15000ms，本模块 `clampShotMs`）防离谱值，
 *      严夹（不超素材**真实**可用时长，`chatcut-timing.ts::planShotTiming`）防越界。
 *      少了严夹 → ChatCut 判 `Source range exceeds video asset duration` ⇒ **整单失败**，
 *      不是降级，用户白等几分钟 + 要退积分。
 *
 *   ③ **跨文件契约**（最容易漂移、也最贵的一类）：
 *      · `edl.ts` 的枚举集合 ↔ `chatcut.ts` 的 `ChatCutOptionsSchema`；
 *      · `prompts.ts` 里提示词示范的 JSON 字段名 ↔ `parseEdl` 真正读的字段名；
 *      · 提示词的 `{{变量}}` ↔ `prompt-vars.ts` 的白名单。
 *      任何一边单改，结果都是**静默退化**，所以这里逐条钉住。
 *
 * 八节：① 粗夹边界 ② 脏 JSON 容错 ③ 枚举回退 ④ 「不可用 ⇒ edl 为 null」三条路径
 *      ⑤ toEdlShotMs 的 null 语义 ⑥ 严夹（不超素材 / 不破下限 / 与转场余量无关）
 *      ⑦ ★★ 关掉 EDL 时逐字段与改动前一致 ⑧ 跨文件契约与结构约束
 *
 * 运行：cd server && npx tsx scripts/verify-edl.ts
 * ★★ 本脚本**零依赖、零连接**：不连库、不连 Redis、不发网络请求、不碰临时文件。
 *    为此它**只 import 纯函数模块**（`edl.ts` / `chatcut-timing.ts` / `prompts.ts` /
 *    `prompt-vars.ts` 都是零 import 的）；`chatcut.ts` 与 `edit-plan.service.ts`
 *    都间接拉进了连接（redis / prisma）⇒ 对它们只做**源码断言**，不 import。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clampShotMs,
  extractJsonObject,
  parseEdl,
  toEdlShotMs,
  EDL_BGMS,
  EDL_PACINGS,
  EDL_SHOT_MAX_MS,
  EDL_SHOT_MIN_MS,
  EDL_SUBTITLE_STYLES,
  EDL_TRANSITIONS,
  type Edl,
  type EdlDefaults,
} from '../src/render/edl.js'
import { planShotTiming } from '../src/render/chatcut-timing.js'
import { EDIT_PLAN_FALLBACK, EDIT_PLAN_PROMPT, EDIT_PLAN_SCENE } from '../prisma/prompts.js'
import { LIVE_SCENE_CODES, SCENE } from '../src/ai/scene-codes.js'
import { SCENE_VARIABLES, validateTemplate } from '../src/ai/prompt-vars.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const src = (rel: string) => readFile(join(ROOT, rel), 'utf8')

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
  ok(label, Object.is(actual, expected), `期望 ${String(expected)}，实得 ${String(actual)}`)
}

function arrEq(label: string, actual: readonly unknown[], expected: readonly unknown[]): void {
  ok(
    label,
    actual.length === expected.length && actual.every((v, i) => Object.is(v, expected[i])),
    `期望 [${expected.join(', ')}]，实得 [${actual.join(', ')}]`,
  )
}

/** 用户面板档位 —— 既是给模型的倾向，也是解析失败时的兜底值 */
const PREFER: EdlDefaults = {
  pacing: 'NATURAL',
  transitions: 'SMOOTH',
  subtitleStyle: 'CLEAN',
  bgm: 'NONE',
}

const FENCE = '```'

/** 一份结构完全合法的模型输出，供各节改坏它 */
const GOOD_JSON = '{"pacing":"FAST","transitions":"DYNAMIC","subtitleStyle":"SOCIAL","bgm":"UPBEAT","shots":[{"index":0,"targetMs":3000,"reason":"开场要快"},{"index":1,"targetMs":1800}]}'

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n① 粗夹（clampShotMs）：防离谱值，但接受数字字符串')

{
  eq('★ 正常值原样通过', clampShotMs(3000), 3000)
  eq('  小数四舍五入', clampShotMs(3000.6), 3001)
  eq(`  下限：低于 ${EDL_SHOT_MIN_MS}ms 被抬到下限`, clampShotMs(500), EDL_SHOT_MIN_MS)
  eq(`  上限：高于 ${EDL_SHOT_MAX_MS}ms 被压到上限`, clampShotMs(30000), EDL_SHOT_MAX_MS)

  eq('★★ 数字字符串 "3200" 被接受（模型常这么写，丢掉=静默丢决策）', clampShotMs('3200'), 3200)
  eq('  └ 带空格的 " 3200 " 同样接受', clampShotMs(' 3200 '), 3200)
  eq('★ 带单位的 "3.2s" 必须丢弃（单位是秒，猜错差 1000 倍）', clampShotMs('3.2s'), null)

  eq('  空串丢弃', clampShotMs(''), null)
  eq('  纯空格丢弃', clampShotMs('  '), null)
  eq('  NaN 丢弃', clampShotMs(Number.NaN), null)
  eq('  Infinity 丢弃', clampShotMs(Number.POSITIVE_INFINITY), null)
  eq('  0 丢弃（不是「合理的零」而是「没给」）', clampShotMs(0), null)
  eq('  负数丢弃', clampShotMs(-5), null)
  eq('  true 丢弃', clampShotMs(true), null)
  eq('  null 丢弃', clampShotMs(null), null)
  eq('  undefined 丢弃', clampShotMs(undefined), null)
  eq('★ 数组丢弃 —— 证明类型守卫先于 Number()（Number([3200]) 其实是 3200）', clampShotMs([3200]), null)

  // 字符串形态被接受后，上下限仍然生效
  eq('  "30000" 仍被上限压住', clampShotMs('30000'), EDL_SHOT_MAX_MS)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n② 脏 JSON 容错（extractJsonObject / parseEdl）：模型输出的实际形状')

{
  eq('★ ```json 围栏被剥掉', extractJsonObject(`${FENCE}json\n${GOOD_JSON}\n${FENCE}`), GOOD_JSON)
  eq('★ 前后有废话也能抠出来', extractJsonObject(`好的，这是我的剪辑方案：\n${GOOD_JSON}\n希望满意。`), GOOD_JSON)
  eq('  没有花括号 ⇒ null', extractJsonObject('抱歉，我无法完成这个任务。'), null)
  eq('  只有一个花括号 ⇒ null', extractJsonObject('{ 半截'), null)

  const fenced = parseEdl(`好的：\n${FENCE}json\n${GOOD_JSON}\n${FENCE}\n以上。`, PREFER)
  ok('★★ 围栏 + 前后废话的完整输出仍被解析成功', fenced.edl !== null, fenced.problems.join('；'))
  eq('  └ 两个镜头都拿到', fenced.edl?.shots.length ?? -1, 2)
  eq('  └ pacing 取到 FAST', fenced.edl?.pacing ?? '', 'FAST')
  eq('  └ 合法输入不留下 problem', fenced.problems.length, 0)

  const trailing = parseEdl('{"pacing":"FAST","shots":[{"index":0,"targetMs":3200},]}', PREFER)
  ok('★★ 尾逗号被清掉后重试成功', trailing.edl !== null, trailing.problems.join('；'))
  eq('  └ 镜头时长取到 3200', trailing.edl?.shots[0]?.targetMs ?? -1, 3200)

  const asObject = parseEdl('{"pacing":"FAST","shots":{"0":3200,"1":1800}}', PREFER)
  ok('★ shots 写成对象（{"0":3200}）也能归一成数组', asObject.edl !== null, asObject.problems.join('；'))
  arrEq(
    '  └ 归一后的镜头',
    (asObject.edl?.shots ?? []).map((s) => s.index),
    [0, 1],
  )
  ok(
    '  └ 归一这件事留下了 problem（否则「模型总写错形状」会一直没人发现）',
    asObject.problems.some((p) => p.includes('对象而不是数组')),
    asObject.problems.join('；'),
  )

  const strMs = parseEdl('{"pacing":"FAST","shots":[{"index":0,"targetMs":"3200"}]}', PREFER)
  eq('★ targetMs 给字符串也能用（不再是静默丢镜头）', strMs.edl?.shots[0]?.targetMs ?? -1, 3200)

  const unitMs = parseEdl('{"pacing":"FAST","shots":[{"index":0,"targetMs":"3.2s"}]}', PREFER)
  eq('★ 带单位的时长被丢弃 ⇒ 没有可用镜头 ⇒ 整体退回档位', unitMs.edl, null)

  const dup = parseEdl('{"pacing":"FAST","shots":[{"index":0,"targetMs":3000},{"index":0,"targetMs":9000}]}', PREFER)
  eq('  下标重复取**先出现的那个**', dup.edl?.shots.length ?? -1, 1)
  eq('  └ 先出现的是 3000', dup.edl?.shots[0]?.targetMs ?? -1, 3000)

  const oob = parseEdl('{"pacing":"FAST","shots":[{"index":-1,"targetMs":3000},{"index":9,"targetMs":3000},{"index":1,"targetMs":2000}]}', PREFER)
  eq('  负下标被丢弃', oob.edl?.shots.some((s) => s.index < 0) ?? true, false)
  eq('  越界下标**不在解析层**丢弃（解析层不知道镜头总数，留给 toEdlShotMs）', oob.edl?.shots.length ?? -1, 2)

  const noisy = parseEdl('{"pacing":"FAST","shots":["3000",null,{"index":2,"targetMs":2500}]}', PREFER)
  eq('★ shots 里的非对象元素被跳过、不炸', noisy.edl?.shots.length ?? -1, 1)
  eq('  └ 只剩合法的那个', noisy.edl?.shots[0]?.index ?? -1, 2)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n③ 枚举回退：不认识就退回用户档位 + 留痕')

{
  const unknown = parseEdl('{"pacing":"SUPER_FAST","transitions":"DYNAMIC","subtitleStyle":"SOCIAL","bgm":"UPBEAT","shots":[{"index":0,"targetMs":3000}]}', PREFER)
  ok('★ 不认识的 pacing 退回用户档位、但仍算解析成功', unknown.edl !== null, unknown.problems.join('；'))
  eq('  └ pacing 退回 PREFER 的 NATURAL', unknown.edl?.pacing ?? '', PREFER.pacing)
  ok('  └ 留下了一条 problem 指明原因', unknown.problems.some((p) => p.includes('SUPER_FAST')), unknown.problems.join('；'))

  const caseFree = parseEdl('{"pacing":" fast ","shots":[{"index":0,"targetMs":3000}]}', PREFER)
  eq('★ 大小写与首尾空格不敏感（" fast " ⇒ FAST）', caseFree.edl?.pacing ?? '', 'FAST')

  const missing = parseEdl('{"shots":[{"index":0,"targetMs":3000}]}', PREFER)
  eq('  整片档位缺失 ⇒ 退回用户档位', missing.edl?.pacing ?? '', PREFER.pacing)
  eq('  └ 且**不**记 problem（没给 ≠ 给错，记了会天天刷）', missing.problems.length, 0)

  const notStr = parseEdl('{"pacing":123,"shots":[{"index":0,"targetMs":3000}]}', PREFER)
  eq('  档位给了数字 ⇒ 退回用户档位', notStr.edl?.pacing ?? '', PREFER.pacing)
  ok('  └ 并记一条 problem', notStr.problems.some((p) => p.includes('不是字符串')), notStr.problems.join('；'))

  const reason = parseEdl(`{"shots":[{"index":0,"targetMs":3000,"reason":"  ${'长'.repeat(80)}  "}]}`, PREFER)
  eq('  reason 被裁到 60 字（只进日志，不该撑爆）', reason.edl?.shots[0]?.reason?.length ?? -1, 60)

  const noReason = parseEdl('{"shots":[{"index":0,"targetMs":3000,"reason":"   "}]}', PREFER)
  eq('★ 全空白的 reason 归一成 undefined（不是空串）', noReason.edl?.shots[0]?.reason, undefined)
  eq('  └ 且对象里根本没有 reason 这个键', 'reason' in (noReason.edl?.shots[0] ?? {}), false)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n④ 「不可用 ⇒ edl 为 null」的三条路径（调用方据此完全退回档位）')

{
  eq('★ 连 JSON 都找不到 ⇒ null', parseEdl('我建议加快节奏。', PREFER).edl, null)
  eq('  └ 并给出原因', parseEdl('我建议加快节奏。', PREFER).problems[0], '模型输出里找不到 JSON 对象')

  // ★ 花括号不成对时 `extractJsonObject` 就返回 null 了（取不到最后一个 `}`），走的是
  //   「找不到 JSON」那条路。要验「JSON 解析失败」必须给一个**括号配平但语法错**的串。
  const unbalanced = parseEdl('{ 不是合法 JSON', PREFER)
  eq('★ 花括号不成对 ⇒ 连 JSON 都抠不出来', unbalanced.problems[0], '模型输出里找不到 JSON 对象')

  const broken = parseEdl('{"pacing": FAST}', PREFER)
  eq('★ 括号配平但语法错 ⇒ null', broken.edl, null)
  ok(
    '  └ 原因里带上了解析错误',
    broken.problems[0]?.startsWith('JSON 解析失败') === true,
    broken.problems.join('；'),
  )

  // ★ `extractJsonObject` 取的是「第一个 `{` 到最后一个 `}`」⇒ 它**总会**返回以 `{` 开头的串，
  //   所以 parseEdl 里「JSON 顶层不是对象」那条分支实际不可达（纯防御）。这里只钉可观测结果。
  const wrapped = parseEdl('[{"index":0,"targetMs":3000}]', PREFER)
  eq('★ 被数组包起来的输出 ⇒ 拿不到镜头 ⇒ 退回档位', wrapped.edl, null)

  const emptyShots = parseEdl('{"pacing":"FAST","shots":[]}', PREFER)
  eq('★★ shots 为空 ⇒ null（空 shots 与「不覆盖」语义相同，没必要区分）', emptyShots.edl, null)
  eq('  └ 原因明确', emptyShots.problems[0], '没有解析出任何可用的镜头时长')

  const allBad = parseEdl('{"shots":[{"index":0,"targetMs":"3.2s"},{"index":1,"targetMs":null}]}', PREFER)
  eq('★ 所有镜头时长都不可用 ⇒ null', allBad.edl, null)

  const shotsMissing = parseEdl('{"pacing":"FAST"}', PREFER)
  eq('  shots 整个缺失 ⇒ null', shotsMissing.edl, null)
  eq('  └ 缺 shots 与空 shots 共用同一句 reason', shotsMissing.problems[0], '没有解析出任何可用的镜头时长')

  const shotsWrongType = parseEdl('{"pacing":"FAST","shots":"none"}', PREFER)
  eq('  shots 类型不对 ⇒ null', shotsWrongType.edl, null)
  eq('  └ 这种形状才记「shots 缺失或类型不对」', shotsWrongType.problems[0], 'shots 缺失或类型不对')
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n⑤ toEdlShotMs：摊成与 clips 等长，没给的下标必须是 null')

{
  arrEq('★ edl 为 null ⇒ 全是 null', toEdlShotMs(null, 3), [null, null, null])

  const edl: Edl = {
    pacing: 'FAST',
    transitions: 'DYNAMIC',
    subtitleStyle: 'SOCIAL',
    bgm: 'UPBEAT',
    shots: [
      { index: 1, targetMs: 2000 },
      { index: 9, targetMs: 1000 },
    ],
  }
  const out = toEdlShotMs(edl, 3)
  arrEq('★★ 越界的 index 被忽略，未给的下标是 null（不是「档位近似值」）', out, [null, 2000, null])
  ok(
    '  └ 用 null 而不是近似值：否则「模型漏了第 0 个镜头」会静默消失',
    out[0] === null && out[2] === null,
    String(out),
  )
  arrEq('  长度恒等于 clipCount', toEdlShotMs(edl, 0), [])
  arrEq('  负数 clipCount 也不炸', toEdlShotMs(edl, -1), [])
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n⑥ 严夹（planShotTiming.edlShotMs）：不超素材可用时长、不破节奏下限')

{
  /**
   * 三镜头夹具，与 `verify-chatcut-timing.ts` 同源：
   *   0 号 真实 4000ms ｜ 1 号 探测到 2968ms（客户端上报 3000ms，经典取整陷阱）｜ 2 号 800ms
   * SMOOTH 转场（handleFrames=6）⇒ 余量 0/200ms、1/200ms、2/100ms
   * ⇒ rawShotMs = [3600, 2568, 600]
   */
  const CLIPS = [
    { durationMs: 4000, trimStartMs: 0 },
    { durationMs: 3000, trimStartMs: 0 },
    { durationMs: 800, trimStartMs: 0 },
  ]
  const ASSET_MS = [4000, 2968, 800]
  const base = {
    clips: CLIPS,
    clipAssetMs: ASSET_MS,
    fps: 30,
    transitionHandleFrames: 6,
  }

  const values = (edlShotMs: readonly (number | null)[] | null | undefined, shotScale: number, minShotMs: number) =>
    planShotTiming({
      ...base,
      pacingShotScale: shotScale,
      pacingMinShotMs: minShotMs,
      edlShotMs,
    })

  const raw = values(undefined, 1, 0)
  arrEq('  基线：rawShotMs = [3600, 2568, 600]（素材 ∧ trim ∧ 转场余量三重约束）', [0, 1, 2].map(raw.rawShotMs), [3600, 2568, 600])

  // ── 上限：绝不超素材可用时长。超了 ChatCut 直接拒单（整单失败，不是降级）──
  const tooLong = values([9000, 3000, 5000], 1, 0)
  arrEq(
    '★★ 模型给的超长值全被夹到 rawShotMs（否则 ChatCut 判 Source range exceeds video asset duration）',
    [0, 1, 2].map(tooLong.scaledShotMs),
    [3600, 2568, 600],
  )
  arrEq('  └ 最终排轨初值同源', tooLong.slotMs, [3600, 2568, 600])

  // ── 下限：EDL 给的太短会被节奏下限抬起来，但**不能**突破 raw ──
  const FAST = { shotScale: 0.78, minShotMs: 1200 }
  const mixed = values([2000, 300, null], FAST.shotScale, FAST.minShotMs)
  arrEq(
    '★★ EDL 值生效 / 太短被下限抬起 / 下限也不能突破 raw / 没给的镜头退回档位',
    [0, 1, 2].map(mixed.scaledShotMs),
    [2000, 1200, 600],
  )

  const deep = values([null, null, null], FAST.shotScale, FAST.minShotMs)
  arrEq(
    '★★ 全 null ⇒ 与「完全不传 edlShotMs」逐字段一致（原路线行为）',
    [0, 1, 2].map(deep.scaledShotMs),
    [2808, 2003, 600],
  )

  // ── EDL 的值直接传 300（未过粗夹）也不会破下限 ⇒ 证明严夹不依赖粗夹 ──
  const unclamped = values([300, 300, 300], FAST.shotScale, FAST.minShotMs)
  arrEq('★ 未过粗夹的 300ms 仍被严夹抬起 ⇒ 两道夹取职责独立', [0, 1, 2].map(unclamped.scaledShotMs), [1200, 1200, 600])

  // ── 非有限正数一律走档位分支 ──
  const junk = values([Number.NaN, 0, -5], 1, 0)
  arrEq('★ NaN / 0 / 负数当作「没给」⇒ 走档位分支', [0, 1, 2].map(junk.scaledShotMs), [3600, 2568, 600])

  const longer = values([null, null, null, 5000], 1, 0)
  arrEq('  下标越界的多余额度不影响三个镜头', [0, 1, 2].map(longer.scaledShotMs), [3600, 2568, 600])

  // ── ★ 转场余量按**素材**算，与 EDL 无关 ⇒ 两者必然同源 ──
  arrEq('★★ 转场余量不随 EDL 变化（余量按素材帧数算，不按时长）', tooLong.handleFrames, [6, 6, 3])
  arrEq('  └ handleMsOf 同源', [0, 1, 2].map(tooLong.handleMsOf), [200, 200, 100])
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n⑦ ★★ 关掉 EDL 时逐字段与改动前一致（「不改变原来 AI 生成路线」的代码级证据）')

{
  const CLIPS = [
    { durationMs: 4000, trimStartMs: 0 },
    { durationMs: 3000, trimStartMs: 0 },
    { durationMs: 800, trimStartMs: 0 },
  ]
  const ASSET_MS = [4000, 2968, 800]

  const snap = (edlShotMs: readonly (number | null)[] | null | undefined, shotScale: number) => {
    const r = planShotTiming({
      clips: CLIPS,
      clipAssetMs: ASSET_MS,
      fps: 30,
      transitionHandleFrames: 6,
      pacingShotScale: shotScale,
      pacingMinShotMs: shotScale < 1 ? 1200 : 0,
      edlShotMs,
    })
    return JSON.stringify({
      handleFrames: r.handleFrames,
      raw: [0, 1, 2].map(r.rawShotMs),
      scaled: [0, 1, 2].map(r.scaledShotMs),
      slot: r.slotMs,
    })
  }

  for (const scale of [1, 0.78]) {
    const omitted = snap(undefined, scale)
    ok(
      `★★ 节奏档位 ${scale === 1 ? 'NATURAL/STORY' : 'FAST'}：不传 / 传 undefined / 传 null / 传全 null 数组 —— 四者输出完全相同`,
      omitted === snap(undefined, scale) &&
        omitted === snap(null, scale) &&
        omitted === snap([null, null, null], scale),
      `不传=${omitted}`,
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n⑧ 跨文件契约与结构约束（单改一边就静默退化，所以逐条钉住）')

{
  // ── ⑧-1 枚举集合必须与 chatcut.ts 的 ChatCutOptionsSchema 一致 ──
  const chatcutSrc = await src('src/render/chatcut.ts')
  const schemaValues = (field: string): string => {
    const m = new RegExp(`${field}: z\\.enum\\(([^)]*)\\)`).exec(chatcutSrc)
    return m?.[1] ?? ''
  }
  const pairs: Array<[string, readonly string[]]> = [
    ['pacing', EDL_PACINGS],
    ['transitions', EDL_TRANSITIONS],
    ['subtitleStyle', EDL_SUBTITLE_STYLES],
    ['bgm', EDL_BGMS],
  ]
  for (const [field, allowed] of pairs) {
    const inSchema = schemaValues(field)
    ok(
      `★ edl.ts 的 ${field} 取值集合 [${allowed.join('/')}] 全部存在于 chatcut.ts 的 schema`,
      allowed.length > 0 && allowed.every((v) => inSchema.includes(`'${v}'`)),
      `schema 里读到：${inSchema || '(没匹配到)'}`,
    )
  }

  // ── ⑧-2 提示词的 {{变量}} 必须在白名单里 ──
  const problems = validateTemplate('edit_plan', EDIT_PLAN_PROMPT)
  ok('★★ edit_plan 提示词的所有 {{变量}} 都在 prompt-vars 白名单内', problems.length === 0, problems.join('；'))
  for (const v of ['shotPlanInput', 'preferPlan', 'note', 'copyText']) {
    ok(`  └ 白名单声明了 {{${v}}}`, (SCENE_VARIABLES.edit_plan ?? []).includes(v))
  }
  ok(
    '  └ 且提示词真的用到了 shotPlanInput（逐镜头清单是 EDL 的核心输入）',
    EDIT_PLAN_PROMPT.includes('{{shotPlanInput}}'),
  )

  // ── ⑧-3 提示词示范的 JSON 字段名 ↔ parseEdl 真正读的字段名 ──
  const exampleStart = EDIT_PLAN_PROMPT.indexOf('{"pacing"')
  const exampleJson =
    exampleStart >= 0 ? EDIT_PLAN_PROMPT.slice(exampleStart, EDIT_PLAN_PROMPT.lastIndexOf('}') + 1) : ''
  ok('★★ 提示词里有一份可直接对照的 JSON 示范', exampleJson.length > 0, '没找到以 {"pacing" 开头的示范')

  let example: Record<string, unknown> = {}
  try {
    example = JSON.parse(exampleJson) as Record<string, unknown>
  } catch (e) {
    ok('  └ 示范本身是合法 JSON', false, (e as Error).message)
  }
  ok(
    '★★ 示范的顶层字段名与 parseEdl 读的一致（改字段名必须两边一起改）',
    ['pacing', 'transitions', 'subtitleStyle', 'bgm', 'shots'].every((k) => k in example),
    Object.keys(example).join(', '),
  )
  const exShot = (Array.isArray(example.shots) ? example.shots[0] : undefined) as Record<string, unknown> | undefined
  ok(
    '  └ 示范的 shots 元素字段名一致（index / targetMs）',
    Boolean(exShot) && 'index' in exShot! && 'targetMs' in exShot!,
    exShot ? Object.keys(exShot).join(', ') : 'shots 不是数组',
  )

  // 示范里枚举值是空串 ⇒ 必须**优雅退化成用户档位**，而不是整份作废
  const parsedExample = parseEdl(exampleJson, PREFER)
  ok('★★ 模型照抄示范（枚举是空串）时仍产出可用的 EDL，只是档位退回用户选择', parsedExample.edl !== null, parsedExample.problems.join('；'))
  eq('  └ 四个空串各记一条 problem', parsedExample.problems.length, 4)
  eq('  └ pacing 退回 PREFER', parsedExample.edl?.pacing ?? '', PREFER.pacing)

  // ── ⑧-4 兜底模板必须解析不出任何镜头（「两道保险」的第二道）──
  const fallback = parseEdl(EDIT_PLAN_FALLBACK, PREFER)
  eq('★★ 兜底模板解析不出镜头 ⇒ edl 为 null ⇒ 退回档位（即便 isFallbackTemplate 那道判断被改坏）', fallback.edl, null)
  eq('  └ 恰好一条原因', fallback.problems.length, 1)

  // ── ⑧-5 场景规格：输出预算、能力、登记状态 ──
  // ★ 推理模型的 `max_tokens` 是**思考 + 正文共用**的预算。给太少会返回
  //   `finish_reason='length'` + `content=''`（HTTP 200、报文合法），网关判 `BAD_RESPONSE`
  //   —— 那是**非通道级**故障 ⇒ 它在**同一通道**上按 maxRetries 反复重试，最后仍抛错
  //   被 generateEditPlan 接住 ⇒ 「每次 AI 档出片都静默按面板档位剪」。全项目文本场景
  //   一致用 4000（与 setup-ai-channels 的 SCENE_MIN_OUTPUT_TOKENS 同口径）。
  ok(
    '★★ edit_plan 的 maxOutputTokens ≥ 4000（低于它会被思考吃光 ⇒ 空正文 ⇒ 每次都静默退化成面板档位）',
    (EDIT_PLAN_SCENE.maxOutputTokens ?? 0) >= 4000,
    `实得 ${EDIT_PLAN_SCENE.maxOutputTokens}`,
  )
  ok('  └ 声明为 TEXT（候选链里混进 IMAGE 模型会被能力闸门静默跳过）', EDIT_PLAN_SCENE.kind === 'TEXT')
  ok(
    '  └ 已登记进 LIVE_SCENE_CODES（后台「AI 场景」页据此标「已接入」）',
    LIVE_SCENE_CODES.includes(SCENE.edit_plan),
  )
  ok(
    '  └ 有兜底模板（网关走兜底时不会拿一段预置文案去解析）',
    typeof EDIT_PLAN_SCENE.fallback === 'string' && EDIT_PLAN_SCENE.fallback.length > 0,
  )

  // ── ⑧-5b 候选链必须在 SCENE_OVERRIDES 里显式给备用 ──
  // ★★ 不加这条，新场景的候选链就由 `firstModelOfKind` 决定 = **GPT 单候选、无备用**
  //   （sync 建行时 `fallbackModelIds: []`）。本场景实测单次 46.6s / 60s 预算
  //   ⇒ 上游一超时就没有第二个候选可退，「剪辑决策」会静默消失、只按面板档位剪。
  const setupSrc = await src('scripts/setup-ai-channels.ts')
  const overrideBlock = /edit_plan:\s*\{([\s\S]*?)\n {2}\}/.exec(setupSrc)?.[1] ?? ''
  ok('★★ SCENE_OVERRIDES 里有 edit_plan 条目（否则候选链落到 GPT 单候选、无备用）', overrideBlock.length > 0)
  ok(
    '  └ 且 fallbacks 非空 —— 单候选一旦上游超时，这次剪辑决策就静默消失',
    /fallbacks:\s*\[\s*'tokenbox-/.test(overrideBlock),
    overrideBlock || '(没匹配到 edit_plan 条目)',
  )
  ok(
    '  └ 且备用里没有 claude（它无视 reasoning_effort，4000 预算会被思考吃光并返回空正文）',
    overrideBlock.length > 0 && !overrideBlock.includes('claude'),
  )

  // ── ⑧-5 edl.ts 必须零 import（否则守护脚本要连库、这条闸门很快会被跳过）──
  const edlSrc = await src('src/render/edl.ts')
  ok('★★ edl.ts 零 import（一旦引入 chatcut.ts 就会拉进 redis，守护得连库才能跑）', !/^\s*import\s/m.test(edlSrc))

  // ── ⑧-6 chatcut-timing.ts 的入参绑定位置（TDZ 回归的护栏）──
  const timingSrc = await src('src/render/chatcut-timing.ts')
  ok(
    '★★ planShotTiming 仍在函数体**第一行**就绑定 fps 与 edlShotMs（防 TDZ 回归）',
    /const \{ clips, clipAssetMs, fps, edlShotMs \} = params/.test(timingSrc),
  )

  // ── ⑧-7 edit-plan.service.ts：merchantId 转换必须在 try 内 + 函数体绝不 throw ──
  const svcSrc = await src('src/render/edit-plan.service.ts')
  const convIdx = svcSrc.indexOf('typeof input.merchantId === \'bigint\'')
  const callIdx = svcSrc.indexOf('await runBilledScene(')
  ok('★★ merchantId 的 string→bigint 转换存在', convIdx > 0)
  ok(
    '★★ 且**在 try 内**、在计费调用之前 —— 否则非法编号会在启动阶段抛错把整单打成 FAILED',
    convIdx > 0 && convIdx < callIdx,
  )
  ok('  └ 用 BigInt 而不是 Number（超 2^53 会静默丢精度、扣错账户）', svcSrc.includes('BigInt(input.merchantId)'))

  const body = svcSrc.slice(svcSrc.indexOf('export async function generateEditPlan'))
  ok('★★★ generateEditPlan 函数体内没有任何 throw（「绝不抛错」是它的唯一硬纪律）', !/\bthrow\b/.test(body))
  ok('  └ 且确实有 catch 兜住计费调用的全部失败', /\}\s*catch\s*\(/.test(body))

  // ── ⑧-8 chatcut-driver.ts：EDL 的位置与「档位只读 options」 ──
  const drvSrc = await src('src/render/chatcut-driver.ts')
  const probeIdx = drvSrc.indexOf('const clipAssetMs')
  const planIdx = drvSrc.indexOf('await generateEditPlan(')
  const timingIdx = drvSrc.indexOf('const timing = planShotTiming(')
  ok('★★ EDL 在**素材探测之后**（要把每段真实时长喂给模型）', probeIdx > 0 && probeIdx < planIdx)
  ok('★★ EDL 在**排轨之前**（决策决定档位 ⇒ 档位决定时长与转场余量）', planIdx > 0 && planIdx < timingIdx)
  ok(
    '★★ 档位只读 `options`（有效选项），不再读 `input.options` —— 混读会产生「节奏用了 AI 的、字幕还在用面板的」半覆盖',
    drvSrc.includes('PACING_PLANS[options.pacing]') &&
      drvSrc.includes('TRANSITION_PLANS[options.transitions]') &&
      !drvSrc.includes('PACING_PLANS[input.options.pacing]'),
  )
  ok(
    '  └ 且 plan.edl 为 null 时 options 就是 input.options（同引用，逐字段一致）',
    /const options: ChatCutOptions = plan\.edl\s*\?/.test(drvSrc) &&     drvSrc.includes(': input.options'),
  )
  // ── ⑧-9 「有效选项」的**其余两个出口**：上面那条只盯了 PACING/TRANSITION ──
  //    ★★ 这三条是事后补的，起因是一次真实漏判：守则写着「档位只读 options」，
  //       而 chatcut-driver 里读档位的地方其实有**四处**（节奏、转场、BGM、字幕样式）
  //       —— 断言只覆盖前两处 ⇒ 后两处漏接线时守护照样全绿，
  //       而漏接线的后果是「AI 选了 UPBEAT、面板是 NONE」安静地出成没有 BGM 的片子，
  //       一个报错都没有。凡是「一条断言 + 多个同类读取点」的形状，都要逐个点名。
  ok(
    '★★ BGM 的取值点读 `options.bgm`（不是 input.options.bgm）—— 漏了就是「AI 选的 BGM 静默不生效」',
    drvSrc.includes('const bgmChoice = options.bgm'),
  )
  ok(
    '★★ 字幕样式的取值点同样读 `options.subtitleStyle`',
    drvSrc.includes('subtitleStyle: options.subtitleStyle'),
  )
  const preferSubIdx = drvSrc.indexOf('subtitleStyle: input.options.subtitleStyle')
  // ★ 边界不能用 `planIdx`："喂给模型的偏好"正是 `generateEditPlan({ …, prefer: {…} })` 的**实参**，
  //   所以合法位置在 planIdx **之后**。真正的上界是「决策拿回来、开始覆盖档位」那一步。
  const optionsIdx = drvSrc.indexOf('const options: ChatCutOptions')
  ok(
    '  └ 而 `subtitleStyle: input.options.subtitleStyle` 只允许作为**喂给模型**的用户倾向存在（即 generateEditPlan 的入参区间内），且只有一处',
    preferSubIdx > planIdx && preferSubIdx < optionsIdx && drvSrc.lastIndexOf('subtitleStyle: input.options.subtitleStyle') === preferSubIdx,
  )
  // ── ⑧-10 配音下界与 EDL 的关系 ──
  //    ★★ EDL 的逐镜头时长与用户选的节奏档**彼此独立**：用户可能选 NATURAL（shotScale=1，
  //       原条件不成立）而 AI 把某镜头砍到 2 秒 ⇒ 漏判会让 `synthesizeNarration` 用
  //       `-t` 把台词**从中间截断**，日志里没有任何提示。
  ok(
    '★★★ 配音下界的判据必须包含「该镜头被 EDL 缩短了」（只判 shotScale < 1 会漏掉 NATURAL + AI 砍短 ⇒ 台词静默截断）',
    drvSrc.includes('const wantedShorter = scaledShotMs(index) < rawShotMs(index) - 1') &&
      /if \(pacePlan\.shotScale < 1 \|\| wantedShorter\)/.test(drvSrc),
  )
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
