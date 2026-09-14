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

function submitTool(): string {
  const value = process.env.CHATCUT_MCP_SUBMIT_TOOL?.trim()
  if (!value) throw new ChatCutToolMappingError('缺少 CHATCUT_MCP_SUBMIT_TOOL，完成 OAuth 后请按 tools/list 返回值配置')
  return value
}

function statusTool(): string | null {
  return process.env.CHATCUT_MCP_STATUS_TOOL?.trim() || null
}

export class ChatCutNotConfiguredError extends Error {
  constructor(message = 'ChatCut MCP 尚未授权，请配置 CHATCUT_MCP_ACCESS_TOKEN 或 OAuth refresh token') {
    super(message)
    this.name = 'ChatCutNotConfiguredError'
  }
}

export class ChatCutToolMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatCutToolMappingError'
  }
}

export function chatCutConfigured(): boolean {
  return Boolean(
    (envAccessToken() || process.env.CHATCUT_OAUTH_REFRESH_TOKEN?.trim()) &&
      process.env.CHATCUT_MCP_SUBMIT_TOOL?.trim(),
  )
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

function extractStructured(result: McpToolResult): Record<string, unknown> {
  if (result.isError) {
    const message = result.content?.map((item) => item.text).filter(Boolean).join('\n') || 'ChatCut 工具执行失败'
    throw new Error(message)
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as Record<string, unknown>
  }
  const text = result.content?.map((item) => item.text).filter(Boolean).join('\n') || ''
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { message: text }
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await rpc<McpToolResult>('tools/call', { name, arguments: args }, Number(process.env.CHATCUT_MCP_TIMEOUT_MS ?? 120_000))
  return extractStructured(result)
}

function mapJob(value: Record<string, unknown>, fallbackId: string): ChatCutJobResult {
  const rawStatus = String(value.status ?? value.state ?? 'QUEUED').toUpperCase()
  const status: ChatCutJobResult['status'] = rawStatus === 'SUCCESS' || rawStatus === 'COMPLETED'
    ? 'SUCCESS'
    : rawStatus === 'FAILED' || rawStatus === 'ERROR'
      ? 'FAILED'
      : rawStatus === 'RUNNING' || rawStatus === 'PROCESSING'
        ? 'RUNNING'
        : 'QUEUED'
  return {
    externalJobId: String(value.jobId ?? value.job_id ?? value.taskId ?? value.task_id ?? fallbackId),
    projectId: value.projectId ? String(value.projectId) : value.project_id ? String(value.project_id) : undefined,
    editorUrl: value.editorUrl ? String(value.editorUrl) : value.editor_url ? String(value.editor_url) : undefined,
    status,
    resultUrl: value.resultUrl ? String(value.resultUrl) : value.result_url ? String(value.result_url) : undefined,
    resultKey: value.resultKey ? String(value.resultKey) : value.result_key ? String(value.result_key) : undefined,
    errorMessage: value.errorMessage ? String(value.errorMessage) : value.error ? String(value.error) : undefined,
  }
}

export async function submitChatCutJob(input: ChatCutJobInput): Promise<ChatCutJobResult> {
  const value = await callTool(submitTool(), {
    idempotencyKey: `dashuai-render-${input.taskId}`,
    projectName: input.title,
    source: 'dashuai-mini-program',
    keywords: input.options.note,
    render: {
      aspectRatio: '9:16',
      width: input.output.width,
      height: input.output.height,
      fps: input.output.fps,
    },
    voice: { presetId: input.options.voiceId },
    captions: { enabled: input.options.subtitles, style: input.options.subtitleStyle },
    audio: { bgm: input.options.bgm, normalize: input.options.normalizeAudio },
    editing: {
      pacing: input.options.pacing,
      transitions: input.options.transitions,
      removeSilence: input.options.removeSilence,
    },
    clips: input.clips,
  })
  return mapJob(value, input.taskId)
}

export async function getChatCutJob(externalJobId: string): Promise<ChatCutJobResult> {
  const tool = statusTool()
  if (!tool) throw new ChatCutToolMappingError('缺少 CHATCUT_MCP_STATUS_TOOL，无法轮询 ChatCut 任务')
  const value = await callTool(tool, { jobId: externalJobId })
  return mapJob(value, externalJobId)
}
