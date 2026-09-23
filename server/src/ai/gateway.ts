// AI 网关：场景化调用 + 故障转移 + 熔断 + 成本核算
// 业务层只传 sceneCode，永不直接引用具体模型

import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'
import { AiCallError, getAdapter, openaiImage, type AiUsage } from './adapters.js'
import { CircuitBreaker, DEFAULT_CIRCUIT } from './circuit-breaker.js'
import { decryptSecret } from '../lib/secret.js'
import { ceilDiv } from '../lib/decimal.js'
import { HEALTH_PROBE_PROMPT, HEALTH_PROBE_IMAGE_PROMPT, HEALTH_PROBE_MAX_OUTPUT_TOKENS } from './health-probe.js'
import { normalizeModelCapability } from './model-capabilities.js'
import { LOW_REASONING_SCENES } from './scene-codes.js'

export type SceneRunResult =
  | {
      ok: true
      text: string
      usage: AiUsage
      costFen: number
      providerId: bigint
      modelId: bigint
      modelCode: string
      usedFallback: boolean
      attempts: number
      /**
       * 「这次调用的价格不由 token 决定，就是场景标价」。
       *
       * ★ 只有图像场景会带上它（见候选循环里的 kind==='IMAGE' 分支）。原因：出图返回里
       *   **没有 token 用量**（实测 usage=null），按 token 结算会把一整张封面算成 0 积分，
       *   而平台是真的付了钱的。所以图像场景的 `ai_scene.bean_price` 语义是**报价本身**，
       *   不是「单次上限」。由这里显式传给账务层，免得结算函数再去猜「什么时候按固定价」。
       */
      fixedBeans?: bigint
    }
  | {
      ok: false
      reason: 'SCENE_DISABLED' | 'NO_CANDIDATE' | 'ALL_FAILED'
      message: string
      attempts: number
    }

export interface RunSceneParams {
  sceneCode: string
  variables: Record<string, string>
  merchantId?: bigint
  requestId: string
}

/** 模板变量替换：{{key}} */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '')
}

/**
 * 成本（分）= ceil(输入 tokens × 输入分/百万 / 1e6) + ceil(输出 tokens × 输出分/百万 / 1e6)
 *
 * 用 BigInt 做除法再取整。价格字段在库里是 UnsignedInt，tokens 也是整数，
 * 所以当前实现其实是精确的；改 BigInt 是为了防止后续把 tokens 换成估算小数、
 * 或把价格改成小数字段时，`Math.ceil(浮点除法)` 出现「整数边界被舍入到略大 → 多扣 1 分」。
 */
export function computeCostFen(
  promptTokens: number,
  completionTokens: number,
  inputPricePerMtok: number,
  outputPricePerMtok: number,
): number {
  const per = 1_000_000n
  const fen =
    ceilDiv(safeNonNegInt(promptTokens) * safeNonNegInt(inputPricePerMtok), per) +
    ceilDiv(safeNonNegInt(completionTokens) * safeNonNegInt(outputPricePerMtok), per)
  const n = Number(fen)
  if (!Number.isSafeInteger(n)) throw new RangeError(`computeCostFen: 结果溢出 ${fen}`)
  return n
}

/** 把任意入参归一为非负安全整数：NaN / Infinity / 负数 / 小数一律按语义安全处理，绝不抛错 */
function safeNonNegInt(v: number): bigint {
  if (!Number.isFinite(v)) return 0n
  const t = Math.trunc(v)
  if (!Number.isSafeInteger(t) || t <= 0) return 0n
  return BigInt(t)
}

/**
 * 是否属于「通道级」故障 —— 即「换到备用通道才可能成功」的错误。
 *
 * 用于让网关**立即熔断**该通道，而不是干等 record() 的失败率熔断：
 * 后者要求滑动窗口内至少 minSamples(20) 个样本，低频场景几小时都攒不满，
 * 于是每次请求都要先在这个坏通道上耗掉一次超时（ai_scene.timeout_ms 默认 30s）
 * 才轮到备用 —— 「自动切换」名义上有、体验上没有。
 *
 * · TIMEOUT / NETWORK —— 连不上、超时
 * · HTTP 401 / 403    —— 密钥无效或无权
 * · HTTP 429          —— 限流
 * · HTTP 5xx          —— 对端故障
 *
 * 反例：BAD_RESPONSE（报文偶发异常）与其余 4xx（多半是请求本身的问题）——
 * 重试同一通道仍有成功可能，不该熔断。
 */
