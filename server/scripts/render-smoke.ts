// FFmpeg 链路冒烟 + 中间产物缓存收益实测
// 用途：部署机上线前验证 ffmpeg/ffprobe 可用、编码参数正确、重调色（10豆）确实比重跑（30豆）省 CPU
// 运行：npm run render:smoke
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  ffmpegNormalize,
  ffmpegApplyColor,
  ffmpegConcat,
  probeDurationMs,
  buildColorFilter,
} from '../src/render/ffmpeg.js'

const execFileP = promisify(execFile)
const color = { brightness: 5, contrast: 10, saturation: 0, sharpen: 20 }
const CLIP_COUNT = 3
const SRC_SEC = 8 // 每段素材时长，适当放大以避免 ffmpeg 进程启动开销淹没真实编码耗时
const TRIM = { startMs: 500, endMs: 7500 }

async function main() {
  console.log('调色滤镜 =', buildColorFilter(color))
  console.log('调色滤镜(全 0) =', buildColorFilter({ brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }))

  const dir = await mkdtemp(join(tmpdir(), 'smoke-'))
  try {
    // 1) 生成测试素材（竖屏 + 横屏混剪，模拟真实上传）
    for (let i = 0; i < CLIP_COUNT; i++) {
      await execFileP('ffmpeg', [
        '-f', 'lavfi', '-i', `testsrc=size=${i === 0 ? '720x1280' : '1280x720'}:rate=30`,
        '-t', String(SRC_SEC), '-pix_fmt', 'yuv420p', '-y', join(dir, `src${i}.mp4`),
      ], { timeout: 60000 })
    }
    console.log(`✓ 生成 ${CLIP_COUNT} 段测试素材（720x1280 竖屏 + 1280x720 横屏）`)

    // 2) 阶段A「首次合成 / 无缓存」：逐镜头归一化 → 拼接 → 整片调色
    //    归一化产物即后续可复用的中间产物缓存
    const normPaths: string[] = []
    const t0 = Date.now()
    for (let i = 0; i < CLIP_COUNT; i++) {
      const norm = join(dir, `norm${i}.mp4`)
      await ffmpegNormalize(join(dir, `src${i}.mp4`), norm, {
        width: 1080, height: 1920, startMs: TRIM.startMs, endMs: TRIM.endMs, timeoutMs: 120000,
      })
      normPaths.push(norm)
    }
    const concatA = join(dir, 'concatA.mp4')
    await ffmpegConcat(normPaths, concatA, 120000)
    const finalA = join(dir, 'finalA.mp4')
    await ffmpegApplyColor(concatA, finalA, color, 120000)
    const fullMs = Date.now() - t0
    console.log(`✓ 阶段A 首次合成（归一化 ${CLIP_COUNT} 段 + 拼接 + 调色）= ${fullMs}ms`)

    // 3) 阶段B「重调色 / 缓存全命中」：复用归一化产物 → 拼接(copy) → 整片调色
    //    与阶段A 唯一差别就是省掉「归一化」，差值即缓存收益
    const t1 = Date.now()
    const concatB = join(dir, 'concatB.mp4')
    await ffmpegConcat(normPaths, concatB, 120000)
    const final = join(dir, 'final.mp4')
    await ffmpegApplyColor(concatB, final, color, 120000)
    const recolorMs = Date.now() - t1
    console.log(`✓ 阶段B 重调色（复用缓存 + 拼接 + 调色）= ${recolorMs}ms`)
    console.log(
      `  → 缓存收益：重调色为首次合成的 ${(recolorMs / fullMs).toFixed(2)}×（省 ${100 - Math.round((recolorMs / fullMs) * 100)}%）`,
    )
    console.log(`  → 其中归一化耗时约 ${fullMs - recolorMs}ms，占首次合成 ${Math.round(((fullMs - recolorMs) / fullMs) * 100)}%`)

    // 4) 校验分辨率与时长
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', final,
    ], { timeout: 20000 })
    const dur = await probeDurationMs(final)
    const size = String(stdout).trim()
    console.log(`✓ 输出分辨率 = ${size} (期望 1080,1920)`)
    const expectMs = (TRIM.endMs - TRIM.startMs) * CLIP_COUNT
    console.log(`✓ 输出时长 = ${dur} ms (期望约 ${expectMs}ms)`)
    if (dur === null || Math.abs(dur - expectMs) > 1000) throw new Error(`时长不符：${dur} vs 期望 ${expectMs}`)
    if (size !== '1080,1920') throw new Error(`分辨率不符：${size}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().then(() => console.log('冒烟通过')).catch((e) => {
  console.error('冒烟失败:', e)
  process.exit(1)
})
