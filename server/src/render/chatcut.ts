import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { redis } from '../db.js'

export const CHATCUT_VOICES = [
  { id: 'warm-female', name: '温暖女声', description: '自然亲切，适合探店种草' },
  { id: 'bright-female', name: '活力女声', description: '节奏明快，适合促销上新' },
  { id: 'gentle-male', name: '温和男声', description: '沉稳自然，适合品牌介绍' },
  { id: 'magnetic-male', name: '磁性男声', description: '质感突出，适合品质表达' },
  { id: 'energetic-youth', name: '活力青年', description: '轻快有冲劲，适合同城引流' },
  { id: 'custom', name: '我的配音', description: '上传自己的录音作为旁白' },
] as const

/**
 * 「不配音」档位（2026-09-21 新增）：保留画面原声，不生成配音轨。
 * ★ 连带后果：**字幕也没有** —— 字幕是从配音轨转录派生的（driver 第 5 步 `edit_captions`
 *   依赖 `transcriptionAssetIds`，而那些 id 来自配音素材）。所以选它时字幕开关应一起关掉。
 */
export const CHATCUT_VOICE_OFF = 'none'

/**
 * 「素材送云端之前要不要先在本机归一化」—— 2026-09-22 新增的用户可选路线。
 *
 * - `ORIGINAL`（**默认，也是原来的唯一路线**）：素材原文件直接推 COS 原始字节，
 *   画布适配全交给云端的 `fit:"cover"`。**不经二次压缩，画质最好**；
 *   代价是「云端只能看到我们声明的宽高」⇒ 一旦元数据探测出错，就会按错比例裁切
 *   （2026-09-22 的 `rotation` 事故就是这一类）。
 * - `NORMALIZED`（本地打底）：先用本机 ffmpeg 把整段素材转成成片画布（1080×1920）再上传。
 *   ffmpeg 的 `scale`/`crop` **默认 autorotate**，手机拍的旋转信息在本地就被转正
 *   ⇒ 送上去的素材**几何是确定的**，云端 `cover` 只会 1:1 落位、不可能再算错。
 *   代价：多一道本地转码（出片变慢、且多一次编解码 ⇒ 画质略降）。
 *
 * ★ 为什么做成「用户可选」而不是二选一：两者是**画质 ↔ 稳健**的取舍，没有绝对优解
 *   —— 素材规整时 ORIGINAL 更好，素材来源杂时 NORMALIZED 更稳。让用户按自己的素材选。
 */
export const CHATCUT_CLIP_PREPS = ['ORIGINAL', 'NORMALIZED'] as const

export const ChatCutOptionsSchema = z.object({
  /** AUTO 交给系统按素材识别；ADVANCED 完全使用用户明确选择的参数。 */
  editMode: z.enum(['AUTO', 'ADVANCED']),
  voiceId: z.enum([CHATCUT_VOICE_OFF, ...CHATCUT_VOICES.map((voice) => voice.id)] as [string, ...string[]]),
  subtitles: z.boolean(),
  subtitleMode: z.enum(['OFF', 'VOICE', 'SOURCE_AUDIO', 'VOICE_AND_SOURCE']),
  // ── 以下 6 项已于 2026-09-21 **全部接上真实原语**（此前是「收了但不用」的装饰控件）──────
  // 每一项的落地方式见下面的 *_PRESETS/*_PLANS 常量与 chatcut-driver.ts 里的对应阶段。
  // ⚠ 仍然存在的前置条件（不是 bug，是额度/依赖约束）：
  //   · subtitleStyle 只在**有字幕**时生效（无配音 ⇒ 无转录 ⇒ 无字幕）
  //   · removeSilence 走 clean_script，同样依赖转录
  //   · bgm 要 `CHATCUT_BGM_ENABLED=true`（生成音乐**消耗 ChatCut 额度**，留作运维开关）
  subtitleStyle: z.enum(['CLEAN', 'EMPHASIS', 'SOCIAL']),
  pacing: z.enum(['NATURAL', 'FAST', 'STORY']),
  transitions: z.enum(['CLEAN', 'SMOOTH', 'DYNAMIC']),
  removeSilence: z.boolean(),
  normalizeAudio: z.boolean(),
  bgm: z.enum(['NONE', 'LIGHT', 'UPBEAT', 'PREMIUM']),
  clipPrep: z.enum(CHATCUT_CLIP_PREPS),
  note: z.string().trim().max(300),
})

