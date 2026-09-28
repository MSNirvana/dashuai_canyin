/**
 * 配乐选曲 —— 让模型**按这条片子的口播内容**，从本地曲库里挑一首最贴的。
 *
 * ⚠⚠ 本模块与 `edit-plan.service.ts` 同一条硬纪律：**绝不抛错**。
 *
 *   配乐选曲是出片链路里的**增强步骤**，不是必需步骤。它失败的最坏后果应该是
 *   「按老规矩随机抽一首」（那条路径早就跑通了），而**绝不能**是「整单 FAILED」。
 *   所以下面每一个失败分支（开关关、候选不够、没有台词、AI 调用抛错、走了兜底模板、
 *   模型返回的下标越界）都返回 `file: null` 而不是 throw。
 *
 * ── 为什么是「从本地池子里挑」而不是「让模型写一段描述再去生成」 ──────────────
 * `bgm_select` 这个场景**原本的设计**是输出一段曲风描述（mood/tags/tempo），
 * 那就意味着「渲染时按需生成一首」—— 而生成一首要 1~5 分钟，且公共池 QPS≤2 会排队，
 * nginx 只给 480s、前端 420s / 服务端 390s。这正是「池子 + 后台补货」架构要避开的坑
 * （见 `bgm-replenish.ts` 头部）。所以这里**改了它的用途**：
 * 候选集合是**已经躺在磁盘上的**几首曲子，模型只做「选哪一首」，一次调用几百 token、几秒返回，
 * 而且**无论选成什么都一定有一个可用的文件**。
 *
 * ── 为什么风格仍由档位决定，模型只在**这个风格内部**挑 ──────────────────────
 * 风格早就由素材画像/用户档位定下来了（`auto-edit.ts::resolveAutoChatcutOptions` 给出
 * LIGHT/UPBEAT/PREMIUM）。让模型跨风格重选会**盖掉用户的面板选择**（ADVANCED 档里
 * 用户是显式点了某一档的）；而同一风格内的几首曲子本来就有快慢、器乐、情绪的差别，
 * 「按口播内容挑最贴的一首」在这个范围内是有意义的、也不会推翻任何既有约定。
 *
 * ★ 为什么 `requestId` 只用 taskId、不带时间戳/随机数：与 `edit_plan` 同一个理由 ——
 *   worker 崩溃重跑（MAX_RESUME=3）时命中幂等去重，**不会重复扣用户的积分**。
 */
import { prisma } from '../db.js'
import { aiGateway } from '../ai/gateway-instance.js'
import { runBilledScene } from '../ai/ai.service.js'
import { SCENE } from '../ai/scene-codes.js'
import { buildBgmOptionText, parseBgmChoice } from './bgm-choice.js'
import { describeBgmCandidates } from './bgm-library.js'

/**
 * 运维开关。**默认开**（理由与 `CHATCUT_EDL_ENABLED` 完全一致）：
 * 关掉时用户在界面上看到的现象与「开关忘了配」**无法区分**，所以默认开、出问题一键 `=false`。
 */
export function bgmSelectEnabled(): boolean {
  return process.env.BGM_SELECT_ENABLED?.trim().toLowerCase() !== 'false'
}

export interface BgmSelectInput {
  merchantId: bigint
  /** 渲染任务 id（决定 requestId，必须稳定） */
  taskId: string | number | bigint
  /** 已定下来的风格（LIGHT / UPBEAT / PREMIUM）—— 只在这个风格的池子里挑 */
  style: string
  /** 这条片子的口播文案（逐镜头拼起来）。空 = 没有可判断的内容 */
  copyText: string
  /**
   * 该门店最近用过的曲子（绝对路径，见 `bgm-history.ts`）—— 从候选里**排除**掉。
   *
   * ★ 排除**必须发生在喂给模型之前**，而不是拿到模型的下标之后再过滤：模型返回的是
   *   **下标**，而下标与候选清单一一对应。先按同一份清单算下标、再拿被过滤过的清单去取，
   *   就会取到**另一首**（而且不报错）—— 那正是 `bgm-library.ts::describeBgmCandidates`
   *   注释里警告过的「顺序 = 契约」。
   */
  exclude?: readonly string[]
}

export interface BgmSelectOutcome {
  /** 选中的曲子绝对路径；`null` = 没选出来 ⇒ 调用方退回随机抽取 */
  file: string | null
  /** 给日志看的一句话；成功与失败都会给 */
  notice: string
  /** 本次选曲实际扣掉的积分（0 = 没调或没选出可用的） */
  beanCharged: bigint
}

/**
 * 至少要有这么多首**带描述**的候选，才值得花一次 AI 调用去比。
 *
 * ★ 少于它就别调：模型看不到音频，判断依据只有侧车里的生成描述。只有一首有描述时，
 *   「选出一首」的结果是被描述绑定的，等于白花钱；一首都没有时更是只能瞎猜。
 * ★ 手放的曲子没有侧车 ⇒ 不参与比选；但这**不影响它被随机抽到**（渲染那条路径不看描述）。
 */
