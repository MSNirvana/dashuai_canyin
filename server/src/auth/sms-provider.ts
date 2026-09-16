// 短信发送通道（provider 适配器）
//
// 分层理由：`sms.ts` 负责「业务规则」（何时发、限流、校验、落库），
// 本文件只负责「把一条短信送出去」。换供应商时不需要动业务规则。
//
// ⚠ 两条硬约束 —— 都是「不写就会静默出错」的类型，别简化：
//
// 1) 腾讯云 `SendSms` **发送失败也返回 HTTP 200、也不抛异常**。
//    失败信息在响应体的 `SendStatusSet[*].Code` 里。若只用 try/catch 判断成功，
//    就会出现「用户永远收不到短信，系统却认为已发送并保留了验证码记录」的静默失败。
//    ⇒ 必须逐条检查 `Code === 'Ok'`，失败时由调用方**回滚已写入的记录**。
//
// 2) 模板变量个数必须与 `TemplateParamSet` **完全一致**，否则报
//    `FailedOperation.TemplateParamInconsistent`（同样属于「请求成功但业务失败」）。
//    本项目模板正文只有一个变量 {1}（验证码本身），不含有效分钟数 ⇒ 只传 1 个参数。

import tencentcloud from 'tencentcloud-sdk-nodejs-sms'

/** 短信发送失败：通道明确返回失败，或请求本身异常（网络/鉴权/参数）。 */
export class SmsSendFailedError extends Error {
  readonly code = 'SMS_SEND_FAILED'
  constructor(readonly reason: string) {
    super(`短信发送失败：${reason}`)
    this.name = 'SmsSendFailedError'
  }
}

export type SmsProviderMode = 'tencent' | 'none'

/** 生产环境实际生效的短信通道。仅识别 `tencent`，未知取值一律视为未配置。 */
export function smsProviderMode(env: NodeJS.ProcessEnv = process.env): SmsProviderMode {
  return (env.SMS_PROVIDER ?? '').trim().toLowerCase() === 'tencent' ? 'tencent' : 'none'
}

export interface TencentSmsConfig {
  secretId: string
  secretKey: string
  sdkAppId: string
  signName: string
  templateId: string
  region: string
}

/** 五项必填。缺任一项都视为「通道未配置」——不猜、不降级。 */
const REQUIRED_KEYS = [
  'TENCENT_SMS_SECRET_ID',
  'TENCENT_SMS_SECRET_KEY',
  'TENCENT_SMS_SDK_APP_ID',
  'TENCENT_SMS_SIGN_NAME',
  'TENCENT_SMS_TEMPLATE_ID',
] as const

/** 当前缺失（或为空白）的配置项名。供启动日志与排查使用，不含任何密钥值。 */
export function missingTencentSmsKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_KEYS.filter((key) => !(env[key] ?? '').trim())
}

/**
 * 读取腾讯云短信配置。
 *
 * 缺项时返回 `null` 而**不是抛错**：短信是登录的**备选通道**，
 * 主通道（微信一键登录）不依赖它。配置不全只应让短信登录不可用，
 * 不该阻止服务启动 —— 这与支付（`PAYMENTS_ENABLED` 属于 fail-closed 硬依赖）刻意不同。
 */
export function readTencentSmsConfig(env: NodeJS.ProcessEnv = process.env): TencentSmsConfig | null {
  if (missingTencentSmsKeys(env).length > 0) return null
  return {
    secretId: (env.TENCENT_SMS_SECRET_ID ?? '').trim(),
    secretKey: (env.TENCENT_SMS_SECRET_KEY ?? '').trim(),
    sdkAppId: (env.TENCENT_SMS_SDK_APP_ID ?? '').trim(),
    signName: (env.TENCENT_SMS_SIGN_NAME ?? '').trim(),
    templateId: (env.TENCENT_SMS_TEMPLATE_ID ?? '').trim(),
    // 国内短信固定用广州区域；国际/港澳台短信才需要换。
    region: (env.TENCENT_SMS_REGION ?? '').trim() || 'ap-guangzhou',
  }
}

/** 短信通道是否真正可用（已选 tencent 且五项配置齐全）。 */
export function tencentSmsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return smsProviderMode(env) === 'tencent' && readTencentSmsConfig(env) !== null
}

const ENDPOINT = 'sms.tencentcloudapi.com'
/** 请求超时（秒）。腾讯云短信正常在 1 秒内返回，10 秒足够且不会长时间挂住登录请求。 */
const REQUEST_TIMEOUT_SEC = 10

/**
 * 发送验证码短信。成功静默返回；任何失败一律抛 `SmsSendFailedError`，
 * 由调用方负责回滚已写入的验证码记录（否则会留下一条永远等不到短信的有效验证码）。
 *
 * `phone` 传纯 11 位国内手机号，本函数负责补 `+86` 前缀（腾讯云要求 E.164 格式）。
 */
export async function sendSmsViaTencent(cfg: TencentSmsConfig, phone: string, code: string): Promise<void> {
  const client = new tencentcloud.sms.v20210111.Client({
    credential: { secretId: cfg.secretId, secretKey: cfg.secretKey },
    region: cfg.region,
    profile: { httpProfile: { endpoint: ENDPOINT, reqTimeout: REQUEST_TIMEOUT_SEC } },
  })

  let res: Awaited<ReturnType<typeof client.SendSms>>
  try {
    res = await client.SendSms({
      SmsSdkAppId: cfg.sdkAppId,
      SignName: cfg.signName,
      TemplateId: cfg.templateId,
      // ⚠ 与模板变量个数严格一致：本项目模板只有 {1}
      TemplateParamSet: [code],
      PhoneNumberSet: [`+86${phone}`],
    })
  } catch (e) {
    // 网络不通、SecretId/SecretKey 错误、参数被拒等都会走到这里
    throw new SmsSendFailedError((e as Error)?.message || '请求异常')
  }

  // ⚠ 关键：HTTP 200 + 无异常 ≠ 发送成功。必须看每一条的状态码。
  const status = res?.SendStatusSet?.[0]
  if (!status || status.Code !== 'Ok') {
    const detail = `${status?.Code ?? 'NO_STATUS'}${status?.Message ? ` ${status.Message}` : ''}`
    throw new SmsSendFailedError(detail)
  }
}
