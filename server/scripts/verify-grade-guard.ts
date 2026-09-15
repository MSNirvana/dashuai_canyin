// P1-6 + AI 档提交前拦截验证
//   ① chatCutConfigured() 在缺 STATUS_TOOL 时必须返回 false
//   ② POST /creations/:id/render 传 grade=AI 在通道未配置时应 409/4013 且**不冻结**
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
const saved = {
  sub: process.env.CHATCUT_MCP_SUBMIT_TOOL,
  stat: process.env.CHATCUT_MCP_STATUS_TOOL,
  tok: process.env.CHATCUT_MCP_ACCESS_TOKEN,
}
function setEnv(sub?: string, stat?: string, tok?: string) {
  if (sub === undefined) delete process.env.CHATCUT_MCP_SUBMIT_TOOL
  else process.env.CHATCUT_MCP_SUBMIT_TOOL = sub
  if (stat === undefined) delete process.env.CHATCUT_MCP_STATUS_TOOL
  else process.env.CHATCUT_MCP_STATUS_TOOL = stat
  if (tok === undefined) delete process.env.CHATCUT_MCP_ACCESS_TOKEN
  else process.env.CHATCUT_MCP_ACCESS_TOKEN = tok
}
const cases: Array<[string, string | undefined, string | undefined, string | undefined, boolean]> = [
  ['全缺', undefined, undefined, undefined, false],
  ['只有 token', undefined, undefined, 'tok', false],
  ['token + 提交工具（旧逻辑会误判为可用）', undefined, undefined, 'tok', false],
  ['token + 提交工具 + 查询工具', 'submit_job', 'get_job', 'tok', true],
  ['有查询工具但没提交工具', undefined, 'get_job', 'tok', false],
]
for (const [name, sub, stat, tok, expect] of cases) {
  setEnv(sub, stat, tok)
  let actual: boolean | string
  try {
    actual = chatCutConfigured()
  } catch (e) {
    actual = `抛错:${(e as Error).name}` // 契约要求不能抛错
  }
  const ok = actual === expect
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(34)} → ${actual}（期望 ${expect}）`)
}
// 单独验证「半配置」这一条：旧逻辑
setEnv('submit_job', undefined, 'tok')
console.log(`\n  半配置（token + 提交工具，无查询工具）：chatCutConfigured() = ${chatCutConfigured()}  ← 旧逻辑为 true，会提交成功但轮询必失败`)
Object.assign(process.env, {
  ...(saved.sub !== undefined ? { CHATCUT_MCP_SUBMIT_TOOL: saved.sub } : {}),
  ...(saved.stat !== undefined ? { CHATCUT_MCP_STATUS_TOOL: saved.stat } : {}),
  ...(saved.tok !== undefined ? { CHATCUT_MCP_ACCESS_TOKEN: saved.tok } : {}),
})

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
console.log(`冻结豆：${before.frozen} → ${after.frozen}   ${before.frozen === after.frozen ? '✓ 未冻结' : '✗ 被冻结了'}`)
console.log(`余额：  ${before.balance} → ${after.balance}   ${before.balance === after.balance ? '✓ 未变动' : '✗ 被扣了'}`)
console.log(`PENDING_RESERVATION 任务数：${beforeTasks} → ${afterTasks}   ${beforeTasks === afterTasks ? '✓ 未建任务' : '✗ 建了任务'}`)
console.log(`${res.status === 409 && body.code === 4013 ? '✓ 正确的拒绝语义' : '✗ 拒绝语义不符（期望 409/4013）'}`)

await prisma.$disconnect()
