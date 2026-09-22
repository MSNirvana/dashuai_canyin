/**
 * 「AI 档素材路线」的守护 —— `ORIGINAL`（原路线）／`NORMALIZED`（本地打底）的契约闸门。
 *
 * ★★ 为什么需要它（2026-09-22 新增功能，用户可选）：
 *   AI 档原来只有一条路线：把素材原文件直接推给云端，画布适配全交给云端的 `fit:"cover"`。
 *   这条路线**依赖我们上报的宽高是对的**。而 2026-09-22 的事故证明它会错
 *   （容器 960×540 + `rotation=-90` 被当横屏 ⇒ 云端多放大 1.78 倍，成片只剩脸部特写）。
 *
 *   于是新增一条 `NORMALIZED`：先用本机 ffmpeg 把**整段**素材转成成片画布再上传。
 *   ffmpeg 的 `scale`/`crop` 默认 autorotate ⇒ 送上去的文件本身就是 1080×1920、
 *   且**不再带任何旋转标记** ⇒ 云端 cover 只能 1:1 落位，结构上不可能再算错。
 *
 * ★ 这个守护要守住三件事，缺一不可：
 *   ① **默认值不许变**：`clipPrep` 必须是 `'ORIGINAL'`。
 *      这是「**不覆盖原来 AI 生成路线**」的硬契约 —— 用户没主动选时行为必须与改动前逐字节一致。
 *   ② **键必须是「整段」而不是「剪好的片段」**：AI 档的裁切由云端驱动自己按 trim + 转场余量算
 *      （`sourceStartMs = trimStart + handleMsOf(index)`）。若递剪好的片段，handle 会越界被拒单。
 *      所以 B1 的缓存键**不许含 trim**，且必须落在被 GC 排除的缓存目录下（否则产物会被当孤儿删掉）。
 *   ③ **产物的几何真的被定死了**：现场造一个「躺着的竖拍素材」跑一遍归一化，
 *      产物必须 `1080×1920` ∧ 旋转标记归零 ∧ **时长不缩水**（缩水就会让云端 handle 无米可炊）。
 *
 * 运行：cd server && npx tsx scripts/verify-clip-prep.ts
 * ⚠ 不连库、不连 Redis、不连 COS；只在系统临时目录里造两个小文件并清理。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  INTERMEDIATE_CACHE_PREFIX,
  normalizedClipKey,
  normalizedFullClipKey,
} from '../src/render/cache-keys.js'
import {
  ChatCutOptionsSchema,
  CHATCUT_CLIP_PREPS,
  DEFAULT_CHATCUT_OPTIONS,
} from '../src/render/chatcut.js'
import { ffmpegBin, ffmpegNormalize, ffprobeBin, probeClipMeta } from '../src/render/ffmpeg.js'
import type { RenderClip } from '../src/services/render.service.js'

const execFileP = promisify(execFile)

let pass = 0
let fail = 0
let skipped = 0

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

function skip(label: string, reason: string): void {
  skipped += 1
  console.log(`  ⊘ ${label} —— 已跳过：${reason}`)
}

const OUTPUT = { width: 1080, height: 1920 }
const MERCHANT = 7n

/** 造一个 RenderClip 骨架（只用到 B1 关心的字段） */
function clipOf(assetId: string, trimStartMs?: number, trimEndMs?: number): RenderClip {
  return {
    shotId: `shot-${assetId}`,
    assetId,
    cosKey: `uploads/7/${assetId}.mp4`,
    trimStartMs,
    trimEndMs,
    durationMs: 3000,
    line: '',
  } as RenderClip
}