export type ChatCutOptions = z.infer<typeof ChatCutOptionsSchema>

export const DEFAULT_CHATCUT_OPTIONS: ChatCutOptions = {
  editMode: 'AUTO',
  voiceId: 'warm-female',
  subtitles: true,
  subtitleMode: 'VOICE',
  subtitleStyle: 'CLEAN',
  // ★ 默认 NONE：BGM 是**生成类**调用（消耗 ChatCut 额度）且要显式开 `CHATCUT_BGM_ENABLED`，
  //   默认选 LIGHT 会让每次渲染都白跑一次生成。用户主动选了才做。
  bgm: 'NONE',
  pacing: 'NATURAL',
  /**
   * ★★ 默认档位 = **有转场**（2026-09-22 改，此前是 `CLEAN`）。
   *
   *   改的理由是一条真实投诉：用户跑完 AI 档说「**画面比例不对、也没有转场和剪辑**」。
   *   查证发现「没有转场」不是缺陷、是**默认值本身**：`CLEAN` 就是「不加转场」，
   *   而用户从没动过这个选择 ⇒ **每一条默认出片都必然是 6 段硬拼**。
   *   对一个卖点是「AI 全自动出片」的产品，「默认看起来没剪过」比「默认略短」严重得多。
   *
   *   `TRANSITION_PLANS` 的注释写着「默认档位不能悄悄把片子缩短」—— 那条顾虑仍然成立，
   *   但**已经被 UI 覆盖**：客户端 `TRANSITION_HINT.SMOOTH` 原文就是
   *   「要用到少量画面素材，整片会略短一点」⇒ 代价在选项里写着，不是悄悄发生的。
   *
   *   代价（6 镜头 / 30fps）：整片约短 2.4s。★ **不会截断台词** —— 服务端给配音留了
   *   时间下界（`chatcut-timing.ts` 的 `slotMs`），镜头再短也短不过那一段配音。
   */
  transitions: 'SMOOTH',
  removeSilence: true,
  normalizeAudio: true,
  // ★★ 默认 = **原路线**（原文直传），**不覆盖/不改变原有 AI 生成行为**。
  //   用户主动选 `NORMALIZED` 才走本地打底 —— 理由（画质 ↔ 稳健的取舍）见 CHATCUT_CLIP_PREPS。
  clipPrep: 'ORIGINAL',
  note: '',
}

// ─────────────────────────────────────────────────────────────────────────────
// 档位 → 真实原语 的映射表（2026-09-21 实测取得，**改动前必须重新实测核对**）
//
// ★ 为什么单独抽成常量而不是散在 driver 里：这三个映射的**取值全部来自外部服务**
//   （ChatCut 的预设目录 / 内置转场库 / 时间线约束），是本项目里最容易被远端改坏的东西。
//   集中在一处，出问题时只改一张表；也便于写脚本对着 `edit_captions action=template`
//   与 `browse_library category=transitions` 的真实返回做断言。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 字幕样式档位 → ChatCut 内置字幕预设 id。
 * 来源：`edit_captions {action:"template"}`（不带 templatePreset）返回的语言感知目录，
 * 实测 `catalog="chinese"`、共 10 个预设。
 * ★ 三个档位**刻意选了视觉差异最大**的三个，而不是三个都「白字带描边」：
 *   CLEAN 无底无描边、EMPHASIS 黄字黑描边、SOCIAL 带卡片底 —— 用户换档位必须一眼看得出来。
 */
export const CAPTION_PRESETS: Record<ChatCutOptions['subtitleStyle'], string> = {
  CLEAN: 'plain', // 基础：Inter 400 纯白，无底无描边无阴影
  EMPHASIS: 'yellow-impact', // 黄字黑描边：Xinqingnian 800 + stroke + shadow，促销最强调
  SOCIAL: 'deyi-card', // 得意黑：Smiley Sans + 卡片底，潮感社媒风
}

