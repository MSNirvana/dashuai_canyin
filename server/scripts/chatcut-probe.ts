/**
 * ChatCut MCP 通道自检 & 工具名探测器 —— **只读**：不写库、不创建任何剪辑任务。
 *   ★ 唯一的例外：若 ChatCut 在刷新时**轮换了** refresh_token，会把它写回 server/.env
 *     —— 不写就永久丢失、只能重走浏览器授权。详见 persistRotatedRefreshToken()。
 *
 * 为什么需要它（2026-09-17 建，2026-09-21 随判据变更修订）：
 *   AI 档（外部剪辑）走 ChatCut MCP。`chatCutConfigured()` 的判据是
 *   **有凭证 ∧ 没被 `CHATCUT_ADAPTER_ENABLED=false` 关掉**（★ 不再看工具名，见下）。
 *   本脚本要回答的问题是「AI 档为什么没开 / 开了之后到底能不能出片」：
 *     ① 凭证是否有效（真换一次 access token）；
 *     ② `chatCutConfigured()` 会返回什么（逐项列出**参与判定的**变量）；
 *     ③ 驱动依赖的工具名是否都还在 ChatCut 上（ChatCut 改了名 ⇒ 跑到那一步才炸）。
 *
 * 用法（两种都支持）：
 *   ① 读 .env 里既有的配置：        npx tsx scripts/chatcut-probe.ts
 *   ② 临时拿一个 token 先试、不落盘： CHATCUT_MCP_ACCESS_TOKEN=xxx npx tsx scripts/chatcut-probe.ts
 *      （安全：只把 token 放进当前进程的环境变量，脚本不会写进任何文件）
 *
 * ★ 它顺手验证一个**代码里的隐含假设**：
 *   `src/render/chatcut.ts::rpc()` **从不发 `initialize`**，而是直接 POST `tools/list`。
 *   多数 MCP server 允许这样，但规范并不保证（有的要求先握手拿 session id）。
 *   本脚本「先 initialize 再 tools/list」和「直接 tools/list」两种都打一遍并对比 ——
 *   若前者成功、后者失败，说明生产代码必须补握手；症状会是「探测一切正常、线上一直失败」。
 *
 * ★ 另一处同样重要的对照（2026-09-21 改写）：**驱动实际调用的工具名是否还在**。
 *   旧版这段是拿 `submitChatCutJob()` 那 10 个字段去和真实工具对照 —— 但那个函数
 *   2026-09-17 已经删除了，照抄的字段清单只会得出「需要改代码」这个**早已完成**的结论。
 *   现在改为**运行时扫** `src/render/chatcut-driver.ts` 里的 `callTool('<name>'`，
 *   与真实 `tools/list` 求差集：缺哪个，就是哪一步会在运行时炸（而不是启动时就报）。
 */
import 'dotenv/config'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENDPOINT = (process.env.CHATCUT_MCP_URL ?? '').trim() || 'https://api.chatcut.io/api/external-mcp/mcp'
const SURFACE = (process.env.CHATCUT_MCP_SURFACE ?? '').trim() || 'codex'
const MCP_TIMEOUT_MS = Number(process.env.CHATCUT_MCP_TIMEOUT_MS ?? 120_000)
const OAUTH_TIMEOUT_MS = Number(process.env.CHATCUT_OAUTH_TIMEOUT_MS ?? 15_000)

/**
 * `--tool=<名字>[,<名字>...]`（也支持 `--tool <名字>`）——
 * 只打印指定工具的**完整 description + inputSchema**，然后退出。
 *
 * 为什么需要它：⑤ 节默认把 description 截断到 90 字符、且完全不打印 inputSchema，
 * 那个粒度够用来「认工具」，**不够用来写适配代码**。
 * 而适配层（`src/render/chatcut-driver.ts`）的每个字段都必须按真实 schema 落 —— 猜字段名的
 * 代价就是这个项目已经踩过一次的坑（早期作业式适配器那 10 个字段真实工具一个都不认，已删除）。
 */
const WANT_TOOLS = process.argv
  .slice(2)
  .flatMap((arg, index, all) => {
    if (arg.startsWith('--tool=')) return arg.slice('--tool='.length).split(',')
    const next = all[index + 1]
    if (arg === '--tool' && next) return next.split(',')
    return []
  })
  .map((name) => name.trim())
  .filter(Boolean)

