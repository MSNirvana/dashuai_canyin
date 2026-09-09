// 审计特征验证：断言当前缺陷，不代表产品验收通过。只调用真实函数 + 内存 DB 边界。
// 禁止加载 .env、启动 bootstrap、访问真实 DB/Redis/支付/AI/COS。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'

const requireServer = createRequire(`${process.cwd()}/server/package.json`)
const express = requireServer('express')
const checks: Array<{ name: string; run: () => Promise<void> | void }> = []
const check = (name: string, run: () => Promise<void> | void) => checks.push({ name, run })

function beanMemory(balance = 40n, grantBalance = 60n) {
  const state = { balance, grantBalance, frozen: 0n }
  const ledgers: any[] = []
  const db: any = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ id: 1n, merchant_id: 1n, balance: state.balance, grant_balance: state.grantBalance, frozen: state.frozen }],
    beanAccount: {
      update: async ({ data }: any) => {
        for (const key of ['balance', 'grantBalance', 'frozen'] as const) {
          if (typeof data[key] === 'bigint') state[key] = data[key]
        }
        return { ...state }
      },
      upsert: async () => ({ ...state }),
    },
    beanLedger: {
      findFirst: async ({ where }: any) => ledgers.find((row) => Object.entries(where).every(([k, v]) => row[k] === v)) ?? null,
      create: async ({ data }: any) => { ledgers.push(data); return data },
    },
    systemSetting: { findUnique: async () => null },
  }
  // 仅执行回调，不模拟提交/回滚/锁；不得据此推断 MySQL 行为。
  db.$transaction = async (callback: any) => callback(db)
  return { db, state, ledgers }
}