/**
 * 转场风格档位 → 内置转场 + **时长** + **需要的素材余量（handle）**。
 *
 * ★★ 为什么转场要带 handleFrames，而不是「只给一个转场 id」：
 *   2026-09-21 干跑实测（用真实项目 validateOnly 逐组试出来的）——
 *   转场不是「往接缝上贴一个效果」，它要**消耗两边的素材**：
 *     · 前一个镜头要留出**尾部**素材，后一个镜头要留出**头部**素材；
 *     · 而我们排轨时把每段素材**用满了**（source [0, D)）⇒ 余量 0 ⇒ ChatCut 直接拒：
 *       `adds[0] transition duration 14f exceeds feasible visual transition limit 0f`。
 *   实测出精确关系：**可行帧数上限 = 2 × handle − 2**（handle 是两侧各留的帧数）。
 *   所以想要 d 帧转场，两侧各留 `handleFrames = d/2 + 1` 帧才刚好够 —— 本表的取值
 *   都是按这条关系算出来并向 ChatCut 验证过的。
 *
 * ⚠ 代价（必须让用户知情）：留出来的素材**不会出现在时间线上** ⇒ 整片会变短。
 *   每个镜头少 `2 × handleFrames` 帧；6 个镜头下 SMOOTH 约短 2.4s、DYNAMIC 约短 3.2s。
 *   这也是为什么 CLEAN **刻意做成硬切**（assetId=null、不占任何素材）——
 *   默认档位不能悄悄把片子缩短，用户明确选了转场才付出这个代价。
 */
export const TRANSITION_PLANS: Record<ChatCutOptions['transitions'], {
  /** 内置转场 assetId；`null` = 硬切（不加转场，也不预留素材） */
  assetId: string | null
  /** 接缝转场时长（帧）。30fps 下 10 帧≈0.33s / 14 帧≈0.47s */
  durationFrames: number
  /** 每个镜头**首尾各**要预留的素材帧数。上限关系：durationFrames ≤ 2×handleFrames − 2 */
  handleFrames: number
}> = {
  CLEAN: { assetId: null, durationFrames: 0, handleFrames: 0 },
  SMOOTH: { assetId: 'builtin:tr-organic-dissolve', durationFrames: 10, handleFrames: 6 },
  DYNAMIC: { assetId: 'builtin:tr-whip-pan', durationFrames: 14, handleFrames: 8 },
}

/**
 * 剪辑节奏档位 → 镜头时长系数 / 镜头自身的首尾淡入淡出（秒）。
 *
 * ★★ 为什么用「缩短镜头」而不是「调 playbackRate（变速）」来体现快节奏：
 *   变速会让**源素材消耗量**变成 `时长 × 倍率`。加速 ⇒ 需要比现在更多的源字节，
 *   一旦分镜已经把素材用满（没有 trimEnd 余量），就会撞上 ChatCut 的
 *   `Source range exceeds video asset duration` 拒单（这个坑 2026-09-17 踩过一次）。
 *   而**缩短镜头只会减少源消耗**，任何情况下都安全。所以：
 *     FAST    = 镜头 ×0.78                       —— 切得密
 *     NATURAL = 原样
 *     STORY   = 原样 + 镜头首尾 0.3s 淡入淡出      —— 舒缓、连贯
 *   三者都只改「我们自己排的帧」，不依赖远端对变速的支持。
 *
 * ★ 转场的时长、以及「要预留多少素材」**不在这里** —— 那是 `TRANSITION_PLANS`（转场风格档位）的事：
 *   它要占素材、会改变整片时长，和「节奏快慢」是两件独立的事。
 *
 * ⚠ FAST 的 0.78 是**目标**而不是结果：镜头还要给配音让路 ——
 *   配音是按镜头时长合成的（尾部补静音对齐），把镜头缩到比台词本身还短就会把话吃掉。
 *   所以 driver 会先量出「这句话真实多长」，再决定「缩到 0.78 需要的语速」是否可接受
 *   （上限 `MAX_SPEECH_TEMPO`）；不可接受就只缩到「刚好放得下这句话」为止。
 *   即：**FAST 永远不会以牺牲台词为代价**。
 */
