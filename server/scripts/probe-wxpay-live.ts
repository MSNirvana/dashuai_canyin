/**
 * 微信支付 v3 · **只读**上线自检（收款前就能确认「接入成功」）。
 *
 * 为什么需要它：`wxpay:verify` 是离线的契约测试（验签逻辑对不对），
 * 但它**不证明凭据在微信那边有效** —— 凭据写错、被轮换、商户号没开通，
 * 离线测试照样全绿。而真去下一笔单来验证既不安全也不方便。
 *
 * 本脚本只调**只读**接口（GET），**不建单、不退款、不动任何钱**：
 *   1. `GET /v3/certificates`  —— 判断商户是「平台证书」还是「公钥」模式
 *   2. `GET /v3/pay/transactions/out-trade-no/{不存在的单号}?mchid=…`
 *      —— 期望 `404 ORDER_NOT_EXIST`。**拿到业务错误码本身就是成功信号**：
 *         它同时证明「商户侧签名链路正确」+「APIv3 密钥正确」
 *   3. 用配置的微信侧材料验签上面两个**响应的签名头**（微信连错误响应也签名）
 *   4. 反向篡改（报文加一个空格）必须验签失败 —— 排除「验签恒真」的假象
 *
 * 用法：npm run wxpay:probe          （只读，可随时重跑）
 *
 * ⚠ 两个必须记住的坑（否则会白排查半天）：
 *   · Node fetch 默认**不发** `Accept-Language`，微信用 `406 PARAM_ERROR 传入了不支持的
 *     Accept-Language` 回应 —— 报错说「传入了不支持的」，其实你根本没传。必须显式带 `zh-CN`。
 *   · `WX_PAY_PLATFORM_CERT` 里装的是**微信侧**材料（证书或公钥），用于验微信的签名；
 *     商户私钥是**另一个方向**。拿商户证书去验微信的签名只会一直失败。
 */
import 'dotenv/config'
import { createSign, createVerify } from 'crypto'
import { wechatVerifyMode } from '../src/lib/wxpay.js'

const BASE = 'https://api.mch.weixin.qq.com'
const mchId = (process.env.WX_PAY_MCH_ID ?? '').trim()
const serialNo = (process.env.WX_PAY_SERIAL_NO ?? '').trim()
const privateKey = (process.env.WX_PAY_PRIVATE_KEY ?? '').replace(/\\n/g, '\n')
const apiV3Key = (process.env.WX_PAY_API_KEY_V3 ?? '').trim()
const wxMaterial = (process.env.WX_PAY_PLATFORM_CERT ?? '').replace(/\\n/g, '\n')
const publicKeyId = (process.env.WX_PAY_PUBLIC_KEY_ID ?? '').trim()
const notifyUrl = (process.env.WX_PAY_NOTIFY_URL ?? '').trim()
const appId = (process.env.WX_APPID ?? '').trim()

let pass = 0
let failed = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${extra ? `  （${extra}）` : ''}`)
  }
}

/** 商户侧请求签名：`METHOD\nURL_PATH?QUERY\nTS\nNONCE\nBODY\n` 用商户私钥 RSA-SHA256 */
function sign(method: string, urlPath: string, body = '') {
  const ts = Math.floor(Date.now() / 1000).toString()
  const nonce = Math.random().toString(36).slice(2, 18).toUpperCase()
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`
  const signature = createSign('RSA-SHA256').update(message).sign(privateKey, 'base64')
  return {
    Authorization:
      `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",` +
      `signature="${signature}",timestamp="${ts}",serial_no="${serialNo}"`,
  }
}

/** 验微信响应的签名：RSA-SHA256 over `{timestamp}\n{nonce}\n{body}\n` */
function verifyWxResponse(headers: Headers, body: string, material = wxMaterial): boolean {
  const ts = headers.get('wechatpay-timestamp')
  const nonce = headers.get('wechatpay-nonce')
  const sig = headers.get('wechatpay-signature')
  if (!ts || !nonce || !sig) return false
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false
  return createVerify('RSA-SHA256')
    .update(`${ts}\n${nonce}\n${body}\n`)
    .verify(material, sig, 'base64')
}

async function wxGet(urlPath: string) {
  const res = await fetch(BASE + urlPath, {
    method: 'GET',
    // ★ 缺这个头，微信会回一个极具误导性的 406 PARAM_ERROR
    headers: { Accept: 'application/json', 'Accept-Language': 'zh-CN', ...sign('GET', urlPath) },
  })
  const body = await res.text()
  let parsed: any = null
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = null
  }
  return { status: res.status, body, parsed, headers: res.headers }
}

