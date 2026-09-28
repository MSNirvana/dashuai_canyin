/**
 * 配乐池补货 —— `npm run bgm:replenish [-- --yes]`
 *
 * 目的：把 `assets/bgm/<风格>/` 这个**池子**维持到目标数量，让渲染时随机抽到的曲子有足够差异
 * （用户诉求原文：「我不是三首固定曲子，而是根据实际拍摄随机获取或者生成，曲库要大要多」）。
 *
 * ★★ 为什么是「池子 + 后台补货」，而不是「渲染时现调 API 生成」：
 *   ① **生成很慢**：火山 GenBGM 实测 1–5 分钟一首，而 nginx `proxy_read_timeout` 只有 480s、
 *      前端 420s / 服务端 390s（既有不变量）—— 现调会吃掉巨量预算；且公共池 QPS≤2 要排队，
 *      延迟**无界**。放进出片链路等于把第三方抖动直接变成出片失败。
 *   ② **音频必须是磁盘上的文件**：`synthesis.ts::mixAudioTracks()` 走 ffmpeg 读文件，
 *      「不保存、每次现取」在物理上不成立。
 *   ③ **「随机」要求候选集合已经存在**：随机是从一个集合里抽，集合不存在就无从随机。
 *   所以：运行时**毫秒级**读本地随机抽一首（`bgm-library.ts::resolveBgmTrack`），
 *   补货时后台慢慢调 API。第三方挂了/额度耗尽只是「池子不再变大」，**不影响出片**。
 *
 * ★★ 每次跑一遍是**幂等**的，策略三条：
 *   ① 池内 > target ⇒ 淘汰最旧的，直到恰好 target（`pruneBgmPool`，连 `.json` 一起清）
 *   ② 池内 < target ⇒ 补到 target，但**单次每个风格最多 `--max` 首**（防手抖烧额度）
 *   ③ 池内 = target ⇒ 什么都不做
 *
 * ── ★★ 第四件事：轮换（`--rotate=N`，默认 **0 = 关**） ──────────────────────
 * 「池子满了」并不等于「用户不会再听到重复」：池子 100 首对**一家门店**来说是 100 个候选，
 * 但它听过的那几首会被一直避开（`bgm-history.ts` 那条「用过的全避」），
 * 于是这家店能再听到的**新鲜曲目只会越来越少**。轮换就是补这个：
 * **每天淘汰几首「已经有人听过的」，用新曲子顶上来**（判据与顺序见 `planBgmRotation`）。
 *
 *   · **只淘汰「被派发过」的曲子**。淘汰一首谁都没用过的曲子是**纯亏**——
 *     没有任何门店因此多听到一首新的；反过来淘汰「听过的」，每一家听过的门店都**净增一首**。
 *   · **都没有用过 ⇒ 本轮不动**（`planBgmRotation` 直接返回空）。新池子刚建好时就是这种状态，
 *     那时轮换只会平白烧钱。**这条是语义要求，不是优化。**
 *   · **先删后补**，顺序不能反：补货取词挑的是「池里没用过的描述」，而**删掉侧车 `.json`
 *     才把那条描述释放回可用池**。反过来做（先补再删）会得到「池内两条曲子撞同一条描述」。
 *     ★ 副作用要知情：新曲子会**复用刚腾出来的那几条描述** ⇒ 曲子是新的、但**曲风与刚删掉的相近**。
 *       要连曲风一起换新，必须**先往 `VOLCANO_BGM_PROMPTS` 加词**
 *       （现在每风格 100 条 = 池内 100 首的硬上限，见 `bgm-library.ts::BGM_POOL_TARGET`）。
 *   · **池内没满时不轮换**：轮换是先删后补，而补货可能因额度耗尽失败 —— 边删边补失败就是**净减**，
 *     连着删几天能把 100 首的池子削没。**满了才动手** ⇒ 只在有余量的位置上操作。
 *   · **冷却期**（`--rotate-cooldown`，默认 6 小时）：最近这么久内被派发过的**不淘汰**。
 *     一次出片是「先记下路径、几十秒后 ffmpeg 才去读它」，正好删到那一条 ⇒ `ENOENT`
 *     ⇒ **那一单出片失败**。取「最久未派发优先」已天然避开刚用的，冷却期是第二道保险。
 *   · 成本：`--rotate=5` × 3 风格 × 0.24 元 ≈ **3.6 元/天**（磁盘**不涨**：删 5 补 5）。
 *     默认 0 ⇒ 不显式要求就不轮换、不花钱。
 *
 * ★ 提示词表**有条数上限**：`--target` 一旦超过表里条数，取词就会绕回起点取到同一批描述，
 *   让**选曲层的候选描述撞车**，而且**不报任何错** ⇒ 脚本会在预检里显性告警（但不阻断）。
 *   ★ 「撞词 ⇒ 生成近乎重复的曲子」**已被实测否掉**（同一 Text 两次生成结果不同，见
 *     `bgm-library.ts::BGM_POOL_TARGET` 的注释）⇒ 这一段防的是**选曲失去区分度**，不是重复曲。
 *
 * ★★ 「额度／开通」类错误 ⇒ **立刻中止整轮**，不再试下一首（见 `VOLCANO_FATAL_ERROR_CODES`）：
 *   这类错误（200023 超 QPS／200028 无资源包／200030 服务未开通 …）**立刻返回**，而循环里
 *   没有任何间隔 ⇒ 继续试只会把该风格剩余的 `--max` 预算在几秒内全烧掉，且**注定一起失败**。
 *   实测（2026-09-28）：一轮 84 次机会被这样烧掉 **70 次**，而前 **14 首连续成功** ——
 *   日志形态是「先连续成功若干首，然后全部失败」。**别把这个形态误判成「并发/发太快」**：
 *   并行确实是另一个错（见下），但形态完全不同。
 *   ★ 区分办法：看错误码。QPS 相关是 200023；而 200030 `ServiceNotActivated` /
 *     200028 `APINoSource` 属于**账号侧没开通或没资源包**，等几秒不会恢复，要去控制台处理。
 *
 * ★ 默认 **dry-run**：只打印会发什么；加 `--yes` 才真调 API。
 *   火山按秒计费（约 0.002 元/秒，120s 一首 ≈ 0.24 元），ChatCut 消耗额度。
 *
 * ★ 生成源（`--source`，默认 volcano；`BGM_SOURCE` 环境变量可覆盖）：
 *   volcano ⇒ 火山 `GenBGMForTime`（豆包音乐 v5.0），需 `VOLCENGINE_ACCESS_KEY` / `VOLCENGINE_SECRET_KEY`
 *   chatcut ⇒ ChatCut `submit_music`（mureka-9），走 MCP 桥，需能连上 ChatCut
 *   两个源都能写池子；具体实现共用 `src/render/bgm-ingest.ts`（与 `bgm:generate` 同一份）。
 *
 * 用法：
 *   npm run bgm:replenish                        # 看池子现状与计划（不发请求）
 *   npm run bgm:replenish -- --yes               # 按缺口补，并把超额部分淘汰
 *   npm run bgm:replenish -- --target=8 --max=3  # 目标 8 首，单次每风格最多补 3 首
 *   npm run bgm:replenish -- --yes --rotate=5    # 轮换：每风格淘汰 5 首「被派发过」的并补回新的
 *   npm run bgm:replenish -- --yes --rotate=5 --rotate-cooldown=12   # 冷却期改成 12 小时
 *   npm run bgm:replenish -- --prune-only        # 只淘汰超额，不生成
 *   npm run bgm:replenish -- --list              # 只看现状
 */