export const PACING_PLANS: Record<ChatCutOptions['pacing'], {
  /** 镜头时长系数（<1 变短；只允许缩短，见上面注释） */
  shotScale: number
  /** 每个镜头自身首尾淡入淡出秒数（0 = 不淡） */
  clipFadeSec: number
  /** 镜头缩短后的时长下限（毫秒）—— 再短就没信息量了。
   *  ⚠ 它是「下限」而不是「结果」：driver 最后还会和原始时长取小
   *    （否则一个本来 1.0s 的镜头会被下限顶到 1.2s，比原来还长 ⇒ 排帧超素材时长被拒单）。 */
  minShotMs: number
}> = {
  NATURAL: { shotScale: 1, clipFadeSec: 0, minShotMs: 0 },
  FAST: { shotScale: 0.78, clipFadeSec: 0, minShotMs: 1200 },
  STORY: { shotScale: 1, clipFadeSec: 0.3, minShotMs: 0 },
}

/**
 * 配乐档位 → 音乐生成提示词（`submit_music generationType=instrumental`）。
 * ★ 都显式写了 `no vocals` —— instrumental 模式本就不出人声，但提示词里点明能进一步
 *   降低模型「哼唱」的概率；餐饮口播底下出现人声是明显的质量事故。
 */
export const BGM_PROMPTS: Record<Exclude<ChatCutOptions['bgm'], 'NONE'>, string> = {
  LIGHT: 'warm minimal acoustic guitar and soft piano, calm, under a restaurant promo voiceover, not distracting, no vocals',
  UPBEAT: 'upbeat light electronic pop, confident energy, background bed under a short food promo, no vocals',
  PREMIUM: 'cinematic warm strings and soft piano, elegant premium mood for a food brand film, no vocals',
}

export interface ChatCutClipInput {
  shotId: string
  assetId: string
  sourceUrl: string
  trimStartMs: number
  trimEndMs: number | null
  durationMs: number | null
  line: string | null
}

export interface ChatCutJobInput {
  taskId: string
  merchantId: string
  creationId: string
  title: string
  clips: ChatCutClipInput[]
  options: ChatCutOptions
  output: { width: number; height: number; fps: number }
  /**
   * 启动阶段（`startChatCutRender`）的阶段上报，`ratio` 为 0~1。
   *
   * ★ 存在的理由：启动是**分钟级**的多步串行远端调用（建项目 → 逐条探测素材 → 逐镜头 TTS
   *   → 上传全部字节 → 排轨），而任务进度只有在启动**返回之后**才会被
   *   `storeChatCutState` 从 5% 改成 30%/60%。不报阶段的话，整个启动期间进度钉死在 5%，
   *   用户看到的就是「一直卡在合成中 5%」。
   *
   * 回调只做可观测性：打日志/写库失败**不能让启动流程失败**（见 driver 里的 safePhase）。
   */
  onPhase?: (info: { ratio: number; label: string }) => void
}

export interface ChatCutJobResult {
  externalJobId: string
  projectId?: string
  editorUrl?: string
  status: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED'
  resultUrl?: string
  resultKey?: string
  errorMessage?: string
}

interface McpResponse<T> {
  jsonrpc: '2.0'
  id?: number | string | null
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>
  structuredContent?: unknown
  isError?: boolean
}

let requestId = 0
let refreshInFlight: Promise<string> | null = null
let memoryToken: { accessToken: string; expiresAtMs: number } | null = null

const TOKEN_CACHE_KEY = 'dashuai:chatcut:oauth:access-token'
const REFRESH_CACHE_KEY = 'dashuai:chatcut:oauth:refresh-token'
const REFRESH_LOCK_KEY = 'dashuai:chatcut:oauth:refresh-lock'

interface OAuthTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number | string
  token_type?: string
  error?: string
  error_description?: string
}

function endpoint(): string {
  return process.env.CHATCUT_MCP_URL?.trim() || 'https://api.chatcut.io/api/external-mcp/mcp'
}

function refreshConfigured(): boolean {
  return Boolean(process.env.CHATCUT_OAUTH_TOKEN_URL?.trim() && (process.env.CHATCUT_OAUTH_REFRESH_TOKEN?.trim() || memoryToken))
}

function tokenRefreshSkewMs(): number {
  return Math.max(30_000, Number(process.env.CHATCUT_OAUTH_REFRESH_SKEW_SECONDS ?? 300) * 1000)
}

function envAccessToken(): string | null {
  return process.env.CHATCUT_MCP_ACCESS_TOKEN?.trim() || null
}