export function isChannelLevelFailure(err: AiCallError): boolean {
  if (err.code === 'TIMEOUT' || err.code === 'NETWORK') return true
  const s = err.status
  return s === 401 || s === 403 || s === 429 || (typeof s === 'number' && s >= 500)
}

export class AiGateway {
  constructor(
    private prisma: PrismaClient,
    private redis: Redis,
    private circuit: CircuitBreaker,
  ) {}

  async runScene(params: RunSceneParams): Promise<SceneRunResult> {
    const scene = await this.prisma.aiScene.findUnique({ where: { code: params.sceneCode } })
    if (!scene || !scene.enabled) {
      return { ok: false, reason: 'SCENE_DISABLED', message: `scene ${params.sceneCode} disabled`, attempts: 0 }
    }

    const fallbackIds = (Array.isArray(scene.fallbackModelIds) ? (scene.fallbackModelIds as unknown[]) : [])
      .map((v) => BigInt(v as number))
    const candidates = [scene.defaultModelId, ...fallbackIds]

    const prompt = renderTemplate(scene.promptTemplate, params.variables)
    let attempts = 0
    let lastError = ''
    /**
     * 「这条候选为什么没被用」。
     *
     * ★ 全部候选都被跳过时（enabled=false / 熔断 / 超预算 / 能力不匹配），
     *   旧实现只会回一句 `no available provider` —— 运营在后台看到的是一句无法行动的话，
     *   而这恰恰是最常见的配置类故障。这里把原因收集起来一并返回（见下面的 ALL_FAILED）。
     */
    const skipped: string[] = []

    for (let i = 0; i < candidates.length; i++) {
      const modelId = candidates[i]!
      const model = await this.prisma.aiModel.findUnique({
        where: { id: modelId },
        include: { provider: true },
      })
      if (!model || !model.enabled) {
        skipped.push(`候选模型 id=${modelId} ${model ? '在模型页被停用' : '不存在（可能已被删除）'}`)
        continue
      }

      const provider = model.provider
      // ★ 这几个 `continue` 都是**静默跳过**：用户看不到「第 2 条候选被跳过了」，
      //   只能感知到总耗时变长（前端超时 = 候选数 × 单候选超时 × (maxRetries+1)）。
      //   `!provider.enabled` 这一条是 30 分钟健康体检（ai-health.service.ts）自动停用的
      //   落点：被停用的通道在**请求路径**上从此刻起不再被调用（这正是我们要的），
      //   但也意味着**它再也不会被请求路径探到** —— 所以体检必须自己按
      //   `enabled = 1 OR auto_disabled = 1` 扫，而不是只看 enabled。
      //   ⚠ 若以后有人给体检加上「重排候选链 / 按可用性前置过滤」，务必把这里的
      //   `!provider.enabled` 判断提到上面 `findUnique` **之前**做前置过滤；
      //   留在原地的话，一条 2 候选的链会变成「实际只跑 1 条」，而前端仍按 2 条算超时。
      // ★ 这三个 continue 全都**必须**记进 skipped —— 它们原来是无条件静默跳过，
      //   于是「候选全被跳掉」时最终错误只剩一句 `no available provider`（见文件尾 ALL_FAILED）。
      //   2026-09-21 生产事故就是这么被藏住的：出图通道被健康体检自动停用（enabled=false /
      //   healthStatus=DOWN），`publish_cover` 的唯一候选被这里静默跳过，用户看到
      //   「封面生成失败」，而真正的原因（通道被停用、谁停的、怎么恢复）一个字都没留下。
      if (!provider.enabled || provider.healthStatus === 'DOWN') {
        skipped.push(
          `候选通道 ${provider.code} 当前不可用（enabled=${provider.enabled}，healthStatus=${provider.healthStatus}` +
            `${provider.autoDisabled ? '；由健康体检自动停用，可跑一次体检或后台「立即体检」恢复' : ''}）`,
        )
        continue
      }
      if (await this.circuit.isOpen(provider.id)) {
        skipped.push(`候选通道 ${provider.code} 处于熔断中（短时故障，稍后自动恢复）`)
        continue
      }
      if (
        provider.monthlyBudgetFen !== null &&
        provider.usedBudgetFen >= provider.monthlyBudgetFen
      ) {
        skipped.push(
          `候选通道 ${provider.code} 已用完月度预算（已用 ${provider.usedBudgetFen} ≥ 上限 ${provider.monthlyBudgetFen} 分）`,
        )
        continue
      }

      /**
       * 能力匹配：图像场景的候选**必须**是 capability='IMAGE' 的模型，文本场景反过来排除它。
       *
       * ★ 这条存在的唯一理由，是「配错」在这里是**静默**的：
       *   后台「AI 场景」页的模型下拉不按 capability 过滤，运营完全可能把 gpt-5.5 填进出图场景。
       *   没有这条判断时，网关会照常调 chat/completions、拿回一段文字，
       *   然后被当成图片地址交给下游去下载 —— 报错在很远的地方出现，而积分已经扣了。
       *   有了它，配错会在**调用前**就跳过，并把原因带进最终错误消息（见下面的 skipped）。
       */
      const wantImage = scene.kind === 'IMAGE'
      if (wantImage && model.capability !== 'IMAGE') {
        skipped.push(`候选模型 ${model.modelCode} 的能力是 ${model.capability}（图像场景需要 IMAGE）`)
        continue
      }
      if (!wantImage && model.capability === 'IMAGE') {
        skipped.push(`候选模型 ${model.modelCode} 是图像模型，不能用于文本场景 ${scene.code}`)
        continue
      }

      // MOCK 协议只实现 chat（用于无网络联调），出图没有 mock —— 明确跳过而不是发一个假请求
      if (wantImage && provider.protocol === 'MOCK') {
        skipped.push(`候选通道 ${provider.code} 是 MOCK 协议，不支持图像生成`)
        continue
      }

      const adapter = wantImage ? openaiImage : getAdapter(provider.protocol)
      const maxTry = scene.maxRetries + 1

      for (let t = 0; t < maxTry; t++) {
        attempts++
        const startedAt = Date.now()
        try {
          const res = await adapter({
            baseUrl: provider.baseUrl,
            apiKey: decryptSecret(provider.apiKeyEncrypted),
            model: model.modelCode,
            user: prompt,
            temperature: scene.temperature ? Number(scene.temperature) : undefined,
            maxOutputTokens: scene.maxOutputTokens ?? undefined,
            // ★ 低推理预算场景（五个文案款）显式压掉思考——不压的话推理模型会在
            //   80~190 字的稿子上花掉几千个思考 token，把 30s 场景超时全耗光。
            //   清单与实测依据见 ai/scene-codes.ts 的 LOW_REASONING_SCENES。
            reasoningEffort: LOW_REASONING_SCENES.has(scene.code) ? 'low' : undefined,
            timeoutMs: scene.timeoutMs,
            sceneCode: scene.code,
          })

          const costFen = computeCostFen(
            res.usage.promptTokens,
            res.usage.completionTokens,
            model.inputPricePerMtok,
            model.outputPricePerMtok,
          )
          const latencyMs = Date.now() - startedAt

          await this.circuit.record(provider.id, true)
          await this.prisma.$transaction([
            this.prisma.aiProvider.update({
              where: { id: provider.id },
              data: {
                usedBudgetFen: { increment: costFen },
                healthStatus: 'HEALTHY',
                // ★ 成功即清零「连续失败」——「连续」这个词的唯一正确读法：
                //   通道自己把活干完了，就说明它现在没有在坏。
                consecutiveFailures: 0,
                // 熔断标记的**数据库镜像**（写侧见 noteChannelFailure）：
                //   能干活就顺手清掉，否则后台会一直挂着一个早该过期的熔断时间。
                circuitOpenUntil: null,
              },
            }),
            this.prisma.aiCallLog.create({
              data: {
                merchantId: params.merchantId,
                sceneCode: params.sceneCode,
                requestId: params.requestId,
                providerId: provider.id,
                modelId: model.id,
                isFallback: i > 0,
                fallbackFromModelId: i > 0 ? scene.defaultModelId : null,
                promptTokens: res.usage.promptTokens,
                completionTokens: res.usage.completionTokens,
                totalTokens: res.usage.promptTokens + res.usage.completionTokens,
                costFen,
                latencyMs,
                status: i > 0 ? 'FALLBACK_USED' : 'SUCCESS',
                promptSnapshot: prompt.slice(0, 8000),
                responseSnapshot: res.text.slice(0, 8000),
              },
            }),
          ])

          return {
            ok: true,
            text: res.text,
            usage: res.usage,
            costFen,
            providerId: provider.id,
            modelId: model.id,
            modelCode: model.modelCode,
            usedFallback: i > 0,
            attempts,
            // 图像场景：本次调用的价格就是场景标价（出图无 token 用量，按 token 结算会算成 0）
            ...(wantImage ? { fixedBeans: scene.beanPrice } : {}),
          }
        } catch (e) {
          const err = e as AiCallError
          lastError = `[${provider.code}/${model.modelCode}] ${err.message}`

          // 通道级硬故障：立即熔断该通道，并**放弃它剩余的重试**，直接换下一个候选。
          // 不能只依赖 record() 的失败率熔断（需 ≥20 样本，低频场景攒不满），
          // 更不能在这里重试 —— 否则主通道挂掉时，每个请求要连等 maxRetries+1 次超时。
          if (isChannelLevelFailure(err)) {
            await this.circuit.open(provider.id)
            await this.circuit.record(provider.id, false)
            // ★ Redis 的熔断只有 5 分钟记忆，必须同时落一份**持久**证据，
            //   否则「这个通道在连续干不了活」这件事出了这个进程就没人知道。
            await this.noteChannelFailure(provider.id, err)
            break
          }

          await this.circuit.record(provider.id, false)
          if (t < maxTry - 1) await sleep(200 * (t + 1))
        }
      }
    }

    return {
      ok: false,
      reason: 'ALL_FAILED',
      // 一个候选都没真正跑过时（attempts===0），lastError 是空的 ——
      // 这时把「每条候选为什么被跳过」拼进消息，否则后台只能看到
      // 一句 `no available provider`，那是无法行动的（不知道是没配通道、
      // 被熔断、超预算，还是模型能力配错了）。实测最有价值的就是最后这一种。
      message:
        lastError ||
        (skipped.length > 0
          ? `没有可用的候选通道：${skipped.join('；')}`
          : 'no available provider'),
      attempts,
    }
  }

