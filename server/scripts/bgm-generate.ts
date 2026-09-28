/**
 * 用**第三方音乐生成**补本地配乐曲库 —— `npm run bgm:generate -- --style=LIGHT --yes`
 *
 * ★ 这个脚本存在的理由：配乐此前要么靠合成的一条和弦床（听感是嗡，不是曲子），
 *   要么靠运维手工放一个 `DEFAULT_BGM_PATH`（且所有风格共用同一首）。
 *   而 ChatCut 的 `submit_music` 是**真音乐生成**（mureka-9），
 *   生成的素材又能用 `request_asset_download` 取回本地 —— 于是可以
 *   「用 ChatCut 只做配乐、渲染仍然留在本地」，既拿到真曲子，
 *   又不动本地引擎（本地引擎上挂着字幕位置/分段/接缝帧率那些修复，换引擎会把它们全废掉）。
 *
 * ★★ 两个生成源（`--source`，默认 chatcut ⇒ 不传参数时行为与加这个开关之前完全一致）：
 *   ① `chatcut`：ChatCut `submit_music`，默认写**单文件** `assets/bgm/<风格>.<ext>`（保持现状），
 *      加 `--pool` 才写池子。
 *   ② `volcano`：火山引擎 `GenBGMForTime`（豆包音乐 v5.0），**只走池子** `assets/bgm/<风格>/`。
 *      需要 `VOLCENGINE_ACCESS_KEY` / `VOLCENGINE_SECRET_KEY`（AK/SK v4 签名）——
 *      ⚠ 与火山 TTS 的 `X-Api-Key` **不是同一套凭证**。缺密钥时本脚本按「未配置」直接报错，
 *      不会静默跳过，也不会退回 ChatCut（换源必须是**显式**的）。
 *   ★ 密钥未到也不影响出片：这条链路只在**补货**时联网，渲染管线永远只读本地文件。
 *
 * ★★ 关键设计：联网只发生在**补货**这一步（运维动作），渲染管线只读本地文件。
 *   所以 ChatCut / 火山挂了或额度耗尽，只是「不能补曲库」，不会让出片失败。
 *
 * ★★ 本脚本只做 **CLI 解析 + 逐风格调度**；生成、时长校验、落盘、写元数据的全部实现在
 *   `src/render/bgm-ingest.ts`（与 `bgm:replenish` 共用同一份）。**要改生成行为去那里改。**
 *   ★ 想「把池子维持到 N 首、超额自动淘汰」用 `npm run bgm:replenish`，不是这个脚本
 *     （这个脚本每个风格最多生成一首）。
 *
 * ★ 与 `chatcut-call.ts` 同一套安全约定：**默认 dry-run**（只打印将发送的请求），
 *   加 `--yes` 才真发。因为 `submit_music` 是**消耗 ChatCut 额度**的调用
 *   （对方 schema 原文：this tool costs ChatCut credits），火山那边也是**按秒计费**。
 *
 * 用法：
 *   npm run bgm:generate -- --style=LIGHT              # 先看会发什么（不发）
 *   npm run bgm:generate -- --style=LIGHT --yes        # 真生成一首 LIGHT
 *   npm run bgm:generate -- --style=ALL --yes          # 三个风格都补齐
 *   npm run bgm:generate -- --source=volcano --style=LIGHT --yes   # 改用火山生成（落池子）
 *   npm run bgm:generate -- --list                     # 只看曲库现状
 *
 * 可选参数：
 *   --source=chatcut|volcano 生成源（默认 chatcut；也可用 BGM_SOURCE 环境变量指定）
 *   --pool                   把 chatcut 源的结果也写进池子（默认写单文件）
 *   --project=<projectId>    指定落进哪个 ChatCut 项目（默认读 CHATCUT_BGM_PROJECT_ID，
 *                            都没有就新建一个名为 dashuai-bgm-library 的项目）※ 仅 chatcut
 *   --asset=<assetId>        跳过生成、只取回落盘已生成好的素材（不花生成额度）※ 仅 chatcut
 *   --wait=<秒>              等待生成的就绪预算（默认 300）
 */