function envAccessTokenExpiryMs(): number {
  const raw = process.env.CHATCUT_MCP_ACCESS_TOKEN_EXPIRES_AT?.trim()
  if (!raw) return Number.POSITIVE_INFINITY
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

async function readCachedAccessToken(): Promise<{ accessToken: string; expiresAtMs: number } | null> {
  if (memoryToken && memoryToken.expiresAtMs - tokenRefreshSkewMs() > Date.now()) return memoryToken
  try {
    const raw = await redis.get(TOKEN_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { accessToken?: string; expiresAtMs?: number }
    if (!parsed.accessToken || !parsed.expiresAtMs || parsed.expiresAtMs - tokenRefreshSkewMs() <= Date.now()) return null
    memoryToken = { accessToken: parsed.accessToken, expiresAtMs: parsed.expiresAtMs }
    return memoryToken
  } catch (error) {
    console.warn('[chatcut] Redis token cache unavailable:', (error as Error).message)
    return null
  }
}

async function readRefreshToken(): Promise<string | null> {
  try {
    const cached = await redis.get(REFRESH_CACHE_KEY)
    if (cached) return cached
  } catch (error) {
    console.warn('[chatcut] Redis refresh-token cache unavailable:', (error as Error).message)
  }
  return process.env.CHATCUT_OAUTH_REFRESH_TOKEN?.trim() || null
}

async function storeTokens(value: OAuthTokenResponse): Promise<string> {
  const accessToken = value.access_token?.trim()
  if (!accessToken) throw new Error('ChatCut OAuth 刷新响应缺少 access_token')
  const expiresIn = Math.max(60, Number(value.expires_in ?? 3600))
  const expiresAtMs = Date.now() + expiresIn * 1000
  memoryToken = { accessToken, expiresAtMs }
  tokenProvenInMemory = true
  try {
    await redis.set(TOKEN_CACHE_KEY, JSON.stringify(memoryToken), 'PX', expiresIn * 1000)
    if (value.refresh_token?.trim()) await redis.set(REFRESH_CACHE_KEY, value.refresh_token.trim())
  } catch (error) {
    console.warn('[chatcut] Redis token persistence unavailable:', (error as Error).message)
  }
  return accessToken
}

async function performTokenRefresh(): Promise<string> {
  const tokenUrl = process.env.CHATCUT_OAUTH_TOKEN_URL?.trim()
  const refreshToken = await readRefreshToken()
  if (!tokenUrl || !refreshToken) throw new ChatCutNotConfiguredError('ChatCut OAuth 授权已失效，且未配置 token 刷新端点或 refresh token')

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  const clientId = process.env.CHATCUT_OAUTH_CLIENT_ID?.trim()
  const clientSecret = process.env.CHATCUT_OAUTH_CLIENT_SECRET?.trim()
  if (clientId) body.set('client_id', clientId)
  if (clientSecret) body.set('client_secret', clientSecret)

  let response: Response
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(Number(process.env.CHATCUT_OAUTH_TIMEOUT_MS ?? 15_000)),
    })
  } catch (error) {
    throw new Error(`ChatCut OAuth token 刷新网络失败：${(error as Error).message}`)
  }
  const raw = await response.text()
  let value: OAuthTokenResponse
  try {
    value = JSON.parse(raw) as OAuthTokenResponse
  } catch {
    throw new Error(`ChatCut OAuth token 刷新响应无法解析（HTTP ${response.status}）`)
  }
  if (!response.ok || value.error) {
    throw new Error(`ChatCut OAuth token 刷新失败（HTTP ${response.status}）：${value.error_description || value.error || 'unknown_error'}`)
  }
  return storeTokens(value)
}

async function refreshAccessTokenSingleFlight(): Promise<string> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const owner = randomUUID()
    let locked = false
    try {
      try {
        locked = (await redis.set(REFRESH_LOCK_KEY, owner, 'PX', 20_000, 'NX')) === 'OK'
      } catch (error) {
        console.warn('[chatcut] Redis refresh lock unavailable, using process lock:', (error as Error).message)
        locked = true
      }
      if (locked) {
        try {
          const token = await performTokenRefresh()
          markRefreshResult(null)
          return token
        } catch (error) {
          // 留痕后再抛 —— 调用方（worker / 能力表探测）的行为不变，只是多了一份可观测性
          markRefreshResult(error as Error)
          throw error
        }
      }

      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const cached = await readCachedAccessToken()
        if (cached) return cached.accessToken
      }
      const timeoutError = new Error('等待其他实例刷新 ChatCut access token 超时')
      markRefreshResult(timeoutError)
      throw timeoutError
    } finally {
      if (locked) {
        try {
          await redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            REFRESH_LOCK_KEY,
            owner,
          )
        } catch {
          // 锁有短 TTL；Redis 不可用时无需阻断业务错误处理。
        }
      }
    }
  })().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

