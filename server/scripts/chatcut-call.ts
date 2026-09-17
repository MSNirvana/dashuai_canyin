// ChatCut 工具调用器 —— 适配层开发用（**会真的调用工具**，不是只读）
//
// 为什么需要它：适配层的每个参数都必须按真实 schema 落，不能猜 ——
// 这个项目已经因为「猜字段名」踩过一次坑：`submitChatCutJob()` 发出去的那 10 个字段
// （idempotencyKey / projectName / source / keywords / render / voice / captions / audio /
// editing / clips）经实测**真实工具一个都不认**。所以写适配代码之前，必须能
// 「照 schema 试跑一次、看原始返回」。
//
// 与 chatcut-probe.ts 的分工：
//   · probe  = **只读**（配置体检 / tools-list / `--tool` 查 schema），不产生副作用
//   · call   = 会真的执行 `tools/call`，可能创建项目、消耗额度
//   ★ 因此本脚本**默认 dry-run**（只打印将发送的 JSON），加 `--yes` 才真发。
//
// 用法：
//   npx tsx scripts/chatcut-call.ts --tool=create_project \
//     --args='{"name":"dashuai-test","compositionWidth":1080,"compositionHeight":1920}'
//   ↑ 上面只打印请求；确认无误后原样再加 `--yes` 才会真正发出。
//
// 凭证：与生产代码同一套（`server/.env`）。`CHATCUT_MCP_ACCESS_TOKEN` 优先，
//   否则用 `CHATCUT_OAUTH_REFRESH_TOKEN` 现场换。★ ChatCut 会**轮换** refresh_token，
//   所以换到新值后必须写回 `.env`（本脚本会做，不写下次刷新必然失败）。
import 'dotenv/config'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENDPOINT = (process.env.CHATCUT_MCP_URL ?? '').trim() || 'https://api.chatcut.io/api/external-mcp/mcp'
const SURFACE = (process.env.CHATCUT_MCP_SURFACE ?? '').trim() || 'codex'
const MCP_TIMEOUT_MS = Number(process.env.CHATCUT_MCP_TIMEOUT_MS ?? 120_000)
const OAUTH_TIMEOUT_MS = Number(process.env.CHATCUT_OAUTH_TIMEOUT_MS ?? 15_000)

/** 取 `--flag=value` 或 `--flag value` 的值 */
function argValue(flag: string): string | null {
  const prefix = `${flag}=`
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(flag)
  if (index < 0) return null
  const next = process.argv[index + 1]
  return next && !next.startsWith('--') ? next : null
}

const TOOL = argValue('--tool')
const RAW_ARGS = argValue('--args') ?? '{}'
const CONFIRMED = process.argv.includes('--yes')

interface McpCall {
  status: number
  raw: string
  payload: Record<string, unknown> | null
  sessionId: string | null
}

async function mcpCall(token: string, method: string, params: unknown): Promise<McpCall> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'x-chatcut-mcp-surface': SURFACE,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
  })
  const raw = await response.text()
  let payload: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(raw) as unknown
    payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    // SSE 或非 JSON：下面按原文展示，不吞掉
    payload = null
  }
  return { status: response.status, raw, payload, sessionId: response.headers.get('mcp-session-id') }
}

/** 把轮换后的 refresh_token 写回 server/.env（已有同名行则替换） */
async function persistRotatedRefreshToken(value: string): Promise<void> {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env')
  const content = await readFile(envPath, 'utf8')
  const line = `CHATCUT_OAUTH_REFRESH_TOKEN="${value}"`
  const pattern = /^\s*CHATCUT_OAUTH_REFRESH_TOKEN\s*=.*$/m
  const next = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.replace(/\n*$/, '\n')}${line}\n`
  await writeFile(envPath, next)
  console.log('  ✓ 已把轮换后的 refresh_token 写回 server/.env')
}

async function acquireAccessToken(): Promise<string | null> {
  const staticToken = (process.env.CHATCUT_MCP_ACCESS_TOKEN ?? '').trim()
  if (staticToken) {
    console.log('凭证来源：CHATCUT_MCP_ACCESS_TOKEN（静态）')
    return staticToken
  }
  const refreshToken = (process.env.CHATCUT_OAUTH_REFRESH_TOKEN ?? '').trim()
  const tokenUrl = (process.env.CHATCUT_OAUTH_TOKEN_URL ?? '').trim()
  if (!refreshToken || !tokenUrl) return null

  console.log(`凭证来源：OAuth refresh_token 交换（${tokenUrl}）`)
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  const clientId = (process.env.CHATCUT_OAUTH_CLIENT_ID ?? '').trim()
  const clientSecret = (process.env.CHATCUT_OAUTH_CLIENT_SECRET ?? '').trim()
  if (clientId) body.set('client_id', clientId)
  if (clientSecret) body.set('client_secret', clientSecret)

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
  console.log(`✓ 换到 access_token，expires_in=${String(parsed?.expires_in ?? '未返回')}`)
  const rotated = typeof parsed?.refresh_token === 'string' ? parsed.refresh_token.trim() : ''
  if (rotated && rotated !== refreshToken) {
    console.log('  ★ ChatCut 轮换了 refresh_token（旧值已作废）—— 写回 .env')
    await persistRotatedRefreshToken(rotated)
  }
  return accessToken
}

async function main(): Promise<void> {
  if (!TOOL) {
    console.log('用法：npx tsx scripts/chatcut-call.ts --tool=<工具名> --args=\'<JSON>\' [--yes]')
    console.log('')
    console.log('  · 默认 dry-run：只打印将发送的请求，不真发')
    console.log('  · 加 --yes 才真正调用')
    console.log('  · 查工具有哪些 / 查某个工具的 schema：npm run chatcut:probe [-- --tool=<名字>]')
    return
  }

  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(RAW_ARGS) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--args 必须是一个 JSON 对象')
    }
    args = parsed as Record<string, unknown>
  } catch (error) {
    console.log(`✗ --args 不是合法 JSON 对象：${(error as Error).message}`)
    console.log(`  收到的是：${RAW_ARGS}`)
    process.exitCode = 1
    return
  }

  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL, arguments: args } }
  console.log(`工具：${TOOL}`)
  console.log(`endpoint：${ENDPOINT}   surface：${SURFACE}`)
  console.log('请求体：')
  console.log(JSON.stringify(request, null, 2))

  if (!CONFIRMED) {
    console.log('')
    console.log('（dry-run，未发出。确认无误后加 --yes 再跑一次。）')
    return
  }

  const token = await acquireAccessToken()
  if (!token) {
    console.log('✗ 没有可用凭证 —— 先在 server/.env 配好 CHATCUT_OAUTH_REFRESH_TOKEN，或设 CHATCUT_MCP_ACCESS_TOKEN')
    process.exitCode = 1
    return
  }

  console.log('\n── 调用结果 ──────────────────────────────────────')
  const call = await mcpCall(token, 'tools/call', { name: TOOL, arguments: args })
  console.log(`HTTP ${call.status}`)
  if (call.sessionId) console.log(`session: ${call.sessionId}`)
  if (call.payload) {
    const error = call.payload.error
    if (error) {
      console.log('✗ JSON-RPC error：')
      console.log(JSON.stringify(error, null, 2))
    } else {
      console.log('返回：')
      console.log(JSON.stringify(call.payload.result ?? call.payload, null, 2))
    }
  } else {
    console.log('（非 JSON 响应，原文如下）')
    console.log(call.raw.slice(0, 4000))
  }
}

await main().catch((error: unknown) => {
  console.error(`\n调用器异常退出：${(error as Error).message}`)
  process.exitCode = 1
})
