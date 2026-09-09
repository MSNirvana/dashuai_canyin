// 调用真实 jwt.ts/auth.ts；仅替换 merchant 查询边界，不证明 MySQL 行为。
// 运行位置：项目根目录。无需 .env，不访问真实服务。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

async function main() {
  process.env.NODE_ENV = 'test'
  process.env.JWT_SECRET = 'audit-jwt-secret-32-bytes-minimum-for-test'
  process.env.JWT_ISSUER = 'audit-issuer'
  process.env.JWT_AUDIENCE = 'audit-client'
  process.env.DATABASE_URL = 'mysql://audit:audit@127.0.0.1:1/never_connect'
  process.env.REDIS_URL = 'redis://127.0.0.1:1'

  const sourceFiles = ['server/src/lib/jwt.ts', 'server/src/middleware/auth.ts']
  const fingerprints = sourceFiles.map((file) => ({
    file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  }))
  console.log('SOURCE', JSON.stringify(fingerprints))
  const requireServer = createRequire(`${process.cwd()}/server/package.json`)
  const jsonwebtoken = requireServer('jsonwebtoken')
  const jwt = await import('../../server/src/lib/jwt.js')
  const { auth } = await import('../../server/src/middleware/auth.js')
  const { prisma, redis } = await import('../../server/src/db.js')
  let blockedQueries = 0
  prisma.$use(async () => {
    blockedQueries++
    throw new Error('AUDIT_BLOCKED_REAL_DATABASE_QUERY')
  })
  const delegate = prisma.merchant
  const originalFindUnique = delegate.findUnique
  type MerchantState = 'ACTIVE' | 'DISABLED' | 'MISSING' | 'QUERY_ERROR'
  let merchantState: MerchantState = 'ACTIVE'
  const lookups: unknown[] = []
  let totalLookups = 0
  let failed = 0
  const responsePayload = { mid: '42', phone: '13800000000', typ: 'access' }

  delegate.findUnique = (async (query: unknown) => {
    lookups.push(query)
    totalLookups++
    if (merchantState === 'QUERY_ERROR') throw new Error('AUDIT_QUERY_ERROR')
    return merchantState === 'MISSING' ? null : { status: merchantState }
  }) as typeof originalFindUnique

  function tokenWith(payload: Record<string, unknown>, options: Record<string, unknown> = {}) {
    return jsonwebtoken.sign(payload, process.env.JWT_SECRET!, {
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE,
      algorithm: 'HS256',
      ...options,
    }) as string
  }

  async function probe(token: string, state: MerchantState) {
    merchantState = state
    lookups.length = 0
    const req: any = { headers: { authorization: `Bearer ${token}` } }
    const res: any = {
      locals: {}, statusCode: 200,
      status(code: number) { this.statusCode = code; return this },
      json(value: unknown) { this.payload = value },
    }
    let nextCount = 0
    await auth(req, res, () => { nextCount++ })
    return { nextCount, status: res.statusCode, payload: res.payload, mid: req.merchantId, phone: req.merchantPhone }
  }

  type Case = { name: string; token: () => string; state?: MerchantState; allowed?: boolean; queries: number }
  const cases: Case[] = [
    { name: '合法access + ACTIVE允许并注入身份', token: () => jwt.signAccess({ mid: '42', phone: '13800000000' }), allowed: true, queries: 1 },
    { name: 'refresh拒绝且不查merchant', token: () => jwt.signRefresh(42n), queries: 0 },
    { name: 'admin拒绝且不查merchant', token: () => jwt.signAdmin('audit', 7n), queries: 0 },
    { name: '禁用商家有效access拒绝', token: () => jwt.signAccess({ mid: '42', phone: '13800000000' }), state: 'DISABLED', queries: 1 },
    { name: '不存在商家拒绝', token: () => tokenWith(responsePayload), state: 'MISSING', queries: 1 },
    { name: 'merchant查询失败拒绝', token: () => tokenWith(responsePayload), state: 'QUERY_ERROR', queries: 1 },
    { name: '错误issuer拒绝', token: () => tokenWith(responsePayload, { issuer: 'wrong' }), queries: 0 },
    { name: '错误audience拒绝', token: () => tokenWith(responsePayload, { audience: 'wrong' }), queries: 0 },
    { name: '缺失issuer拒绝', token: () => jsonwebtoken.sign({ ...responsePayload, aud: 'audit-client' }, process.env.JWT_SECRET!), queries: 0 },
    { name: '缺失audience拒绝', token: () => jsonwebtoken.sign({ ...responsePayload, iss: 'audit-issuer' }, process.env.JWT_SECRET!), queries: 0 },
    { name: 'HS384算法拒绝', token: () => tokenWith(responsePayload, { algorithm: 'HS384' }), queries: 0 },
    { name: 'HS512算法拒绝', token: () => tokenWith(responsePayload, { algorithm: 'HS512' }), queries: 0 },
    { name: 'none无签名算法拒绝', token: () => jsonwebtoken.sign(responsePayload, null, { algorithm: 'none', issuer: 'audit-issuer', audience: 'audit-client' }), queries: 0 },
    { name: '缺失typ拒绝', token: () => tokenWith({ mid: '42', phone: 'x' }), queries: 0 },
    { name: '未知typ拒绝', token: () => tokenWith({ ...responsePayload, typ: 'other' }), queries: 0 },
    { name: '非法mid拒绝', token: () => tokenWith({ ...responsePayload, mid: '-42' }), queries: 0 },
    { name: '过期access拒绝', token: () => tokenWith(responsePayload, { expiresIn: -1 }), queries: 0 },
    { name: '错误签名拒绝', token: () => jsonwebtoken.sign(responsePayload, 'another-secret', { issuer: 'audit-issuer', audience: 'audit-client' }), queries: 0 },
  ]
  try {
    for (const item of cases) {
      try {
        const result = await probe(item.token(), item.state ?? 'ACTIVE')
        assert.equal(result.nextCount, item.allowed ? 1 : 0)
        assert.equal(result.status, item.allowed ? 200 : 401)
        if (item.allowed) {
          assert.equal(result.mid, 42n)
          assert.equal(result.phone, '13800000000')
        } else {
          assert.equal(result.payload.code, 1001)
          assert.equal(result.mid, undefined)
        }
        assert.equal(lookups.length, item.queries)
        if (item.queries) assert.deepEqual(lookups[0], { where: { id: 42n }, select: { status: true } })
        assert.equal(blockedQueries, 0, '不得触发真实Prisma查询')
        console.log(`PASS ${item.name}`)
      } catch (error) {
        failed++
        console.error(`FAIL ${item.name}`, error)
      }
    }
    const unchanged = fingerprints.every(({ file, sha256 }) => createHash('sha256').update(readFileSync(file)).digest('hex') === sha256)
    console.log(`SOURCE_UNCHANGED=${unchanged} blockedRealQueries=${blockedQueries}`)
    console.log(`SUMMARY total=${cases.length} passed=${cases.length - failed} failed=${failed} merchantLookups=${totalLookups}`)
    if (!unchanged) console.error('源码执行期间变动，本批结果需重新确认版本，不作稳定验收。')
    process.exitCode = failed || !unchanged ? 1 : 0
  } finally {
    delegate.findUnique = originalFindUnique
    redis.disconnect()
    await prisma.$disconnect()
  }
}

main().catch((error) => { console.error('HARNESS_ERROR', error); process.exitCode = 1 })