  /**
   * 把一次「通道级硬故障」记到通道行上 —— Redis 熔断之外的**持久**证据。
   *
   * ★ 为什么不能只依赖 `CircuitBreaker`：那个标记只活在 Redis 里且带 `EX 300`，
   *   5 分钟后自动遗忘。而本项目的 AI 调用是**低频**的（几分钟才几次），
   *   于是「这个通道刚刚坏掉」这件事在下一次请求到来前就已经不存在了 ——
   *   每个请求都要重新白等一次完整超时。
   *   2026-09-23 实测：deepseek 在 `storyboard_generate` 上思考跑飞 108~147 秒，
   *   越过 150s 场景超时才降级到 claude（41s）⇒ 用户实等 **191 秒**；
   *   而健康体检全程把它判成 HEALTHY（因为它在别的场景成功过），从来不会降级它。
   *
   * ★ 判据与熔断器**严格一致**：只统计 `isChannelLevelFailure` 认定的错误
   *   （TIMEOUT / NETWORK / 401 / 403 / 429 / 5xx）—— 这类才意味着「换条通道可能成功」。
   *   `BAD_RESPONSE`（报文异常）与其余 4xx 多半是请求或配置本身的问题，
   *   计进通道健康会让我们去停一条其实没坏的通道。
   *
   * ★ 本方法**绝不抛错**：它跑在故障转移的关键路径上。一次写库失败如果冒泡出去，
   *   会把「换下一个候选」这件事本身也打断 —— 那比不计数严重得多。
   */
  private async noteChannelFailure(providerId: bigint, err: AiCallError): Promise<void> {
    try {
      await this.prisma.aiProvider.update({
        where: { id: providerId },
        data: {
          consecutiveFailures: { increment: 1 },
          lastFailureAt: new Date(),
          lastFailureCode: (err.code ?? `HTTP_${err.status ?? '?'}`).slice(0, 64),
          lastFailureMsg: err.message.slice(0, 500),
          // `circuit_open_until` 此前**全代码只有读、没有任何写入点**（恒为 NULL，
          // 于是后台「AI 通道」页永远显示不出「刚才熔断过」）。这里把 Redis 的
          // 冷藏期镜像进库，运营才看得见发生了什么；成功分支在同一事务里清回 NULL。
          circuitOpenUntil: new Date(Date.now() + DEFAULT_CIRCUIT.openSeconds * 1000),
        },
      })
    } catch (e) {
      console.error(
        `[ai] 记录通道 ${providerId} 连续失败次数失败（不影响故障转移）:`,
        (e as Error).message,
      )
    }
  }