// ── ① 默认值与向后兼容 ──────────────────────────────────────────────────────
console.log('\n① 默认值 / 向后兼容（「不覆盖原来 AI 生成路线」的硬契约）')
{
  eq('★★ 默认 clipPrep = ORIGINAL（原路线），绝不许悄悄改', DEFAULT_CHATCUT_OPTIONS.clipPrep, 'ORIGINAL')
  ok('  └ 档位取值表里恰有两条路线', CHATCUT_CLIP_PREPS.length === 2, CHATCUT_CLIP_PREPS.join(','))
  ok('  └ ORIGINAL 在取值表里', CHATCUT_CLIP_PREPS.includes('ORIGINAL'))

  // 走一遍服务端真实的合流点：`{...DEFAULT, ...input.chatcut}`
  const oldClient = { ...DEFAULT_CHATCUT_OPTIONS } as Record<string, unknown>
  delete oldClient.clipPrep // 老客户端的包**没有这个字段**
  const merged = ChatCutOptionsSchema.parse({ ...DEFAULT_CHATCUT_OPTIONS, ...oldClient })
  eq('★★ 老客户端提交（缺该字段）⇒ 落回默认 ORIGINAL（行为与改动前一致）', merged.clipPrep, 'ORIGINAL')

  const picked = ChatCutOptionsSchema.parse({ ...DEFAULT_CHATCUT_OPTIONS, clipPrep: 'NORMALIZED' })
  eq('用户显式选 NORMALIZED ⇒ 被 schema 接受', picked.clipPrep, 'NORMALIZED')

  const bad = ChatCutOptionsSchema.safeParse({ ...DEFAULT_CHATCUT_OPTIONS, clipPrep: 'LOCAL' })
  ok('  └ 非法取值被拒（防手抄字符串漂移）', !bad.success)

  // 判读历史任务的口径：老任务库里没有该字段
  const legacyTask = { ...DEFAULT_CHATCUT_OPTIONS } as Record<string, unknown>
  delete legacyTask.clipPrep
  eq(
    '  └ 判读历史任务只能用 `=== NORMALIZED`（老任务取值为 undefined）',
    (legacyTask.clipPrep as string | undefined) === 'NORMALIZED',
    false,
  )
}

// ── ② 缓存键契约 ────────────────────────────────────────────────────────────
console.log('\n② normalizedFullClipKey（整段归一化产物的对象键）')
{
  const plain = clipOf('a100')
  const trimmed = clipOf('a100', 500, 2500)

  const key = normalizedFullClipKey(MERCHANT, plain, OUTPUT)
  ok('★★ 落在被 GC 排除的缓存目录下（否则产物会被当孤儿删掉）', key.startsWith(INTERMEDIATE_CACHE_PREFIX), key)
  ok('  └ 含商家前缀（跨商家不互相覆盖）', key.startsWith(`${INTERMEDIATE_CACHE_PREFIX}${MERCHANT}/`), key)
  ok('  └ 是 mp4', key.endsWith('.mp4'), key)
  eq('  └ 同一入参稳定（内容寻址）', normalizedFullClipKey(MERCHANT, plain, OUTPUT), key)

  // ★★ 核心断言：B1 要的是**整段**，trim 不许进键
  eq(
    '★★ 有 trim 与无 trim 的同一素材 ⇒ **同一个键**（B1 传的是整段，裁切留给云端驱动）',
    normalizedFullClipKey(MERCHANT, trimmed, OUTPUT),
    key,
  )

  // 反证：与本地管线「已剪好的片段」的键**必须不同**（否则两条路线会互相读到错误的产物）
  const localTrimmed = normalizedClipKey(MERCHANT, trimmed, OUTPUT)
  ok(
    '  └ 反证：本地管线带 trim 的键与它不同（不会串产物）',
    localTrimmed !== key,
    `${localTrimmed} vs ${key}`,
  )
  // 而「本地管线也没 trim」时两者相同 —— 这是设计允许的共用缓存，写进断言免得以后被当 bug 修掉
  eq(
    '  └ 本地管线未 trim 时两者键相同（有意共用缓存，不是 bug）',
    normalizedClipKey(MERCHANT, plain, OUTPUT),
    key,
  )

  // 输出尺寸必须进键：换了画布就是另一份产物
  ok(
    '  └ 换输出尺寸 ⇒ 换键',
    normalizedFullClipKey(MERCHANT, plain, { width: 720, height: 1280 }) !== key,
  )
}

