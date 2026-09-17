// P1-6 + AI 档提交前拦截验证
//   ① chatCutConfigured() 的可用性契约（★ 语义已改，见下）
//   ② POST /creations/:id/render 传 grade=AI 在通道不可用时应 409/4013 且**不冻结**
import { chatCutConfigured, ChatCutOptionsSchema, DEFAULT_CHATCUT_OPTIONS } from '../src/render/chatcut.js'
import { prisma } from '../src/db.js'
import crypto from 'node:crypto'

const SECRET = 'local-development-secret'
const ISSUER = 'dshuaai-server'
const AUDIENCE = 'dshuaai-client'
const b64 = (o: string | object) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
function token(mid: number) {
  const now = Math.floor(Date.now() / 1000)
  const h = b64({ alg: 'HS256', typ: 'JWT' })
  const p = b64({ mid: String(mid), phone: '13800000000', typ: 'access', iat: now, exp: now + 3600, iss: ISSUER, aud: AUDIENCE })
  return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`
}

console.log('=== ① chatCutConfigured() 契约 ===')
const ENV_KEYS = [
  'CHATCUT_MCP_ACCESS_TOKEN',
  'CHATCUT_OAUTH_TOKEN_URL',
  'CHATCUT_OAUTH_REFRESH_TOKEN',
  'CHATCUT_ADAPTER_ENABLED',
] as const
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<string, string | undefined>

/**
 * ★ 契约已于 2026-09-17 改写。
 * 旧契约断言「配了凭证但没配 CHATCUT_MCP_SUBMIT_TOOL / STATUS_TOOL 时必须返回 false」——
 * 那个断言本身建立在错误假设上：以为 ChatCut 有「提交作业 / 查询作业」两个工具。
 * 实测 tools/list 的 59 个工具里没有，ChatCut 是「多步驱动云端编辑器」，
 * 所以工具名不再是判据（留着它只会逼运维去填假值，把「置灰」变成「可点但必失败」）。
 * 新契约 = 有凭证 ∧ 没被 CHATCUT_ADAPTER_ENABLED=false 关掉。
 */
function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const PASS_TOKEN = 'access-token-for-contract-test'
const cases: Array<[string, Partial<Record<(typeof ENV_KEYS)[number], string>>, boolean]> = [
  ['全缺（无任何凭证）', {}, false],
  ['只有 access token', { CHATCUT_MCP_ACCESS_TOKEN: PASS_TOKEN }, true],
  ['只有 OAuth 端点、无 refresh token', { CHATCUT_OAUTH_TOKEN_URL: 'https://example.invalid/token' }, false],
  ['OAuth 端点 + refresh token', { CHATCUT_OAUTH_TOKEN_URL: 'https://example.invalid/token', CHATCUT_OAUTH_REFRESH_TOKEN: 'rt' }, true],
  ['有凭证但急停开关打开', { CHATCUT_MCP_ACCESS_TOKEN: PASS_TOKEN, CHATCUT_ADAPTER_ENABLED: 'false' }, false],
  ['急停开关显式设为 true', { CHATCUT_MCP_ACCESS_TOKEN: PASS_TOKEN, CHATCUT_ADAPTER_ENABLED: 'true' }, true],
]
let contractOk = true
for (const [name, env, expect] of cases) {
  setEnv(env)
  let actual: boolean | string
  try {
    actual = chatCutConfigured()
  } catch (e) {
    actual = `抛错:${(e as Error).name}` // 契约要求不能抛错：调用方是能力表与提交前拦截，抛错会 500
  }
  const ok = actual === expect
  if (!ok) contractOk = false
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(30)} → ${actual}（期望 ${expect}）`)
}
console.log(`${contractOk ? '✓' : '✗'} ① 契约用例${contractOk ? '全部通过' : '有不通过项'}`)
setEnv(saved as Partial<Record<(typeof ENV_KEYS)[number], string>>)

console.log('\n=== ② 提交 AI 档：应拒绝且不冻结 ===')
const BASE = 'http://127.0.0.1:3000/api/v1'
const H = { authorization: `Bearer ${token(1)}`, 'content-type': 'application/json' }

async function beanState() {
  const acc = await prisma.beanAccount.findUnique({ where: { merchantId: 1n } })
  return { balance: acc?.balance, frozen: acc?.frozen }
}
const before = await beanState()
const beforeTasks = await prisma.renderTask.count({ where: { merchantId: 1n, status: 'PENDING_RESERVATION' } })

const res = await fetch(`${BASE}/creations/2/render`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ grade: 'AI', requestId: `verify-grade-${Date.now()}`, chatcut: ChatCutOptionsSchema.parse(DEFAULT_CHATCUT_OPTIONS) }),
})
const body = (await res.json()) as { code?: number; message?: string }

const after = await beanState()
const afterTasks = await prisma.renderTask.count({ where: { merchantId: 1n, status: 'PENDING_RESERVATION' } })

console.log(`HTTP ${res.status}  code=${body.code}  message=${body.message}`)
console.log(`冻结积分：${before.frozen} → ${after.frozen}   ${before.frozen === after.frozen ? '✓ 未冻结' : '✗ 被冻结了'}`)
console.log(`余额：  ${before.balance} → ${after.balance}   ${before.balance === after.balance ? '✓ 未变动' : '✗ 被扣了'}`)
console.log(`PENDING_RESERVATION 任务数：${beforeTasks} → ${afterTasks}   ${beforeTasks === afterTasks ? '✓ 未建任务' : '✗ 建了任务'}`)
console.log(`${res.status === 409 && body.code === 4013 ? '✓ 正确的拒绝语义' : '✗ 拒绝语义不符（期望 409/4013）'}`)

await prisma.$disconnect()
