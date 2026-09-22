/**
 * AI 剪辑决策（EDL）生成 —— 让模型来决定「怎么剪」，而不是从固定档位表里取值。
 *
 * ⚠⚠ 本模块的**唯一硬纪律：绝不抛错**。
 *
 *   出片链路里，剪辑决策是一个**增强步骤**，不是必需步骤：它失败的最坏后果应该是
 *   「这条片子按用户选的档位剪」，而**绝不能**是「整单 FAILED、用户白等 4 分钟、还得退积分」。
 *   所以下面每一个失败分支（开关关、没分镜、AI 调用抛错、模型返回的不是 JSON、
 *   JSON 合法但没有一个可用的镜头时长）都**返回 `edl: null` 而不是 throw**，
 *   调用方拿到 null 就完全按原档位走 —— 那条路径是早就跑通的。
 *
 * ★ 为什么 requestId 只用 taskId 而不能带时间戳/随机数：
 *   同一任务的素材与台词是**固定**的，剪辑决策自然也该固定。用确定性 requestId 的收益是
 *   ① worker 崩溃重跑（MAX_RESUME=3）时命中幂等去重，**不会重复扣用户的积分**；
 *   ② 重跑拿到的还是同一份决策 ⇒ 用户看到的仍是「同一版片子」，不会因为重跑换了剪法。
 *   带随机数会让这两个收益同时消失。
 *
 * ★ 为什么不在这里做「不超素材时长」的夹取：那需要每段素材**探到的真实时长**，
 *   而它只有驱动层在探测之后才知道（本模块拿到的 `assetMs` 是驱动层探测后回填的，
 *   但转场余量还要按最终档位再算一次）。真正的严夹在
 *   `chatcut-timing.ts::planShotTiming` —— 见那里的 `edlShotMs` 分支。这里只做粗夹。
 */
import { prisma } from '../db.js'
import { aiGateway } from '../ai/gateway-instance.js'
import { runBilledScene } from '../ai/ai.service.js'
import { SCENE } from '../ai/scene-codes.js'
import { parseEdl, type Edl, type EdlDefaults } from './edl.js'

/**
 * 运维开关。**默认开**（这是 AI 档的核心卖点），显式写 `CHATCUT_EDL_ENABLED=false` 才关。
 *
 * ★ 为什么默认是「开」而不是「关」：关掉时用户看到的现象是「AI 档又变回模板套片」，
 *   而这与「开关忘了配」在界面上**完全无法区分**。默认开 ⇒ 想让功能生效不需要额外动作，
 *   出问题时一键 `=false` 即可退回（退回路径就是原来那条久经考验的档位路径）。
 */
export function editPlanEnabled(): boolean {
  return process.env.CHATCUT_EDL_ENABLED?.trim().toLowerCase() !== 'false'
}

export interface EditPlanShotInput {
  /** 该镜头的口播台词；空 = 这段只有画面 */
  line: string | null
  /** 驱动层探到的素材**真实**时长（ms）；null = 探测失败 */
  assetMs: number | null
  /** 客户端上报的分镜时长（ms），只在探测失败时当参考 */
  durationMs: number | null
}

export interface EditPlanRequest {
  /**
   * 商户编号。★ 接受 `string`：驱动层的 `ChatCutJobInput.merchantId` 是**序列化过的字符串**
   * （见 `worker.ts` 的 `task.merchantId.toString()`），而计费层 `BilledSceneParams` 要 `bigint`。
   * 转换**必须由本模块自己做** —— 「绝不抛错」是这里的契约；若把 `BigInt()` 留在驱动层，
   * 一旦转换失败就是启动阶段抛错 ⇒ 整单 FAILED，正好违背本模块存在的理由。
   */
  merchantId: string | bigint
  /** 渲染任务 id（决定 requestId，必须稳定） */
  taskId: string | number | bigint
  shots: readonly EditPlanShotInput[]
  /** 用户在面板上选的档位 —— 既是给模型的「倾向」，也是解析失败时的兜底值 */
  prefer: EdlDefaults
  /** 用户填的备注（可在面板里写「这次想要快节奏」之类） */
  note?: string
}

export interface EditPlanOutcome {
  /** null = 按面板档位剪（调用方直接走原路径） */
  edl: Edl | null
  /** 模型给的哪几处不合法，只用于日志 */
  problems: string[]
  /** 给进度/日志看的一句话；成功与失败都会给 */
  notice: string | null
  /** 本次决策调用实际扣掉的积分（0 = 没调或走了兜底模板） */
  beanCharged: bigint
}

/**
 * 逐镜头信息拼成一段文本喂给模型。
 *
 * ★ 为什么明说「素材 X.Xs」而不是只给台词：模型必须知道**每段有多长**才排得出节奏 ——
 *   一个 2 秒的镜头和一个 9 秒的镜头，该留多长的判断完全不同。
 * ★ 为什么给的是**素材总时长**而不是「扣掉转场余量的可用时长」：后者要按最终转场档位再算一次，
 *   而转场档位此刻**还在等模型决定**（循环依赖）。所以给总时长，并在提示词里明确要求
 *   「留出余量」；真正的越界由 `planShotTiming` 夹掉。
 */