import 'dotenv/config'
import { prisma, redis } from '../src/db.js'
import { BGM_STYLES, describeBgmLibrary, listBgmPool, resolveBgmTrack, type BgmStyle } from '../src/render/bgm-library.js'
// ★ 生成/落盘的全部实现都在 `src/render/bgm-ingest.ts`（两个补货 CLI 共用）。
//   本脚本只做 **CLI 解析 + 逐风格调度** —— 想改生成行为要去那个模块，别在这里补。
import {
  ensureChatcutBgmProject,
  fail,
  ingestChatcutBgm,
  ingestVolcanoBgm,
} from '../src/render/bgm-ingest.js'

const DEFAULT_WAIT_SECONDS = 300

function argValue(flag: string): string | null {
  const prefix = `${flag}=`
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(flag)
  if (index < 0) return null
  const next = process.argv[index + 1]
  return next && !next.startsWith('--') ? next : null
}

const CONFIRMED = process.argv.includes('--yes')
const LIST_ONLY = process.argv.includes('--list')
/** 默认「只补缺口」：已存在的风格直接跳过 —— 生成是**花额度**的，`--style=ALL` 不该重造已有的曲子 */
const FORCE = process.argv.includes('--force')

/**
 * 生成源。`--source=` 优先，其次 `BGM_SOURCE` 环境变量，默认 `chatcut`。
 *
 * ★ 默认**必须**是 chatcut：不传任何新参数时，行为与加这个开关之前**完全一致**，
 *   已有的运维习惯与文档都不用改，风险为零。
 */
const SOURCE = (argValue('--source') ?? process.env.BGM_SOURCE ?? 'chatcut').trim().toLowerCase()

/**
 * 落盘位置。
 *   volcano ⇒ **一定**写池子 `assets/bgm/<风格>/`（火山这条源本来就是为池子准备的）
 *   chatcut ⇒ 默认写老的**单文件** `assets/bgm/<风格>.<扩展名>`（保持现状），加 `--pool` 才写池子
 *
 * ★ 这样「换生成源」**不会覆盖也不会删掉**现有的那几首曲子 —— 池子与单文件是两个位置，
 *   运行时的取用规则是「池子优先、单文件兜底」（`bgm-library.ts::resolveBgmTrack`）。
 */
const INTO_POOL = SOURCE === 'volcano' || process.argv.includes('--pool')

