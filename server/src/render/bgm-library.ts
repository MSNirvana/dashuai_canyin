import { randomInt } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
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
 * ★★ 两档目录约定（取用时**池子优先、单文件兜底**）：
 *   ① 池子 `assets/bgm/<STYLE>/`：同风格多条曲子，运行时**随机抽一首** ⇒ 每条片子配乐不重样。
 *      这是「API 供给的缓存层」——补货脚本（`npm run bgm:replenish`）往这里写，渲染只读。
 *   ② 单文件 `assets/bgm/<STYLE>.<ext>`：老的约定，线上现存曲库就是这种，**继续有效**。
 *   两个位置互不覆盖：换生成源（ChatCut ↔ 火山）不会删掉已有的曲子。
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

/**
 * 曲子时长下限（毫秒）：**低于它会在成片中途静音，而且不报任何错**（见文件头时长约束那段）。
 *
 * ★ 这个常量放在**曲库模块**而不是生成侧：它是「一首曲子合不合格」的判据，
 *   而要校验它的人不止生成脚本 —— 守护（`verify-bgm-library`）与运营手放文件时同样要守。
 */
export const BGM_MIN_DURATION_MS = 65_000

/**
 * 池子每个风格的目标曲目数（`bgm:replenish` 的默认目标）。
 *
 * ★ 放这里而不是补货脚本里：**守护要用它**。提示词表的条数必须 ≥ 这个数，否则补货取词会
 *   绕回起点取到同一批描述 ⇒ 池子长出近乎重复的曲子且**不报任何错**。
 *   两处共用同一个常量，才能做到「把目标调大 ⇒ 守护立刻因提示词不够而红」。
 *
 * ★★ 为什么是 30 而不是 5：配乐多样性是一个**生日问题** —— 同一门店、同一风格下连续出 n 条，
 *   至少重样一次的概率是 `1 - ∏(1 - i/N)`。实测口径：N=5 时第 6 条**必撞**；N=8 时 8 条内
 *   99.8% 会撞；N=20 时降到约 80%；N=30 时降到约 64%、而「最近 3 条内」降到约 10%。
 *   再往上收益迅速衰减（N=125 时 8 条内仍有约 20%）⇒ **「堆到几百首」不是这个问题的解**，
 *   短期重叠要靠运行期的「避开最近用过的」去消。
 * ★★ 真正的硬约束是**提示词条数**：本值一旦超过 `VOLCANO_BGM_PROMPTS[style].length`，
 *   补货取词就会绕回起点取到同一批描述（`bgm-replenish.ts` 只告警、**不阻断**）⇒
 *   花钱生成近乎重复的曲子。所以**抬目标必须同时加词**，两处都由守护钉住。
 */
export const BGM_POOL_TARGET = 30

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

