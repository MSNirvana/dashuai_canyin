import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 本地配乐曲库：把「风格 → 曲子文件」固定成一份落盘约定，渲染时按风格直接取用。
 *
 * ★ 为什么需要它：配乐此前只有两条路 ——
 *   ① `DEFAULT_BGM_PATH` 指一个文件（**所有风格都放同一首**，且必须人工准备）；
 *   ② `ffmpegGenerateBackgroundMusic` 合成一条和弦床（实测约 -37dBFS 的静态三音，
 *      听感是「嗡」不是曲子 —— 用户反馈的「没有配乐」就是这个）。
 *   而风格**早就自动识别出来了**（`auto-edit.ts::resolveAutoChatcutOptions` 按素材画像
 *   给出 `LIGHT` / `UPBEAT` / `PREMIUM`），缺的只是「每个风格各有一首能听的曲子」。
 *   这里就是把那份曲库固定下来：`assets/bgm/<STYLE>.<ext>`。
 *
 * ★ 曲库从哪来：`npm run bgm:generate`（`scripts/bgm-generate.ts`）用 ChatCut 的
 *   `submit_music`（mureka-9）真生成一首，再 `request_asset_download` 取回本地落盘。
 *   运营也可以直接丢一个**已获授权**的文件进去，命名成 `LIGHT.mp3` 即可 —— 不用改代码。
 *
 * ★★ 生产出片**不依赖 ChatCut 在线**：联网只发生在「补曲库」那一步（运维动作），
 *   渲染管线只读本地文件。这一点是刻意的 —— 把第三方可用性挡在出片链路之外。
 *
 * ★ 版权：本模块只负责「按风格找一个文件」，不判断授权。文件由谁放进来的，
 *   授权就该由谁负责；`bgm:generate` 会把 license / 生成来源写进同名的 `.json` 元数据，
 *   便于合规审查。**绝不在这里按名字猜到某首来路不明的曲子就装上**。
 *
 * ★★ 时长约束：曲子必须**不比成片短**。`synthesis.ts::mixAudioTracks()` 用
 *   `amix=duration=longest` 且只输出一条音频流，**没有做循环**；比成片短的曲子会在中途静音。
 *   AI 档成片上限 65s（`validateOutputQuality`），而 `bgm:generate` 产出的曲子实测 155s，
 *   所以正常路径够用。手放文件时请守住「≥65s」这条线。
 *   ⚠ 不要顺手加 `-stream_loop -1`：混音输出是**单条无限流**，`-shortest` 将无有界流可比，
 *     会让渲染永久挂住 —— 要加循环必须同时给 `-t <成片时长>`，那是另一笔改动。
 */

/** 与 `ChatCutOptions['bgm']` 去掉 `NONE` 之后的取值集合一致（由 verify 断言与 prompt 表对齐） */
export const BGM_STYLES = ['LIGHT', 'UPBEAT', 'PREMIUM'] as const

export type BgmStyle = (typeof BGM_STYLES)[number]

/** 认可的音频扩展名（按优先级）。运营手放的免费曲子常见 mp3，AI 生成常见 mp3/wav。 */
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] as const

/**
 * 曲库目录。
 *
 * 解析顺序（**必须容错**，因为「找不到曲库」只是回退到合成垫底，不该让出片失败）：
 *   ① `BGM_LIBRARY_DIR`（显式指定，运维可控）
 *   ② 模块文件向上两级（`src/render` 与 `dist/render` 都正好是 server 根）+ `assets/bgm`
 *   ③ `process.cwd()/assets/bgm`（pm2 的 cwd 就是 server 根，脚本也是在 server 下跑的）
 *
 * ★ 不用 `process.cwd()` 当唯一依据：脚本从仓库根跑时 cwd 会变，
 *   而模块路径不会 —— 所以模块路径优先，cwd 只作兜底。
 */
export function bgmLibraryDir(): string {
  const fromEnv = process.env.BGM_LIBRARY_DIR?.trim()
  if (fromEnv) return resolve(fromEnv)
  const fromModule = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'bgm')
  if (existsSync(fromModule)) return fromModule
  return resolve(process.cwd(), 'assets', 'bgm')
}

/** 该曲目对应的元数据文件（由 `bgm:generate` 写入；手放的曲子可以没有） */
export function bgmMetadataPath(file: string): string {
  return file.replace(/\.[a-z0-9]+$/i, '.json')
}

function isStyle(value: string): value is BgmStyle {
  return (BGM_STYLES as readonly string[]).includes(value)
}

/**
 * 按风格找本地曲子。找到返回**绝对路径**，没有返回 `null`（调用方据此回退）。
 *
 * ★ 认「大写风格名 + 小写扩展名」，也认全大写/全小写两种写法 ——
 *   让人手放文件时不必猜命名规范（`LIGHT.mp3` / `light.mp3` 都行）。
 * ★ 目录不存在、没有读权限一律返回 `null` 而不抛：这是**可选增强**，
 *   不能因为它让整条出片失败。
 */
export function resolveBgmTrack(style: string | undefined | null): string | null {
  const wanted = String(style ?? '').trim().toUpperCase()
  if (!wanted || !isStyle(wanted)) return null

  const dir = bgmLibraryDir()
  let names: string[]
  try {
    if (!statSync(dir).isDirectory()) return null
    names = readdirSync(dir)
  } catch {
    return null
  }

  const byLowerName = new Map(names.map((name) => [name.toLowerCase(), name]))
  for (const extension of AUDIO_EXTENSIONS) {
    const hit = byLowerName.get(`${wanted.toLowerCase()}.${extension}`)
    if (hit) {
      const file = join(dir, hit)
      try {
        if (statSync(file).isFile() && statSync(file).size > 0) return file
      } catch {
        // 落到下一个扩展名继续找
      }
    }
  }
  return null
}

/** 曲库现状（诊断用：`bgm:generate` 会打印，排查「为什么还是垫底」时先看它） */
export interface BgmLibraryEntry {
  style: string
  file: string | null
  /** 元数据里的生成来源/License 摘要，没有元数据时为 null */
  note: string | null
}

export function describeBgmLibrary(): { dir: string; dirExists: boolean; entries: BgmLibraryEntry[] } {
  const dir = bgmLibraryDir()
  return {
    dir,
    dirExists: existsSync(dir),
    entries: BGM_STYLES.map((style) => {
      const file = resolveBgmTrack(style)
      return { style, file, note: file ? readBgmNote(file) : null }
    }),
  }
}

/**
 * 读同名的 `.json` 元数据，拼成一行摘要。读不到/格式不对就返回 null ——
 * 元数据只是给人看的，不该影响任何判断。
 */
function readBgmNote(file: string): string | null {
  try {
    const raw = readFileSync(bgmMetadataPath(file), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const parts = ['source', 'model', 'license', 'attribution', 'prompt', 'generatedAt']
      .map((key) => {
        const value = parsed[key]
        return typeof value === 'string' && value.trim() ? `${key}=${value.trim()}` : null
      })
      .filter(Boolean)
    return parts.length > 0 ? parts.join('  ') : null
  } catch {
    return null
  }
}
