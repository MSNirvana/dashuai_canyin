/**
 * ChatCut OAuth 一次性授权助手 —— 把「浏览器点一次同意」之外的所有步骤全部自动化。
 *
 * 为什么需要它（2026-09-17）：
 *   ChatCut 的授权是标准 OAuth authorization_code 流程，**其中「点同意」这一步必须人工
 *   在浏览器里完成**（无头服务端做不到，这就是 AI 档一直接不上的根本原因）。
 *   但除了那一次点击，其余每一步 —— 生成 PKCE、动态注册 client、起本地回调、
 *   用 code 换 token —— 都**不该让人手工拼命令**。手工做的话有四个必踩的坑：
 *     · code_verifier 忘了存，回来后无法换 token（而 authorize 不校验参数完整性，
 *       拼错的链接不会当场失败，只会在换 token 时报 invalid_grant）
 *     · redirect_uri 两次不一致
 *     · 沙箱里没有监听，浏览器回调时报「连接被拒绝」
 *     · 拿到的其实是 access_token 而不是 refresh_token（1 小时后静默失效、零告警）
 *   本脚本把这四件事一次做对。
 *
 * 用法：
 *   npx tsx scripts/chatcut-authorize.ts                # 默认本地 8765 端口，只打印结果
 *   npx tsx scripts/chatcut-authorize.ts --write        # 额外把三行配置写进 server/.env
 *   npx tsx scripts/chatcut-authorize.ts --port 9000    # 换端口（会重新注册 client）
 *   npx tsx scripts/chatcut-authorize.ts --client-id xxx
 *   npx tsx scripts/chatcut-authorize.ts --no-open      # 不自动开浏览器，自己复制链接
 *
 * ★ 它会自动打开浏览器；打不开、或加了 --no-open 也不影响 —— 授权 URL 一样会打印出来。
 * ★ 不做任何写操作，除非显式加 --write。加了 --write 也只会改 server/.env
 *   （该文件已被 .gitignore 忽略，refresh_token 不会进版本库）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROTECTED_RESOURCE =
  'https://api.chatcut.io/.well-known/oauth-protected-resource/api/external-mcp/mcp'

/** 兜底端点（2026-09-17 实测）。正常路径是现场拉元数据，这三个只在拉取失败时用。 */
const FALLBACK = {
  authorize: 'https://api.chatcut.io/auth/mcp/authorize',
  token: 'https://api.chatcut.io/auth/mcp/token',
  register: 'https://api.chatcut.io/auth/mcp/register',
}

/** ★ 必须带 offline_access —— 否则 ChatCut 不发 refresh_token，服务端就无法自动续期。 */
const SCOPE = 'openid profile email offline_access'

const WAIT_TIMEOUT_MS = 10 * 60 * 1000

const argv = process.argv.slice(2)
const hasFlag = (name: string): boolean => argv.includes(`--${name}`)
function flagValue(name: string): string | null {
  const index = argv.indexOf(`--${name}`)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : null
}

interface Endpoints {
  authorize: string
  token: string
  register: string
}

async function discoverEndpoints(): Promise<Endpoints> {
  const endpoints: Endpoints = { ...FALLBACK }
  try {
    const protectedRes = await fetch(PROTECTED_RESOURCE, { signal: AbortSignal.timeout(15_000) })
    const protectedJson = (await protectedRes.json()) as { authorization_servers?: string[] }
    const issuer = protectedJson.authorization_servers?.[0]
    if (!issuer) return endpoints

    const metaRes = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(15_000),
    })
    const meta = (await metaRes.json()) as Record<string, unknown>
    if (typeof meta.authorization_endpoint === 'string') endpoints.authorize = meta.authorization_endpoint
    if (typeof meta.token_endpoint === 'string') endpoints.token = meta.token_endpoint
    if (typeof meta.registration_endpoint === 'string') endpoints.register = meta.registration_endpoint
    console.log('端点来源：ChatCut 现场公布（非硬编码）')
  } catch (error) {
    console.log(`端点来源：内置兜底（现场拉取失败：${(error as Error).message}）`)
  }
  return endpoints
}

async function registerClient(registerUrl: string, redirectUri: string): Promise<string> {
  const response = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'dashuai-server',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`动态注册失败（HTTP ${response.status}）：${raw.slice(0, 300)}`)
  const parsed = JSON.parse(raw) as { client_id?: string }
  if (!parsed.client_id) throw new Error(`动态注册未返回 client_id：${raw.slice(0, 300)}`)
  console.log(`✓ 已注册 public client：${parsed.client_id}`)
  console.log('  public client 没有 client_secret（靠 PKCE 保证安全），这个 id 不是机密，可留作复用。')
  return parsed.client_id
}

