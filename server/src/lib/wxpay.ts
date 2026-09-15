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

// 微信支付公钥 ID（可选）。**它不是密钥材料**，不能替代上面的公钥 PEM ——
// 它只是「微信侧验签钥匙」的**标识**，两个用途：
//   ① 微信在下发响应/回调时用 `Wechatpay-Serial` 头指明「本次签名用的是哪把钥匙」；
//   ② 商户在需要**上送加密敏感信息**的接口（如商家转账的收款人姓名）时，
//      也要在请求头带 `Wechatpay-Serial: <公钥ID>` 指明用什么公钥加密。
// 本项目的 JSAPI 下单 + 回调流程**不需要发这个头**（没有需要加密上送的敏感字段），
// 所以配置它纯粹是为了在日志里核对回调头，便于真机排查。实测（商户 1750405417）：
// 微信对 v3 请求的响应头 `wechatpay-serial` 就是该值。
const publicKeyId = (process.env.WX_PAY_PUBLIC_KEY_ID ?? '').trim()

/** 已配置的微信支付公钥 ID；未配置时为空串。 */
export function getPublicKeyId(): string {
  return publicKeyId
}

/**
 * 描述回调头 `Wechatpay-Serial` 与已配置公钥 ID 的关系（供日志使用）。
 *
 * ⚠ **仅用于日志核对，绝不可作为拒绝回调的依据** —— 理由见 verifyNotify 的注释：
 *   微信在「平台证书 → 公钥」灰度期该头可能仍返回平台证书序列号，
 *   据此拒绝会把**合法回调误判为伪造**，用户付了钱拿不到积分。
 *
 * `expectedId` 默认取环境变量，显式传入便于测试。
 */
export function describeNotifySerial(serial: string | undefined, expectedId: string = publicKeyId): string {
  if (!expectedId) return `Wechatpay-Serial=${serial ?? '(缺失)'}（未配置 WX_PAY_PUBLIC_KEY_ID，未核对）`
  if (!serial) return `Wechatpay-Serial 缺失（已配置公钥 ID=${expectedId}）`
  return serial === expectedId
    ? `Wechatpay-Serial=${serial}（与已配置公钥 ID 一致）`
    : `Wechatpay-Serial=${serial} ≠ 已配置公钥 ID=${expectedId}（不拒绝，仅提示）`
}

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

/**
 * 构造 APIv3 请求的 Authorization 头（请求签名）。
 *
 * 签名串固定五段：`METHOD\nURL_PATH[?QUERY]\nTIMESTAMP\nNONCE\nBODY\n`
 * —— **GET 没有 body 也要保留最后那个 `\n`**（写漏了就是 401 SIGN_ERROR）。
 * `urlPathWithQuery` 必须**带 query**（如 `/v3/pay/.../x?mchid=123`），否则签名对不上。
 */