import 'dotenv/config'
import { prisma, redis } from '../src/db.js'
import {
  BGM_POOL_TARGET,
  BGM_STYLES,
  listBgmPool,
  planBgmRotation,
  pruneBgmPool,
  removeBgmTracks,
  usedBgmPromptTexts,
  type BgmRotationPlan,
  type BgmStyle,
  type BgmUsage,
} from '../src/render/bgm-library.js'
import {
  ensureChatcutBgmProject,
  fail,
  ingestChatcutBgm,
  ingestVolcanoBgm,
  type BgmIngestOptions,
} from '../src/render/bgm-ingest.js'
import { describeVolcanoBgmConfig, isVolcanoFatalError, VOLCANO_BGM_PROMPTS } from '../src/render/volcano-bgm.js'

/** 单风格目标曲目数 —— 用库模块的常量（守护靠它判断提示词表条数够不够） */
const DEFAULT_TARGET = BGM_POOL_TARGET
/** 单次每个风格最多生成几首 —— 补货是花钱动作，一次跑太多不容易发现「提示词全打偏」 */
const DEFAULT_MAX_PER_RUN = 2
const DEFAULT_WAIT_SECONDS = 300
/** `--rotate` 的默认值：**0 = 不轮换**。★ 默认必须是关的，否则「改了脚本」本身就会开始花钱。 */
const DEFAULT_ROTATE_PER_RUN = 0
/** `--rotate-cooldown`（小时）：最近这么久内被派发过的曲子不淘汰（防删掉正在出片要读的那一首） */
const DEFAULT_ROTATE_COOLDOWN_HOURS = 6
/**
 * 读「派发记录」时最多扫这么多条任务。
 *
 * ★ 它不是「只保留最近 N 条」的语义，而是**归并窗口**：同一首曲子被派给好几家门店时会占好几行。
 *   窗口比「池内 300 首」大一个量级就够。
 * ★ 落在窗口外的老记录等价于「更久没被派发过」⇒ 只会让那首在淘汰序里**更靠前**；
 *   而**不会**被误判成「没用过」（那种误判才是危险的：白淘汰一首没人听过的曲子）。
 */
