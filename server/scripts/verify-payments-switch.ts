// PAYMENTS_ENABLED 支付开关契约测试（P1-7）。
//
// 验证五件事：
//   A. paymentsEnabled() 的取值解析（含无法识别时必须抛错）
//   B. validateProductionConfig() —— 关闭支付只跳过「支付凭据」校验，
//      **其余全部安全守卫必须照旧生效**（这是本次改动的核心诉求）
//   C. resolvePayMode() 真值表 —— 特别是「production 下永远不会走演示支付」这条铁律
//   D. resolvePayChannel() 真值表 —— 通道必须按**本次请求的客户端能力**选，
//      不许退回「看本环境配没配 WX_VP_*」的进程级判定（那会让旧版本客户端付不了款）
//   E. 当前 server/.env 的实际判定
//
// 全部为纯函数测试（+ D 段的源码级断言），不碰数据库、不起服务、无副作用。
// 跑法：npm run payments:verify
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import '../src/env.js' // 加载 .env（并为 E 段提供真实进程环境）
import { paymentsEnabled, validateProductionConfig } from '../src/lib/config.js'
import { resolvePayMode, resolvePayChannel } from '../src/services/order.service.js'
import { vpLegacyJsapiAllowed } from '../src/lib/xpay.js'

let pass = 0
let fail = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ✓ ${label} → ${a}`)
    pass += 1
  } else {
    console.log(`  ✗ ${label} → 实际 ${a}，期望 ${e}`)
    fail += 1
  }
}

/** 一份「除支付外全部合规」的生产环境，用来单独观察支付相关分支 */
const PROD_OK: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(48),
  APP_MASTER_KEY: 'a'.repeat(64),
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  CORS_ORIGIN: 'https://admin.example.com',
  DEV_LOGIN: 'false',
  MOCK_AI: 'false',
  PAYMENT_MODE: 'real',
  FFMPEG_WORKER: 'true',
  STORAGE_MODE: 'cos',
  COS_BUCKET: 'b-1',
  COS_REGION: 'ap-beijing',
  COS_SECRET_ID: 'id',
  COS_SECRET_KEY: 'key',
  WX_PAY_MCH_ID: '1900000000',
  WX_PAY_API_KEY_V3: 'k'.repeat(32),
  WX_PAY_SERIAL_NO: 'SN',
  WX_PAY_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
  WX_APPID: 'wxappid',
  WX_PAY_NOTIFY_URL: 'https://api.example.com/notify',
  WX_PAY_PLATFORM_CERT: '-----BEGIN CERTIFICATE-----',
}

/** 跑一段会抛错的逻辑：不抛返回 null，抛了返回错误信息。用于断言「必须拒绝」。 */
function mustThrow(fn: () => void): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/** 断言 fn 不抛错。返回 true 表示符合预期。 */
function mustPass(fn: () => void): boolean {
  return mustThrow(fn) === null
}

console.log('=== A. paymentsEnabled() 取值解析 ===')
{
  const cases: Array<[string, string | undefined, unknown]> = [
    ['未设置 → 开启（fail-closed，逼迫显式选择）', undefined, true],
    ['空字符串 → 开启', '', true],
    ['true → 开启', 'true', true],
    ['false → 关闭', 'false', false],
    ['0 → 关闭', '0', false],
    ['NO → 关闭（大小写不敏感）', 'NO', false],
    ['off → 关闭', 'off', false],
    ['yes → 开启', 'yes', true],
    ['TRUE（含空格）→ 开启', ' TRUE ', true],
  ]
  for (const [label, raw, expected] of cases) {
    const env = raw === undefined ? {} : ({ PAYMENTS_ENABLED: raw } as NodeJS.ProcessEnv)
    check(label, paymentsEnabled(env), expected)
  }
  // 无法识别的取值必须抛错：安全开关静默误读比响亮报错危险得多
  const r = mustThrow(() => paymentsEnabled({ PAYMENTS_ENABLED: 'maybe' } as NodeJS.ProcessEnv))
  check('maybe → 抛错而非猜测', r !== null && r.includes('无法识别'), true)
}

console.log('\n=== B. validateProductionConfig() 守卫矩阵 ===')
{
  check('基准：生产 + 支付齐备 → 通过', mustPass(() => validateProductionConfig(PROD_OK)), true)

  // 未设置 PAYMENTS_ENABLED：保持原有 fail-closed，生产缺支付凭据拒绝启动
  const noPay = { ...PROD_OK, PAYMENTS_ENABLED: undefined } as NodeJS.ProcessEnv
  delete noPay.WX_PAY_MCH_ID
  const r1 = mustThrow(() => validateProductionConfig(noPay))
  check('生产 + 未设置开关 + 缺支付凭据 → 拒绝启动', r1 !== null && r1.includes('Missing production payment config'), true)

  // 显式关闭：跳过支付校验，服务器可启动 —— 这正是本次改动要达成的效果
  // 注意 `: NodeJS.ProcessEnv` 注解不能删：展开一个带索引签名的类型会丢掉索引签名，
  // 于是下面 `delete off.WX_PAY_*` 会报「属性不存在」。加上注解即恢复环境变量语义。
  const off: NodeJS.ProcessEnv = { ...PROD_OK, PAYMENTS_ENABLED: 'false' }
  delete off.WX_PAY_MCH_ID
  delete off.WX_PAY_API_KEY_V3
  delete off.WX_PAY_NOTIFY_URL
  check('生产 + PAYMENTS_ENABLED=false + 缺支付凭据 → 允许启动', mustPass(() => validateProductionConfig(off)), true)

  // ★ 关键：关闭支付**不得**顺带放松任何其他守卫
  const relaxedCases: Array<[string, NodeJS.ProcessEnv]> = [
    ['DEV_LOGIN=true', { ...off, DEV_LOGIN: 'true' }],
    ['MOCK_AI=true', { ...off, MOCK_AI: 'true' }],
    ['STORAGE_MODE=local', { ...off, STORAGE_MODE: 'local' }],
    ['CORS_ORIGIN=*', { ...off, CORS_ORIGIN: '*' }],
    ['FFMPEG_WORKER 未开', { ...off, FFMPEG_WORKER: 'false' }],
    ['JWT_SECRET 过短', { ...off, JWT_SECRET: 'short' }],
    ['JWT_SECRET 含 dev-insecure', { ...off, JWT_SECRET: 'dev-insecure-secret-'.padEnd(48, 'x') }],
    ['APP_MASTER_KEY 非 64 hex', { ...off, APP_MASTER_KEY: 'not-hex' }],
    ['缺 COS_SECRET_KEY', (() => { const e = { ...off }; delete e.COS_SECRET_KEY; return e })()],
  ]
  for (const [label, env] of relaxedCases) {
    const r = mustThrow(() => validateProductionConfig(env))
    check(`生产 + 关闭支付 + ${label} → 仍然拒绝启动`, r !== null, true)
  }
}

console.log('\n=== C. resolvePayMode() 真值表 ===')
{
  const WX = {
    WX_PAY_MCH_ID: '1900000000',
    WX_PAY_API_KEY_V3: 'k'.repeat(32),
    WX_PAY_SERIAL_NO: 'SN',
    WX_PAY_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
    WX_APPID: 'wxappid',
    WX_PAY_NOTIFY_URL: 'https://api.example.com/notify',
    WX_PAY_PLATFORM_CERT: '-----BEGIN CERTIFICATE-----',
  }
  // 注意：resolvePayMode 读的是模块级 wxpayEnabled（进程 env），
  // 所以这里只测「开关 / NODE_ENV / PAYMENT_MODE」三维，凭据维度由 wxpayEnabled 决定。
  const cases: Array<[string, NodeJS.ProcessEnv, unknown]> = [
    ['development + 未设开关 + PAYMENT_MODE=test → demo（向后兼容）', { NODE_ENV: 'development', PAYMENT_MODE: 'test' }, 'demo'],
    ['development + 未设开关 + PAYMENT_MODE=real → disabled', { NODE_ENV: 'development', PAYMENT_MODE: 'real' }, 'disabled'],
    ['development + 关支付 + PAYMENT_MODE=test → demo（演示支付不受开关影响）', { NODE_ENV: 'development', PAYMENTS_ENABLED: 'false', PAYMENT_MODE: 'test' }, 'demo'],
    ['production + 关支付 + PAYMENT_MODE=test → disabled ★production 永远拿不到演示支付', { NODE_ENV: 'production', PAYMENTS_ENABLED: 'false', PAYMENT_MODE: 'test' }, 'disabled'],
    ['production + 未设开关 + PAYMENT_MODE=real → disabled（本机无真实凭据）', { NODE_ENV: 'production', PAYMENT_MODE: 'real' }, 'disabled'],
    ['production + 未设开关 + PAYMENT_MODE=test → disabled ★', { NODE_ENV: 'production', PAYMENT_MODE: 'test' }, 'disabled'],
  ]
  for (const [label, env, expected] of cases) {
    check(label, resolvePayMode(env), expected)
  }
  void WX
}

console.log('\n=== D. resolvePayChannel()：通道必须按「本次客户端的能力」选 ===')
{
  /** 环境侧已配齐虚拟支付（offerId / appKey / WX_APPID 三项齐备） */
  const VP_OK: NodeJS.ProcessEnv = {
    WX_VP_ENV: '0',
    WX_VP_OFFER_ID: 'off-1',
    WX_VP_APP_KEY: 'k'.repeat(32),
    WX_APPID: 'wxappid',
  }
  const cases: Array<[string, { env: NodeJS.ProcessEnv; clientVpCapable: boolean }, unknown]> = [
    // ① 环境没配 ⇒ 只有 JSAPI 一条路，客户端认不认识都一样
    ['环境未配 WX_VP_* + 客户端认识 → jsapi', { env: {}, clientVpCapable: true }, 'jsapi'],
    ['环境未配 WX_VP_* + 客户端不认识 → jsapi', { env: {}, clientVpCapable: false }, 'jsapi'],
    [
      '只配一半（缺 appKey）→ jsapi（vpEnabled=false，绝不半信半疑）',
      { env: { WX_VP_OFFER_ID: 'o', WX_APPID: 'a' }, clientVpCapable: true },
      'jsapi',
    ],
    // ② 配齐了：认识的客户端一律走虚拟支付
    ['配齐 + 客户端认识 → vp', { env: VP_OK, clientVpCapable: true }, 'vp'],
    [
      '配齐 + 客户端认识 + 开关=false → vp（切齐开关不影响新版客户端）',
      { env: { ...VP_OK, WX_VP_LEGACY_JSAPI: 'false' }, clientVpCapable: true },
      'vp',
    ],
    // ③ ★ 整个改动的核心：不认识四件套的客户端必须留在 JSAPI
    [
      '配齐 + 客户端不认识 + 开关默认 → jsapi ★否则线上旧版本客户端全体付不了款',
      { env: VP_OK, clientVpCapable: false },
      'jsapi',
    ],
    [
      '配齐 + 不认识 + 开关=true → jsapi',
      { env: { ...VP_OK, WX_VP_LEGACY_JSAPI: 'true' }, clientVpCapable: false },
      'jsapi',
    ],
    [
      '配齐 + 不认识 + 开关=FALSE（大小写不敏感）→ vp',
      { env: { ...VP_OK, WX_VP_LEGACY_JSAPI: 'FALSE' }, clientVpCapable: false },
      'vp',
    ],
    [
      '配齐 + 不认识 + 开关=false → vp（全量发布新版之后的切齐动作）',
      { env: { ...VP_OK, WX_VP_LEGACY_JSAPI: 'false' }, clientVpCapable: false },
      'vp',
    ],
    [
      '配齐 + 不认识 + 开关=0 → vp',
      { env: { ...VP_OK, WX_VP_LEGACY_JSAPI: '0' }, clientVpCapable: false },
      'vp',
    ],
    // ④ 写错值必须退回「放行」：错误方向指向安全侧
    [
      '配齐 + 不认识 + 开关写错(flase) → jsapi ★拼错必须退回安全侧，不能把线上打通',
      { env: { ...VP_OK, WX_VP_LEGACY_JSAPI: 'flase' }, clientVpCapable: false },
      'jsapi',
    ],
  ]
  for (const [label, input, expected] of cases) {
    check(label, resolvePayChannel(input), expected)
  }

  // ⑤ 过渡期开关自身的取值语义
  check('开关未设置 → 允许（默认放行）', vpLegacyJsapiAllowed({}), true)
  check('开关为空串 → 允许', vpLegacyJsapiAllowed({ WX_VP_LEGACY_JSAPI: '' }), true)
  check("开关=' false '（带空格）→ 关闭", vpLegacyJsapiAllowed({ WX_VP_LEGACY_JSAPI: ' false ' }), false)
  check("开关='0' → 关闭", vpLegacyJsapiAllowed({ WX_VP_LEGACY_JSAPI: '0' }), false)
  check(
    "开关='no' → 允许（只认 false/0，不猜其他否定词）",
    vpLegacyJsapiAllowed({ WX_VP_LEGACY_JSAPI: 'no' }),
    true,
  )
}

// ⑥ 源码级：两个下单函数都必须把「客户端能力」一路传下去。
//    ★ 为什么这里要机械校验：漏传参数 TS 会报错（该参数无默认值），但真正危险的是
//      有人图省事把 `resolvePayChannel` 改回「只读 env」的旧写法 —— 那种回退
//      **类型完全合法**，却会让线上所有旧版本客户端瞬间付不了款。类型系统拦不住它。
{
  const orderSvc = readFileSync(
    fileURLToPath(new URL('../src/services/order.service.ts', import.meta.url)),
    'utf8',
  )
  check(
    'order.service.ts：两个下单口都传了 clientVpCapable',
    (orderSvc.match(/resolvePayChannel\(\{\s*clientVpCapable/g) ?? []).length,
    2,
  )
  check(
    'order.service.ts：不存在无参调用 resolvePayChannel()（进程级旧写法）',
    (orderSvc.match(/resolvePayChannel\(\s*\)/g) ?? []).length,
    0,
  )

  const routes = readFileSync(fileURLToPath(new URL('../src/routes/orders.ts', import.meta.url)), 'utf8')
  check(
    'routes/orders.ts：入参 schema 用 optionalFlag 接收 vpCapable（永不 400）',
    /vpCapable:\s*optionalFlag\(\)/.test(routes),
    true,
  )
  check(
    'routes/orders.ts：两个下单口都把 vpCapable 传给了 service',
    (routes.match(/^\s+vpCapable,$/gm) ?? []).length,
    2,
  )
}

console.log('\n=== E. 当前 server/.env 的实际判定 ===')
{
  // 由 src/env.ts 已加载的真实环境
  const mode = resolvePayMode(process.env)
  console.log(`  NODE_ENV=${process.env.NODE_ENV}  PAYMENT_MODE=${process.env.PAYMENT_MODE ?? '(未设置)'}  PAYMENTS_ENABLED=${process.env.PAYMENTS_ENABLED ?? '(未设置)'}`)
  console.log(`  → resolvePayMode() = ${mode}`)
  if (process.env.NODE_ENV !== 'production' && mode === 'demo') {
    console.log('  ✓ 本地开发仍走演示支付，行为与改动前一致')
    pass += 1
  } else if (process.env.NODE_ENV === 'production' && mode === 'disabled') {
    console.log('  ✓ 生产环境支付已关闭，下单会被拒绝')
    pass += 1
  } else {
    console.log('  ⚠ 与预期不符，请检查 .env')
    fail += 1
  }
}

console.log(`\n★ ${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
