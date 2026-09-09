// 微信支付 v3（JSAPI）客户端
// 仅用 Node 内置 crypto 实现，不引第三方支付 SDK：
//  - 下单：RSA-SHA256 对「METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n」签名，带 Authorization 头
//  - 调起支付：用 prepay_id 构造 wx.requestPayment 所需 paySign（RSA-SHA256）
//  - 回调：AES-256-GCM 解密 resource.ciphertext
// 缺少真实配置时能力关闭；生产严禁通过缺配置隐式进入演示支付。
import crypto from 'crypto'

const mchId = process.env.WX_PAY_MCH_ID ?? ''
const apiV3Key = process.env.WX_PAY_API_KEY_V3 ?? ''
const serialNo = process.env.WX_PAY_SERIAL_NO ?? ''
const privateKey = (process.env.WX_PAY_PRIVATE_KEY ?? '').replace(/\\n/g, '\n')
const appId = process.env.WX_APPID ?? ''
const notifyUrl = process.env.WX_PAY_NOTIFY_URL ?? ''
const platformCert = (process.env.WX_PAY_PLATFORM_CERT ?? '').replace(/\\n/g, '\n')

/** 是否具备真实微信支付能力；所有平台验签与通知配置必须完整。 */
export const wxpayEnabled = Boolean(
  mchId &&
  apiV3Key.length === 32 &&
  serialNo &&
  privateKey.includes('BEGIN') &&
  appId &&
  notifyUrl &&
  platformCert.includes('BEGIN CERTIFICATE'),
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

/** 校验回调签名头（配置了平台证书才校验，否则 dev 跳过） */
export function verifyNotify(headers: Record<string, string | undefined>, rawBody: string): boolean {
  if (!platformCert) return false
  const ts = headers['wechatpay-timestamp']
  const nonce = headers['wechatpay-nonce']
  const sig = headers['wechatpay-signature']
  if (!ts || !nonce || !sig || !/^\d+$/.test(ts)) return false
  const timestamp = Number(ts)
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false
  const message = `${ts}\n${nonce}\n${rawBody}\n`
  try {
    return crypto.createVerify('RSA-SHA256').update(message).verify(platformCert, Buffer.from(sig, 'base64'))
  } catch {
    return false
  }
}