const MIN_DESCRIBED_CANDIDATES = 2

/**
 * 按内容从池子里挑一首。**永不抛错** —— 任何失败都退化成 `file: null`。
 */
export async function selectBgmFromPool(input: BgmSelectInput): Promise<BgmSelectOutcome> {
  const skip = (notice: string): BgmSelectOutcome => ({ file: null, notice, beanCharged: 0n })

  if (!bgmSelectEnabled()) return skip('配乐选曲已关闭（BGM_SELECT_ENABLED=false）⇒ 随机抽一首')

  // ★ 没有台词就没有「内容」可依据。此时连调用都不该发：模型拿不到任何与这条片子相关的信息，
  //   它只能凭候选项自己编一个理由 —— 那是花钱买一个假决策，还不如就用画像定的风格。
  const copyText = input.copyText.trim()
  if (!copyText) return skip('这条片子没有口播台词 ⇒ 没有内容依据，随机抽一首')

  const allCandidates = describeBgmCandidates(input.style)
  // ★ 「避开该门店最近用过的」——**在喂给模型之前**就把它们剔掉（理由见 `exclude` 的注释）。
  // ★ 全被剔空（池子很小 / 该门店已把池子用遍）时退回全池：宁可重样，也不能没有候选可比。
  const blocked = new Set((input.exclude ?? []).filter(Boolean))
  const remaining = blocked.size > 0 ? allCandidates.filter((candidate) => !blocked.has(candidate.file)) : allCandidates
  const candidates = remaining.length > 0 ? remaining : allCandidates
  if (candidates.length <= 1) {
    return skip(`风格 ${input.style} 的池内只有 ${candidates.length} 首可挑 ⇒ 无从选，随机抽一首`)
  }
  const describedCount = candidates.filter((candidate) => candidate.note).length
  if (describedCount < MIN_DESCRIBED_CANDIDATES) {
    return skip(
      `风格 ${input.style} 的池内带描述的候选只有 ${describedCount} 首（需要 ≥${MIN_DESCRIBED_CANDIDATES} 才能比选）⇒ 随机抽一首`,
    )
  }

  try {
    const r = await runBilledScene(prisma, aiGateway, {
      sceneCode: SCENE.bgm_select,
      merchantId: input.merchantId,
      requestId: `bgm-${String(input.taskId)}`,
      variables: {
        copyText,
        bgmOptions: buildBgmOptionText(candidates),
      },
      bizId: String(input.taskId),
    })

    // 兜底模板 = 场景没配好 / 通道全挂。那段预置文本里有个 `index`，但它**不是**一个决策，
    // 拿去用等于「每次都选第一首」——必须显式挡掉（与 edit_plan 同一处坑）。
    if (r.isFallbackTemplate) {
      return { file: null, notice: '配乐选曲走了兜底模板 ⇒ 随机抽一首', beanCharged: r.beanCharged }
    }

    const choice = parseBgmChoice(r.text, candidates.length)
    if (!choice) {
      return { file: null, notice: '配乐选曲返回的下标不可用 ⇒ 随机抽一首', beanCharged: r.beanCharged }
    }

    const picked = candidates[choice.index]
    if (!picked) {
      // 理论上不可达（parseBgmChoice 已经按 count 夹过范围）；留着是因为「取不到却继续用」
      // 会变成 undefined 一路传到 ffmpeg，报一个与配乐毫无关系的错。
      return { file: null, notice: '配乐选曲的下标取不到对应曲子 ⇒ 随机抽一首', beanCharged: r.beanCharged }
    }

    const reason = choice.reason ? `（${choice.reason}）` : ''
    return {
      file: picked.file,
      notice: `配乐选曲：从 ${candidates.length} 首里选中第 ${choice.index} 首${reason}`,
      beanCharged: r.beanCharged,
    }
  } catch (e) {
    // ★ 这里 catch 的是 runBilledScene 的一切失败：场景没建/被停用、候选链全灭、超时、
    //   熔断、**积分不足**…… 全部退化成「随机抽一首」。
    //   注意「积分不足」是**很可能发生**的（新用户注册赠积分有限），它必须是一条正常分支。
    // ★ 把换行压成空格再截断：Prisma 的错误串是多行的（里面还嵌着源码片段），
    //   直接塞进日志会把「一行 = 一次调用」的约定打散，之后 grep 一行根本读不出因果。
    const msg = ((e as Error)?.message ?? String(e)).replace(/\s+/g, ' ').trim()
    return skip(`配乐选曲调用失败（${msg.slice(0, 80)}）⇒ 随机抽一首`)
  }
}