/** RFC 9728 受保护资源元数据。未授权响应的 www-authenticate 头就是指向它，所以不用猜。 */
const PROTECTED_RESOURCE_METADATA =
  'https://api.chatcut.io/.well-known/oauth-protected-resource/api/external-mcp/mcp'

/**
 * 本脚本**不 import `src/render/chatcut.ts`**，是刻意的：
 * 那个模块会连带加载 `src/db.js`（PrismaClient + ioredis）——「通道坏了」的场景里
 * 数据库/Redis 很可能也起不来，一 import 就整脚本挂掉，恰好在最需要它的时候失效。
 * 代价是下面的判定规则与 `chatCutConfigured()` 重复了一份：
 * ★ 改动 `src/render/chatcut.ts::chatCutConfigured()` 的判定条件时，**必须同步改这里**。
 *
 * ⚠ 2026-09-21：这条「手工同步」的契约**已经翻过一次车**。2026-09-17 把判据从
 *   「凭证 + CHATCUT_MCP_SUBMIT_TOOL + CHATCUT_MCP_STATUS_TOOL 三样齐全」改成
 *   「有凭证 ∧ 没被 CHATCUT_ADAPTER_ENABLED=false 关掉」，但没同步改本脚本 —— 于是它在
 *   **凭证完全正确**的情况下仍然打印「chatCutConfigured() = false / 现在是半配置」，
 *   把「AI 档为什么没开」的判断直接带反；而同一个脚本的 ⑧ 段又在说「不要填工具名」，自相矛盾。
 *   ⇒ 教训：**凡是「照抄一份判据」的地方，就是最容易过时的地方。能现场从源码/接口取事实的，
 *     就别抄** —— ⑦ 段的驱动工具核对就是这么改的（运行时扫 chatcut-driver.ts）。
 */

/** 直接打印值的变量（它们不是秘密，打印出来才有诊断价值） */
const PLAIN_VARS = [
  'CHATCUT_MCP_URL',
  'CHATCUT_MCP_SURFACE',
  'CHATCUT_OAUTH_TOKEN_URL',
  // 急停开关：一旦为 false，凭证再全也会被判不可用。属于判定的一部分，必须能看见。
  'CHATCUT_ADAPTER_ENABLED',
  // ↓ 这两个自 2026-09-17 起**已作废**（旧作业式适配器 submitChatCutJob/getChatCutJob 已删除）。
  //   留在打印列表里是为了让「有人照旧文档填了它们」这件事被看见 —— ② 段会单独告警。它们不该有值。
  'CHATCUT_MCP_SUBMIT_TOOL',
  'CHATCUT_MCP_STATUS_TOOL',
  'CHATCUT_MCP_ACCESS_TOKEN_EXPIRES_AT',
  'CHATCUT_OAUTH_REFRESH_SKEW_SECONDS',
  'CHATCUT_OAUTH_TIMEOUT_MS',
  'CHATCUT_MCP_TIMEOUT_MS',
] as const

/**
 * 代码里带默认值的变量。**必须打印默认值** ——
 * 否则 `.env` 里留空会显示成「（空）」，看的人会以为「没配」，
 * 而实际生效的是默认值（例如 endpoint 与 surface 就是靠默认值工作的）。
 */
const FALLBACKS: Record<string, string> = {
  CHATCUT_MCP_URL: 'https://api.chatcut.io/api/external-mcp/mcp',
  CHATCUT_MCP_SURFACE: 'codex',
  CHATCUT_OAUTH_REFRESH_SKEW_SECONDS: '300',
  CHATCUT_OAUTH_TIMEOUT_MS: '15000',
  CHATCUT_MCP_TIMEOUT_MS: '120000',
}

function plainState(key: string): string {
  const value = env(key)
  if (value) return value
  const fallback = FALLBACKS[key]
  return fallback ? `（空 ⇒ 生效默认值 ${fallback}）` : '（空）'
}

/** 只打印「是否设置 + 长度」的变量 */
const SECRET_VARS = [
  'CHATCUT_MCP_ACCESS_TOKEN',
  'CHATCUT_OAUTH_REFRESH_TOKEN',
  'CHATCUT_OAUTH_CLIENT_ID',
  'CHATCUT_OAUTH_CLIENT_SECRET',
] as const