function listAudioFiles(dir: string): string[] {
  let names: string[]
  try {
    if (!statSync(dir).isDirectory()) return []
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files: string[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const dot = name.lastIndexOf('.')
    if (dot <= 0) continue
    const extension = name.slice(dot + 1).toLowerCase()
    if (!(AUDIO_EXTENSIONS as readonly string[]).includes(extension)) continue
    const file = join(dir, name)
    try {
      if (statSync(file).isFile() && statSync(file).size > 0) files.push(file)
    } catch {
      // 单个文件读不到就跳过，不让它毁掉整个池子
    }
  }
  // 排序：随机抽取需要一个稳定的输入集合，补货/淘汰与守护断言也要可比
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * 池子目录：`assets/bgm/<风格>/`。
 *
 * ★ 目录名大小写不敏感（`LIGHT/` 与 `light/` 都认），与单文件命名规则一致。
 * ★ 目录不存在时**返回约定路径**而不是 null —— 补货脚本要靠它 mkdir。
 */
export function bgmPoolDir(style: string | undefined | null): string {
  const wanted = String(style ?? '').trim().toUpperCase()
  const root = bgmLibraryDir()
  if (!wanted || !isStyle(wanted)) return join(root, wanted)
  try {
    const hit = readdirSync(root).find((name) => {
      try {
        return name.toLowerCase() === wanted.toLowerCase() && statSync(join(root, name)).isDirectory()
      } catch {
        return false
      }
    })
    if (hit) return join(root, hit)
  } catch {
    // 曲库根目录还不存在 —— 用约定路径
  }
  return join(root, wanted)
}

/** 池子里全部可用曲子（已排序）。空数组 = 没有池子，调用方回退单文件约定。 */
export function listBgmPool(style: string | undefined | null): string[] {
  const wanted = String(style ?? '').trim().toUpperCase()
  if (!wanted || !isStyle(wanted)) return []
  return listAudioFiles(bgmPoolDir(wanted))
}

/**
 * 读一首曲子的「生成描述」—— 同名 `.json` 侧车里的 `prompt` 字段，读不到返回 `null`。
 *
 * ★ 为什么单拎出来：它在两处被用到，而两处对「读不到」的处理**恰好相反又都要正确**：
 *   · 补货（`usedBgmPromptTexts`）把读不到当成「没记录过」，顶多多生成一首；
 *   · 选曲（`describeBgmCandidates`）把读不到当成「description 为空」，那一首就不该
 *     被交给模型去比。写成两份就一定有一份会漂移。
 * ★ 一律 `trim()`：池子里的曲子是照着提示词表生成的，而提示词表里的原串没有首尾空白 ——
 *   不 trim 就永远比不中，等于这条记录不存在（**静默**失效）。
 */
function readBgmPrompt(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(bgmMetadataPath(file), 'utf8')) as { prompt?: unknown }
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
    return prompt || null
  } catch {
    // 没有侧车或内容不可解析：当作没记录过
    return null
  }
}

/**
 * 池内**已经用过的**生成提示词（读同名 `.json` 侧车的 `prompt` 字段）。
 *
 * ★ 为什么需要它：补货按「池内数量 + 序号」顺序取词，隐含假设「已有曲子正好占了 0..n-1 号」。
 *   而手工单发（`bgm:generate`）是**随机**取词 ⇒ 池子被随机播种之后，顺序取词会撞上池里
 *   已经用过的那条描述，生成一首**近乎重复**的曲子，而且**不报任何错**。
 *   所以补货必须先看池里用过哪些词，再挑没用过的。
 * ★ 手放的曲子没有侧车 ⇒ 自然计入「未用过」，不影响补货。
 * ★ 侧车坏了/不存在都当作「没记录过」：顶多多生成一首，不影响可用性（绝不抛错）。
 */
export function usedBgmPromptTexts(style: string | undefined | null): Set<string> {
  const used = new Set<string>()
  for (const file of listBgmPool(style)) {
    const prompt = readBgmPrompt(file)
    if (prompt) used.add(prompt)
  }
  return used
}

/** 池内一首候选曲子：文件绝对路径 + 它的生成描述（侧车缺失时为 `null`） */
export interface BgmCandidate {
  file: string
  /**
   * 这首曲子「长什么样」的一句话描述（来自生成时的提示词）。
   *
   * ★ 它是**选曲**唯一的依据：模型看不到音频，只看到文字。没有描述就等于「一首无法描述的歌」，
   *   无从比较 —— 所以调用方在候选里描述太少时应当**放弃调用**（见 `bgm-select.service.ts`），
   *   而不是让模型在几行「（无描述）」里瞎猜。
   * ★ 手放的曲子没有侧车 ⇒ 这里为 `null`；这不影响渲染（照样能被随机抽到），只影响能否被 AI 比选。
   */
  note: string | null
}

/**
 * 池内候选（保持 `listBgmPool` 的稳定排序）—— 交给选曲服务去做「按内容挑一首」。
 *
 * ★ 顺序**必须稳定**：模型返回的是下标，下标与顺序一一对应。顺序一变，同样的返回值
 *   就指向了另一首曲子 —— 而且**不会报错**。所以直接沿用 `listBgmPool` 的排序，不要在这里重排。
 */