async function main() {
  console.log('\n════ 一、凭据齐备性（缺一项就会被 fail-closed 拒绝）════')
  const mode = wechatVerifyMode(wxMaterial)
  check(!!appId, `WX_APPID = ${appId || '(缺失)'}`)
  check(/^\d{6,}$/.test(mchId), `WX_PAY_MCH_ID = ${mchId || '(缺失)'}`)
  check(apiV3Key.length === 32, `WX_PAY_API_KEY_V3 长度 = ${apiV3Key.length}（必须正好 32）`)
  check(/^[0-9A-Fa-f]{40}$/.test(serialNo), `WX_PAY_SERIAL_NO = ${serialNo.slice(0, 8)}…（40 位十六进制）`)
  check(privateKey.includes('BEGIN'), 'WX_PAY_PRIVATE_KEY 含 PEM 头')
  check(mode !== 'none', `微信侧验签材料形态 = ${mode}`)
  check(/^https:\/\//.test(notifyUrl), `WX_PAY_NOTIFY_URL = ${notifyUrl || '(缺失)'}（必须 HTTPS）`)
  console.log(`  · 公钥 ID = ${publicKeyId || '(未配置，仅影响日志核对)'}`)

  if (failed > 0 || mode === 'none') {
    console.log('\n✗ 凭据不全，后面的联网自检没有意义，先补齐再跑。')
    return
  }

  console.log('\n════ 二、商户侧签名是否有效 + 属于哪种模式 ════')
  const certs = await wxGet('/v3/certificates')
  console.log(`  GET /v3/certificates → HTTP ${certs.status}  ${certs.parsed?.code ?? ''}`)
  if (certs.status === 200) {
    console.log('  ⇒ 平台证书模式（返回了证书列表）')
  } else if (certs.parsed?.code === 'RESOURCE_NOT_EXISTS') {
    console.log('  ⇒ **公钥模式**：该商户没有平台证书，需用「微信支付公钥」验签（不是故障）')
  }
  check(
    certs.status !== 401,
    '商户侧请求签名有效（401 SIGN_ERROR 才是签名/凭据不配套）',
    certs.parsed?.message ?? '',
  )
  check(certs.status !== 406, 'Accept-Language 已正确携带（406 PARAM_ERROR 即为此坑）')

  console.log('\n════ 三、验签微信的真实响应（不是模拟报文）════')
  check(certs.status === 404 || certs.status === 200, `拿到业务级响应而非鉴权失败（HTTP ${certs.status}）`)
  const v1 = verifyWxResponse(certs.headers, certs.body)
  check(v1, '① GET /v3/certificates 的响应签名验签通过')
  check(
    !verifyWxResponse(certs.headers, certs.body + ' '),
    '反向：报文多一个空格 → 验签失败（排除「验签恒真」）',
  )
  const serial = certs.headers.get('wechatpay-serial')
  if (serial) {
    const modeBySerial = serial.startsWith('PUB_KEY_ID_') ? '公钥模式' : '平台证书模式'
    console.log(`  · wechatpay-serial = ${serial} ⇒ ${modeBySerial}`)
    if (publicKeyId) {
      console.log(
        serial === publicKeyId
          ? '  · 与配置的公钥 ID 一致 ✓'
          : `  · 与配置的公钥 ID 不一致（不拒绝，仅提示；灰度期该头可能仍返回旧序列号）`,
      )
    }
  }

  console.log('\n════ 四、查单接口（真实交易链路的前置，只读）════')
  // 故意的假单号：期望 ORDER_NOT_EXIST。拿到这个码就说明签名链路 + APIv3 密钥都对。
  const probeNo = `PROBE${Date.now()}`
  const probe = await wxGet(`/v3/pay/transactions/out-trade-no/${probeNo}?mchid=${mchId}`)
  console.log(`  GET /v3/pay/transactions/out-trade-no → HTTP ${probe.status}  ${probe.parsed?.code ?? ''}`)
  check(
    probe.parsed?.code === 'ORDER_NOT_EXIST',
    '查单接口返回 ORDER_NOT_EXIST（= 接口可调通、凭据有效）',
    probe.parsed?.message ?? probe.body.slice(0, 120),
  )
  check(verifyWxResponse(probe.headers, probe.body), '② 查单响应的签名验签通过（第二条独立样本）')

  console.log('\n════ 结论 ════')
  if (failed === 0) {
    console.log('  ✓ 微信支付凭据有效、商户侧签名链路与验签链路全部打通。')
    console.log('    接下来只剩「回调能不能到达服务器」（notify_url 需 HTTPS + 公网可达）。')
  } else {
    console.log(`  ✗ 有 ${failed} 项不通过，见上面的明细。`)
    console.log('    常见原因：商户号/序列号/私钥三者不配套（401 SIGN_ERROR）、')
    console.log('    或 AppID 未与商户号关联（下单时才报 APPID_MCHID_NOT_MATCH）。')
  }
  console.log('')
}

main()
  .catch((e) => {
    console.error('\n✗ 自检异常：', e)
    process.exitCode = 1
  })
  .finally(() => {
    if (failed > 0) process.exitCode = 1
    console.log(`结果：${pass} 通过 / ${failed} 失败`)
  })
