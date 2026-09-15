/**
 * 微信支付 v3 · 探测「AppID 是否已关联到商户号」。
 *
 * 为什么需要它：商户号开通了、七项凭据也齐了，**但 AppID 没在商户平台关联**的话，
 * `wxpay:probe` 那些只读接口**全都正常**（它们不看 AppID），
 * 于是你会在「接入全部通过」的错觉里打开支付 —— 直到**真实用户下单的那一刻**才报：
 *
 *     APPID_MCHID_NOT_MATCH  appid和mch_id不匹配
 *
 * 这个错误**只有下单才会暴露**，而项目配置里 `PAYMENTS_ENABLED=false` 又让下单被拦在业务层。
 * 所以唯一的提前验法就是：拿一个**假 openid** 真去调一次「下单」，看微信怎么回。
 *
 * 判定逻辑（关键：不是看"成功/失败"，而是看**错在哪一步**）：
 *   · `APPID_MCHID_NOT_MATCH`        ⇒ ❌ AppID 未关联商户号 —— 这就是阻断项，去商户平台关联
 *   · 报错指向 openid / payer        ⇒ ✅ AppID↔商户号这一关**已经过了**（错误发生在更靠后的校验）
 *   · 401 SIGN_ERROR / 406           ⇒ ⚠ 是配置或请求头问题，与 AppID 无关（见 wxpay:probe）
 *   · 其他                            ⇒ ⚠ 未命中已知特征，**照原样贴出微信的 code/message 人工判断**
 *
 * 本脚本**会真的创建一笔 1 分的预支付订单**（微信侧，不会出现在你的账单里、也不会扣钱），
 * 因此结束后会尽力 `close` 掉它。它**只调微信接口、完全不写本地数据库**。
 *
 * 用法：npm run wxpay:appid     ← ⚠ 必须在**服务器**上跑（凭据在服务器的 .env 里）
 */
import 'dotenv/config'
import { createSign, randomBytes } from 'crypto'

const BASE = 'https://api.mch.weixin.qq.com'
const mchId = (process.env.WX_PAY_MCH_ID ?? '').trim()
const serialNo = (process.env.WX_PAY_SERIAL_NO ?? '').trim()
const privateKey = (process.env.WX_PAY_PRIVATE_KEY ?? '').replace(/\\n/g, '\n')
const apiV3Key = (process.env.WX_PAY_API_KEY_V3 ?? '').trim()
const notifyUrl = (process.env.WX_PAY_NOTIFY_URL ?? '').trim()
const appId = (process.env.WX_APPID ?? '').trim()

const mask = (s: string) => (s.length <= 8 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`)

/** 商户侧请求签名：`METHOD\nURL_PATH?QUERY\nTS\nNONCE\nBODY\n` 用商户私钥 RSA-SHA256 */
function sign(method: string, urlPath: string, body = '') {
  const ts = Math.floor(Date.now() / 1000).toString()
  const nonce = Math.random().toString(36).slice(2, 18).toUpperCase()
  const signature = createSign('RSA-SHA256').update(`${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`).sign(privateKey, 'base64')
  return {
    Authorization:
      `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",` +
      `signature="${signature}",timestamp="${ts}",serial_no="${serialNo}"`,
  }
}

/**
 * ⚠ 必须是**假** openid：这个前缀 `o` + 28 位是微信 openid 的**形态**，
 * 但内容是随机生成的 —— 微信会在 openid 校验这一步拒绝它，
 * 而那正好证明「AppID↔商户号」这一关已经通过。
 */
const fakeOpenid = `o${randomBytes(20).toString('base64url').slice(0, 27)}`
const outTradeNo = `PROBE${Date.now()}`

interface WxResp {
  status: number
  body: string
  json: Record<string, unknown>
}

async function call(method: 'POST', urlPath: string, body: string): Promise<WxResp> {
  const resp = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: sign(method, urlPath, body).Authorization,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // ★ Node fetch/undici 默认不发 Accept-Language ⇒ 微信回极具误导性的
      //   `406 PARAM_ERROR 传入了不支持的Accept-Language`（你其实没传）。
      'Accept-Language': 'zh-CN',
    },
    body,
  })
  const text = await resp.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* 非 JSON 也照样原样打印 */
  }
  return { status: resp.status, body: text, json }
}