async function post(app: any, path: string, body: string, headers: Record<string, string> = {}) {
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
    })
    return { status: response.status, text: await response.text() }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function main() {
  // 所有业务模块均在环境隔离之后动态加载，确保模块级常量不读取真实配置。
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('WX_') || key.startsWith('COS_')) delete process.env[key]
  }
  process.env.NODE_ENV = 'production'
  process.env.JWT_SECRET = 'audit-only-key-not-a-production-secret'
  process.env.DATABASE_URL = 'mysql://audit:audit@127.0.0.1:1/audit_never_connect'
  process.env.REDIS_URL = 'redis://127.0.0.1:1'
  process.env.FFMPEG_WORKER = 'false'
  process.env.WX_PAY_API_KEY_V3 = '12345678901234567890123456789012'
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  process.env.WX_PAY_PLATFORM_CERT = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

  const jwt = await import('../../server/src/lib/jwt.js')
  const { auth } = await import('../../server/src/middleware/auth.js')
  const creation = await import('../../server/src/services/creation.service.js')
  const bean = await import('../../server/src/bean/bean.service.js')
  const ai = await import('../../server/src/ai/ai.service.js')
  const wxpay = await import('../../server/src/lib/wxpay.js')
  const order = await import('../../server/src/services/order.service.js')
  const render = await import('../../server/src/services/render.service.js')
  const tts = await import('../../server/src/render/tts.js')
  const { prisma, redis } = await import('../../server/src/db.js')
  prisma.$use(async () => { throw new Error('AUDIT_BLOCKED_REAL_DATABASE_QUERY') })
  const payRouter = (await import('../../server/src/routes/pay.js')).default

  function authProbe(token: string) {
    const req: any = { headers: { authorization: `Bearer ${token}` } }
    let allowed = false
    const res: any = { locals: {}, code: 200, status(code: number) { this.code = code; return this }, json() {} }
    auth(req, res, () => { allowed = true })
    return { allowed, status: res.code, mid: req.merchantId }
  }

  check('Q01 refresh token 被业务 auth 接受；access接受/admin拒绝对照', () => {
    assert.deepEqual(authProbe(jwt.signRefresh(42n)), { allowed: true, status: 200, mid: 42n })
    assert.equal(authProbe(jwt.signAccess({ mid: '42', phone: 'test' })).allowed, true)
    assert.equal(authProbe(jwt.signAdmin('audit', 1n)).allowed, false)
  })

  check('Q02 createCreation 只校验 store，不校验外租户 dish', async () => {
    let data: any
    const db: any = {
      store: { findFirst: async ({ where }: any) => { assert.equal(where.merchantId, 1n); return { id: 1n } } },
      dish: { findFirst: async () => { throw new Error('unexpected dish lookup') } },
      creation: { create: async (input: any) => { data = input.data; return data } },
    }
    await creation.createCreation(db, 1n, { storeId: 1n, dishId: 200n })
    assert.equal(data.dishId, 200n)
    db.store.findFirst = async () => null
    await assert.rejects(() => creation.createCreation(db, 1n, { storeId: 2n }), creation.CreationStoreMismatchError)
  })

  check('Q03 updateShotAsset 保留shot/creation限定但不校验新asset', async () => {
    let input: any
    const db: any = {
      creation: { findFirst: async () => ({ id: 1n, shots: [] }) },
      shot: {
        updateMany: async (value: any) => { input = value; return { count: 1 } },
        findUnique: async () => ({ id: 10n, assetId: 900n }),
      },
    }
    await creation.updateShotAsset(db, 1n, 1n, 10n, { assetId: 900n })
    assert.deepEqual(input.where, { id: 10n, creationId: 1n })
    assert.equal(input.data.assetId, 900n)
  })

  check('Q04 真实freeze→consume使充值40赠60消费80后变充值-40赠60', async () => {
    const { db, state } = beanMemory()
    await bean.freeze(db, { merchantId: 1n, amount: 80n, requestId: 'split' })
    await bean.consume(db, { merchantId: 1n, amount: 80n, requestId: 'split' })
    assert.deepEqual(state, { balance: -40n, grantBalance: 60n, frozen: 0n })
  })

  check('Q05 freeze正常边界：不足及非正金额被拒绝', async () => {
    const { db, state } = beanMemory()
    await assert.rejects(() => bean.freeze(db, { merchantId: 1n, amount: 101n }), bean.BeanNotEnoughError)
    await assert.rejects(() => bean.freeze(db, { merchantId: 1n, amount: 0n }), /positive/)
    assert.equal(state.frozen, 0n)
  })

  check('Q06 全局requestId使B租户返回A租户AI快照；无日志仍拒绝', async () => {
    const { db, ledgers } = beanMemory()
    ledgers.push({ merchantId: 1n, requestId: 'shared', type: 'FREEZE', frozenAfter: 5n })
    db.aiScene = { findUnique: async () => ({ enabled: true, beanPrice: 5n, name: 'test' }) }
    db.aiCallLog = { findFirst: async ({ where }: any) => {
      assert.deepEqual(where, { requestId: 'shared' })
      return { merchantId: 1n, responseSnapshot: 'TENANT_A_PRIVATE_TEXT', beanCharged: 1n }
    } }
    const gateway: any = { runScene: async () => { throw new Error('gateway must not run') } }
    const params = { merchantId: 2n, requestId: 'shared', sceneCode: 'copy_generate', variables: {}, bizId: 'B' }
    const result = await ai.runBilledScene(db, gateway, params)
    assert.equal(result.text, 'TENANT_A_PRIVATE_TEXT')
    assert.equal(result.duplicated, true)
    db.aiCallLog.findFirst = async () => null
    await assert.rejects(() => ai.runBilledScene(db, gateway, params), ai.ScenePendingError)
  })

  const standard = { out_trade_no: 'AUDIT_ORDER', transaction_id: 'AUDIT_TX', trade_state: 'SUCCESS' }
  const nonce = '123456789012'
  const associated_data = 'transaction'
  const cipher = crypto.createCipheriv('aes-256-gcm', process.env.WX_PAY_API_KEY_V3, nonce)
  cipher.setAAD(Buffer.from(associated_data))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(standard)), cipher.final(), cipher.getAuthTag()]).toString('base64')
  const resource = { ciphertext, nonce, associated_data }
  const rawBody = JSON.stringify({ resource }, null, 2)
  const timestamp = '1700000000'
  const signature = crypto.createSign('RSA-SHA256').update(`${timestamp}\n${nonce}\n${rawBody}\n`).sign(keys.privateKey, 'base64')
  const headers = { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-signature': signature }

  check('Q07 标准AES-GCM解密保留snake_case；handleNotify返回SUCCESS但零DB调用', async () => {
    assert.deepEqual(wxpay.decryptResource(resource), standard)
    const forbidden: any = new Proxy({}, { get() { throw new Error('DB touched') } })
    assert.deepEqual(await order.handleNotify(forbidden, rawBody), { code: 'SUCCESS' })
  })

  check('Q08 HTTP真实payRouter：JSON先raw破坏原文；raw优先对照保持验签', async () => {
    assert.equal(wxpay.verifyNotify(headers, rawBody), true)
    assert.equal(wxpay.verifyNotify(headers, '[object Object]'), false)
    const broken = express()
    let brokenBody: unknown
    broken.use(express.json())
    broken.use('/api/v1/pay', express.raw({ type: 'application/json' }), (req: any, _res: any, next: any) => { brokenBody = req.body; next() }, payRouter)
    const response = await post(broken, '/api/v1/pay/notify', rawBody, headers)
    assert.equal(Buffer.isBuffer(brokenBody), false)
    assert.equal(response.status, 500)
    assert.match(response.text, /object Object|Unexpected token/)
    const control = express()
    control.use('/api/v1/pay', express.raw({ type: 'application/json' }), payRouter)
    assert.equal((await post(control, '/api/v1/pay/notify', rawBody, headers)).status, 200)
  })

  check('Q09 NODE_ENV=production缺支付凭据时加油包直接PAID并入账', async () => {
    assert.equal(wxpay.wxpayEnabled, false)
    const { db, state, ledgers } = beanMemory(0n, 0n)
    let row: any
    db.beanPackage = { findFirst: async () => ({ id: 1n, priceFen: 10000, beans: 10000n, bonusBeans: 0n }) }
    db.membership = { findFirst: async () => ({ id: 1n, endAt: new Date(Date.now() + 86400000) }) }
    db.order = {
      create: async ({ data }: any) => { row = { id: 1n, ...data }; return row },
      findUnique: async () => row,
      update: async ({ data }: any) => { Object.assign(row, data); return row },
    }
    const response = await order.createBeanOrder(db, 1n, 1n)
    assert.equal(response.dev, true)
    assert.equal(row.status, 'PAID')
    assert.match(row.wxTransactionId, /^DEV/)
    assert.equal(state.balance, 10000n)
    assert.equal(ledgers[0].type, 'RECHARGE')
  })

  function renderMemory() {
    const memory = beanMemory(1000n, 0n)
    const { db } = memory
    let task: any
    db.membership = { findFirst: async () => ({ id: 1n }) }
    db.creation = { findFirst: async () => ({ id: 1n, shots: [] }) }
    db.shot = { findMany: async () => [{ id: 10n, assetId: 900n, trimStartMs: 0, trimEndMs: 1000, line: '必须保留的口播' }] }
    db.mediaAsset = { findMany: async ({ where }: any) => {
      assert.equal(where.merchantId, undefined)
      return [{ id: 900n, merchantId: 2n, cosKey: 'tenant-B/private.mp4', coverKey: null, durationMs: 1000 }]
    } }
    db.renderTask = {
      findFirst: async ({ where }: any) => where.id ? task : null,
      create: async ({ data }: any) => {
        task = { id: 99n, createdAt: new Date(), finishAt: null, progress: 0, cacheHit: false, resultKey: null, ...data }
        return task
      },
      update: async ({ data }: any) => { Object.assign(task, data); return task },
    }
    return { ...memory, task: () => task }
  }

  check('Q10 实际submitRender传播外租户素材、遗漏line、模拟首素材SUCCESS', async () => {
    const { db } = renderMemory()
    const result = await render.submitRender(db, 1n, 1n, { mode: 'FULL', grade: 'AI', requestId: 'render-ok' })
    assert.equal(result.task.clips[0].cosKey, 'tenant-B/private.mp4')
    assert.equal(result.task.clips[0].line, undefined)
    assert.equal(result.task.status, 'SUCCESS')
    assert.equal(result.task.resultKey, result.task.clips[0].cosKey)
  })

  check('Q11 submitRender第二事务异常向外抛；任务创建已先执行且未标FAILED', async () => {
    const memory = renderMemory()
    let calls = 0
    memory.db.$transaction = async (callback: any) => {
      calls++
      if (calls === 2) throw new Error('AUDIT_SECOND_TX_FAILURE')
      return callback(memory.db)
    }
    await assert.rejects(() => render.submitRender(memory.db, 1n, 1n, { mode: 'FULL', requestId: 'render-fail' }), /AUDIT_SECOND_TX_FAILURE/)
    assert.equal(calls, 2)
    assert.equal(memory.task().status, 'QUEUED')
    assert.equal(memory.state.frozen, 0n)
  })

  check('Q12 配置真实TTS供应商仍抛not implemented，不执行ffmpeg', async () => {
    await assert.rejects(() => tts.synthesizeNarration('口播', 1000, '/tmp/audit-never-written.m4a', { code: 'tencent', apiKey: 'audit' } as any), /not implemented yet/)
  })

  check('Q13 实际creations路由：未订阅copy/storyboard返回500而非403/2005', async () => {
    const delegate = prisma.membership as any
    const original = delegate.findFirst
    delegate.findFirst = async () => null
    try {
      const router = (await import('../../server/src/routes/creations.js')).default
      const app = express()
      app.use(express.json())
      app.use('/api/v1/creations', router)
      for (const scene of ['copy', 'storyboard']) {
        const response = await post(app, `/api/v1/creations/1/${scene}`, '{}', { authorization: `Bearer ${jwt.signAccess({ mid: '1', phone: 'audit' })}` })
        assert.equal(response.status, 500)
        assert.equal(JSON.parse(response.text).code, 500)
      }
    } finally { delegate.findFirst = original }
  })

  let failed = 0
  try {
    for (const item of checks) {
      try { await item.run(); console.log(`PASS ${item.name}`) }
      catch (error) { failed++; console.error(`FAIL ${item.name}`, error) }
    }
    console.log(`SUMMARY total=${checks.length} passed=${checks.length - failed} failed=${failed}; characterization only, not acceptance`)
  } finally {
    redis.disconnect()
    await prisma.$disconnect()
  }
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => { console.error('HARNESS_ERROR', error); process.exitCode = 1 })