// ★ 原 `OUR_SUBMIT_ARGS`（idempotencyKey/projectName/source/...）与 `OUR_STATUS_ARGS`（jobId）
//   已于 2026-09-21 删除：它们照抄自**已删除**的作业式适配器（submitChatCutJob / getChatCutJob），
//   留着只会让 ⑦ 段拿一套不存在的字段去和真实工具对照，得出「需要改代码」这个**早已完成**的结论。
//   现在核对的是「驱动实际调用的工具名是否还在 ChatCut 上」，见 ⑦ 段的 readDriverTools()。

let rpcId = 0

interface McpCall {
  status: number
  sessionId: string | null
  payload: Record<string, unknown> | null
  raw: string
}

interface ToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown> | null
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 58 - title.length))}`)
}

function env(key: string): string {
  return (process.env[key] ?? '').trim()
}

function secretState(key: string): string {
  const value = env(key)
  return value ? `已设置（${value.length} 字符，值已隐去）` : '（空）'
}

/** MCP 既可能回 JSON，也可能回 text/event-stream；生产代码也是先找 `data:` 行。 */
function jsonRpcText(raw: string): string {
  const sse = raw
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.startsWith('data:'))
  return sse ? sse.slice(5).trim() : raw
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(jsonRpcText(raw)) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function errorOf(payload: Record<string, unknown> | null): string | null {
  const error = payload?.error
  if (!error || typeof error !== 'object') return null
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : JSON.stringify(error)
}

function toolsOf(payload: Record<string, unknown> | null): ToolInfo[] {
  const result = payload?.result
  if (!result || typeof result !== 'object') return []
  const tools = (result as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((item): ToolInfo[] => {
    if (!item || typeof item !== 'object') return []
    const { name, description, inputSchema } = item as Record<string, unknown>
    if (typeof name !== 'string') return []
    return [
      {
        name,
        description: typeof description === 'string' ? description : '',
        inputSchema: inputSchema && typeof inputSchema === 'object' ? (inputSchema as Record<string, unknown>) : null,
      },
    ]
  })
}

/** 打印一次 MCP 调用的一行结果（状态码 + 错误或结果摘要） */
function reportCall(label: string, call: McpCall): void {
  const err = errorOf(call.payload)
  if (call.status !== 200) {
    console.log(`✗ ${label}：HTTP ${call.status} —— ${err ?? jsonRpcText(call.raw).slice(0, 200)}`)
    return
  }
  if (err) {
    console.log(`✓ ${label}：HTTP 200，但 JSON-RPC error —— ${err}`)
    return
  }
  console.log(
    `✓ ${label}：HTTP 200${call.sessionId ? `，session=${call.sessionId.slice(0, 8)}…` : '，无 session 头'}`,
  )
}

async function mcpCall(token: string, method: string, params: unknown, sessionId: string | null): Promise<McpCall> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
    'x-chatcut-mcp-surface': SURFACE,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
  })
  const raw = await response.text()
  return { status: response.status, sessionId: response.headers.get('mcp-session-id'), payload: parsePayload(raw), raw }
}

/**
 * 把轮换后的 refresh_token 写回 server/.env。
 *
 * ★ 为什么一个「只读探测脚本」在这里破例写文件：
 *   OAuth 允许授权服务器在刷新时**轮换** refresh_token（旧值随即作废）。
 *   生产代码 `chatcut.ts::storeTokens()` 会把新值存进 Redis，服务端不受影响；
 *   但本脚本**既不连 Redis 也不写 .env** ⇒ 一旦 ChatCut 真的轮换，
 *   旧值当场失效、而新值若只打印成一句「已轮换」就**永久丢失**，只能重走浏览器授权。
 *   ⇒ 所以这是本脚本**唯一**的写操作，只写这一个 key，目的就是别把刚拿到的凭证弄丢。
 *   实现与 `chatcut-authorize.ts::writeEnvLines()` 一致：已有同名行**替换**，否则追加，
 *   `.env` 里其他配置不受影响。
 */
async function persistRotatedRefreshToken(value: string): Promise<void> {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env')
  let content = ''
  try {
    content = await readFile(envPath, 'utf8')
  } catch {
    console.log('  ⚠ 读不到 server/.env，无法自动写回。请手工把下面这个值填进 CHATCUT_OAUTH_REFRESH_TOKEN：')
    console.log(`    ${value}`)
    return
  }
  const line = `CHATCUT_OAUTH_REFRESH_TOKEN="${value}"`
  const pattern = /^\s*CHATCUT_OAUTH_REFRESH_TOKEN\s*=.*$/m
  const next = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.replace(/\n*$/, '\n')}${line}\n`
  await writeFile(envPath, next)
  console.log('  ✓ 已把轮换后的 refresh_token 写回 server/.env')
  console.log('  ⚠ 服务端若在运行，Redis 里可能还压着旧值 ⇒ 改完记得 touch src/index.ts 重启')
}

