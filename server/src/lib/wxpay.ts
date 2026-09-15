// 微信支付 v3（JSAPI）客户端
// 仅用 Node 内置 crypto 实现，不引第三方支付 SDK：
//  - 下单：RSA-SHA256 对「METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n」签名，带 Authorization 头
//  - 调起支付：用 prepay_id 构造 wx.requestPayment 所需 paySign（RSA-SHA256）
//  - 回调：AES-256-GCM 解密 resource.ciphertext
// 缺少真实配置时能力关闭；生产严禁通过缺配置隐式进入演示支付。
//
// ★ 两套密钥方向相反，最容易混淆，务必分清：
//   · 商户 API 证书（WX_PAY_PRIVATE_KEY + WX_PAY_SERIAL_NO）——代表**商户侧**身份，
//     用于我们对微信发起的**请求签名**。来自「API安全 → 申请API证书」。
//   · 微信侧验签凭据（WX_PAY_PLATFORM_CERT）——代表**微信侧**身份，
//     用于验证微信下发给我们的**响应与回调签名**。来自「API安全 → 微信支付公钥 / 平台证书」。
import crypto from 'crypto'

const mchId = process.env.WX_PAY_MCH_ID ?? ''
const apiV3Key = process.env.WX_PAY_API_KEY_V3 ?? ''
const serialNo = process.env.WX_PAY_SERIAL_NO ?? ''
const privateKey = (process.env.WX_PAY_PRIVATE_KEY ?? '').replace(/\\n/g, '\n')
const appId = process.env.WX_APPID ?? ''
const notifyUrl = process.env.WX_PAY_NOTIFY_URL ?? ''

// 微信侧验签凭据，两种模式二选一（微信对同一商户**只启用其中一种**）：
//   ① 平台证书（X.509，5 年有效期，需用 GET /v3/certificates 定期轮换）
//   ② 微信支付公钥（SPKI，**长期有效**，2024 年底起微信主推）
// 环境变量名沿用 `WX_PAY_PLATFORM_CERT` 是因为它先于公钥存在；它装的是「微信侧公钥材料」，
// 两种内容都合法。**不要**因为变量名里的 "CERT" 就只接受证书 —— 见下方 wxpayEnabled。
const platformCert = (process.env.WX_PAY_PLATFORM_CERT ?? '').replace(/\\n/g, '\n')

/**
 * 微信侧验签凭据的形态。
 *   certificate —— 平台证书（X.509）
 *   public-key  —— 微信支付公钥（SPKI）
 *   none        —— 未配置或内容无法识别
 *
 * 参数默认取环境变量，显式传入便于测试（见 scripts/verify-wxpay-notify-signature.ts）。
 */
export function wechatVerifyMode(material: string = platformCert): 'certificate' | 'public-key' | 'none' {
  if (material.includes('BEGIN CERTIFICATE')) return 'certificate'
  if (material.includes('BEGIN PUBLIC KEY')) return 'public-key'
  return 'none'
}

/**
 * 是否具备真实微信支付能力；微信侧验签凭据与通知配置必须完整。
 *
 * ⚠ 这里**必须同时接受平台证书与微信支付公钥**。
 *   微信支付对同一商户只启用其中一种，而**新注册商户（2024 年底起）默认没有平台证书** ——
 *   此时调 `GET /v3/certificates` 会返回：
 *     `404 RESOURCE_NOT_EXISTS 无可用的平台证书，请在商户平台-API安全申请使用微信支付公钥`
 *   若只认 `BEGIN CERTIFICATE`，这类商户的支付永远启用不了（配置全填了却静默降级成 disabled）。
 */
export const wxpayEnabled = Boolean(
  mchId &&
  apiV3Key.length === 32 &&
  serialNo &&
  privateKey.includes('BEGIN') &&
  appId &&
  notifyUrl &&
  wechatVerifyMode() !== 'none',
)

const BASE = 'https://api.mch.weixin.qq.com'

function sha256RsaSign(message: string): string {
  if (!privateKey) throw new Error('WX_PAY_PRIVATE_KEY not set')
  return crypto.createSign('RSA-SHA256').update(message).sign(privateKey, 'base64')
}

export interface PayParams {
  timeStamp: string
  nonceStr: string
  package: string
  signType: 'RSA'
  paySign: string
}

