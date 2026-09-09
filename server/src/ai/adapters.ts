// AI 供应商协议适配器
// 新增供应商只需在 AiProvider.protocol 里选协议，无需改代码

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
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    const err = e as Error
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
      stream: false,
    }),
    timeoutMs: p.timeoutMs,
  })) as any

  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string') {
    throw new AiCallError('unexpected response: missing choices[0].message.content', undefined, 'BAD_RESPONSE')
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
 * - copy_generate      → 一段可直接落库的营销文案
 * - storyboard_generate → 一段可被 extractJson 解析的分镜 JSON 数组
 * 真实环境请改用 OPENAI_COMPATIBLE（如 DeepSeek）并填入 apiKey。
 */
export const mockAdapter: AiAdapter = async (p) => {
  const store = (p.user.match(/门店[：:]\s*([^\n，,。；;]+)/) || [])[1]?.trim() || '本店'
  const dish = (p.user.match(/菜品[：:]\s*([^\n，,。；;]+)/) || [])[1]?.trim() || ''

  if (p.sceneCode === 'storyboard_generate') {
    const shots = [
      { shotType: '开场', durationSuggest: 3, line: `${store}严选好食材，每一口都安心`, visualReq: '门店门头 + 招牌菜特写，暖色调，慢推近' },
      { shotType: '特写', durationSuggest: 4, line: dish ? `${dish}现做现卖，热气腾腾` : '招牌菜品出锅瞬间', visualReq: '锅中翻炒特写，蒸汽升腾，微距' },
      { shotType: '制作', durationSuggest: 5, line: '后厨干净卫生，工艺看得见', visualReq: '厨师操作全景，展示新鲜食材' },
      { shotType: '试吃', durationSuggest: 4, line: '一口下去，外酥里嫩', visualReq: '人物试吃表情特写，自然光' },
      { shotType: '卖点', durationSuggest: 4, line: dish ? `${dish}今日特价，到店即享` : '多款套餐任选，性价比高', visualReq: '菜单 / 价目牌 + 优惠标签' },
      { shotType: '收尾', durationSuggest: 3, line: '地址就在楼下，欢迎来尝', visualReq: '门店环境 + 定位字幕，淡出' },
    ]
    return {
      text: JSON.stringify(shots, null, 2),
      usage: { promptTokens: 140, completionTokens: 360 },
    }
  }

  const copy = [
    `【${store}】${dish ? `${dish}，` : ''}街坊邻居都爱来的味道。`,
    `新鲜现做、分量实在，人均不过几十块，吃的是安心，尝的是人情味。`,
    `今天到店还有专属福利，扫码进群先领券——好味道，等你来。`,
  ].join('\n')
  return { text: copy, usage: { promptTokens: 120, completionTokens: 180 } }
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