export function describeBgmCandidates(style: string | undefined | null): BgmCandidate[] {
  return listBgmPool(style).map((file) => ({ file, note: readBgmPrompt(file) }))
}

/**
 * 淘汰池子里超额的曲子。**只有补货脚本该调用它，运行时不调用。**
 *
 * 保留策略：按修改时间**新的优先**；至少保留 1 首
 * （池子被清空就退回合成垫底，那是更差的结果）。返回被删掉的文件。
 * ★ 删不掉就留着：清理逻辑绝不能把补货/出片搞挂。
 */
export function pruneBgmPool(style: string, keep: number): string[] {
  const pool = listBgmPool(style)
  const limit = Math.max(1, keep)
  if (pool.length <= limit) return []
  const ranked = pool
    .map((file) => {
      let mtimeMs = 0
      try {
        mtimeMs = statSync(file).mtimeMs
      } catch {
        mtimeMs = 0 // 读不到当最旧，优先淘汰
      }
      return { file, mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const removed: string[] = []
  for (const { file } of ranked.slice(limit)) {
    try {
      rmSync(file, { force: true })
      rmSync(bgmMetadataPath(file), { force: true })
      removed.push(file)
    } catch {
      // 留着即可
    }
  }
  return removed
}

// ★★ 取用顺序：**池子优先、单文件兜底**。
//   池子 = 「API 供给的缓存层」：补货脚本往 `assets/bgm/<风格>/` 写，运行时只读。
//   同风格多条曲子时，每条片子抽到的配乐不重样。
//   随机只影响「抽哪一首」，不影响「有没有」—— 池子里有任何一首可用就一定命中，
//   所以出片成功率不随池子大小波动，也不依赖第三方在线。

/**
 * **只**按老的**单文件**约定找曲子：`assets/bgm/<风格>.<扩展名>`（按扩展名优先级取第一个命中）。
 * 找不到返回 `null`。**不看池子。**
 *
 * ★★ 为什么必须把它单独导出来 —— `resolveBgmTrack` 现在是「池子优先」，
 *   池子非空时它返回的是**池内随机一首**。补曲脚本里有一句「清掉同风格的单文件残留」，
 *   若拿 `resolveBgmTrack` 的结果当「残留」，在池子非空时会**删掉刚攒进池子的曲子**
 *   （补一首、删一首，池子永远长不大）。所以「找单文件」和「找一个能用的曲子」
 *   是**两件事**，不能共用一个函数。
 */
export function singleFileBgmTrack(style: string | undefined | null): string | null {
  const wanted = String(style ?? '').trim().toUpperCase()
  if (!wanted || !isStyle(wanted)) return null
  // listAudioFiles 已按白名单与「非空文件」过滤，这里只按扩展名优先级挑
  const byLowerName = new Map(listAudioFiles(bgmLibraryDir()).map((file) => [basename(file).toLowerCase(), file]))
  for (const extension of AUDIO_EXTENSIONS) {
    const hit = byLowerName.get(`${wanted.toLowerCase()}.${extension}`)
    if (hit) return hit
  }
  return null
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

  // ① 池子优先：只要有任意一首可用就随机抽一首，命中与否与池子大小无关
  const pool = listAudioFiles(bgmPoolDir(wanted))
  if (pool.length > 0) return pool[randomInt(pool.length)] ?? pool[0] ?? null

  // ② 单文件兜底：老的 `assets/bgm/<风格>.<扩展名>` 约定（线上现存曲库就是这种）
  return singleFileBgmTrack(wanted)
}

/** 曲库现状（诊断用：`bgm:generate` 会打印，排查「为什么还是垫底」时先看它） */
export interface BgmLibraryEntry {
  style: string
  file: string | null
  /** 池子（`assets/bgm/<风格>/`）里的曲子数量；0 = 没有池子，走单文件兜底 */
  poolSize: number
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
      return { style, file, poolSize: listBgmPool(style).length, note: file ? readBgmNote(file) : null }
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