async function main() {
  console.log('\n════ 0. 前置检查 ════')
  const missing = [
    ['WX_PAY_MCH_ID', mchId],
    ['WX_PAY_SERIAL_NO', serialNo],
    ['WX_PAY_PRIVATE_KEY', privateKey.includes('BEGIN') ? 'ok' : ''],
    ['WX_PAY_API_KEY_V3(32位)', apiV3Key.length === 32 ? 'ok' : ''],
    ['WX_APPID', appId],
    ['WX_PAY_NOTIFY_URL', notifyUrl],
  ].filter(([, v]) => !v)
  if (missing.length > 0) {
    console.log(`  ✗ 缺少配置：${missing.map(([k]) => k).join(', ')}`)
    console.log('\n本机没有支付凭据 ⇒ 请在**服务器**上跑（凭据在服务器的 server/.env 里）：')
    console.log('  ssh … && cd /opt/dashuai/server && npm run wxpay:appid\n')
    process.exit(2)
  }
  console.log(`  ✓ 凭据齐备  mchid=${mchId}  appid=${appId}  serial=${mask(serialNo)}`)
  console.log(`  通知地址 notify_url=${notifyUrl}`)

  console.log('\n════ 1. 用假 openid 下一笔 1 分的 JSAPI 单（唯一目的：看微信在哪一步拒绝）════')
  console.log(`  测试单号 out_trade_no=${outTradeNo}`)
  console.log(`  假 openid=${fakeOpenid}`)
  const payload = {
    appid: appId,
    mchid: mchId,
    description: 'APPID关联探测（不会扣钱，脚本结束会关单）',
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: { total: 1, currency: 'CNY' },
    payer: { openid: fakeOpenid },
  }
  const body = JSON.stringify(payload)
  const r = await call('POST', '/v3/pay/transactions/jsapi', body)

  console.log(`\n  HTTP ${r.status}`)
  console.log(`  微信原始响应：${r.body}`)
  const code = String(r.json.code ?? '')
  const message = String(r.json.message ?? '')
  const gotPrepayId = typeof r.json.prepay_id === 'string' && r.json.prepay_id.length > 0

  console.log('\n════ 2. 结论 ════')
  let verdict: 'linked' | 'not-linked' | 'unknown' = 'unknown'

  if (gotPrepayId) {
    // 意料之外：微信居然接受了这个假 openid。那 AppID 一定是关联好的（否则连这一步都过不去）
    verdict = 'linked'
    console.log('  ✅ 竟然成功拿到 prepay_id ⇒ AppID↔商户号**已关联**（而且这个 openid 未被拦）')
    console.log(`     prepay_id=${String(r.json.prepay_id).slice(0, 24)}…`)
  } else if (code === 'APPID_MCHID_NOT_MATCH') {
    verdict = 'not-linked'
    console.log('  ❌ AppID **未关联**到该商户号 —— 这就是必须在开放支付前解决的那一项。')
    console.log('     去「微信商户平台 → 产品中心 → AppID账号管理」把该小程序的 AppID 关联上（需小程序管理员确认）。')
    console.log('     不解决的话：只读自检全绿，但真实用户一付款就报 APPID_MCHID_NOT_MATCH。')
  } else if (/openid|payer/i.test(message) || /openid|payer/i.test(r.body)) {
    verdict = 'linked'
    console.log('  ✅ 报错指向 openid/payer，**不是** AppID 与商户号不匹配 —— 说明这一关已经过了。')
    console.log('     （假 openid 被拒是预期结果：本脚本用的就是随机生成的假 openid。）')
  } else if (code === 'SIGN_ERROR' || r.status === 401) {
    console.log('  ⚠ 商户侧签名/凭据问题（不是 AppID 问题）。先跑 `npm run wxpay:probe` 排查。')
  } else if (r.status === 406 || code === 'PARAM_ERROR') {
    console.log('  ⚠ 请求参数/请求头问题（406 常见于缺 Accept-Language，本脚本已带；请核对上面原始报文）。')
  } else {
    console.log('  ⚠ 未命中已知特征，**请人工看上面的 code/message**：')
    console.log(`     code=${code || '(无)'}  message=${message || '(无)'}`)
    console.log('     判定要点：只要不是 APPID_MCHID_NOT_MATCH，AppID 关联这一关就大概率已经过了。')
  }

  console.log('\n════ 3. 清理：关掉这笔预支付订单 ════')
  if (gotPrepayId || r.status === 200) {
    const closePath = `/v3/pay/transactions/out-trade-no/${outTradeNo}/close`
    const cr = await call('POST', closePath, JSON.stringify({ mchid: mchId }))
    console.log(`  HTTP ${cr.status}  ${cr.body.trim() === '' ? '（空响应体 = 关单成功）' : cr.body}`)
  } else {
    console.log('  （没有创建成功，无需关单）')
  }

  console.log(`\n★ 结论：${verdict === 'linked' ? 'AppID 已关联商户号 ✅' : verdict === 'not-linked' ? 'AppID 未关联商户号 ❌（阻断项）' : '未能自动判定，请人工看原始报文 ⚠'}\n`)
  console.log('附：本脚本只调微信接口，没有写任何本地数据；测试单号前缀 PROBE 便于事后辨认。\n')
  process.exit(verdict === 'not-linked' ? 1 : 0)
}

main().catch((e) => {
  console.error('\n脚本异常：', e)
  process.exit(1)
})