/** wx.requestPayment 调起参数（前端拿到后直接 wx.requestPayment(payParams)） */
export function buildPayParams(prepayId: string): PayParams {
  const timeStamp = Math.floor(Date.now() / 1000).toString()
  const nonceStr = crypto.randomBytes(16).toString('hex')
  const pkg = `prepay_id=${prepayId}`
  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`
  const paySign = sha256RsaSign(message)
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign }
}

export interface JsapiOrderInput {
  description: string
  outTradeNo: string
  amountFen: number
  openid: string
}

/** 创建 JSAPI 支付订单，返回 prepay_id */
export async function createJsapiOrder(input: JsapiOrderInput): Promise<{ prepayId: string }> {
  const url = '/v3/pay/transactions/jsapi'
  const body = JSON.stringify({
    appid: appId,
    mchid: mchId,
    description: input.description,
    out_trade_no: input.outTradeNo,
    notify_url: notifyUrl,
    amount: { total: input.amountFen },
    payer: { openid: input.openid },
  })
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = crypto.randomBytes(16).toString('hex')
  const signature = sha256RsaSign(`POST\n${url}\n${timestamp}\n${nonce}\n${body}\n`)
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`

  const resp = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body,
  })
  const data = (await resp.json()) as { code?: string; message?: string; prepay_id?: string }
  if (!resp.ok || !data.prepay_id) {
    throw new Error(`WeChat Pay JSAPI failed: ${data.code ?? resp.status} ${data.message ?? ''}`)
  }
  return { prepayId: data.prepay_id }
}

export interface DecryptedNotify {
  appid: string
  mchid: string
  outTradeNo: string
  transactionId: string
  tradeState: string
  amountFen: number
  currency: string
  successTime?: string
}

/** 解密回调报文（AES-256-GCM） */
export function decryptResource(resource: { ciphertext: string; nonce: string; associated_data?: string }): DecryptedNotify {
  if (!apiV3Key) throw new Error('WX_PAY_API_KEY_V3 not set')
  const buf = Buffer.from(resource.ciphertext, 'base64')
  const authTag = buf.subarray(buf.length - 16)
  const data = buf.subarray(0, buf.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', apiV3Key, resource.nonce)
  decipher.setAuthTag(authTag)
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data))
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
  const input = JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>
  const amount = input.amount as Record<string, unknown> | undefined
  if (typeof input.appid !== 'string' || typeof input.mchid !== 'string' || typeof input.out_trade_no !== 'string' || typeof input.transaction_id !== 'string' || typeof input.trade_state !== 'string' || typeof amount?.total !== 'number' || amount.currency !== 'CNY') throw new Error('Invalid payment notification payload')
  return {
    appid: input.appid,
    mchid: input.mchid,
    outTradeNo: input.out_trade_no,
    transactionId: input.transaction_id,
    tradeState: input.trade_state,
    amountFen: amount.total,
    currency: String(amount.currency),
    successTime: typeof input.success_time === 'string' ? input.success_time : undefined,
  }
}

/**
 * 校验回调签名头（未配置微信侧验签凭据时返回 false，调用方在 dev 会放行）。
 *
 * 平台证书与微信支付公钥**走同一段代码**：`crypto.createVerify().verify()` 的第一个参数
 * 既接受 X.509 证书 PEM，也接受 SPKI 公钥 PEM，且签名算法相同（RSA-SHA256）。
 * 所以支持公钥模式**不需要**在这里分叉。
 *
 * 关于 `Wechatpay-Serial` 头：微信用它指明「本次签名用的是哪把钥匙」，证书模式下是平台证书
 * 序列号，公钥模式下是公钥 ID（`PUB_KEY_ID_...`）。我们**刻意不强制校验它**：
 *   1. 本商户只配置一把微信侧钥匙，没有「用哪把」的歧义；
 *   2. 只要签名能通过我们配置的那把公钥验签，就证明报文确实来自微信支付
 *      （私钥只在微信手里），安全性不依赖该头；
 *   3. 微信在「平台证书 → 公钥」灰度切换期，该头可能仍返回平台证书序列号，
 *      强校验会把合法回调误判为伪造 —— 那才是真正的线上事故（用户付了钱拿不到积分）。
 * 该头仍会记入日志便于排查。
 */
export function verifyNotify(
  headers: Record<string, string | undefined>,
  rawBody: string,
  verifyMaterial: string = platformCert,
): boolean {
  if (!verifyMaterial) return false
  const ts = headers['wechatpay-timestamp']
  const nonce = headers['wechatpay-nonce']
  const sig = headers['wechatpay-signature']
  if (!ts || !nonce || !sig || !/^\d+$/.test(ts)) return false
  const timestamp = Number(ts)
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false
  const message = `${ts}\n${nonce}\n${rawBody}\n`
  try {
    return crypto.createVerify('RSA-SHA256').update(message).verify(verifyMaterial, Buffer.from(sig, 'base64'))
  } catch {
    return false
  }
}