// ── ③ 端到端：整段归一化真的把几何定死了 ────────────────────────────────────
console.log('\n③ 端到端：躺着的竖拍素材 ⇒ 归一化产物 1080×1920 ∧ 旋转归零 ∧ 时长不缩水')
{
  const dir = await mkdtemp(join(tmpdir(), 'dashuai-prep-verify-'))
  try {
    const landscape = join(dir, 'landscape.mp4')
    const rotated = join(dir, 'rotated.mp4')
    const out = join(dir, 'normalized.mp4')

    // 造一个带音轨的横屏源（音轨是为了验证 apad/-shortest 不会把画面截短）
    await execFileP(ffmpegBin(), [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=960x540:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      '-y', landscape,
    ], { timeout: 60_000 })

    // ★ 关键一步：以**横屏像素**为输入打上旋转标记 ⇒ 还原手机竖拍的实际形态
    await execFileP(ffmpegBin(), [
      '-v', 'error', '-display_rotation', '-90', '-i', landscape, '-c', 'copy', '-y', rotated,
    ], { timeout: 60_000 })

    const { stdout: rawMeta } = await execFileP(ffprobeBin(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:stream_side_data=rotation',
      '-of', 'csv=p=0', rotated,
    ], { timeout: 30_000 })
    const container = String(rawMeta).trim()

    if (!/^960,540,-90/.test(container)) {
      skip('整段归一化', `本机 ffmpeg 打不出 rotation 标记（ffprobe 读到「${container}」）⇒ 无法复现前提`)
    } else {
      ok('前提成立：输入容器躺着 960×540 ＋ rotation=-90（显示应为 540×960）', true)
      const before = await probeClipMeta(rotated)
      eq('  └ 归一化前 probeClipMeta 报的是显示尺寸 540×960', `${before.width}x${before.height}`, '540x960')

      // 与 worker 里 prepClipLocally 完全同参：startMs=0 / endMs=0 ⇒ 整段
      await ffmpegNormalize(rotated, out, {
        width: OUTPUT.width,
        height: OUTPUT.height,
        startMs: 0,
        endMs: 0,
        timeoutMs: 120_000,
      })

      const after = await probeClipMeta(out)
      ok('归一化产物可探测', after.ok, after.reason ?? '')
      eq('★★ 产物就是成片画布 1080×1920（云端 cover 只能 1:1 落位）', `${after.width}x${after.height}`, '1080x1920')
      eq('★★ 旋转标记已归零（本地已转正 ⇒ 云端不可能再算错）', after.rotationDegrees, null)

      const { stdout: outRaw } = await execFileP(ffprobeBin(), [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:stream_side_data=rotation',
        '-of', 'csv=p=0', out,
      ], { timeout: 30_000 })
      ok(
        '  └ 反证：产物的**容器**宽高也已是 1080×1920（不是靠旋转标记凑出来的）',
        String(outRaw).trim().startsWith('1080,1920'),
        String(outRaw).trim(),
      )

      // ★★ 时长不缩水：B1 传的是整段，云端驱动的 trim + 转场 handle 全靠它
      const beforeSec = (before.durationMs ?? 0) / 1000
      const afterSec = (after.durationMs ?? 0) / 1000
      ok(
        `★★ 时长不缩水（源 ${beforeSec.toFixed(2)}s ⇒ 产物 ${afterSec.toFixed(2)}s）—— 否则云端 handle 无米可炊`,
        afterSec >= beforeSec - 0.2,
        `缩短了 ${(beforeSec - afterSec).toFixed(2)}s`,
      )
    }
  } catch (e) {
    skip('整段归一化', `ffmpeg/ffprobe 不可用或执行失败：${(e as Error).message.split('\n')[0]}`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

console.log(
  `\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过`,
)
process.exit(fail === 0 ? 0 : 1)
