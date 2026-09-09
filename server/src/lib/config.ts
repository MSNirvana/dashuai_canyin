/** Validate production configuration and fail closed. */
export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return
  for (const key of ['JWT_SECRET', 'APP_MASTER_KEY', 'DATABASE_URL', 'REDIS_URL', 'CORS_ORIGIN']) {
    const value: string = env[key] ?? ''
    if (!value || /dev-insecure|please-change|changeme|123456/i.test(value)) throw new Error(`Unsafe production config: ${key}`)
  }
  if ((env.JWT_SECRET ?? '').length < 32) throw new Error('JWT_SECRET requires at least 32 characters')
  if (!/^[0-9a-fA-F]{64}$/.test(env.APP_MASTER_KEY ?? '')) throw new Error('APP_MASTER_KEY requires 64 hex characters')
  if (env.DEV_LOGIN === 'true' || env.PAYMENT_MODE !== 'real' || env.MOCK_AI === 'true') throw new Error('Demo features forbidden in production')
  for (const key of ['WX_PAY_MCH_ID', 'WX_PAY_API_KEY_V3', 'WX_PAY_SERIAL_NO', 'WX_PAY_PRIVATE_KEY', 'WX_APPID', 'WX_PAY_NOTIFY_URL', 'WX_PAY_PLATFORM_CERT']) {
    if (!(env[key] ?? '')) throw new Error(`Missing production payment config: ${key}`)
  }
  if ((env.WX_PAY_API_KEY_V3 ?? '').length !== 32) throw new Error('WX_PAY_API_KEY_V3 requires 32 characters')
  if (env.FFMPEG_WORKER !== 'true') throw new Error('Real render worker required in production')
  if (env.CORS_ORIGIN === '*') throw new Error('Explicit CORS origins required')
}
