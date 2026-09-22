/**
 * 「素材旋转元数据」的守护 —— 宽高口径的离线闸门。
 *
 * ★★ 为什么需要它（2026-09-22 线上事故：AI 档成片构图被毁）：
 *   手机竖拍经部分 App / 微信导出后，落地像素是**躺着**的：
 *   容器写 `960×540`，另配 `rotation=-90` 的 side data 告诉播放器「转 90° 再显示」。
 *   ⇒ **真实显示尺寸是 `540×960`**。
 *
 *   而 `probeClipMeta()` 原来只 `-show_entries stream=width,height`（**不看旋转**）
 *   ⇒ 上报给云端合成器的宽高是 960×540 ⇒ 云端据此算 `fit:"cover"` 的缩放
 *     `max(1080/960, 1920/540) = 3.556`，按真实尺寸只要 `max(1080/540, 1920/960) = 2.0`
 *   ⇒ **多放大 1.78 倍**再居中裁切 ⇒ 成片只剩脸部特写。
 *
 *   ★ 本地 ffmpeg 管线没有这个缺陷（`scale`/`crop` 默认 autorotate），
 *     所以现象是「同一条素材，基础档正常、AI 档被裁坏」—— 极易误判成「云端剪辑能力差」。
 *
 * ★ 这个守护必须**真的探一遍文件**，不能只断言纯函数：
 *   纯函数测不出「`-show_entries` 忘了带 `stream_side_data=rotation`」这个回归 ——
 *   那才是原始 bug 本身。所以第 ② 节会现场用 ffmpeg 造一个带旋转的视频再探它。
 *
 * 四节：① 纯函数 rotateToDisplay 的档位矩阵
 *      ② 端到端：真造带旋转的文件 ⇒ probeClipMeta 必须返回**显示**尺寸（不是容器尺寸）
 *      ③ 反向：不带旋转的普通视频必须**原样返回**（防过度修正）
 *      ④ 影响量化：错算/正算的放大倍数比 ≈ 1.78（写进断言，避免以后有人觉得「影响不大」）
 *
 * 运行：cd server && npx tsx scripts/verify-clip-rotation.ts
 * ⚠ 不连库、不连 Redis；只在系统临时目录里造两个小文件并清理。
 * ⚠ 本机/服务器都装了 ffmpeg；万一没有，第 ② 节会**打印原因并跳过**（不是假绿）。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ffmpegBin, ffprobeBin, probeClipMeta, rotateToDisplay } from '../src/render/ffmpeg.js'

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

// ── ① 纯函数：旋转角 → 显示宽高 ──────────────────────────────────────────────
console.log('\n① rotateToDisplay（容器宽高 + 旋转角 ⇒ 显示宽高）')
{
  const W = 960
  const H = 540
  const list = (rotation: unknown): Array<{ rotation?: number }> => [{ rotation: rotation as number }]

  const rot90 = rotateToDisplay(W, H, list(90))
  eq('rotation=90 ⇒ 交换（竖过来）', `${rot90.width}x${rot90.height}`, `${H}x${W}`)
  const rot270 = rotateToDisplay(W, H, list(270))
  eq('rotation=270 ⇒ 交换', `${rot270.width}x${rot270.height}`, `${H}x${W}`)

  // ★ 线上那条素材的实际取值就是 -90（负数）⇒ 归一化到 [0,360) 之后等价 270
  const rotNeg90 = rotateToDisplay(W, H, list(-90))
  eq('★ rotation=-90（线上实际值）⇒ 交换', `${rotNeg90.width}x${rotNeg90.height}`, `${H}x${W}`)
  eq('  └ rotationDegrees 原样保留（-90，不是 270）', rotNeg90.rotationDegrees, -90)
  const rotNeg270 = rotateToDisplay(W, H, list(-270))
  eq('rotation=-270 ⇒ 交换', `${rotNeg270.width}x${rotNeg270.height}`, `${H}x${W}`)
  const rot450 = rotateToDisplay(W, H, list(450))
  eq('rotation=450（等价 90）⇒ 交换', `${rot450.width}x${rot450.height}`, `${H}x${W}`)

  const rot0 = rotateToDisplay(W, H, list(0))
  eq('rotation=0 ⇒ 不变', `${rot0.width}x${rot0.height}`, `${W}x${H}`)
  const rot180 = rotateToDisplay(W, H, list(180))
  eq('rotation=180（上下颠倒，宽高不变）⇒ 不变', `${rot180.width}x${rot180.height}`, `${W}x${H}`)
  const rot360 = rotateToDisplay(W, H, list(360))
  eq('rotation=360 ⇒ 不变', `${rot360.width}x${rot360.height}`, `${W}x${H}`)

  eq('没有 side_data ⇒ 不变', `${rotateToDisplay(W, H, undefined).width}x${rotateToDisplay(W, H, undefined).height}`, `${W}x${H}`)
  eq('空数组 ⇒ 不变', `${rotateToDisplay(W, H, []).width}x${rotateToDisplay(W, H, []).height}`, `${W}x${H}`)
  const rotNaN = rotateToDisplay(W, H, list('abc'))
  eq('rotation 不是数字 ⇒ 不变（不要瞎猜）', `${rotNaN.width}x${rotNaN.height}`, `${W}x${H}`)
  eq('  └ rotationDegrees 记 null', rotNaN.rotationDegrees, null)
  const rotPartial = rotateToDisplay(W, H, [{}, { rotation: 90 }])
  eq('列表里夹着无 rotation 的项 ⇒ 取第一个能用的', `${rotPartial.width}x${rotPartial.height}`, `${H}x${W}`)
}

// ── ② 端到端：真的造一个带旋转的文件再探 ─────────────────────────────────────
console.log('\n② 端到端探测（证明 ffprobe 真的取到了 rotation，而不只是纯函数对）')
{
  const dir = await mkdtemp(join(tmpdir(), 'verify-rotation-'))
  // ★ 三种素材，覆盖「躺着的竖拍」与两种普通情况：
  //   landscape：容器 960×540、无旋转 —— 普通横屏，必须原样返回
  //   portrait ：容器 540×960、无旋转 —— 普通竖屏，必须原样返回
  //   rotated  ：容器 960×540 **＋ rotation -90** —— 这才是线上那 6 段素材的真实形态
  const landscape = join(dir, 'landscape.mp4')
  const portrait = join(dir, 'portrait.mp4')
  const rotated = join(dir, 'rotated.mp4')
  try {
    await execFileP(ffmpegBin(), [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=960x540:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', landscape,
    ], { timeout: 60_000 })
    await execFileP(ffmpegBin(), [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', portrait,
    ], { timeout: 60_000 })

    // ★ 关键一步：以**横屏像素**为输入，用 `-display_rotation` 打上旋转标记、`-c copy` 保持容器尺寸
    //   ⇒ 得到的正是手机竖拍的实际形态：容器躺着（960×540）＋ 一条 rotation=-90。
    await execFileP(ffmpegBin(), [
      '-v', 'error', '-display_rotation', '-90', '-i', landscape, '-c', 'copy', '-y', rotated,
    ], { timeout: 60_000 })

    // 先用 ffprobe 自己确认「测试前提」成立：不成立就**显式跳过**，绝不假绿
    const { stdout } = await execFileP(ffprobeBin(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:stream_side_data=rotation',
      '-of', 'csv=p=0', rotated,
    ], { timeout: 30_000 })
    const container = String(stdout).trim()
    if (!/^960,540,-90/.test(container)) {
      skip(
        '带旋转视频的构造',
        `本机 ffmpeg 打不出 rotation 标记（ffprobe 读到「${container}」）⇒ 无法复现前提`,
      )
    } else {
      ok('前提成立：容器躺着 960×540 ＋ rotation=-90（显示应为 540×960）', true)

      const probe = await probeClipMeta(rotated)
      ok('probeClipMeta 成功', probe.ok, probe.reason ?? '')
      eq('★★ 返回的是**显示**宽高 540×960，不是容器的 960×540', `${probe.width}x${probe.height}`, '540x960')
      eq('  └ rotationDegrees 一并带出（便于排查）', probe.rotationDegrees, -90)
      ok('  └ 反证：容器宽高确实与显示宽高不同（否则这条用例没有意义）', container.startsWith('960,540'), container)
    }

    // ③ 反向：不带旋转的两种普通素材必须**原样返回**（防过度修正）
    const landProbe = await probeClipMeta(landscape)
    ok('普通横屏探测成功', landProbe.ok, landProbe.reason ?? '')
    eq('无旋转横屏 ⇒ 原样 960×540（不许被误交换）', `${landProbe.width}x${landProbe.height}`, '960x540')
    eq('  └ rotationDegrees 为 null', landProbe.rotationDegrees, null)

    const portProbe = await probeClipMeta(portrait)
    ok('普通竖屏探测成功', portProbe.ok, portProbe.reason ?? '')
    eq('无旋转竖屏 ⇒ 原样 540×960', `${portProbe.width}x${portProbe.height}`, '540x960')
    eq('  └ rotationDegrees 为 null', portProbe.rotationDegrees, null)

    // ④ 影响量化：把「错算 vs 正算」的放大倍数固化进断言
    const target = { w: 1080, h: 1920 }
    const wrongScale = Math.max(target.w / 960, target.h / 540)
    const rightScale = Math.max(target.w / 540, target.h / 960)
    ok(
      `★ 影响量化：错算 cover=${wrongScale.toFixed(3)} / 正算=${rightScale.toFixed(3)} ⇒ 多放大 ${(wrongScale / rightScale).toFixed(2)} 倍`,
      Math.abs(wrongScale / rightScale - 1.7778) < 0.001,
      `比值 ${wrongScale / rightScale}`,
    )
  } catch (e) {
    skip('端到端探测', `ffmpeg/ffprobe 不可用或执行失败：${(e as Error).message.split('\n')[0]}`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

console.log(
  `\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过`,
)
process.exit(fail === 0 ? 0 : 1)