async function accessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = await readCachedAccessToken()
    if (cached) return cached.accessToken
    const envToken = envAccessToken()
    if (envToken && envAccessTokenExpiryMs() - tokenRefreshSkewMs() > Date.now()) return envToken
  }
  if (refreshConfigured() || process.env.CHATCUT_OAUTH_REFRESH_TOKEN?.trim()) return refreshAccessTokenSingleFlight()
  const token = envAccessToken()
  if (!token) throw new ChatCutNotConfiguredError()
  if (forceRefresh) throw new ChatCutNotConfiguredError('ChatCut MCP access token 已失效，且未配置 OAuth 自动续期')
  return token
}

export class ChatCutNotConfiguredError extends Error {
  constructor(message = 'ChatCut MCP 尚未授权，请配置 CHATCUT_MCP_ACCESS_TOKEN 或 OAuth refresh token') {
    super(message)
    this.name = 'ChatCutNotConfiguredError'
  }
}

/** 本进程内成功换过一次 token ⇒ 即便 .env 里只有 Redis 才有 refresh token，也算有凭证 */
let tokenProvenInMemory = false

/**
 * 最近一次 token 刷新的结果 —— **只记结果，不记原文**（错误原文含产品名/HTTP 报文，不能外露）。
 *
 * ★ 为什么需要它（2026-09-21）：`chatCutConfigured()` 原本**只检查「环境变量在不在」**，
 *   所以 refresh_token 一旦在 ChatCut 侧被作废，能力表照样返回 `available=true`、小程序照样
 *   放开 AI 档 ⇒ 商户点了提交（通过）、**冻结了积分**、等上几分钟，才在 worker 里失败。
 *   这是最难查的一类故障：**档位明明可点，一点就失败**，而且没有任何告警。
 *   把「最近一次刷新成没成、是哪类失败」留在这里，就能让能力表提前反映出来（见 chatCutConfigured）。
 *
 * ★ 为什么只认 `auth` 类：`invalid_grant` / 401 / 403 表示授权**确定性地坏了**（不会自愈），
 *   这时候置灰是对的。网络类失败（fetch failed / 超时）自己会好，把它算进去会让档位
 *   莫名其妙地灰掉，反而更糟 —— 所以只做留痕、不参与可用性判定。
 */
let lastRefresh: { ok: boolean; atMs: number; kind: RefreshFailureKind } | null = null

type RefreshFailureKind = 'auth' | 'network' | 'other'

/** 分类失败原因。只返回类别，不返回原文 —— 调用方要展示给运维看（能力表不鉴权）。 */
function classifyRefreshFailure(message: string): RefreshFailureKind {
  if (/invalid_grant|unauthorized|\b401\b|\b403\b|授权|鉴权/i.test(message)) return 'auth'
  if (/network|fetch failed|timeout|超时|ECONN|EAI_AGAIN|socket/i.test(message)) return 'network'
  return 'other'
}

function markRefreshResult(error: Error | null): void {
  lastRefresh = error
    ? { ok: false, atMs: Date.now(), kind: classifyRefreshFailure(error.message) }
    : { ok: true, atMs: Date.now(), kind: 'other' }
}

/**
 * 给运维看的通道健康位（**不含任何凭证或错误原文**）。
 * 挂在 `/api/v1/render/capabilities` 上，因为那条接口不鉴权、随时可 curl。
 */
export interface ChatCutHealth {
  /** 环境变量是否齐全（= 是否配过，不代表有效） */
  configured: boolean
  /** 最近一次 token 刷新结果；null = 本进程还没刷新过（刚重启） */
  lastRefresh: { ok: boolean; kind: RefreshFailureKind; agoSec: number } | null
  /** 当前判定结论，与 chatCutConfigured() 一致 */
  usable: boolean
  /**
   * 「配乐」档位是否可用 —— 配乐 = 调 `submit_music` 生成音乐，**消耗 ChatCut 额度**，
   * 所以留了 `CHATCUT_BGM_ENABLED` 这个运维开关。小程序据此置灰「配乐」那一栏，
   * 而不是让用户选了之后才收到一句「本次无背景音乐」。
   */
  bgmEnabled: boolean
}