const USAGE_SCAN_LIMIT = 5000

const BGM_SOURCES = ['volcano', 'chatcut'] as const
type BgmSource = (typeof BGM_SOURCES)[number]

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
const PRUNE_ONLY = process.argv.includes('--prune-only')

function positiveInt(raw: string | null, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

/** 允许 0（`--rotate=0` 是「关掉轮换」这个**有效**取值，不能用 `positiveInt`） */
function nonNegativeNumber(raw: string | null, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * 读「哪些曲子被派发过、最近一次是什么时候」—— 轮换的判据来源。
 *
 * ★ 数据源就是 `render_task.bgm_track`（出片时写入的那条绝对路径），**不需要新表新列**：
 *   那本来就是「这次出片用了哪一首」的唯一记账处（见 `bgm-history.ts`）。
 * ★ 取最近 `USAGE_SCAN_LIMIT` 条**有配乐记录**的任务，再按路径归并取「最近一次」。
 *   ★ 别只查 `id > 上次跑的位置`：首曲子被派给第二家门店时也会新增一行，
 *     「某首曲子最近一次是什么时候」必须看**全窗口**，只看增量会漏掉最新的那次。
 * ★★ 查库失败**不抛**，返回空数组 ⇒ 上层据此「本轮不轮换」。
 *   轮换是**可选**动作，绝不能因为它把补货（必要动作）一起搞挂。
 */
async function loadBgmUsage(): Promise<BgmUsage[]> {
  try {
    const rows = await prisma.renderTask.findMany({
      where: { bgmTrack: { not: null } },
      orderBy: { id: 'desc' },
      take: USAGE_SCAN_LIMIT,
      select: { bgmTrack: true, createdAt: true },
    })
    const usage: BgmUsage[] = []
    for (const row of rows) {
      const file = typeof row.bgmTrack === 'string' ? row.bgmTrack.trim() : ''
      if (!file) continue
      const usedAt = row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt)
      if (!Number.isFinite(usedAt)) continue
      usage.push({ file, usedAt })
    }
    return usage
  } catch (error) {
    console.warn(`  ⚠ 读取派发记录失败（本轮不做轮换）：${(error as Error)?.message ?? String(error)}`)
    return []
  }
}

async function main(): Promise<void> {
  const requested = (argValue('--style') ?? 'ALL').trim().toUpperCase()
  const styles: BgmStyle[] = requested === 'ALL' ? [...BGM_STYLES] : [requested as BgmStyle]
  for (const style of styles) {
    if (!(BGM_STYLES as readonly string[]).includes(style)) {
      fail(`未知风格 ${style}，可选：${BGM_STYLES.join(' / ')} / ALL`)
    }
  }

  const target = positiveInt(argValue('--target'), DEFAULT_TARGET)
  const maxPerRun = positiveInt(argValue('--max'), DEFAULT_MAX_PER_RUN)
  // ★ 轮换：默认 0（关）。0 是**有效取值**，所以用 nonNegativeNumber 而不是 positiveInt。
  const rotatePerRun = Math.floor(nonNegativeNumber(argValue('--rotate'), DEFAULT_ROTATE_PER_RUN))
  const rotateCooldownHours = nonNegativeNumber(
    argValue('--rotate-cooldown'),
    DEFAULT_ROTATE_COOLDOWN_HOURS,
  )
  const rotateCooldownMs = rotateCooldownHours * 3_600_000
  const source = (argValue('--source') ?? process.env.BGM_SOURCE ?? 'volcano').trim().toLowerCase()
  if (!(BGM_SOURCES as readonly string[]).includes(source)) {
    fail(`未知生成源 ${source}，可选：${BGM_SOURCES.join(' / ')}（也可用 BGM_SOURCE 环境变量指定）`)
  }
  const waitSeconds = positiveInt(argValue('--wait'), DEFAULT_WAIT_SECONDS)

  // ── 现状 ────────────────────────────────────────────────────────────────
  console.log('大帅餐饮配乐池')
  console.log(
    `  生成源：${source}    目标：每风格 ${target} 首    单次每风格最多补：${maxPerRun} 首` +
      (rotatePerRun > 0
        ? `    轮换：每风格最多 ${rotatePerRun} 首（冷却 ${rotateCooldownHours} 小时）`
        : '    轮换：关闭（--rotate=N 开启）'),
  )
  if (!CONFIRMED && !LIST_ONLY) {
    console.log('  （dry-run：只打印计划，不发任何请求；加 --yes 才真调用）')
  }
  for (const style of BGM_STYLES) {
    const size = listBgmPool(style).length
    const gap = target - size
    const note = gap > 0 ? `缺 ${gap} 首` : gap < 0 ? `超额 ${-gap} 首（会淘汰最旧的）` : '正好'
    console.log(`  ${style.padEnd(8)} 池内 ${String(size).padStart(2)} 首    ${note}`)
  }

  if (LIST_ONLY) return

  // ── 容量告警 ────────────────────────────────────────────────────────────
  // ★★ 提示词表是**有上限**的：目标数一旦超过表里条数，取词按序号绕回起点 ⇒ 同一条描述
  //   会对应池里好几首 ⇒ **选曲层失去区分度**（模型看到的候选彼此无法区分），而且**全程不报错**
  //   （本项目最典型的静默失效形态）；曲子本身**不会**重复（同 Text 两次生成结果不同，已实测）。
  // ★ 这里**只告警、不阻断**：描述复用总比没曲子强；但「花了钱却买到没有区分度的候选」这件事
  //   必须让人看见，而且要出现在 dry-run 里 —— 等花完钱才发现就晚了。
  // ★ 只对 volcano 源成立：chatcut 源用的是 `chatcut.ts::BGM_PROMPTS`，与这张表无关。
  if (source === 'volcano') {
    for (const style of styles) {
      const capacity = VOLCANO_BGM_PROMPTS[style].length
      if (target > capacity) {
        console.log(
          `  ⚠ ${style} 目标 ${target} 首 > 提示词 ${capacity} 条 ⇒ 第 ${capacity + 1} 首起会重复使用已有描述。` +
            `要更大的池子，先往 VOLCANO_BGM_PROMPTS.${style} 里加词。`,
        )
      }
    }
  }

  // ── 轮换计划（`--rotate=N`）────────────────────────────────────────────────
  // ★ 计划**在所有风格上先算出来、后执行**（真正删除在下面的逐风格循环里），两个原因：
  //   ① dry-run 必须能看见它 —— 这是花钱动作，先给人看清计划；
  //   ② 下面那句「要不要检查生成凭证」得知道**轮换也会腾出缺口**，否则「池子已满 + 要轮换」
  //      这一档会因为「没有缺口」而跳过凭证检查，一路跑到真生成时才炸。
  // ★ 执行放在循环内、且在中止（`aborted`）时 `break` ⇒ 后面的风格还没被删过。
  //   否则一次额度耗尽会把三个风格同时削掉。
  const rotation = new Map<BgmStyle, BgmRotationPlan>()
  if (rotatePerRun > 0 && !PRUNE_ONLY) {
    const usage = await loadBgmUsage()
    for (const style of styles) {
      const pool = listBgmPool(style)
      const planned = planBgmRotation(pool, usage, {
        limit: rotatePerRun,
        cooldownMs: rotateCooldownMs,
      })
      // ★★ 池内没满 ⇒ 不轮换（`targets` 清空）。理由见文件头：先删后补，补失败了就是净减，
      //   连着几天能把池子削没。满了才动手 ⇒ 只在有余量的位置上操作。
      rotation.set(style, pool.length < target ? { ...planned, targets: [] } : planned)
    }

    console.log('')
    console.log('── 轮换计划（只淘汰「被派发过」的曲子；都没用过就不动）─────────────')
    for (const style of styles) {
      const plan = rotation.get(style)
      const size = listBgmPool(style).length
      if (size < target) {
        console.log(`  ${style.padEnd(8)} 池内 ${size} 首 < 目标 ${target} ⇒ 本轮不轮换（先补满再说）`)
        continue
      }
      console.log(
        `  ${style.padEnd(8)} 池内用过的 ${plan?.used ?? 0} 首` +
          ((plan?.cooled ?? 0) > 0 ? `（其中 ${plan?.cooled} 首最近刚派发过、本轮跳过）` : '') +
          ` ⇒ 淘汰 ${plan?.targets.length ?? 0} 首` +
          ((plan?.used ?? 0) === 0 ? '　← 一首都没被用过，按你的规则不动' : ''),
      )
      for (const file of plan?.targets ?? []) console.log(`      - ${file}`)
      if (plan && (plan.used ?? 0) > 0 && plan.targets.length < plan.used - plan.cooled) {
        console.log(`      （用过的共 ${plan.used} 首，本轮只淘汰最久未派发的 ${plan.targets.length} 首，其余下轮继续）`)
      }
    }
  }

  // ── 前置检查 ────────────────────────────────────────────────────────────
  // ★ 密钥/连通性这类**全局**问题要在循环前一次性挡住：否则会在每个风格上重复报同一句错，
  //   看起来像「三个风格各失败一次」，实际只有一个原因。
  // ★★ 但**惰性**：只有「确实要生成」时才检查。纯淘汰场景（池子超额、或 --prune-only）
  //   跟生成凭证毫无关系，不该因为没配 AK/SK 就跑不动 —— 淘汰本来就该随时能做。
  // ★★ dry-run **不做**这些检查、也**不建项目**：没配密钥的人也必须能先看清计划
  //   （否则「先 dry-run 看看」这一步就被密钥挡住了，等于没法评估要不要做这件事）。
  // ★ 轮换也会腾出缺口（先删 N 首、随后补回）⇒ 必须算进「要不要检查生成凭证」里，
  //   否则「池子已满 + 开轮换」这一档会跳过凭证检查，一路跑到真生成时才炸。
  const needsGeneration =
    !PRUNE_ONLY &&
    styles.some(
      (style) => listBgmPool(style).length < target || (rotation.get(style)?.targets.length ?? 0) > 0,
    )
  let projectId = ''
  if (needsGeneration && CONFIRMED) {
    if (source === 'volcano') {
      const config = describeVolcanoBgmConfig()
      if (!config.configured) {
        fail(
          `未配置火山 AK/SK：缺 ${config.missing.join(' / ')}` +
            `（控制台右上角账号 → 密钥管理 → 新建密钥；建议用子账户的 AK/SK。` +
            `注意这与火山 TTS 的 X-Api-Key 不是同一套凭证）`,
        )
      }
    } else {
      // ChatCut 需要项目上下文；配乐素材不需要画布，用与 `bgm:generate` 同一个曲库项目
      projectId = await ensureChatcutBgmProject(argValue('--project'))
    }
  } else if (needsGeneration && source === 'chatcut') {
    projectId = '<将新建 dashuai-bgm-library>'
  }

  // ★ 池子模式下 `intoPool` 恒为 true —— 本脚本就是为池子存在的
  const ingestOptions: BgmIngestOptions = {
    confirmed: CONFIRMED,
    intoPool: true,
    waitSeconds,
    projectId,
    presetAssetId: null,
  }

  let created = 0
  let removed = 0
  let rotated = 0
  let failed = 0
  let aborted = false
  for (const style of styles) {
    let size = listBgmPool(style).length
    console.log(`\n── ${style} ─────────────────────────────────────────────`)

    // ⓿ 轮换：先把「被派发过」的淘汰掉（计划已在上面算好），随后由 ③ 补回新的。
    //   ★ 一个风格一个风格地来：某个风格因额度耗尽中止（`break`）时，
    //     后面的风格**还没被删过** —— 否则一次中止会同时削掉三个风格。
    const plannedRotation = rotation.get(style)?.targets ?? []
    if (plannedRotation.length > 0) {
      if (!CONFIRMED) {
        console.log(`  · （dry-run）将轮换淘汰 ${plannedRotation.length} 首「被派发过」的曲子，随后补回新的`)
        for (const file of plannedRotation) console.log(`      - ${file}`)
        // ★ 模拟删除，让后面的缺口计算与真跑走**同一条路径**（本脚本一贯的做法）
        size = Math.max(0, size - plannedRotation.length)
      } else {
        const dropped = removeBgmTracks(plannedRotation)
        rotated += dropped.length
        console.log(`  · 轮换：淘汰 ${dropped.length} 首「被派发过」的曲子（下面补回新的）`)
        for (const file of dropped) console.log(`      - ${file}`)
        size = listBgmPool(style).length
      }
    }

    // ① 超额 ⇒ 淘汰最旧的（连 `.json` 元数据一起），且**不再生成**
    if (size > target) {
      if (!CONFIRMED) {
        // ★ dry-run 绝不能真删：只报计划
        console.log(`  · （dry-run）超额 ${size - target} 首，将淘汰最旧的 ${size - target} 首、保留最新 ${target} 首`)
        continue
      }
      const dropped = pruneBgmPool(style, target)
      removed += dropped.length
      console.log(`  · 超额：淘汰 ${dropped.length} 首最旧的，保留最新 ${target} 首`)
      for (const file of dropped) console.log(`      - ${file}`)
      continue
    }

    // ② 正好 ⇒ 不动
    if (size === target) {
      console.log(`  · 正好 ${target} 首，不动`)
      continue
    }

    // ③ 缺口 ⇒ 补 min(缺口, 单次上限)
    // ★ dry-run 走的是**同一条路径**（只是 `confirmed:false` 让 ingest 只打印不发请求），
    //   否则「计划里说 2 首、真跑时因为别的原因变成 1 首」这种分叉会一直存在。
    const todo = Math.min(target - size, maxPerRun)
    if (PRUNE_ONLY) {
      console.log(`  · 缺口 ${target - size} 首，但 --prune-only 只淘汰不生成 ⇒ 跳过`)
      continue
    }
    console.log(`  · 缺口 ${target - size} 首，本次补 ${todo} 首（改 --max 可一次多补）`)

    // ★★ 取词：先挑池里**没用过**的描述，用尽后才按顺序轮转。
    //   只按「池内数量 + 序号」取词是不够的 —— 那个算法隐含假设「已有曲子正好占了 0..n-1 号」，
    //   而手工单发（`bgm:generate`）是随机取词的 ⇒ 池子一旦被随机播种过，顺序取词就会撞上
    //   已经用过的那条描述，**白生成一首「同描述」的曲子**（曲风与已有那首高度相近），
    //   **而且不报任何错**。
    const capacity = VOLCANO_BGM_PROMPTS[style].length
    const usedTexts = source === 'volcano' ? usedBgmPromptTexts(style) : new Set<string>()
    const fresh: number[] = []
    for (let i = 0; i < capacity; i += 1) {
      const prompt = VOLCANO_BGM_PROMPTS[style][i]
      if (prompt && !usedTexts.has(prompt)) fresh.push(i)
    }
    const plan = fresh.slice(0, todo)
    // 未用过的凑不够（表太小 / 池子已经覆盖了全部描述）⇒ 按顺序轮转补齐：
    // 复用描述总比不补强，但必须让人看见「从这一首起，选曲的候选开始撞车了」。
    for (let i = 0; plan.length < todo; i += 1) plan.push(i % capacity)
    if (usedTexts.size > 0) {
      console.log(`  · 池内已用过 ${usedTexts.size} 条描述，本次跳过；可用新描述 ${fresh.length} 条`)
    }
    if (fresh.length < todo) {
      console.log(
        `  ⚠ 未用过的描述只剩 ${fresh.length} 条，其余 ${todo - fresh.length} 首将复用已有描述` +
          `（这些曲子本身不会重复，但选曲层的候选会撞车；要更多可区分的候选，往 VOLCANO_BGM_PROMPTS.${style} 里加词）`,
      )
    }

    for (let index = 0; index < todo; index += 1) {
      try {
        const done =
          source === 'volcano'
            ? await ingestVolcanoBgm(style, { ...ingestOptions, promptIndex: plan[index] })
            : await ingestChatcutBgm(style, ingestOptions)
        if (done) created += 1
        else failed += 0 // dry-run 的 false 不算失败（没生成是预期的）
      } catch (error) {
        const message = (error as Error).message
        // ★★ 额度／开通类错误：**立刻中止整轮**，不要继续试下一首。
        //   原因见 `volcano-bgm.ts::VOLCANO_FATAL_ERROR_CODES` —— 这类错误立刻返回、
        //   循环里没有间隔，会把该风格剩余的整个 `--max` 预算在几秒内全烧掉，
        //   而它们**注定一起失败**（同一个原因重复 N 次）。实测 84 次机会被这样烧掉 70 次。
        if (source === 'volcano' && isVolcanoFatalError(message)) {
          failed += 1
          console.log(`  ✗ ${style} 第 ${index + 1} 首失败：${message}`)
          console.log(
            `\n★★ 命中「额度／开通」类错误 ⇒ **本轮在此中止**（本来还剩 ${todo - index - 1} 次机会）。\n` +
              '   继续试下去不会成功，只会把机会耗光并让日志看起来像「28 个不同的错」。\n' +
              '   处置：去火山控制台确认「音乐生成」服务的**资源包余量与开通状态**\n' +
              '         （200023=超过QPS、200028=没有可用资源包、200030=服务未开通），\n' +
              '         或联系火山商务提高 QPS；恢复后重跑本脚本即可（幂等，只补缺口）。',
          )
          aborted = true
          break
        }
        // 其余（网络抖动、单首生成失败……）才适合「单首失败不中断」：补货是运维动作，跑一次能补几首是几首
        failed += 1
        console.log(`  ✗ ${style} 第 ${index + 1} 首失败：${message}`)
      }
    }
    if (aborted) break
  }

  if (!CONFIRMED) {
    console.log('\n（dry-run 结束：上面只是计划，没有发任何请求、也没有落盘/删除。确认后加 --yes。）')
    return
  }

  console.log(
    `\n完成：新生成 ${created} 首，轮换淘汰 ${rotated} 首，超额淘汰 ${removed} 首，失败 ${failed} 首`,
  )
  if (aborted) {
    console.log(
      '★ 本轮因「额度／开通」类错误**提前中止**：上面的「失败 N 首」不是「试过 N 条不同的坏描述」，\n' +
        '  而是**同一个原因**重复了几次。恢复额度后重跑本脚本即可（幂等，只补缺口）。',
    )
  }
  for (const style of BGM_STYLES) {
    console.log(`  ${style.padEnd(8)} 池内 ${listBgmPool(style).length} 首`)
  }
  if (failed > 0) process.exitCode = 1
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
