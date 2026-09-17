import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { redis } from '../db.js'

export const CHATCUT_VOICES = [
  { id: 'warm-female', name: '温暖女声', description: '自然亲切，适合探店种草' },
  { id: 'bright-female', name: '活力女声', description: '节奏明快，适合促销上新' },
  { id: 'gentle-male', name: '温和男声', description: '沉稳自然，适合品牌介绍' },
  { id: 'magnetic-male', name: '磁性男声', description: '质感突出，适合品质表达' },
  { id: 'energetic-youth', name: '活力青年', description: '轻快有冲劲，适合同城引流' },
] as const

export const ChatCutOptionsSchema = z.object({
  voiceId: z.enum(CHATCUT_VOICES.map((voice) => voice.id) as [string, ...string[]]),
  subtitles: z.boolean(),
  subtitleStyle: z.enum(['CLEAN', 'EMPHASIS', 'SOCIAL']),
  bgm: z.enum(['NONE', 'LIGHT', 'UPBEAT', 'PREMIUM']),
  pacing: z.enum(['NATURAL', 'FAST', 'STORY']),
  transitions: z.enum(['CLEAN', 'SMOOTH', 'DYNAMIC']),
  removeSilence: z.boolean(),
  normalizeAudio: z.boolean(),
  note: z.string().trim().max(300),
})

export type ChatCutOptions = z.infer<typeof ChatCutOptionsSchema>

export const DEFAULT_CHATCUT_OPTIONS: ChatCutOptions = {
  voiceId: 'warm-female',
  subtitles: true,
  subtitleStyle: 'CLEAN',
  bgm: 'LIGHT',
  pacing: 'NATURAL',
  transitions: 'CLEAN',
  removeSilence: true,
  normalizeAudio: true,
  note: '',
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
      if (locked) return await performTokenRefresh()

      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const cached = await readCachedAccessToken()
        if (cached) return cached.accessToken
      }
      throw new Error('等待其他实例刷新 ChatCut access token 超时')
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
