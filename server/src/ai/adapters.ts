// AI 供应商协议适配器
// 新增供应商只需在 AiProvider.protocol 里选协议，无需改代码
import { safeFetch, UnsafeOutboundUrlError } from '../lib/outbound-url.js'

export interface AiUsage {
  promptTokens: number
  completionTokens: number
}

export interface AiCallResult {
  text: string
  usage: AiUsage
  modelReturned?: string
}

export interface AiCallParams {
  baseUrl: string
  apiKey: string
  model: string
  system?: string
  user: string
  temperature?: number
  maxOutputTokens?: number
  /**
   * 推理预算（OpenAI 兼容参数 `reasoning_effort`）。不给则**完全不发这个字段**，
   * 走上游默认值 —— 对推理模型来说默认值等于「想多久随它」。
   *
   * ★ 为什么需要它：推理模型会把 `max_tokens` 同时当作「思考预算 + 正文预算」，
   *   而短输出场景（文案 80~190 字）根本不需要思考。实测同一提示词：
   *   gpt-5.5 默认 83.9s（另一次 126s 直接 524）、加 `low` 后 **7.6s**；
   *   deepseek 默认 50.2s、加 `low` 后 **7.2s**。输出质量不变。
   * ★ **不是所有通道都认**：claude-sonnet-5 对 `reasoning_effort` 与
   *   `thinking:{type:'disabled'}` 均无视（实测），所以它必须移出这类场景的候选链。
   *   哪些场景该带、为什么，见 `ai/scene-codes.ts` 的 LOW_REASONING_SCENES。
   */
  reasoningEffort?: 'low' | 'medium' | 'high'
  timeoutMs: number
  /** 场景码：MOCK 协议据此返回不同形态的样例文本（文案 vs 分镜 JSON） */
  sceneCode?: string
}

export class AiCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'AiCallError'
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith(path) ? base : base + path
}

export type AiAdapter = (p: AiCallParams) => Promise<AiCallResult>

async function postJson(url: string, init: RequestInit & { timeoutMs: number }): Promise<unknown> {
  const { timeoutMs, ...rest } = init
  let res: Response
  try {
    // ★ 必须走 safeFetch 而不是裸 fetch：baseUrl 是**运营在后台手填**的，
    //   服务端还会把已保存的 API key 放进 Authorization 一起发出去。
    //   safeFetch 负责「协议白名单 + 拒本机/私网/保留地址 + 不跟随重定向」，
    //   见 lib/outbound-url.ts 的说明。
    res = await safeFetch(url, rest, { timeoutMs })
  } catch (e) {
    const err = e as Error
    if (err instanceof UnsafeOutboundUrlError) {
      throw new AiCallError(err.message, undefined, 'UNSAFE_URL')
    }
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new AiCallError(`request timeout after ${timeoutMs}ms`, undefined, 'TIMEOUT')
    }
    throw new AiCallError(err.message, undefined, 'NETWORK')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new AiCallError(`HTTP ${res.status}: ${body.slice(0, 300)}`, res.status, 'HTTP_ERROR')
  }
  return res.json()
}

/** 空白正文判定：空字符串或只有空白字符 */
function isBlank(s: string): boolean {
  return s.trim().length === 0
}