interface CallbackWaiter {
  listening: Promise<void>
  code: Promise<string>
}

/** 起一个只在 127.0.0.1 上监听的临时回调服务器，接住浏览器那一跳。 */
function startCallbackServer(port: number, expectedState: string, timeoutMs: number): CallbackWaiter {
  let settleCode: (code: string) => void = () => undefined
  let settleError: (error: Error) => void = () => undefined
  let settled = false

  const code = new Promise<string>((resolveCode, rejectCode) => {
    settleCode = resolveCode
    settleError = rejectCode
  })

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }

    const page = (title: string, detail: string): void => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
          `<body style="font-family:system-ui,-apple-system,sans-serif;padding:48px;max-width:640px;margin:auto;line-height:1.7">` +
          `<h2 style="font-weight:500">${title}</h2><p>${detail}</p></body>`,
      )
    }

    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      action()
    }

    const errorParam = url.searchParams.get('error')
    const codeParam = url.searchParams.get('code')
    const stateParam = url.searchParams.get('state')

    if (errorParam) {
      const description = url.searchParams.get('error_description') ?? ''
      page('授权被拒绝', `ChatCut 返回：${errorParam} ${description}`)
      settle(() => settleError(new Error(`授权被拒绝：${errorParam} ${description}`.trim())))
      return
    }
    if (!codeParam) {
      page('回调里没有 code', '请回到终端重新运行脚本 —— 这个链接可能已经用过了。')
      return
    }
    if (stateParam !== expectedState) {
      page('state 不匹配，已中止', '出于安全考虑不再继续。请重新运行脚本，不要复用旧的授权链接。')
      settle(() => settleError(new Error('state 不匹配：可能是复用了旧链接，或回调被伪造')))
      return
    }

    page('授权成功，可以关闭本页了', '回到终端，脚本会继续用它换 refresh_token。')
    settle(() => settleCode(codeParam))
  })

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    server.close()
    settleError(new Error(`等待 ${Math.round(timeoutMs / 1000)} 秒仍未收到授权回调，已放弃`))
  }, timeoutMs)

  const listening = new Promise<void>((resolveListening, rejectListening) => {
    server.once('listening', () => resolveListening())
    server.once('error', (error) => rejectListening(error))
  })
  server.listen(port, '127.0.0.1')

  return { listening, code }
}

async function exchangeCode(
  tokenUrl: string,
  input: { code: string; redirectUri: string; clientId: string; verifier: string },
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
  })
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  const raw = await response.text()
  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(raw) as unknown
    parsed = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    parsed = null
  }
  if (!response.ok || !parsed || typeof parsed.access_token !== 'string') {
    throw new Error(
      `换 token 失败（HTTP ${response.status}）：${raw.slice(0, 400)}\n` +
        '  常见原因：code 已过期（通常只有几分钟）、redirect_uri 与授权时不一致、' +
        'code_verifier 不是当时用的那个。',
    )
  }
  return parsed
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  execFile(command, args, () => undefined)
}

function maskSecret(value: string): string {
  if (value.length <= 12) return `（${value.length} 字符）`
  return `${value.slice(0, 6)}…${value.slice(-4)}（共 ${value.length} 字符）`
}

async function writeEnvLines(entries: Array<[string, string]>): Promise<string> {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env')
  let content = ''
  try {
    content = await readFile(envPath, 'utf8')
  } catch {
    content = ''
  }
  for (const [key, value] of entries) {
    const line = `${key}="${value}"`
    const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'm')
    if (pattern.test(content)) content = content.replace(pattern, line)
    else content = `${content.replace(/\n*$/, '\n')}${line}\n`
  }
  await writeFile(envPath, content)
  return envPath
}

