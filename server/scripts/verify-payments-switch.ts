// PAYMENTS_ENABLED 支付开关契约测试（P1-7）。
//
// 验证三件事：
//   A. paymentsEnabled() 的取值解析（含无法识别时必须抛错）
//   B. validateProductionConfig() —— 关闭支付只跳过「支付凭据」校验，
//      **其余全部安全守卫必须照旧生效**（这是本次改动的核心诉求）
//   C. resolvePayMode() 真值表 —— 特别是「production 下永远不会走演示支付」这条铁律
//
// 全部为纯函数测试，注入 env 对象，不碰数据库、不起服务、无副作用。
// 跑法：npm run payments:verify
import '../src/env.js' // 加载 .env（并为 D 段提供真实进程环境）
import { paymentsEnabled, validateProductionConfig } from '../src/lib/config.js'
import { resolvePayMode } from '../src/services/order.service.js'

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

console.log('\n=== D. 当前 server/.env 的实际判定 ===')
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
