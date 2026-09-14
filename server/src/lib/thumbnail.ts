// 视频封面抽帧：本地存储模式下服务端能直接读到落盘的视频文件，
// 用 ffmpeg 抽第 1 帧作为缩略图，供小程序 <image> 展示。
// 全程 best-effort：ffmpeg 未安装 / 抽帧失败都不应影响上传主流程。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { downloadToFile, objectExists, uploadFile } from './cos.js'

/** 由视频对象键推导同目录下的封面键：uploads/{m}/a.mp4 → uploads/{m}/covers/a.jpg */
export function coverKeyForVideoKey(videoKey: string): string {
  const dir = dirname(videoKey)
  const stem = basename(videoKey, extname(videoKey))
  return `${dir}/covers/${stem}.jpg`
}

/** ffmpeg 可执行文件路径（可用 FFMPEG_PATH 覆盖，便于测试/自定义安装位置） */
function ffmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg'
}

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} 超时`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${cmd} 退出码 ${code}`))
    })
  })
}

export interface CoverResult {
  ok: boolean
  /** 抽帧所在时间点（秒），失败时为 null */
  atSeconds: number | null
}/**
 * 从视频抽一帧写为 jpg。
 * 默认先试 1s（避开开场黑帧/转场），失败再退回第 0 帧。
 */
export async function generateVideoCover(
  videoPath: string,
  outPath: string,
  opts: { atSeconds?: number; width?: number } = {},
): Promise<CoverResult> {
  const width = opts.width ?? 640
  const candidates = opts.atSeconds !== undefined ? [opts.atSeconds] : [1, 0]
  try {
    await mkdir(dirname(outPath), { recursive: true })
  } catch {
    return { ok: false, atSeconds: null }
  }
  for (const at of candidates) {
    try {
      await run(ffmpegBin(), [
        '-y',
        // 输入前快进，避免解码整段视频
        '-ss', String(at),
        '-i', videoPath,
        '-frames:v', '1',
        // 等比缩放到宽 640，高自动取偶数（jpg 要求）
        '-vf', `scale=${width}:-2`,
        '-q:v', '4',
        outPath,
      ])
      const s = await stat(outPath)
      if (s.size > 0) return { ok: true, atSeconds: at }
    } catch {
      // 换下一个候选时间点
    }
  }
  return { ok: false, atSeconds: null }
}

/**
 * `ensureVideoCoverKey` 的结果。
 * 失败时带 `reason`：把存储层/ffmpeg 的真实原因透出来，
 * 否则运营只会看到「抽帧失败」，而实际原因可能是对象存储欠费、路径无权限等。
 */
export type CoverOutcome =
  | { ok: true; coverKey: string }
  | { ok: false; reason: string }

/**
 * 确保某个视频对象有配套封面：已有就直接复用，没有就抽一帧并写回对象存储。
 *
 * 与 `generateVideoCover` 的区别：那个只处理「本地文件 → 本地文件」，
 * 调用方还得自己判断 `isLocalStorage()`。这个走 `lib/cos.ts` 的
 * `downloadToFile` / `uploadFile`，**本地模式与 COS 模式都可用**，
 * 供「从成片入库」这类没有 media_asset 记录的场景（excellent_work）使用。
 *
 * 本函数不抛异常，失败一律以 `{ ok: false, reason }` 返回，方便调用方 best-effort 处理。
 */
export async function ensureVideoCoverKey(
  videoKey: string,
  opts: { atSeconds?: number; width?: number } = {},
): Promise<CoverOutcome> {
  const coverKey = coverKeyForVideoKey(videoKey)
  try {
    if (await objectExists(coverKey)) return { ok: true, coverKey }
  } catch {
    // 查不到就当没有，继续尝试生成
  }

  const stamp = randomUUID()
  const tmpVideo = join(tmpdir(), `ds-cover-src-${stamp}${extname(videoKey) || '.mp4'}`)
  const tmpCover = join(tmpdir(), `ds-cover-out-${stamp}.jpg`)
  try {
    try {
      await downloadToFile(videoKey, tmpVideo)
    } catch (e) {
      return { ok: false, reason: `读不到视频对象（${(e as Error).message}）` }
    }

    const r = await generateVideoCover(tmpVideo, tmpCover, opts)
    if (!r.ok) return { ok: false, reason: 'ffmpeg 抽帧失败（确认服务端已安装 ffmpeg，且视频可解码）' }

    try {
      await uploadFile(tmpCover, coverKey, 'image/jpeg')
    } catch (e) {
      return { ok: false, reason: `封面写回存储失败（${(e as Error).message}）` }
    }
    return { ok: true, coverKey }
  } finally {
    await Promise.all([
      rm(tmpVideo, { force: true }).catch(() => undefined),
      rm(tmpCover, { force: true }).catch(() => undefined),
    ])
  }
}