async function main(): Promise<void> {
  const before = describeBgmLibrary()
  console.log('大帅餐饮配乐曲库')
  console.log(`曲库目录：${before.dir}${before.dirExists ? '' : '（尚未创建）'}`)
  for (const entry of before.entries) {
    // ★ 同时报池子数量：池子非空时 `file` 是**随机抽到**的池内某一首，
    //   不报数量的话「池子里有 5 首」和「只有 1 首」看起来一模一样。
    const pool = entry.poolSize > 0 ? `（池内 ${entry.poolSize} 首，随机取用）` : ''
    console.log(`  ${entry.style.padEnd(8)} ${entry.file ?? '（缺，渲染时会回退到合成垫底）'}${pool}`)
    if (entry.note) console.log(`${' '.repeat(11)}${entry.note}`)
  }

  const requested = (argValue('--style') ?? '').trim().toUpperCase()
  if (LIST_ONLY || !requested) {
    if (!requested && !LIST_ONLY) {
      console.log('\n用法：--style=LIGHT|UPBEAT|PREMIUM|ALL [--yes] [--force] [--list]')
      console.log('             [--source=chatcut|volcano] [--pool] [--wait=<秒>]')
      console.log('             [--project=<id>] [--asset=<assetId>]   ← 仅 --source=chatcut 有效')
      console.log('默认 dry-run：只打印将发送的请求；加 --yes 才真调用（会消耗额度）。')
      console.log('默认只补缺口：已有曲子的风格会跳过，--force 才重生成。')
      console.log('--asset=<assetId>：跳过生成、只把**已经生成好**的素材取回落盘（不花生成额度）。')
      console.log('--source=chatcut（默认）：用 ChatCut 的 submit_music（mureka-9）生成。')
      console.log('--source=volcano：用火山引擎 GenBGMForTime（豆包音乐）生成，落进**池子**；')
      console.log('                  需 VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY（与 TTS 的 X-Api-Key 不是一套）。')
      console.log('--pool：把 chatcut 源生成的结果也写进池子 `assets/bgm/<风格>/`（默认写单文件，保持现状）。')
    }
    return
  }

  const styles: BgmStyle[] = requested === 'ALL' ? [...BGM_STYLES] : [requested as BgmStyle]
  for (const style of styles) {
    if (!(BGM_STYLES as readonly string[]).includes(style)) {
      fail(`未知风格 ${style}，可选：${BGM_STYLES.join(' / ')} / ALL`)
    }
  }

  if (SOURCE !== 'chatcut' && SOURCE !== 'volcano') {
    fail(`未知生成源 ${SOURCE}，可选：chatcut / volcano（也可用 BGM_SOURCE 环境变量指定）`)
  }

  const presetAssetId = (argValue('--asset') ?? '').trim() || null
  // ★ `--asset` 是 ChatCut 的概念（那是对方项目里的素材 id）。火山源走的是自己的 TaskID，
  //   拿一个 ChatCut assetId 过来只会让人以为「取回落盘了」而其实什么都没发生 —— 直接拦掉。
  if (presetAssetId && SOURCE !== 'chatcut') {
    fail(`--asset=<assetId> 只对 --source=chatcut 有效（当前 source=${SOURCE}）`)
  }
  let projectId = argValue('--project') ?? process.env.CHATCUT_BGM_PROJECT_ID?.trim() ?? ''
  if (!CONFIRMED) {
    projectId ||= presetAssetId ? '<沿用素材所在项目>' : '<将新建 dashuai-bgm-library>'
  } else if (SOURCE === 'chatcut' && !projectId && !presetAssetId) {
    // ★ 只有**要生成**的时候才建项目：带 --asset 时素材已经在某个项目里了，
    //   这时再建一个新项目纯属制造垃圾。
    projectId = await ensureChatcutBgmProject(argValue('--project'))
  }

  const waitSeconds = Number(argValue('--wait') ?? DEFAULT_WAIT_SECONDS)
  const budget = Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : DEFAULT_WAIT_SECONDS

  // ★ 生成/落盘的入参一次性拼好 —— 两个源共用同一个 options（argv 依赖到此为止，
  //   再往下全部是显式入参，这样 `bgm:replenish` 才能安全复用同一份实现）。
  const ingestOptions = {
    confirmed: CONFIRMED,
    intoPool: INTO_POOL,
    waitSeconds: budget,
    projectId,
    presetAssetId,
  } as const

  let ok = 0
  for (const style of styles) {
    // ★ 默认只补缺口：已有曲子就跳过 —— 生成是**花额度**的，`--style=ALL` 不该重造已有曲子。
    // ★★ 判据必须跟着**落盘位置**走（`INTO_POOL`）：池子模式看**池子**、单文件模式看**单文件**。
    //   用错判据的后果是双向的 —— 拿单文件判池子会「明明池子空着却跳过」（漏补），
    //   拿池子判单文件会「单文件还在却说没有」（白花一次额度）。
    const pool = INTO_POOL ? listBgmPool(style) : []
    const existing = INTO_POOL ? (pool[0] ?? null) : resolveBgmTrack(style)
    if (existing && !FORCE) {
      console.log(`\n── ${style} ─────────────────────────────────────────────`)
      console.log(
        INTO_POOL
          ? `  · 池子里已有 ${pool.length} 首，跳过（要再加一首用 --force；批量补货用 npm run bgm:replenish）`
          : `  · 已有曲子，跳过：${existing}（要重生成加 --force）`,
      )
      ok += 1
      continue
    }
    try {
      const done =
        SOURCE === 'volcano' ? await ingestVolcanoBgm(style, ingestOptions) : await ingestChatcutBgm(style, ingestOptions)
      if (done) ok += 1
    } catch (error) {
      // 单个风格失败不该中断其余风格：补曲库是运维动作，跑一次能补几个是几个
      console.log(`  ✗ ${style} 失败：${(error as Error).message}`)
    }
  }

  if (CONFIRMED) {
    console.log(`\n完成：本次成功落盘 ${ok}/${styles.length}`)
    const after = describeBgmLibrary()
    for (const entry of after.entries) {
      console.log(`  ${entry.style.padEnd(8)} ${entry.file ?? '（缺）'}${entry.poolSize > 0 ? `（池内 ${entry.poolSize} 首）` : ''}`)
    }
  }
}

main()
  .catch((error: unknown) => {
    if (process.exitCode !== 1) console.error(`脚本异常：${(error as Error).message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined)
    redis.disconnect()
    process.exit(process.exitCode ?? 0)
  })