function buildShotPlanText(shots: readonly EditPlanShotInput[]): string {
  return shots
    .map((shot, index) => {
      const assetSec =
        shot.assetMs && shot.assetMs > 0
          ? `${(shot.assetMs / 1000).toFixed(1)}`
          : shot.durationMs && shot.durationMs > 0
            ? `约 ${(shot.durationMs / 1000).toFixed(1)}（客户端上报，未探到真实值）`
            : '未知'
      const line = shot.line?.trim() || '（这段没有台词，只有画面）'
      return `镜头 ${index + 1}｜素材 ${assetSec}s｜台词：${line}`
    })
    .join('\n')
}

/** 用户在面板上的选择 —— 作为「倾向」交给模型，而不是硬约束 */
function buildPreferText(prefer: EdlDefaults): string {
  return [
    `节奏 ${prefer.pacing}`,
    `转场 ${prefer.transitions}`,
    `字幕样式 ${prefer.subtitleStyle}`,
    `配乐 ${prefer.bgm}`,
  ].join('、')
}

/** 成功时给日志看的一句话：把决策摘要成一行，便于和成片对照 */
function describeEdl(edl: Edl, total: number): string {
  const secs = edl.shots.map((s) => (Math.round(s.targetMs / 100) / 10).toFixed(1)).join('/')
  return (
    `AI 剪辑决策：节奏 ${edl.pacing}、转场 ${edl.transitions}、` +
    `字幕 ${edl.subtitleStyle}、配乐 ${edl.bgm}；` +
    `${edl.shots.length}/${total} 个镜头自定义时长（${secs}s）`
  )
}

/**
 * 生成剪辑决策。**永不抛错** —— 任何失败都退化成 `edl: null`。
 */
export async function generateEditPlan(input: EditPlanRequest): Promise<EditPlanOutcome> {
  const fallback = (notice: string): EditPlanOutcome => ({
    edl: null,
    problems: [],
    notice,
    beanCharged: 0n,
  })

  if (!editPlanEnabled()) return fallback('剪辑决策已关闭（CHATCUT_EDL_ENABLED=false）⇒ 按面板档位剪')
  if (input.shots.length === 0) return fallback('没有分镜 ⇒ 按面板档位剪')

  try {
    /**
     * ★ 转换放在 `try` **内**：非法编号会在这里抛出、被下面的 catch 接住 ⇒ 退化成
     *   「按面板档位剪」，而不是在启动阶段抛错把整单打成 FAILED。
     * ★ 不能用 `Number()`：商户 id 是 bigint，超过 2^53 会**静默丢精度**、扣错账户。
     */
    const merchantId = typeof input.merchantId === 'bigint' ? input.merchantId : BigInt(input.merchantId)
    const r = await runBilledScene(prisma, aiGateway, {
      sceneCode: SCENE.edit_plan,
      merchantId,
      requestId: `edl-${String(input.taskId)}`,
      variables: {
        shotPlanInput: buildShotPlanText(input.shots),
        copyText: input.shots
          .map((s) => s.line?.trim())
          .filter((v): v is string => Boolean(v))
          .join('\n'),
        preferPlan: buildPreferText(input.prefer),
        note: input.note?.trim() || '（无）',
      },
      bizId: String(input.taskId),
    })

    // 兜底模板 = 场景没配好/通道全挂，网关返回了一段预置文本 —— 那**不是**剪辑决策，
    // 拿去 parse 只会得到一堆 problem，还不如直接说清。
    if (r.isFallbackTemplate) {
      return { edl: null, problems: [], notice: '剪辑决策走了兜底模板 ⇒ 按面板档位剪', beanCharged: r.beanCharged }
    }

    const parsed = parseEdl(r.text, input.prefer)
    if (!parsed.edl) {
      return {
        edl: null,
        problems: parsed.problems,
        notice: `剪辑决策不可用（${parsed.problems[0] ?? '未知原因'}）⇒ 按面板档位剪`,
        beanCharged: r.beanCharged,
      }
    }

    const notice = describeEdl(parsed.edl, input.shots.length)
    if (parsed.problems.length > 0) {
      // ★ 部分字段非法不算失败：合法的那部分照用。但要留下痕迹，否则「模型总把转场写错」
      //   这件事会一直没人发现（它只是安静地退回用户档位）。
      return {
        edl: parsed.edl,
        problems: parsed.problems,
        notice: `${notice}（有 ${parsed.problems.length} 处被修正：${parsed.problems.join('；')}）`,
        beanCharged: r.beanCharged,
      }
    }
    return { edl: parsed.edl, problems: [], notice, beanCharged: r.beanCharged }
  } catch (e) {
    // ★ 这里 catch 的是 runBilledScene 的一切失败：场景没建/被停用、候选链全灭、
    //   超时、熔断、积分不足…… 全部退化成「按面板档位剪」。
    const msg = (e as Error)?.message ?? String(e)
    return {
      edl: null,
      problems: [],
      notice: `剪辑决策调用失败（${msg.slice(0, 80)}）⇒ 按面板档位剪`,
      beanCharged: 0n,
    }
  }
}