/** OpenAI 兼容协议：DeepSeek / 通义 / 豆包 / 混元 / 多数国产模型 */
export const openaiCompatible: AiAdapter = async (p) => {
  const url = joinUrl(p.baseUrl, '/chat/completions')
  const data = (await postJson(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${p.apiKey}`,
    },
    body: JSON.stringify({
      model: p.model,
      messages: [
        ...(p.system ? [{ role: 'system', content: p.system }] : []),
        { role: 'user', content: p.user },
      ],
      temperature: p.temperature ?? 0.7,
      max_tokens: p.maxOutputTokens ?? 2048,
      // ★ 只在显式指定时带上：不指定就不发这个字段（各通道对它的默认值不一样，
      //   统一写一个值会把「本来不思考的通道」也带上参数，属无谓的耦合）。
      ...(p.reasoningEffort ? { reasoning_effort: p.reasoningEffort } : {}),
      stream: false,
    }),
    timeoutMs: p.timeoutMs,
  })) as any

  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string') {
    throw new AiCallError('unexpected response: missing choices[0].message.content', undefined, 'BAD_RESPONSE')
  }
  // ★ 空白正文必须算失败，不能当成功返回。
  //   实测成因：中转站/厂商把 max_tokens 同时当作「思考(reasoning)预算 + 正文预算」，
  //   推理模型（gpt-5.5 / claude-* / deepseek-* 均带思考）常把预算全花在思考上，
  //   于是返回 finish_reason='length' 且 content='' —— HTTP 200、报文结构完全合法。
  //   若在这里放过，网关会判定成功 → 业务层照常扣积分并把空文案交给商户。
  //   判为 BAD_RESPONSE 后：本通道按 maxRetries 重试，仍失败则**转入下一个候选通道**，
  //   全部失败才回落到 ai_scene.fallback_template 且不扣积分。故障转移因此才真正生效。
  if (isBlank(text)) {
    throw new AiCallError(
      `unexpected response: empty content (finish_reason=${data?.choices?.[0]?.finish_reason ?? '?'}) — ` +
        `推理模型可能把 max_tokens(${p.maxOutputTokens ?? 2048}) 全用在思考上，请调大该场景的 max_output_tokens`,
      undefined,
      'BAD_RESPONSE',
    )
  }
  return {
    text,
    usage: {
      promptTokens: Number(data?.usage?.prompt_tokens ?? 0),
      completionTokens: Number(data?.usage?.completion_tokens ?? 0),
    },
    modelReturned: data?.model,
  }
}

/** Anthropic 原生协议：Claude */
export const anthropicNative: AiAdapter = async (p) => {
  const url = joinUrl(p.baseUrl, '/v1/messages')
  const data = (await postJson(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': p.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: p.maxOutputTokens ?? 2048,
      ...(p.system ? { system: p.system } : {}),
      messages: [{ role: 'user', content: p.user }],
      temperature: p.temperature ?? 0.7,
    }),
    timeoutMs: p.timeoutMs,
  })) as any

  const block = data?.content?.[0]
  if (typeof block?.text !== 'string') {
    throw new AiCallError('unexpected response: missing content[0].text', undefined, 'BAD_RESPONSE')
  }
  // 同上：空白正文算失败，否则会「成功」返回空文案并照常扣积分
  if (isBlank(block.text)) {
    throw new AiCallError(
      `unexpected response: empty content (stop_reason=${data?.stop_reason ?? '?'}) — ` +
        `推理模型可能把 max_tokens(${p.maxOutputTokens ?? 2048}) 全用在思考上，请调大该场景的 max_output_tokens`,
      undefined,
      'BAD_RESPONSE',
    )
  }
  return {
    text: block.text,
    usage: {
      promptTokens: Number(data?.usage?.input_tokens ?? 0),
      completionTokens: Number(data?.usage?.output_tokens ?? 0),
    },
    modelReturned: data?.model,
  }
}

/**
 * 本地联调用 MOCK 协议：不发起任何网络请求，直接返回可解析的样例文本。
 * - copy_generate / copy_traffic / copy_persona / copy_knowledge / copy_product / copy_recommend → 对应款式的样例文案
 * - storyboard_generate → 按复杂度（SIMPLE/COMPLEX/FINE）返回 3/6/8 个分镜 JSON
 * 真实环境请改用 OPENAI_COMPATIBLE（如 DeepSeek）并填入 apiKey。
 */

/** 从提示词里抠一个字段（兼容「门店：xx」与「【门店】xx｜…」两种写法）。只吃行内空白，避免空字段串到下一行 */
function pick(prompt: string, label: string): string {
  const re = new RegExp(`${label}[】:：][ \\t]*([^\\n，,。；;｜|]+)`)
  return (prompt.match(re) || [])[1]?.trim() || ''
}

interface MockShot {
  shotType: string
  shotSize: string
  libraryCode: string
  visualReq: string
}

// 基础拍摄手法池（与 seed 的镜头库 code 对齐）
const MOCK_POOL: Record<string, MockShot> = {
  open_storefront: { shotType: '开场', shotSize: '全景', libraryCode: 'open_storefront', visualReq: '有门头素材时，把手机靠稳拍下门店入口；没有就用口播开场' },
  boss_talk: { shotType: '口播', shotSize: '近景', libraryCode: 'boss_talk', visualReq: '老板用手机前置镜头自拍口播，画面保持稳定' },
  closeup_food: { shotType: '特写', shotSize: '特写', libraryCode: 'closeup_food', visualReq: '菜品已上桌时用手机靠近拍一段细节，不补蒸汽或食材效果' },
  make_ingredient: { shotType: '原料', shotSize: '特写', libraryCode: 'make_ingredient', visualReq: '只拍资料提到且现场有的食材，手机近距离记录真实状态' },
  make_process: { shotType: '制作', shotSize: '中景', libraryCode: 'make_process', visualReq: '将手机靠稳，只拍一段实际发生且与口播有关的制作动作' },
  make_serve: { shotType: '制作', shotSize: '近景', libraryCode: 'make_serve', visualReq: '实际出餐时把手机靠稳，拍下真实装盘过程，不补热气效果' },
  scene_ambience: { shotType: '环境', shotSize: '全景', libraryCode: 'scene_ambience', visualReq: '选一个真实可见的店内角落，用手机固定机位拍摄；避开无关顾客' },
  taste_reaction: { shotType: '试吃', shotSize: '近景', libraryCode: 'taste_reaction', visualReq: '只有老板确实要现场试吃时才自拍记录真实反应，不安排演员' },
  selling_combo: { shotType: '卖点', shotSize: '中景', libraryCode: 'selling_combo', visualReq: '套餐与价格资料齐全时拍下菜单或实际套餐内容，不补字幕信息' },
  ending_location: { shotType: '收尾', shotSize: '全景', libraryCode: 'ending_location', visualReq: '口播提到门店位置时拍摄真实门头或店内标识，不添加未提供的地址' },
}

// 本地测试样例，不代表每条真实创作都必须覆盖这些镜头类型。
const MOCK_SEQUENCES: Record<string, string[]> = {
  SIMPLE: ['boss_talk', 'closeup_food', 'scene_ambience'],
  COMPLEX: ['boss_talk', 'make_ingredient', 'make_process', 'make_serve', 'closeup_food', 'scene_ambience'],
  FINE: ['open_storefront', 'boss_talk', 'make_ingredient', 'make_process', 'make_serve', 'closeup_food', 'taste_reaction', 'scene_ambience'],
}
const MOCK_DURATIONS = [3, 4, 4, 5, 3, 4, 4, 3, 4]

/** 把口播文案按句子切成 n 段，保证拼起来仍是完整文案 */
function splitLines(text: string, n: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return Array.from({ length: n }, () => '')
  const parts = clean.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean)
  if (parts.length >= n) {
    const per = Math.ceil(parts.length / n)
    const out: string[] = []
    for (let i = 0; i < parts.length && out.length < n; i += per) {
      out.push(parts.slice(i, i + per).join(''))
    }
    return out
  }
  const out = [...parts]
  while (out.length < n) out.push('')
  return out
}

export const mockAdapter: AiAdapter = async (p) => {
  const store = pick(p.user, '门店') || '本店'
  const dish = pick(p.user, '菜品')
  const city = pick(p.user, '城市')

  if (p.sceneCode === 'storyboard_generate') {
    const complexity = (p.user.match(/（(SIMPLE|COMPLEX|FINE)）/) || [])[1] || 'COMPLEX'
    const codes = MOCK_SEQUENCES[complexity] ?? MOCK_SEQUENCES.COMPLEX!
    const copyText = (p.user.match(/口播文案[】:：]\s*([\s\S]*?)(?=\n【|$)/) || [])[1]?.trim() || ''
    const lines = splitLines(copyText, codes.length)
    const shots = codes.map((code, i) => {
      const s = MOCK_POOL[code]!
      return {
        seq: i + 1,
        shotType: s.shotType,
        shotSize: s.shotSize,
        durationSuggest: MOCK_DURATIONS[i % MOCK_DURATIONS.length]!,
        line: lines[i] || '',
        visualReq: s.visualReq,
        libraryCode: s.libraryCode,
      }
    })
    return {
      text: JSON.stringify(shots, null, 2),
      usage: { promptTokens: 220, completionTokens: 40 * shots.length },
    }
  }

  const head = dish ? `${dish}，` : ''
  const byScene: Record<string, string> = {
    copy_traffic: [
      `平时忙起来，吃饭这件事很容易就凑合过去了。`,
      `你最近有没有好好坐下来吃顿饭？`,
    ].join('\n'),
    copy_persona: [
      `做餐饮每天都有不少琐碎事，能把手上的事一件件做好，比说漂亮话重要。`,
    ].join('\n'),
    copy_knowledge: [
      `做菜前先把食材和调料备齐，再开火会从容很多，也不容易忙中出错。`,
    ].join('\n'),
    copy_product: [
      `${store}的${dish || '这道菜'}，${pick(p.user, '卖点') || '具体做法和价格可以看门店当前介绍'}。`,
    ].join('\n'),
    copy_recommend: [
      `${store}的${dish || '这道菜'}，${pick(p.user, '卖点') || '具体特点以门店介绍为准'}。`,
      `老板把这道菜的实际做法和特点说清楚，顾客再按自己的口味决定。`,
    ].join('\n'),
  }
  const copy =
    byScene[p.sceneCode ?? ''] ??
    [
      `【${store}】${head}街坊邻居都爱来的味道。`,
      `具体做法、价格和包含内容，以门店当前介绍为准。`,
    ].join('\n')
  return { text: copy, usage: { promptTokens: 120, completionTokens: 180 } }
}

/**
 * OpenAI 兼容的**图像生成**协议：`POST {baseUrl}/images/generations`。
 *
 * ★ 与 chat 适配器的三点不同，每一点都有实际后果：
 *
 *   1. **请求体是 `prompt` 而不是 `messages`**：AI 场景模板渲染出来的那段文字，
 *      在文本场景里是「用户消息」，在这里就是图像模型的提示词本身。
 *      所以图像场景的模板必须**写成给图像模型看的画风/规格说明**，不能有「你是…专家」这种
 *      对话式人设（见 prisma/prompts.ts 的 PUBLISH_COVER_PROMPT）。
 *
 *   2. **没有 token 用量**：实测返回体 `usage: null`（中转站不回落上游的计费字段）。
 *      因此 `usage` 恒为 0 —— 也就意味着**按 token 结算会把出图算成 0 积分**。
 *      出图场景的计费走「按张固定价」（网关把 ai_scene.bean_price 作为该次调用的价格，
 *      见 gateway.ts 的 fixedBeans 与 ai.service.ts 的 settleAiCharge）。
 *      ⚠ 所以图像场景的 `bean_price` **不是**「单次上限」，而是**报价本身**，别当成安全网随手调小。
 *
 *   3. **结果是 URL 或 base64，不是文本**：中转站给的是 `data[0].url`
 *      （域名通常与 API 域名不同，本机/国内直连可能被 SNI 拦，见下面的取样说明）；
 *      有的上游只回 `data[0].b64_json`。两种情况都在这里收敛成 `text`：
 *        · 有 url      → text = 该 url（**绝对地址**，调用方负责下载，见 lib/media-fetch.ts）
 *        · 只有 b64    → text = `data:image/png;base64,…` 这种 data URI，调用方按前缀解码
 *      ⚠ 只有 b64 时，`ai_call_log.response_snapshot` 会存下一段被截断的 base64
 *        （网关只截前 8000 字）。这是刻意接受的代价：宁可日志难看，也不要为此改全局日志契约。
 *
 * `size` 从环境变量读（`AI_IMAGE_SIZE`），默认 `1024x1365`：
 *   实测该中转站**接受**这个非标准尺寸，并按 3:4 出图（route 里 native_size=864x1152、
 *   最终落盘 1086x1448）。而标准竖版 `1024x1536` 是 2:3 —— 不是产品要的封面比例。
 */
export const openaiImage: AiAdapter = async (p) => {
  const url = joinUrl(p.baseUrl, '/images/generations')
  const size = (process.env.AI_IMAGE_SIZE ?? '1024x1365').trim()
  const data = (await postJson(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${p.apiKey}`,
    },
    body: JSON.stringify({ model: p.model, prompt: p.user, n: 1, size }),
    timeoutMs: p.timeoutMs,
  })) as any

  const item = data?.data?.[0]
  const remote = typeof item?.url === 'string' && item.url ? item.url : ''
  const b64 = typeof item?.b64_json === 'string' && item.b64_json ? item.b64_json : ''
  if (!remote && !b64) {
    // 报错里带上实际拿到的东西：这类失败最常见的成因是「模型码填错，被中转站按文本模型处理」，
    // 只写「无图片」会让人以为是网络问题。
    throw new AiCallError(
      `出图返回里既没有 data[0].url 也没有 data[0].b64_json（实际拿到 ${JSON.stringify(item ?? data).slice(0, 200)}）`,
      undefined,
      'BAD_RESPONSE',
    )
  }
  return {
    text: remote || `data:image/png;base64,${b64}`,
    usage: { promptTokens: 0, completionTokens: 0 },
    modelReturned: data?.model,
  }
}

export function getAdapter(protocol: string): AiAdapter {
  switch (protocol) {
    case 'ANTHROPIC_NATIVE':
      return anthropicNative
    case 'MOCK':
      return mockAdapter
    case 'OPENAI_COMPATIBLE':
    default:
      return openaiCompatible
  }
}