export function chatCutHealth(): ChatCutHealth {
  return {
    configured: credentialPresent(),
    lastRefresh: lastRefresh
      ? { ok: lastRefresh.ok, kind: lastRefresh.kind, agoSec: Math.round((Date.now() - lastRefresh.atMs) / 1000) }
      : null,
    usable: chatCutConfigured(),
    bgmEnabled: process.env.CHATCUT_BGM_ENABLED?.trim().toLowerCase() === 'true',
  }
}

function credentialPresent(): boolean {
  return Boolean(
    tokenProvenInMemory ||
      envAccessToken() ||
      (process.env.CHATCUT_OAUTH_TOKEN_URL?.trim() && process.env.CHATCUT_OAUTH_REFRESH_TOKEN?.trim()),
  )
}

/**
 * 外部剪辑（AI 档）通道是否可用。
 *
 * ★ 语义已于 2026-09-17 改写。旧判据要求「凭证 + `CHATCUT_MCP_SUBMIT_TOOL` + `CHATCUT_MCP_STATUS_TOOL` 三样齐全」，
 *   而这两个环境变量源自一个**错误假设**：以为 ChatCut 有一个「吃下整片配置、吐出一个 jobId」的工具。
 *   实测 `tools/list` 的 59 个工具里**没有这样的工具**，ChatCut 是「多步驱动云端编辑器」。
 *   ⇒ 继续按工具名判可用性，只会把「配不上」当成「不可用」，或者更糟：填两个名字让它「看起来可用」，
 *   结果 AI 档从「直接置灰」变成「可点但一点就失败」。
 *
 * 新判据 = 有凭证 ∧ 适配层没被显式关掉。
 * `CHATCUT_ADAPTER_ENABLED=false` 是**运维急停开关**（额度异常 / 商务条款未谈拢时一键停 AI 档，
 * 不必去删凭证）。关掉后：能力表 available=false、提交时 409/4013、worker 侧也不会进 ChatCut 分支。
 */
export function chatCutConfigured(): boolean {
  // 注意：这里必须读原始环境变量，不能调会抛错的取配置函数 ——
  // 否则「是否可用」判断会变成抛异常，调用方（/system/settings 探测、能力表）会 500。
  if (process.env.CHATCUT_ADAPTER_ENABLED?.trim().toLowerCase() === 'false') return false
  // ★ 2026-09-21 新增：**已知授权失效**时也判不可用（动机见上面 lastRefresh 的注释）。
  //   只认 `auth` 类 —— 授权坏了是确定性的、不会自愈；网络抖动会自己好，不能拿来置灰。
  //   ⚠ 冷启动（进程刚起、lastRefresh 为 null）时维持原语义（只看环境变量），
  //     因为「还没试过」不等于「不可用」。
  //   ⚠ 代价：手上若还有未过期的 access_token（最长 1 小时），本可以继续出片，
  //     这里也会置灰。这是**有意为之** —— 授权已废的通道注定会坏，提前让商户换基础档，
  //     好过让他提交、冻结积分、等几分钟再失败。
  if (lastRefresh && !lastRefresh.ok && lastRefresh.kind === 'auth') return false
  return credentialPresent()
}

async function rpc<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
  let response: Response
  let token = await accessToken()
  try {
    response = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'x-chatcut-mcp-surface': process.env.CHATCUT_MCP_SURFACE?.trim() || 'codex',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`ChatCut MCP 网络请求失败：${(error as Error).message}`)
  }
  if ((response.status === 401 || response.status === 403) && (refreshConfigured() || process.env.CHATCUT_OAUTH_REFRESH_TOKEN?.trim())) {
    token = await accessToken(true)
    try {
      response = await fetch(endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'x-chatcut-mcp-surface': process.env.CHATCUT_MCP_SURFACE?.trim() || 'codex',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new Error(`ChatCut MCP 重试网络请求失败：${(error as Error).message}`)
    }
  }
  const raw = await response.text()
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('ChatCut MCP 授权失效，请配置有效 OAuth refresh token')
    }
    throw new Error(`ChatCut MCP HTTP ${response.status}: ${raw.slice(0, 300)}`)
  }
  const line = raw
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.startsWith('data:'))
  const jsonText = line ? line.slice(5).trim() : raw
  let payload: McpResponse<T>
  try {
    payload = JSON.parse(jsonText) as McpResponse<T>
  } catch {
    throw new Error(`ChatCut MCP 返回了无法解析的响应：${raw.slice(0, 300)}`)
  }
  if (payload.error) throw new Error(`ChatCut MCP ${payload.error.code}: ${payload.error.message}`)
  if (payload.result === undefined) throw new Error('ChatCut MCP 响应缺少 result')
  return payload.result
}

