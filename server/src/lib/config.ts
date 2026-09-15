// ──────────────────────── 支付开关 ────────────────────────
//
// 为什么需要它（P1-7）：
//   微信支付商户号还在申请中，所以生产环境暂时拿不到 WX_PAY_* 七项凭据。
//   原来的绕法是把 NODE_ENV 写成 staging —— 但 NODE_ENV 是**全部** fail-closed 校验
//   的唯一开关（JWT_SECRET / APP_MASTER_KEY / CORS_ORIGIN / DEV_LOGIN / MOCK_AI /
//   FFMPEG_WORKER / STORAGE_MODE / COS），写 staging 等于把这些安全守卫一起关掉。
//
//   现在把「支付」这一件事单独拎出来，用一个显式开关控制，于是可以安心用
//   NODE_ENV=production，其余守卫全部正常生效。
//
// 取值语义（刻意做成 fail-closed）：
//   PAYMENTS_ENABLED 未设置 → 视为开启（true）。这样生产环境忘了配凭据会在**启动时**
//     直接失败，逼迫运维显式做出选择，而不是静默降级成一个「用户永远付不了钱」的线上环境。
//   PAYMENTS_ENABLED=false  → 关闭的是**真实微信支付能力**：跳过七项凭据校验，服务器可正常
//     启动，所有真实支付下单一律拒绝（业务码 3008）。
//     ⚠ 注意它**不影响非生产环境的演示支付**（PAYMENT_MODE=test 时的自动置 PAID），
//       那是开发联调必需的能力，且被 `NODE_ENV !== production` 单独锁死，生产永远拿不到。
//   取值无法识别 → 直接抛错，不猜测意图。安全相关的开关静默误读比响亮报错危险得多。
const TRUTHY = new Set(['true', '1', 'yes', 'on'])
const FALSY = new Set(['false', '0', 'no', 'off'])

export function paymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.PAYMENTS_ENABLED ?? '').trim().toLowerCase()
  if (raw === '') return true
  if (TRUTHY.has(raw)) return true
  if (FALSY.has(raw)) return false
  throw new Error(`PAYMENTS_ENABLED 取值无法识别：${JSON.stringify(env.PAYMENTS_ENABLED)}（只接受 true/false/1/0/yes/no/on/off）`)
}

/** 生产环境的 WX_PAY_* 七项凭据是否会被校验。供启动日志与部署脚本使用。 */
export function paymentsConfiguredRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' && paymentsEnabled(env)
}

/** Validate production configuration and fail closed. */
export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return
  for (const key of ['JWT_SECRET', 'APP_MASTER_KEY', 'DATABASE_URL', 'REDIS_URL', 'CORS_ORIGIN']) {
    const value: string = env[key] ?? ''
    if (!value || /dev-insecure|please-change|changeme|123456/i.test(value)) throw new Error(`Unsafe production config: ${key}`)
  }
  if ((env.JWT_SECRET ?? '').length < 32) throw new Error('JWT_SECRET requires at least 32 characters')
  if (!/^[0-9a-fA-F]{64}$/.test(env.APP_MASTER_KEY ?? '')) throw new Error('APP_MASTER_KEY requires 64 hex characters')
  if (env.DEV_LOGIN === 'true' || env.MOCK_AI === 'true') throw new Error('Demo features forbidden in production')
  if (paymentsEnabled(env)) {
    if (env.PAYMENT_MODE !== 'real') throw new Error('Demo features forbidden in production')
    for (const key of ['WX_PAY_MCH_ID', 'WX_PAY_API_KEY_V3', 'WX_PAY_SERIAL_NO', 'WX_PAY_PRIVATE_KEY', 'WX_APPID', 'WX_PAY_NOTIFY_URL', 'WX_PAY_PLATFORM_CERT']) {
      if (!(env[key] ?? '')) throw new Error(`Missing production payment config: ${key}`)
    }
    if ((env.WX_PAY_API_KEY_V3 ?? '').length !== 32) throw new Error('WX_PAY_API_KEY_V3 requires 32 characters')
  } else {
    // PAYMENTS_ENABLED=false：显式关闭支付能力。
    // 只跳过支付凭据校验，不放松任何其他守卫；下单入口会在 order.service 里被拒绝。
    console.warn('[config] PAYMENTS_ENABLED=false —— 跳过微信支付凭据校验；所有真实支付下单将被拒绝。仅用于商户号申请期间的灰度关闭。')
  }
  if (env.FFMPEG_WORKER !== 'true') throw new Error('Real render worker required in production')
  if (env.STORAGE_MODE === 'local') throw new Error('Local storage forbidden in production')
  for (const key of ['COS_BUCKET', 'COS_REGION', 'COS_SECRET_ID', 'COS_SECRET_KEY']) {
    if (!(env[key] ?? '')) throw new Error(`Missing production storage config: ${key}`)
  }
  if (env.CORS_ORIGIN === '*') throw new Error('Explicit CORS origins required')
}