function signRequestHeader(method: string, urlPathWithQuery: string, body = ''): string {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = crypto.randomBytes(16).toString('hex')
  const signature = sha256RsaSign(`${method}\n${urlPathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`)
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`
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

  const resp = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: {
      Authorization: signRequestHeader('POST', url, body),
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

/** 微信查单结果里会出现的 trade_state */
export type WxTradeState =
  | 'SUCCESS' // 支付成功
  | 'REFUND' // 已转入退款
  | 'NOTPAY' // 未支付
  | 'CLOSED' // 已关闭（过期未支付 / 主动关单）
  | 'REVOKED' // 已撤销（付款码支付）
  | 'USERPAYING' // 用户支付中
  | 'PAYERROR' // 支付失败
  | 'NOT_EXIST' // 微信侧查无此单（404 ORDER_NOT_EXIST）

export interface WxQueryResult {
  tradeState: WxTradeState
  /** 微信交易号；未支付/查无此单时为 null */
  transactionId: string | null
  /** 微信侧记录的金额（分）；查无此单时为 null */
  amountFen: number | null
  successTime?: string
  /** 微信业务错误码，仅查无此单时有值 */
  wxCode?: string
}

/**
 * 【只读】按商户订单号查单 —— `GET /v3/pay/transactions/out-trade-no/{out_trade_no}?mchid=`。
 *
 * 存在的意义：**微信的异步回调不是可靠通道**。回调会因 notify_url 不可达（域名未备案被拦）、
 * 网络抖动、微信重试耗尽而静默丢失；此时用户钱已付、微信侧已是 SUCCESS，
 * 而我们本地订单永远停在 PENDING ⇒「钱付了没权益」。查单接口是唯一能主动纠正它的手段。
 *
 * 安全：**响应必须验签通过才返回**（fail closed）。查单结果会导致发权益，属于可信输入；
 * 验签失败说明报文不能确定来自微信，此时宁可报错让上层重试，也不能据此发权益。
 */
export async function queryOrderByOutTradeNo(outTradeNo: string): Promise<WxQueryResult> {
  // mchid 必须放进 query 且**参与签名**（签名串里的 URL_PATH 含 query）
  const pathWithQuery = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${mchId}`
  const resp = await fetch(`${BASE}${pathWithQuery}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      // ★ 缺这个头，微信会回一个极具误导性的
      //   `406 PARAM_ERROR 传入了不支持的Accept-Language`（明明我们没传）。
      //   Node 的 fetch/undici 默认不发 Accept-Language，所以必须显式带上。
      'Accept-Language': 'zh-CN',
      Authorization: signRequestHeader('GET', pathWithQuery),
    },
  })
  const body = await resp.text()

  if (!verifyResponse(resp.headers, body)) {
    throw new Error('微信查单响应验签失败：已拒绝据此结算（检查 WX_PAY_PLATFORM_CERT 是否为微信侧当前有效的公钥/证书）')
  }

  const data = JSON.parse(body) as {
    trade_state?: string
    transaction_id?: string
    amount?: { total?: number }
    success_time?: string
    code?: string
    message?: string
  }

  if (resp.status === 404) {
    // 微信侧没有这笔单：预下单没成功 / 已超过可查期限。**不是错误**，是正常的业务结果。
    return { tradeState: 'NOT_EXIST', transactionId: null, amountFen: null, wxCode: data.code }
  }
  if (!resp.ok || !data.trade_state) {
    throw new Error(`微信查单失败: ${data.code ?? resp.status} ${data.message ?? ''}`)
  }
  return {
    tradeState: data.trade_state as WxTradeState,
    transactionId: data.transaction_id ?? null,
    amountFen: typeof data.amount?.total === 'number' ? data.amount.total : null,
    successTime: data.success_time,
  }
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
 * 验签的公共内核：`{timestamp}\n{nonce}\n{body}\n` → 用微信侧材料验 RSA-SHA256。
 *
 * 平台证书与微信支付公钥**走同一段代码**：`crypto.createVerify().verify()` 的第一个参数
 * 既接受 X.509 证书 PEM，也接受 SPKI 公钥 PEM，且签名算法相同。
 * 所以支持公钥模式**不需要**分叉。
 *
 * 时间窗 ±300s 是防重放：微信签发的报文时间戳不会离现在太远。
 */
function verifySignedMessage(
  ts: string | null | undefined,
  nonce: string | null | undefined,
  sig: string | null | undefined,
  body: string,
  material: string,
): boolean {
  if (!material || !ts || !nonce || !sig || !/^\d+$/.test(ts)) return false
  const timestamp = Number(ts)
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false
  try {
    return crypto
      .createVerify('RSA-SHA256')
      .update(`${ts}\n${nonce}\n${body}\n`)
      .verify(material, Buffer.from(sig, 'base64'))
  } catch {
    return false
  }
}

/**
 * 校验**主动请求**（下单 / 查单）的微信响应签名头。
 *
 * 与 verifyNotify 的区别只是取头方式：主动请求的响应头是 `Headers` 对象（小写取值），
 * 回调是被 Express 展平成的普通对象。验签算法完全一致。
 *
 * 查单结果会直接导致发权益，所以调用方必须 **fail closed**：验签不过就抛错、不结算。
 */
export function verifyResponse(headers: Headers, body: string, material: string = platformCert): boolean {
  return verifySignedMessage(
    headers.get('wechatpay-timestamp'),
    headers.get('wechatpay-nonce'),
    headers.get('wechatpay-signature'),
    body,
    material,
  )
}

/**
 * 校验回调签名头（未配置微信侧验签凭据时返回 false，调用方在 dev 会放行）。
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
  return verifySignedMessage(
    headers['wechatpay-timestamp'],
    headers['wechatpay-nonce'],
    headers['wechatpay-signature'],
    rawBody,
    verifyMaterial,
  )
}