async function main(): Promise<void> {
  const port = Number(flagValue('port') ?? 8765)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`--port 不合法：${String(flagValue('port'))}（需 1024~65535）`)
  }
  const redirectUri = `http://127.0.0.1:${port}/callback`

  console.log('ChatCut OAuth 一次性授权')
  console.log('='.repeat(64))
  const endpoints = await discoverEndpoints()

  // PKCE：verifier 62 字符、challenge 43 字符（base64url 的 SHA256 恒为 43 字符）
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')

  console.log('\n[1/4] 准备回调地址')
  console.log(`  ${redirectUri}`)

  console.log('\n[2/4] 准备 OAuth 客户端')
  const suppliedClientId = flagValue('client-id')
  const clientId = suppliedClientId ?? (await registerClient(endpoints.register, redirectUri))
  if (suppliedClientId) {
    console.log(`  复用 --client-id ${clientId}`)
    console.log(`  ⚠ 复用时必须与注册时用的是同一个 redirect_uri，即 ${redirectUri}`)
  }

  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  // ★ 空格必须编码成 %20，不能是 +。URLSearchParams 默认输出 `+`，而 OAuth 里 scope 是
  //   空格分隔的列表 —— 把 `+` 当字面量的实现会把它读成**一个** scope 名，
  //   于是 offline_access 静默失效、服务端拿不到 refresh_token。
  //   ChatCut 的 authorize 又**不校验参数完整性**，这类错误不会当场报。
  const authUrl = `${endpoints.authorize}?${authParams.toString().replace(/\+/g, '%20')}`

  // ★ 先起监听再开浏览器：「监听没起来就点链接」会直接看到「无法访问此网站」，
  //   而那一刻最容易被误判成「回调地址没注册」。
  const waiter = startCallbackServer(port, state, WAIT_TIMEOUT_MS)
  try {
    await waiter.listening
  } catch (error) {
    throw new Error(`本地端口 ${port} 无法监听：${(error as Error).message}（换一个 --port 再试）`)
  }

  console.log('\n[3/4] 请在浏览器里完成授权')
  console.log('  ★ 这一步必须人工点一次「同意」，任何无头程序都代替不了。')
  console.log('  ★ 如果还没有 ChatCut 账号：先注册（免费档送 25 credits），再回来点这个链接。\n')
  console.log(authUrl)
  console.log(`\n  等在这里，最多 ${WAIT_TIMEOUT_MS / 60_000} 分钟……${hasFlag('no-open') ? '（已按 --no-open 跳过自动打开，请手工粘贴上面的链接）' : '（浏览器已尝试自动打开）'}`)
  if (!hasFlag('no-open')) openBrowser(authUrl)

  const code = await waiter.code
  console.log('  ✓ 收到授权回调')

  console.log('\n[4/4] 用 code 换 token')
  const tokens = await exchangeCode(endpoints.token, { code, redirectUri, clientId, verifier })

  const accessToken = String(tokens.access_token)
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : ''
  const expiresIn = String(tokens.expires_in ?? '未返回')
  const scope = typeof tokens.scope === 'string' ? tokens.scope : SCOPE

  console.log(`  ✓ access_token  ${maskSecret(accessToken)}  有效期 ${expiresIn} 秒`)
  console.log(`  ${refreshToken ? '✓' : '✗'} refresh_token ${refreshToken ? maskSecret(refreshToken) : 'ChatCut 没有返回！'}`)
  console.log(`  scope: ${scope}`)

  if (!refreshToken) {
    console.log('\n  ✗ 没有拿到 refresh_token —— 服务端就无法自动续期，AI 档会在一小时后静默失效。')
    console.log('    确认 scope 里有 offline_access（本脚本已带上），然后重新授权一次。')
  }

  const entries: Array<[string, string]> = [
    ['CHATCUT_OAUTH_TOKEN_URL', endpoints.token],
    ['CHATCUT_OAUTH_CLIENT_ID', clientId],
  ]
  if (refreshToken) entries.push(['CHATCUT_OAUTH_REFRESH_TOKEN', refreshToken])

  console.log('\n' + '='.repeat(64))
  console.log('把下面三行加进 server/.env（该文件已被 .gitignore 忽略）：\n')
  for (const [key, value] of entries) console.log(`${key}="${value}"`)
  console.log('\n⚠ refresh_token 是长期凭证，等同于账号权限 —— 不要提交到 Git，也不要贴进聊天记录。')
  console.log('⚠ 之后还差两步（见 deploy/ChatCut授权配置清单-2026-09-17.md）：')
  console.log('   ① 用 tools/list 的真实返回填 CHATCUT_MCP_SUBMIT_TOOL / CHATCUT_MCP_STATUS_TOOL')
  console.log('   ② touch src/index.ts 让服务重载 .env')

  if (hasFlag('write')) {
    const envPath = await writeEnvLines(entries)
    console.log(`\n✓ 已写入 ${envPath}`)
  } else {
    console.log('\n（加 --write 可让脚本自己写进 server/.env；本次没有写任何文件。）')
  }
}

await main().catch((error: unknown) => {
  console.error(`\n授权未完成：${(error as Error).message}`)
  process.exitCode = 1
})
