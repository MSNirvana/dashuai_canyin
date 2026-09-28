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
 * ★ 提示词表**有条数上限**：`--target` 一旦超过表里条数，取词就会绕回起点取到同一批描述，
 *   池子里长出近乎重复的曲子且**不报任何错** ⇒ 脚本会在预检里显性告警（但不阻断）。
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
 *   npm run bgm:replenish -- --prune-only        # 只淘汰超额，不生成
 *   npm run bgm:replenish -- --list              # 只看现状
 */
import 'dotenv/config'
import { prisma, redis } from '../src/db.js'
import {
  BGM_POOL_TARGET,
  BGM_STYLES,
  listBgmPool,
  pruneBgmPool,
  usedBgmPromptTexts,
  type BgmStyle,
} from '../src/render/bgm-library.js'
import {
  ensureChatcutBgmProject,
  fail,
  ingestChatcutBgm,
  ingestVolcanoBgm,
  type BgmIngestOptions,
} from '../src/render/bgm-ingest.js'
import { describeVolcanoBgmConfig, VOLCANO_BGM_PROMPTS } from '../src/render/volcano-bgm.js'

/** 单风格目标曲目数 —— 用库模块的常量（守护靠它判断提示词表条数够不够） */
const DEFAULT_TARGET = BGM_POOL_TARGET
/** 单次每个风格最多生成几首 —— 补货是花钱动作，一次跑太多不容易发现「提示词全打偏」 */
const DEFAULT_MAX_PER_RUN = 2
const DEFAULT_WAIT_SECONDS = 300

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
  const source = (argValue('--source') ?? process.env.BGM_SOURCE ?? 'volcano').trim().toLowerCase()
  if (!(BGM_SOURCES as readonly string[]).includes(source)) {
    fail(`未知生成源 ${source}，可选：${BGM_SOURCES.join(' / ')}（也可用 BGM_SOURCE 环境变量指定）`)
  }
  const waitSeconds = positiveInt(argValue('--wait'), DEFAULT_WAIT_SECONDS)

  // ── 现状 ────────────────────────────────────────────────────────────────
  console.log('大帅餐饮配乐池')
  console.log(`  生成源：${source}    目标：每风格 ${target} 首    单次每风格最多补：${maxPerRun} 首`)
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
  // ★★ 提示词表是**有上限**的：目标数一旦超过表里条数，取词按序号绕回起点 ⇒ 池子里长出
  //   **近乎重复**的曲子，而且**全程不报任何错**（本项目最典型的静默失效形态）。
  // ★ 这里**只告警、不阻断**：重复的曲子总比没曲子强；但钱花在重复上这件事必须让人看见，
  //   而且要出现在 dry-run 里 —— 等花完钱才发现就晚了。
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

  // ── 前置检查 ────────────────────────────────────────────────────────────
  // ★ 密钥/连通性这类**全局**问题要在循环前一次性挡住：否则会在每个风格上重复报同一句错，
  //   看起来像「三个风格各失败一次」，实际只有一个原因。
  // ★★ 但**惰性**：只有「确实要生成」时才检查。纯淘汰场景（池子超额、或 --prune-only）
  //   跟生成凭证毫无关系，不该因为没配 AK/SK 就跑不动 —— 淘汰本来就该随时能做。
  // ★★ dry-run **不做**这些检查、也**不建项目**：没配密钥的人也必须能先看清计划
  //   （否则「先 dry-run 看看」这一步就被密钥挡住了，等于没法评估要不要做这件事）。
  const needsGeneration =
    !PRUNE_ONLY && styles.some((style) => listBgmPool(style).length < target)
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
  let failed = 0
  for (const style of styles) {
    const size = listBgmPool(style).length

    // ① 超额 ⇒ 淘汰最旧的（连 `.json` 元数据一起），且**不再生成**
    if (size > target) {
      console.log(`\n── ${style} ─────────────────────────────────────────────`)
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
      console.log(`\n── ${style} ─────────────────────────────────────────────`)
      console.log(`  · 正好 ${target} 首，不动`)
      continue
    }

    // ③ 缺口 ⇒ 补 min(缺口, 单次上限)
    // ★ dry-run 走的是**同一条路径**（只是 `confirmed:false` 让 ingest 只打印不发请求），
    //   否则「计划里说 2 首、真跑时因为别的原因变成 1 首」这种分叉会一直存在。
    const todo = Math.min(target - size, maxPerRun)
    console.log(`\n── ${style} ─────────────────────────────────────────────`)
    if (PRUNE_ONLY) {
      console.log(`  · 缺口 ${target - size} 首，但 --prune-only 只淘汰不生成 ⇒ 跳过`)
      continue
    }
    console.log(`  · 缺口 ${target - size} 首，本次补 ${todo} 首（改 --max 可一次多补）`)

    // ★★ 取词：先挑池里**没用过**的描述，用尽后才按顺序轮转。
    //   只按「池内数量 + 序号」取词是不够的 —— 那个算法隐含假设「已有曲子正好占了 0..n-1 号」，
    //   而手工单发（`bgm:generate`）是随机取词的 ⇒ 池子一旦被随机播种过，顺序取词就会撞上
    //   已经用过的那条描述，生成一首近乎重复的曲子，**而且不报任何错**。
    const capacity = VOLCANO_BGM_PROMPTS[style].length
    const usedTexts = source === 'volcano' ? usedBgmPromptTexts(style) : new Set<string>()
    const fresh: number[] = []
    for (let i = 0; i < capacity; i += 1) {
      const prompt = VOLCANO_BGM_PROMPTS[style][i]
      if (prompt && !usedTexts.has(prompt)) fresh.push(i)
    }
    const plan = fresh.slice(0, todo)
    // 未用过的凑不够（表太小 / 池子已经覆盖了全部描述）⇒ 按顺序轮转补齐：
    // 重复的曲子总比不补强，但必须让人看见「这里开始重复了」。
    for (let i = 0; plan.length < todo; i += 1) plan.push(i % capacity)
    if (usedTexts.size > 0) {
      console.log(`  · 池内已用过 ${usedTexts.size} 条描述，本次跳过；可用新描述 ${fresh.length} 条`)
    }
    if (fresh.length < todo) {
      console.log(
        `  ⚠ 未用过的描述只剩 ${fresh.length} 条，其余 ${todo - fresh.length} 首将重复已有描述` +
          `（要更多不重样的曲子，得往 VOLCANO_BGM_PROMPTS.${style} 里加词）`,
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
        // 单首失败不该中断其余风格：补货是运维动作，跑一次能补几首是几首
        failed += 1
        console.log(`  ✗ ${style} 第 ${index + 1} 首失败：${(error as Error).message}`)
      }
    }
  }

  if (!CONFIRMED) {
    console.log('\n（dry-run 结束：上面只是计划，没有发任何请求、也没有落盘/删除。确认后加 --yes。）')
    return
  }

  console.log(`\n完成：新生成 ${created} 首，淘汰 ${removed} 首，失败 ${failed} 首`)
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