/**
 * 拿到一个可用的 access token。两条路：
 *   ① 静态 `CHATCUT_MCP_ACCESS_TOKEN`（最省事，适合内部试用）
 *   ② 用 `CHATCUT_OAUTH_REFRESH_TOKEN` 现场换一个（生产推荐，能自动续期）
 * 走 ② 时顺手也验证了「刷新端点 + client 凭据」这批配置 —— 生产代码只会在
 * access token 进入刷新窗口时才做这件事，配错了可能几小时后才暴露。
 */
async function acquireToken(): Promise<string | null> {
  const staticToken = env('CHATCUT_MCP_ACCESS_TOKEN')
  if (staticToken) {
    console.log('凭证来源：CHATCUT_MCP_ACCESS_TOKEN（静态）')
    return staticToken
  }

  const refreshToken = env('CHATCUT_OAUTH_REFRESH_TOKEN')
  const tokenUrl = env('CHATCUT_OAUTH_TOKEN_URL')
  if (!refreshToken || !tokenUrl) return null

  console.log(`凭证来源：OAuth refresh_token 交换（${tokenUrl}）`)
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  if (env('CHATCUT_OAUTH_CLIENT_ID')) body.set('client_id', env('CHATCUT_OAUTH_CLIENT_ID'))
  if (env('CHATCUT_OAUTH_CLIENT_SECRET')) body.set('client_secret', env('CHATCUT_OAUTH_CLIENT_SECRET'))

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  })
  const raw = await response.text()
  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(raw) as unknown
    parsed = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    parsed = null
  }
  const accessToken = typeof parsed?.access_token === 'string' ? parsed.access_token : ''
  if (!response.ok || !accessToken) {
    console.log(`✗ refresh_token 交换失败（HTTP ${response.status}）：${raw.slice(0, 300)}`)
    return null
  }
  const expiresIn = String(parsed?.expires_in ?? '未返回')
  console.log(`✓ 换到 access_token，expires_in=${expiresIn}`)
  const rotated = typeof parsed?.refresh_token === 'string' ? parsed.refresh_token.trim() : ''
  if (rotated && rotated !== refreshToken) {
    console.log('  ★ ChatCut 轮换了 refresh_token（旧值已作废）—— 立刻写回 .env，否则下次刷新必然失败')
    await persistRotatedRefreshToken(rotated)
  }
  return accessToken
}