  /**
   * 后台通道测试：极短探测请求，不参与毛利统计，也不触发熔断阈值之外的副作用。
   *
   * 也被 30 分钟一轮的健康体检 sweeper（ai-health.service.ts）复用，所以有三个可选开关：
   *   · `timeoutMs`  —— 探活超时。★ 默认 10s 对**推理模型**是偏短的：gpt-5.5 这类模型
   *     即使被要求只回 30 字，实测也要 36~52s（见 health-probe.ts 的实测记录）。
   *     体检若照搬 10s，会把「只是慢」误判成「不可用」并自动停用，进而把流量全压到
   *     更贵的备用通道 —— 所以体检显式放宽（见 PROBE_TIMEOUT_MS）。
   *   · `writeLog`    —— 是否落一条 status='TEST' 的 ai_call_log。后台手动测试要留痕；
   *     体检是**常驻**的（3 通道 × 每 30 分钟），落下来只会把调用日志刷满真实使用记录。
   *     体检关掉它，探活结果仍写在 provider.lastTest* 上。
   *   · `user`        —— 提示词。默认是内容型探活提示词（health-probe.ts）。
   *     ⚠ 绝不要改回 'ping'：这个请求体的读数**不可复现**（实测同一形态有过
   *     200/4.9s、400、200 但耗 90s 三种结果，见 health-probe.ts 文件头）
   *     ⇒ 拿它判活或判死都会错。
   */
  async testProvider(
    providerId: bigint,
    modelCode?: string,
    opts: { timeoutMs?: number; writeLog?: boolean; user?: string } = {},
  ): Promise<{
    status: 'SUCCESS' | 'FAILED'
    latencyMs: number
    modelReturned?: string
    promptTokens: number
    completionTokens: number
    estimatedCostFen: number
    errorMsg?: string
  }> {
    const provider = await this.prisma.aiProvider.findUnique({
      where: { id: providerId },
      include: { models: { where: { enabled: true }, take: 10 } },
    })
    if (!provider) {
      return { status: 'FAILED', latencyMs: 0, promptTokens: 0, completionTokens: 0, estimatedCostFen: 0, errorMsg: 'provider not found' }
    }
    const model = modelCode
      ? (provider.models.find((m) => m.modelCode === modelCode) ?? provider.models[0])
      : provider.models[0]
    if (!model) {
      return { status: 'FAILED', latencyMs: 0, promptTokens: 0, completionTokens: 0, estimatedCostFen: 0, errorMsg: 'no enabled model' }
    }

    /**
     * ★★ 适配器必须按**模型能力**选，不能只看通道协议 —— 这里是 2026-09-21 生产事故的根因。
     *
     * `tokenbox-image` 这类「只挂图像模型」的通道，协议仍然是 OPENAI_COMPATIBLE，
     * 于是旧实现用 chat 适配器发出 `POST /chat/completions`（model=gpt-image-2），
     * 上游必然回：
     *   HTTP 400 {"message":"This model is not supported on the Chat Completions endpoint"}
     * —— 这是一次**与被探测通道是否可用完全无关**的必然失败。
     *
     * 后果不是"后台测试按钮显示失败"这么轻：30 分钟一轮的健康体检把它判成连续失败，
     * 据此自动停用（enabled=false / healthStatus=DOWN / autoDisabled=true），
     * 而它是 `publish_cover` 场景**唯一**的候选 ⇒ 每一次封面生成都落兜底模板。
     * 用户看到的是「标题和文案都生成了，封面没出来」，而日志里只剩一句
     * `no available provider`（那个静默跳过已在 runScene 里补上原因）。
     *
     * ⚠ 探活与业务调用必须走**同一个适配器**，否则探活的读数永远不代表业务可用性 ——
     *   这正是 `health-probe.ts` 里「ping 的读数与业务可用性无关」那条教训的第二次现身。
     */
    const wantImage = normalizeModelCapability(model.capability) === 'IMAGE'
    const adapter = wantImage ? openaiImage : getAdapter(provider.protocol)
    const startedAt = Date.now()
    try {
      const res = await adapter({
        baseUrl: provider.baseUrl,
        apiKey: decryptSecret(provider.apiKeyEncrypted),
        model: model.modelCode,
        // 图像模型把 user 当画面描述，文本探活提示词在这里毫无意义（见 health-probe.ts）
        user: opts.user ?? (wantImage ? HEALTH_PROBE_IMAGE_PROMPT : HEALTH_PROBE_PROMPT),
        maxOutputTokens: HEALTH_PROBE_MAX_OUTPUT_TOKENS,
        timeoutMs: opts.timeoutMs ?? 10_000,
      })
      const latencyMs = Date.now() - startedAt
      const costFen = computeCostFen(
        res.usage.promptTokens,
        res.usage.completionTokens,
        model.inputPricePerMtok,
        model.outputPricePerMtok,
      )
      await this.prisma.aiProvider.update({
        where: { id: provider.id },
        data: {
          lastTestAt: new Date(),
          lastTestLatencyMs: latencyMs,
          lastTestStatus: 'SUCCESS',
          lastTestError: null,
        },
      })
      if (opts.writeLog !== false) {
        await this.prisma.aiCallLog.create({
          data: {
            sceneCode: 'PROVIDER_TEST',
            requestId: `test-${provider.id}-${Date.now()}`,
            providerId: provider.id,
            modelId: model.id,
            promptTokens: res.usage.promptTokens,
            completionTokens: res.usage.completionTokens,
            totalTokens: res.usage.promptTokens + res.usage.completionTokens,
            costFen,
            latencyMs,
            status: 'TEST',
          },
        })
      }
      return {
        status: 'SUCCESS',
        latencyMs,
        modelReturned: res.modelReturned ?? model.modelCode,
        promptTokens: res.usage.promptTokens,
        completionTokens: res.usage.completionTokens,
        estimatedCostFen: costFen,
      }
    } catch (e) {
      const err = e as Error
      const latencyMs = Date.now() - startedAt
      await this.prisma.aiProvider.update({
        where: { id: provider.id },
        data: {
          lastTestAt: new Date(),
          lastTestLatencyMs: latencyMs,
          lastTestStatus: 'FAILED',
          lastTestError: err.message.slice(0, 500),
        },
      })
      return {
        status: 'FAILED',
        latencyMs,
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostFen: 0,
        errorMsg: err.message.slice(0, 500),
      }
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