export async function listChatCutTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
  const result = await rpc<{ tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }>('tools/list')
  return result.tools ?? []
}

/**
 * 从 tools/call 的结果里取出**工具结果本体**。
 *
 * ★ 实测（2026-09-17）踩到的坑：结果里有两个地方可能放数据 ——
 *   `content[].text`（工具真正的返回，通常是一段 JSON 字符串）
 *   与 `structuredContent`（**宿主/编辑器上下文**，含 `browserHandoff`、
 *   `status:"active-project"`、`surface:"editor-workbench"` 这类字段）。
 *   原实现优先取 `structuredContent`，于是 `track_export` 读到的 `status` 是
 *   `"active-project"` —— 既不是 SUCCESS 也不是 FAILED ⇒ 被判成「还在跑」，
 *   成片其实 23 秒就出来了，轮询却永远不结束（两轮冒烟都卡死在这里）。
 * ⇒ 优先级必须是「先 content[].text，再 structuredContent」。
 */
function extractStructured(result: McpToolResult): Record<string, unknown> {
  if (result.isError) {
    const message = result.content?.map((item) => item.text).filter(Boolean).join('\n') || 'ChatCut 工具执行失败'
    throw new Error(message)
  }
  const text = result.content?.map((item) => item.text).filter(Boolean).join('\n') || ''
  const structured = result.structuredContent && typeof result.structuredContent === 'object'
    ? (result.structuredContent as Record<string, unknown>)
    : null

  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) {
        // ⚠ 有的工具回的是**数组**（`edit_track action=list` 就是轨道数组）。
        //   早先这里只接对象、把数组也塞进 message，等于把结构化数据降级成了字符串。
        //   统一包成 { items }，调用方按 items 取；原文留在 message 里备正则兜底。
        return { items: parsed as unknown[], message: text }
      }
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 不是 JSON：ChatCut 有一部分工具回的是给 LLM 看的人话
      // （例如 submit_export 的 "Submitted export.\n  renderId: xxx"）。
      // 这类情况必须把原文留成 message，让上层用正则兜底，不能只吞结构化字段。
    }
  }
  if (structured) return text ? { ...structured, message: text } : structured
  return text ? { message: text } : {}
}

/**
 * 调一个 ChatCut 工具并取回结构化结果。
 * 导出给 `chatcut-driver.ts` / 自检脚本用 —— 适配层之所以能拆出去，
 * 是因为「鉴权 + JSON-RPC」这一层是好的，坏的只有上面那层 job 抽象。
 */
export async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await rpc<McpToolResult>('tools/call', { name, arguments: args }, Number(process.env.CHATCUT_MCP_TIMEOUT_MS ?? 120_000))
  return extractStructured(result)
}

// ─────────────────────────────────────────────────────────────────────────────
// ★ 原来的 `submitChatCutJob()` / `getChatCutJob()` 已删除（2026-09-17）。
//
// 它们按「提交一个作业 → 拿 jobId → 轮询 jobId」发请求，而 ChatCut 没有这种接口：
//   submitChatCutJob 发的 10 个字段（idempotencyKey/projectName/source/keywords/render/
//     voice/captions/audio/editing/clips）真实工具一个都不认；
//   getChatCutJob 发的 { jobId } 同样不认。
// 留着它只会让「AI 档为什么一点就失败」变得更难查，所以删掉而不是标注 deprecated。
//
// 真正的多步驱动在 `./chatcut-driver.ts`：
//   startChatCutRender() / pollChatCutRender()
// 本文件只负责三件事：取 token（含 OAuth 刷新与单飞锁）、发 JSON-RPC（callTool）、
// 以及对外声明「AI 档现在能不能用」（chatCutConfigured）。
// ─────────────────────────────────────────────────────────────────────────────
