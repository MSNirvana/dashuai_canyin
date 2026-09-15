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
  //   若在这里放过，网关会判定成功 → 业务层照常扣豆并把空文案交给商户。
  //   判为 BAD_RESPONSE 后：本通道按 maxRetries 重试，仍失败则**转入下一个候选通道**，
  //   全部失败才回落到 ai_scene.fallback_template 且不扣豆。故障转移因此才真正生效。
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
  // 同上：空白正文算失败，否则会「成功」返回空文案并照常扣豆
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
 * - copy_generate / copy_traffic / copy_intro / copy_quality / copy_recommend → 对应款式的营销文案
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
  open_storefront: { shotType: '开场', shotSize: '全景', libraryCode: 'open_storefront', visualReq: '门店门头，从马路对面缓推，清晨柔光' },
  boss_talk: { shotType: '口播', shotSize: '近景', libraryCode: 'boss_talk', visualReq: '老板对镜头口播，机位与眼齐平，背景留出门店环境' },
  closeup_food: { shotType: '特写', shotSize: '特写', libraryCode: 'closeup_food', visualReq: '菜品出锅特写，怼近 20cm，蒸汽升腾，侧逆光' },
  make_ingredient: { shotType: '原料', shotSize: '特写', libraryCode: 'make_ingredient', visualReq: '当天采购的新鲜原料俯拍 + 手拿展示纹理' },
  make_process: { shotType: '制作', shotSize: '中景', libraryCode: 'make_process', visualReq: '备料—下锅—翻炒完整动作线，一镜到底' },
  make_serve: { shotType: '制作', shotSize: '近景', libraryCode: 'make_serve', visualReq: '出锅装盘瞬间，热气正对镜头，一次到位' },
  scene_ambience: { shotType: '环境', shotSize: '全景', libraryCode: 'scene_ambience', visualReq: '堂食区/明档横移，烟火气但不乱，停 2 秒' },
  taste_reaction: { shotType: '试吃', shotSize: '近景', libraryCode: 'taste_reaction', visualReq: '夹起—入口—点头，第一口自然反应' },
  selling_combo: { shotType: '卖点', shotSize: '中景', libraryCode: 'selling_combo', visualReq: '套餐菜品摆好俯拍 + 价格字幕' },
  ending_location: { shotType: '收尾', shotSize: '全景', libraryCode: 'ending_location', visualReq: '门店环境 + 定位字幕，淡出' },
}

// 复杂度 → 分镜序列（覆盖美食特写/老板口播/出锅/环境/原料/制作过程）
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
        line: lines[i] || (i === 0 ? `${store}严选好食材` : dish ? `${dish}现做现卖` : ''),
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
      `就在${city || '你家楼下'}！${store}的${head}本地人排着队来吃。`,
      `别再问我哪家好吃了，这一口下去你就知道什么叫值。`,
      `${city || ''}的朋友，评论区扣个 1，我给你留个位置。`,
    ].join('\n'),
    copy_intro: [
      `${store}的招牌${dish || '菜品'}，${pick(p.user, '卖点') || '用料实在、分量足'}。`,
      `做法不复杂但每一步都讲究，端上桌就能闻到香味。`,
      `价格透明，到店点一份试试，不好吃你来找我。`,
    ].join('\n'),
    copy_quality: [
      `${store}做了这么多年，就认一个理：食材不新鲜，宁可不做。`,
      `${dish || '招牌菜'}从选料到出锅，每一道工序都不将就。`,
      `懂吃的人，值得专程来一趟。`,
    ].join('\n'),
    copy_recommend: [
      `这家店是朋友吃过后一直推荐给我的，今天终于来试试${dish || '招牌菜'}。`,
      `第一口是${pick(p.user, '卖点') || '新鲜和实在'}，不是夸张宣传，确实值得专程来一趟。`,
      `如果你也在找${city || '附近'}值得吃的一家，可以先把${store}收藏起来。`,
    ].join('\n'),
  }
  const copy =
    byScene[p.sceneCode ?? ''] ??
    [
      `【${store}】${head}街坊邻居都爱来的味道。`,
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