/** 未授权/无凭证时：现场拉 OAuth 元数据，把「该去哪里授权」如实打出来，不写死。 */
async function printOAuthDiscovery(): Promise<void> {
  section('未配置凭证 —— 下面是 ChatCut 自己公布的授权入口（现场拉取，非硬编码）')
  try {
    const prRes = await fetch(PROTECTED_RESOURCE_METADATA, { signal: AbortSignal.timeout(15_000) })
    const pr = (await prRes.json()) as {
      authorization_servers?: string[]
      scopes_supported?: string[]
      resource?: string
    }
    console.log(`resource            ${pr.resource ?? ENDPOINT}`)
    const asUrl = pr.authorization_servers?.[0]
    console.log(`authorization_server ${asUrl ?? '（未公布）'}`)
    console.log(`scopes_supported    ${(pr.scopes_supported ?? []).join(' ') || '（未公布）'}`)

    if (!asUrl) return
    const asRes = await fetch(`${asUrl.replace(/\/$/, '')}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(15_000),
    })
    const as = (await asRes.json()) as Record<string, unknown>
    const pick = (key: string): string => (typeof as[key] === 'string' ? (as[key] as string) : '（未公布）')
    const list = (key: string): string =>
      Array.isArray(as[key]) ? (as[key] as string[]).join(', ') : '（未公布）'

    console.log(`\n  authorization_endpoint       ${pick('authorization_endpoint')}`)
    console.log(`  token_endpoint               ${pick('token_endpoint')}`)
    console.log(`  registration_endpoint        ${pick('registration_endpoint')}   ← 动态客户端注册（可自助注册一个 client）`)
    console.log(`  userinfo_endpoint            ${pick('userinfo_endpoint')}`)
    console.log(`  grant_types_supported        ${list('grant_types_supported')}`)
    console.log(`  code_challenge_methods       ${list('code_challenge_methods_supported')}   ← PKCE`)
    console.log(`  token_endpoint_auth_methods  ${list('token_endpoint_auth_methods_supported')}`)

    section('拿凭证的三条路（按省事程度排序）')
    console.log(`  ① 静态 API Key（若账号后台能生成）：填 CHATCUT_MCP_ACCESS_TOKEN 即可，最省事。
     未授权响应里写的是 "Bearer <chatcut API key or JWT>"，说明这条路 ChatCut 是认的；
     但「后台在哪生成」本脚本查不到，需要你登录 app.chatcut.io 找设置/开发者/API 页面确认。

  ② 借官方宿主登录一次（Codex / Claude Code）：装 ChatCut 官方插件并登录，
     官方指引页 chatcut.io/chatgpt 与 chatcut.io/claude。
     注意：官方明确说「插件不接触密钥」，凭据由宿主托管 ⇒ 这条路主要用来
     **验证账号可用 + 拿 tools/list**，不一定能把可长期搬运的 refresh_token 导出。

  ③ 自己走一次标准 OAuth（生产推荐，唯一能产出长期凭证的方式）：
     registration_endpoint 支持动态注册、且 auth methods 含 "none" ⇒ 可以注册成
     public client 只用 PKCE，不需要 client_secret。步骤：
       a. POST registration_endpoint，带上 redirect_uris:[一个你能收到回调的地址]
          与 token_endpoint_auth_method:"none"，拿到 client_id
       b. 浏览器打开 authorization_endpoint?response_type=code&client_id=…&redirect_uri=…
          &scope=openid profile email offline_access&code_challenge=…&code_challenge_method=S256
          ★ 这一步必须人工点同意，无头服务端做不了 —— 这是「为什么 AI 档接通不了」的根本原因
            （我们服务端是无头后端，没有浏览器）
       c. 拿回调里的 code，POST token_endpoint（grant_type=authorization_code + code_verifier）
          换 access_token + refresh_token
       d. 把 refresh_token 填进 CHATCUT_OAUTH_REFRESH_TOKEN，client_id 填 CHATCUT_OAUTH_CLIENT_ID，
          token_endpoint 填 CHATCUT_OAUTH_TOKEN_URL
     scope 里**必须带 offline_access**，否则不发 refresh_token，服务端就无法自动续期。`)
  } catch (error) {
    console.log(`✗ 拉取 OAuth 元数据失败：${(error as Error).message}`)
  }
}

function classify(tools: ToolInfo[]): { submit: ToolInfo[]; status: ToolInfo[] } {
  const statusish = /status|progress|poll|track|query|_get\b|get_/i
  const submitish = /submit|create|compose|render|export|produce|generate|build/i
  return {
    status: tools.filter((t) => statusish.test(t.name)),
    submit: tools.filter((t) => submitish.test(t.name) && !statusish.test(t.name)),
  }
}

function schemaKeys(tool: ToolInfo): string[] {
  const properties = tool.inputSchema?.properties
  if (!properties || typeof properties !== 'object') return []
  return Object.keys(properties as Record<string, unknown>)
}

/**
 * 从驱动源码里**现场提取**它调用的所有 ChatCut 工具名。
 *
 * ★ 为什么扫源码、而不是在脚本里再抄一份清单：
 *   抄一份就一定会随代码改动而**过时** —— 本文件头部记的那次事故就是这么来的
 *   （判据被抄了一份，真实代码改了却忘了改它，于是结论被带反）。
 *   扫源码虽然土，但永远不会脱节：driver 里加了新工具，这里立刻就能核对得上。
 */
async function readDriverTools(): Promise<string[]> {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../src/render/chatcut-driver.ts')
  let source: string
  try {
    source = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const names = new Set<string>()
  for (const match of source.matchAll(/callTool\(\s*'([a-z_][a-z0-9_]*)'/g)) {
    const name = match[1]
    if (name) names.add(name)
  }
  return [...names].sort()
}

/** 按名字打印指定工具的完整 description + inputSchema（供 `--tool` 用） */
function printToolSchemas(tools: ToolInfo[], wanted: string[]): void {
  for (const name of wanted) {
    const tool = tools.find((item) => item.name === name)
    if (!tool) {
      section(`✗ 没有名为 ${name} 的工具`)
      const near = tools.filter((item) => item.name.includes(name) || name.includes(item.name))
      console.log(
        near.length
          ? `  名字相近的有：${near.map((t) => t.name).join(', ')}`
          : '  名字相似的一个也没有，请核对 ⑤ 的完整列表。',
      )
      continue
    }
    section(`工具 ${tool.name}`)
    console.log(tool.description.replace(/\s+/g, ' ').trim() || '（该工具没有 description）')
    console.log('')
    console.log('inputSchema:')
    console.log(
      tool.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : '（该工具未公布 inputSchema）',
    )
    console.log('')
  }
}

async function main(): Promise<void> {
  console.log('ChatCut MCP 通道自检（只读：不写库、不创建任务；仅在轮换时写回 .env 的 refresh_token）')
  console.log(`endpoint = ${ENDPOINT}`)
  console.log(`surface  = ${SURFACE}`)

  section('① 配置现状')
  for (const key of PLAIN_VARS) console.log(`  ${key.padEnd(38)} ${plainState(key)}`)
  for (const key of SECRET_VARS) console.log(`  ${key.padEnd(38)} ${secretState(key)}`)

  section('② 可用性判定（即 chatCutConfigured()）')
  // ★ 判据以 src/render/chatcut.ts::chatCutConfigured() 为准，只有两项：
  //   ① 有凭证  ② 没被急停开关 CHATCUT_ADAPTER_ENABLED=false 关掉。
  //   ⚠ 这里以前是「凭证 + CHATCUT_MCP_SUBMIT_TOOL + CHATCUT_MCP_STATUS_TOOL 三样齐全」，
  //     那套语义 2026-09-17 就已作废 —— 留着会让**任何**配置都打印 false，把判断带反。
  // ⚠ 2026-09-21 又给真实判据加了**第三条**（授权确定性失效时提前置灰），本脚本**复现不了**：
  //   它读的是**本进程内**最近一次 token 刷新是否属于 `auth` 类失败，而本脚本是一次性进程、
  //   该状态恒为 null。所以下面的 configured 是「冷启动语义」——
  //   若线上进程已经刷新失败过，线上会是 false 而这里仍可能 true，两者不一致是正常的。
  const adapterDisabled = env('CHATCUT_ADAPTER_ENABLED')?.trim().toLowerCase() === 'false'
  const hasCredential = Boolean(env('CHATCUT_MCP_ACCESS_TOKEN') || env('CHATCUT_OAUTH_REFRESH_TOKEN'))
  const rows: Array<[string, boolean]> = [
    ['凭证（access token 或 refresh_token）', hasCredential],
    ['急停开关未置 false（CHATCUT_ADAPTER_ENABLED）', !adapterDisabled],
  ]
  for (const [name, ok] of rows) console.log(`  ${ok ? '✓' : '✗'} ${name}`)
  const configured = hasCredential && !adapterDisabled
  console.log(
    configured
      ? '\n⇒ chatCutConfigured() = true：AI 档会对小程序开放（能力表 available=true）'
      : '\n⇒ chatCutConfigured() = false：AI 档被挡住 —— 小程序里会置灰并把选中档弹回基础档，' +
          '服务端另有 409+4013 硬拒（在冻结积分之前，不扣积分）',
  )
  if (adapterDisabled && hasCredential) {
    console.log('  ⚠ 凭证是齐的，但急停开关 CHATCUT_ADAPTER_ENABLED=false 主动关掉了它 ——')
    console.log('    这是运维行为（额度异常 / 商务未谈拢时一键停 AI 档），不是配置缺失。')
  }
  // 反向告警：这两个变量自 2026-09-17 起已作废（旧作业式适配器已删）。一旦有人照旧文档填了，
  // 必须报出来 —— 填了不会让通道可用，只会让 AI 档从「直接置灰」变成「可点但一点就失败」。
  const strayTools = ['CHATCUT_MCP_SUBMIT_TOOL', 'CHATCUT_MCP_STATUS_TOOL'].filter((key) => env(key))
  if (strayTools.length > 0) {
    console.log(`  ⚠ 检测到**已作废**的变量被填：${strayTools.join(' / ')}`)
    console.log('    它们不参与任何判定，请清空。真实驱动在 src/render/chatcut-driver.ts（多步驱动）。')
  }

  const token = await acquireToken()
  if (!token) {
    await printOAuthDiscovery()
    return
  }

  section('③ 协议探测 A：先 initialize 再 tools/list（规范路径）')
  let sessionId: string | null = null
  let toolsPath = 'direct'
  try {
    const init = await mcpCall(
      token,
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dashuai-chatcut-probe', version: '1.0.0' },
      },
      null,
    )
    reportCall('initialize', init)
    sessionId = init.sessionId
    const err = errorOf(init.payload)
    if (err) console.log(`      错误详情：${err}`)

    if (init.status === 200 && !err) {
      // 规范要求握完手发一条 initialized 通知（无 id，不需要等响应）。
      await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'x-chatcut-mcp-surface': SURFACE,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
      }).catch(() => undefined)

      const listed = await mcpCall(token, 'tools/list', {}, sessionId)
      reportCall('tools/list（握手后）', listed)
      const tools = toolsOf(listed.payload)
      if (tools.length > 0) {
        toolsPath = 'handshake'
        await printTools(tools, configured)
        return
      }
      console.log('      ⚠ 握手成功但 tools/list 没返回工具，继续试「直接 tools/list」。')
    }
  } catch (error) {
    console.log(`✗ 握手路径异常：${(error as Error).message}`)
  }

  section('④ 协议探测 B：直接 tools/list（生产代码走的就是这条）')
  console.log('  ★ src/render/chatcut.ts::rpc() 从不发 initialize，直接 POST tools/list。')
  try {
    const listed = await mcpCall(token, 'tools/list', {}, null)
    reportCall('tools/list（无握手）', listed)
    const tools = toolsOf(listed.payload)
    if (tools.length > 0) {
      toolsPath = 'direct'
      await printTools(tools, configured)
      return
    }
    const err = errorOf(listed.payload)
    if (err && toolsPath === 'handshake') {
      console.log('  ★★ 但握手路径成功 —— 说明 ChatCut **要求先 initialize 拿 session**，')
      console.log('     而生产代码没做这件事。这不是配置问题，必须改 src/render/chatcut.ts::rpc()。')
      console.log('     症状会是「探针说通道正常、线上 AI 档却一直失败」。')
    } else if (err && /invalid bearer token|unauthorized/i.test(err)) {
      console.log('  ⇒ 两条路径同为 401：**凭证本身无效**（已过期或抄错），跟工具名无关。')
      console.log('     · 静态 token ⇒ 核对 CHATCUT_MCP_ACCESS_TOKEN_EXPIRES_AT 是否已过')
      console.log('     · OAuth      ⇒ refresh_token 若也失效，只能重新走一次浏览器授权（见上面路径 ③）')
      console.log('  ★ 关键判据：ChatCut 是**先鉴权、后分发方法**的 —— 未授权时任何方法都回同一个 401，')
      console.log('     并且缺 Authorization 头与 token 无效给出的是**两条不同文案**。')
      console.log('     所以 401 无法用来判断「工具名对不对」，必须先让凭证有效再谈其他。')
    } else if (err) {
      console.log(`  ⇒ 请求已被受理但返回 JSON-RPC error，请人工核对报文字段：${JSON.stringify(listed.payload).slice(0, 300)}`)
    } else {
      console.log('\n  ⇒ 两种路径都没拿到工具列表。请人工核对上面 HTTP 状态与报文。')
    }
  } catch (error) {
    console.log(`✗ 直接 tools/list 异常：${(error as Error).message}`)
  }
}

/**
 * ⑤-⑧ 段：先是工具面清单，然后是「驱动依赖是否都还在」与结论/行动项。
 * `configured` 由 main() 按真实判据算好后传进来 —— 判定只做一次，避免两处各判一套。
 * 这里必须是 async：⑦ 段要读 chatcut-driver.ts 源码来提取工具名。
 */
async function printTools(tools: ToolInfo[], configured: boolean): Promise<void> {
  section(`⑤ tools/list 真实返回：共 ${tools.length} 个工具`)
  for (const tool of tools) {
    const brief = tool.description.replace(/\s+/g, ' ').slice(0, 90)
    console.log(`  · ${tool.name}${brief ? `\n      ${brief}` : ''}`)
  }

  if (WANT_TOOLS.length > 0) {
    printToolSchemas(tools, WANT_TOOLS)
    return
  }

  const { submit, status } = classify(tools)

  section('⑥ ★ 关键判断：ChatCut 没有「单次提交整片」的工具')
  console.log('  上面 ⑤ 的工具全是**编辑器操作原语**（建项目 / 导入素材 / 编时间线 / 改字幕 /')
  console.log('  提交导出 / 轮询导出），没有一个是「发一个配置对象、等它出片」的作业式接口。')
  console.log('  ⇒ 正确用法是**多步驱动**，形如：')
  console.log('       create_project → target_project → import_media')
  console.log('         → edit_item / edit_track / manage_timelines   （编排）')
  console.log('         → edit_captions / apply_script                （字幕）')
  console.log('         → submit_voice / submit_music                 （配音、BGM 生成进素材库）')
  console.log('         → submit_export                               （导出）')
  console.log('         → track_export                                （轮询导出状态）')
  console.log('  ⇒ 「怎么剪」必须由**调用方自己的 LLM** 决定 —— ChatCut 只提供积木，不提供决策。')
  console.log('')
  console.log('  ⚠ 按名字前缀自动挑工具是不可靠的。实测教训：本脚本曾据此推荐过')
  console.log('    create_motion_graphic_from_code（实为「用 React/JSX 代码生成动态图形」）')
  console.log('    与 edit_track（实为「管理轨道」）—— 两个都和「提交整片 / 查任务状态」无关。')
  console.log('    所以下面**不再给「照着填」的建议**，请在 ⑤ 的完整列表 + 真实 schema 上人工决定。')
  console.log(`\n  仅作缩小范围 —— 名字含 submit/export/create 的 ${submit.length} 个：`)
  console.log(`    ${submit.map((t) => t.name).join(', ') || '（无）'}`)
  console.log(`  名字含 track/status/query 的 ${status.length} 个：`)
  console.log(`    ${status.map((t) => t.name).join(', ') || '（无）'}`)

  section('⑦ ★ 驱动依赖核对：chatcut-driver.ts 用到的工具，ChatCut 是否都还有')
  const driverTools = await readDriverTools()
  if (driverTools.length === 0) {
    console.log('  ⚠ 没能从 src/render/chatcut-driver.ts 提取到 callTool(...) —— 文件改名或路径变了？跳过。')
  } else {
    const hasTool = new Set(tools.map((tool) => tool.name))
    const missing = driverTools.filter((name) => !hasTool.has(name))
    console.log(`  驱动依赖 ${driverTools.length} 个工具：${driverTools.join(', ')}`)
    if (missing.length === 0) {
      console.log('  ✓ 全部存在于 ChatCut 当前工具面 —— 驱动与对方一致。')
    } else {
      console.log(`  ✗ **ChatCut 上找不到 ${missing.length} 个**：${missing.join(', ')}`)
      console.log('    ⇒ 这条链路会在**跑到那一步时**失败（不是启动时就报，所以更要在这里盯住）。')
      console.log('      改法：按 ⑤ 的完整列表 + 真实 schema 修 src/render/chatcut-driver.ts。')
    }
  }

  section('⑧ 结论与行动项')
  console.log('  适配层已是**多步驱动**（src/render/chatcut-driver.ts，2026-09-17 重写）：')
  console.log('      create_project → import_media → edit_item / edit_track → edit_captions')
  console.log('        → submit_music → submit_export → track_export')
  console.log('  旧的作业式适配器（submitChatCutJob / getChatCutJob）**已删除**，')
  console.log('  所以 CHATCUT_MCP_SUBMIT_TOOL / CHATCUT_MCP_STATUS_TOOL 不存在「该填什么」的问题 —— 留空即可。')
  console.log('')
  if (!configured) {
    console.log('  ⇒ 本机 AI 档**不可用**。行动项：')
    console.log('     1) 补上 ② 里缺的那一项（凭证，或把急停开关打开）')
    console.log('     2) 重启（tsx watch 不监听 .env：touch src/index.ts）')
    console.log('     3) 验收：curl -s http://127.0.0.1:3000/api/v1/render/capabilities → AI.available 应为 true')
  } else {
    console.log('  ⇒ 本机 AI 档**已具备放开条件**（chatCutConfigured() = true）。')
    console.log('     ⚠ 这只代表「有凭证」，不代表「端到端能出片」——')
    console.log('       端到端自证：cd server && npm run chatcut:smoke（真建项目 / 导素材 / 导出成片）')
    console.log('     ⚠ refresh_token 是**轮换**的：谁刷新谁作废旧值。')
    console.log('       多环境共用同一个 refresh_token 会互相踢掉（本脚本一轮换就会写回本机 .env）。')
    console.log('       ⇒ 生产多实例靠共享 Redis（代码已实现 Redis 值优先于 .env）；别在第二个环境再跑本脚本。')
  }
}

await main().catch((error: unknown) => {
  console.error(`\n探测器异常退出：${(error as Error).message}`)
  process.exitCode = 1
})
