// 虚拟支付签名自检 —— 用**官方给出的期望值**验证算法，而不是自己算一遍再自己比一遍。
//
// 官方《签名详解》第 2.6 节给了一段 Python 参考实现，并在最后用了两个 assert 写死期望值：
//   uri        = '/xpay/query_user_balance'
//   post_body  = '{"openid": "xxx", "user_ip": "127.0.0.1", "env": 0}'
//   appkey     = '12345'
//   pay_sig    = 'c37809f27c6d7fd1837ad2500a04512b66b34fd793a39a385fade56dca89a4b5'
//   session_key= '9hAb/NEYUlkaMBEsmFgzig=='
//   signature  = '089d9e8dc5d308977360c4b79ec600a93d736802802a807d634192328032f6c7'
// ★ 这两条是**唯一**能证明「我们的算法与微信一致」的手段：算法写错时，现场只会看到
//   `-15005 / -15006`，而这两个码无法告诉我们到底哪一段错了。所以把它固化成用例。
//
// 运行：npm run xpay:verify
import process from 'node:process'
import {
  calcPaySig,
  calcSignature,
  buildVirtualPayParams,
  vpEnv,
  vpAppKey,
  vpEnabled,
  vpConfigProblems,
  memberProductId,
  beanProductId,
  assertVpProductContract,
  VP_PRODUCT_CONTRACT,
  VP_URI_REQUEST_PAYMENT,
  queryVpOrder,
} from '../src/lib/xpay.js'

let fail = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) console.log(`      期望 ${e}\n      实际 ${a}`)
}

console.log('=== A. 官方期望值（唯一能证明算法一致的手段）===')

// 官方示例里 appkey 是「假设值」，与真实环境无关 —— 这里就是照抄它来比 hex。
const OFFICIAL_APPKEY = '12345'
const OFFICIAL_URI = '/xpay/query_user_balance'
// ★ 这一串必须**逐字节**照抄官方示例：注意 "openid": "xxx" 里冒号后**有一个空格**
//   （官方示例本身就是这么序列化的）。签名对的就是这串字节。
const OFFICIAL_BODY = '{"openid": "xxx", "user_ip": "127.0.0.1", "env": 0}'

check(
  'paySig 与官方期望值一致',
  calcPaySig(OFFICIAL_URI, OFFICIAL_BODY, OFFICIAL_APPKEY),
  'c37809f27c6d7fd1837ad2500a04512b66b34fd793a39a385fade56dca89a4b5',
)
check(
  'signature 与官方期望值一致',
  calcSignature(OFFICIAL_BODY, '9hAb/NEYUlkaMBEsmFgzig=='),
  '089d9e8dc5d308977360c4b79ec600a93d736802802a807d634192328032f6c7',
)

console.log('\n=== B. WX_VP_ENV 真值表（只认 0/1，其他一律抛错）===')
check('未配置 ⇒ 现网 0', vpEnv({}), 0)
check('"0" ⇒ 现网 0', vpEnv({ WX_VP_ENV: '0' }), 0)
check('"1" ⇒ 沙箱 1', vpEnv({ WX_VP_ENV: '1' }), 1)
check('" 1 "（带空白）也认', vpEnv({ WX_VP_ENV: ' 1 ' }), 1)
for (const bad of ['2', 'true', 'sandbox', '现网']) {
  let threw = false
  try {
    vpEnv({ WX_VP_ENV: bad })
  } catch {
    threw = true
  }
  check(`非法值 ${JSON.stringify(bad)} ⇒ 抛错（不取默认）`, threw, true)
}

console.log('\n=== C. AppKey 按 env 取（沙箱 / 现网是两把不同的钥匙）===')
const bothKeys = { WX_VP_ENV: '0', WX_VP_APP_KEY: 'PROD_KEY', WX_VP_APP_KEY_SANDBOX: 'SANDBOX_KEY' }
check('env=0 取现网 AppKey', vpAppKey(bothKeys), 'PROD_KEY')
check('env=1 取沙箱 AppKey', vpAppKey({ ...bothKeys, WX_VP_ENV: '1' }), 'SANDBOX_KEY')

console.log('\n=== D. vpEnabled 与「半配置」检测 ===')
check('四个都没配 ⇒ 未启用', vpEnabled({}), false)
check('四个都没配 ⇒ 无问题（不是错误）', vpConfigProblems({}), [])
check(
  '只填 OFFER_ID 漏 AppKey ⇒ 未启用',
  vpEnabled({ WX_VP_OFFER_ID: 'o1', WX_APPID: 'wxa' }),
  false,
)
check(
  '只填 OFFER_ID 漏 AppKey ⇒ **报出问题**（不许静默退回普通支付）',
  vpConfigProblems({ WX_VP_OFFER_ID: 'o1', WX_APPID: 'wxa' }).length > 0,
  true,
)
check(
  '三项齐备 ⇒ 启用',
  vpEnabled({ WX_VP_OFFER_ID: 'o1', WX_VP_APP_KEY: 'k', WX_APPID: 'wxa' }),
  true,
)
check(
  'env=1 只配现网 AppKey ⇒ 报出「缺沙箱 AppKey」',
  vpConfigProblems({ WX_VP_ENV: '1', WX_VP_OFFER_ID: 'o1', WX_VP_APP_KEY: 'k', WX_APPID: 'wxa' }).join('|'),
  'WX_VP_APP_KEY_SANDBOX 未配置（WX_VP_ENV=1 时需要沙箱 AppKey）',
)

console.log('\n=== E. 商品 → 道具ID 映射（与 MP 后台的契约）===')
check('会员用套餐 code', memberProductId('SUBSCRIPTION'), 'SUBSCRIPTION')
check('加油包用积分数（不含赠送）', beanProductId(10000n), 'BEAN_10000')
check('契约表条目数（新增档位必须同步这里）', VP_PRODUCT_CONTRACT.length, 4)
let emptyCodeThrew = false
try {
  memberProductId('   ')
} catch {
  emptyCodeThrew = true
}
check('会员 code 为空 ⇒ 抛错（不生成空道具ID）', emptyCodeThrew, true)

// ── 道具契约闸门：不一致必须**抛错**，绝不把注定被微信拒的参数发出去 ──
// 这两条的价值在于「错误信息里有没有**照着做就能修好**的指令」——
// 只报「支付失败」的现场，排查者得自己去猜是 -15010 还是 -15013。
let unknownProductMsg = ''
try {
  assertVpProductContract('BEAN_20000', 20000)
} catch (e) {
  unknownProductMsg = (e as Error).message
}
check(
  '未登记的道具 ⇒ 抛错，且消息里点名道具ID 与 -15010',
  unknownProductMsg.includes('BEAN_20000') && unknownProductMsg.includes('-15010'),
  true,
)

let priceMismatchMsg = ''
try {
  assertVpProductContract('BEAN_10000', 8800)
} catch (e) {
  priceMismatchMsg = (e as Error).message
}
check(
  '道具价与本地不一致 ⇒ 抛错，且消息里同时给出两边的价与 -15013',
  priceMismatchMsg.includes('8800') && priceMismatchMsg.includes('10000') && priceMismatchMsg.includes('-15013'),
  true,
)

let contractAllPass = true
for (const c of VP_PRODUCT_CONTRACT) {
  try {
    assertVpProductContract(c.productId, c.goodsPriceFen)
  } catch {
    contractAllPass = false
  }
}
check('契约表内每一条都放行（闸门不得误杀线上在售档位）', contractAllPass, true)

// ★ 反向自洽：契约里的 `BEAN_*` 必须能由**积分数**推导出来。
//   推不出来的后果很隐蔽：`beanProductId(pkg.beans)` 会生成一个契约里没有的 ID，
//   而闸门又会把它拦下 —— 表现是「某个档位永远买不了」，根因只是道具ID 命名对不上。
check(
  '契约表 BEAN_* 的 ID 与 beanProductId(积分数) 自洽',
  VP_PRODUCT_CONTRACT.filter((c) => c.productId.startsWith('BEAN_')).every((c) => {
    const beans = Number(c.productId.slice('BEAN_'.length))
    return Number.isInteger(beans) && beanProductId(beans) === c.productId
  }),
  true,
)

console.log('\n=== F. buildVirtualPayParams 自洽性 ===')
const env = {
  WX_VP_OFFER_ID: 'off-123',
  WX_VP_APP_KEY: 'key-prod',
  WX_VP_ENV: '0',
  WX_APPID: 'wxappid',
}
const p = buildVirtualPayParams({
  productId: 'BEAN_10000',
  goodsPriceFen: 10000,
  outTradeNo: 'B1539600049c10e91',
  attach: 'm12:BEAN',
  sessionKey: '9hAb/NEYUlkaMBEsmFgzig==',
  env,
})
check('mode 固定为道具直购', p.mode, 'short_series_goods')
check(
  'signData 里带齐官方要求的必填字段',
  Object.keys(JSON.parse(p.signData) as Record<string, unknown>).sort(),
  ['attach', 'buyQuantity', 'currencyType', 'env', 'goodsPrice', 'offerId', 'outTradeNo', 'productId'].sort(),
)
check('signData 是可透传的 string（不是对象）', typeof p.signData, 'string')
check(
  'paySig 由**返回的那串 signData** 算出（签名与发送同源）',
  p.paySig,
  calcPaySig(VP_URI_REQUEST_PAYMENT, p.signData, 'key-prod'),
)
check(
  'signature 由**返回的那串 signData** 算出',
  p.signature,
  calcSignature(p.signData, '9hAb/NEYUlkaMBEsmFgzig=='),
)

console.log('\n=== G. outTradeNo / 价格 / session_key 的边界必须响亮报错 ===')
const base = {
  productId: 'BEAN_10000',
  goodsPriceFen: 10000,
  outTradeNo: 'B1539600049c10e91',
  attach: 'a',
  sessionKey: 's',
  env,
}
function throwsWith(patch: Record<string, unknown>): boolean {
  try {
    buildVirtualPayParams({ ...base, ...patch } as never)
    return false
  } catch {
    return true
  }
}
check('outTradeNo 只有 7 字符 ⇒ 抛错（官方下限 8）', throwsWith({ outTradeNo: 'B123456' }), true)
check('outTradeNo 以 _ 开头 ⇒ 抛错', throwsWith({ outTradeNo: '_B153960049c10e91' }), true)
check('outTradeNo 含非法字符 # ⇒ 抛错', throwsWith({ outTradeNo: 'B153960049#10e91' }), true)
check('outTradeNo 33 字符 ⇒ 抛错（官方上限 32）', throwsWith({ outTradeNo: `B${'a'.repeat(32)}` }), true)
check('goodsPriceFen=0 ⇒ 抛错（会被判 -15013）', throwsWith({ goodsPriceFen: 0 }), true)
check('session_key 缺失 ⇒ 抛错（用户态签名无从算起）', throwsWith({ sessionKey: '' }), true)
check('offerId 未配置 ⇒ 抛错', throwsWith({ env: { ...env, WX_VP_OFFER_ID: '' } }), true)
// ★ 契约闸门必须真的接在**构建出口**上：上面那几条纯函数断言全绿，若没人调用仍是空谈。
check(
  'buildVirtualPayParams：道具未登记 ⇒ 抛错（闸门确实接在构建出口）',
  throwsWith({ productId: 'BEAN_9999', goodsPriceFen: 9999 }),
  true,
)
check(
  'buildVirtualPayParams：道具价与契约不符 ⇒ 抛错',
  throwsWith({ productId: 'BEAN_10000', goodsPriceFen: 9900 }),
  true,
)

console.log('\n=== H. 现有单号天然合规（不必改造）===')
// 线上 order_no 形如 B/M/A + 10 位时间戳 + 6 位 uuid 片段 = 17 字符
const realOrderNo = 'B1539600049c10e91'
check('真实单号长度在 8~32 内', realOrderNo.length >= 8 && realOrderNo.length <= 32, true)
check(
  '真实单号能被 buildVirtualPayParams 接受',
  (() => {
    try {
      buildVirtualPayParams({ ...base, outTradeNo: realOrderNo })
      return true
    } catch {
      return false
    }
  })(),
  true,
)

console.log('\n=== I. /xpay/query_order 的请求形状（URL 与请求体必须逐字正确）===')
// ★ 这一段每一条都来自官方《查询创建的订单》文档，而且都是「写错就**静默不工作**」的点：
//   · 请求体里业务单号的字段名是 `order_id`（**不是** `out_trade_no`），且 `openid` **必填**
//     （少了它官方回 268490001 openid错误）；
//   · `access_token` 与 `pay_sig` 都挂在 **Query String** 上，且**都不参与签名**
//     （参与签名的只有 `uri + '&' + body`）。
//   这些点没有任何编译期或运行期提示，只有把报文比下来才守得住。
const apiEnv = { WX_VP_OFFER_ID: 'off-123', WX_VP_APP_KEY: 'key-prod', WX_VP_ENV: '0', WX_APPID: 'wxappid' }
const A_ORDER = 'B1539600049c10e91'

/** 造一个假 fetch，把 (url, body) 记下来；同时返回指定 payload。 */
function fakeFetch(payload: Record<string, unknown>) {
  const calls: { url: string; body: string }[] = []
  const impl = (async (url: string, init?: { body?: unknown }) => {
    calls.push({ url, body: String(init?.body ?? '') })
    return { ok: true, status: 200, json: async () => payload }
  }) as unknown as typeof fetch
  return { calls, impl }
}

const FAKE_ORDER_BASE = {
  order_id: A_ORDER,
  order_fee: 10000,
  paid_fee: 10000,
  wx_order_id: 'WX_INNER_1',
  wxpay_order_id: 'WXPAY_TRADE_1',
  order_type: 0,
}

// ① URL 与请求体
const f1 = fakeFetch({ errcode: 0, errmsg: '', order: { ...FAKE_ORDER_BASE, status: 2 } })
const q1 = await queryVpOrder(
  { orderId: A_ORDER, openid: 'oUSER_1' },
  { accessToken: 'AT-1', env: apiEnv, fetchImpl: f1.impl },
)
check('只发一次请求', f1.calls.length, 1)
check(
  '请求体字段名照抄官方：openid / env / order_id（不是 out_trade_no）',
  f1.calls[0]?.body,
  '{"openid":"oUSER_1","env":0,"order_id":"B1539600049c10e91"}',
)
check(
  'URL 上带 access_token 与 pay_sig（两者都在 Query String）',
  f1.calls[0]?.url.replace(/&pay_sig=.*$/, '&pay_sig=<sig>'),
  'https://api.weixin.qq.com/xpay/query_order?access_token=AT-1&pay_sig=<sig>',
)
check(
  'pay_sig 用的就是**发出去的那串 body**（签名与发送同源）',
  f1.calls[0]?.url.includes(`pay_sig=${calcPaySig('/xpay/query_order', f1.calls[0]!.body, 'key-prod')}`),
  true,
)
check(
  'access_token / pay_sig **不参与**签名（换 token 不改 pay_sig）',
  await (async () => {
    const payload = { errcode: 0, errmsg: '', order: { ...FAKE_ORDER_BASE, status: 2 } }
    const fA = fakeFetch(payload)
    const fB = fakeFetch(payload)
    await queryVpOrder({ orderId: A_ORDER, openid: 'oUSER_1' }, { accessToken: 'AT-AAA', env: apiEnv, fetchImpl: fA.impl })
    await queryVpOrder({ orderId: A_ORDER, openid: 'oUSER_1' }, { accessToken: 'AT-BBB', env: apiEnv, fetchImpl: fB.impl })
    const sig = (u: string) => (u.match(/pay_sig=([^&]+)/) ?? [])[1]
    return sig(fA.calls[0]!.url) === sig(fB.calls[0]!.url)
  })(),
  true,
)
check('查到已支付单 ⇒ paid=true', q1.paid, true)
check('wxpay_order_id（支付交易单号）被取出 —— 写 wx_transaction_id 用的就是它', q1.wxpayOrderId, 'WXPAY_TRADE_1')
check('wx_order_id（微信内部单号）单独保留 —— 可作为下次查单的入参', q1.wxOrderId, 'WX_INNER_1')
check('order_type 被取出（0 普通 / 7 苹果）', q1.orderType, 0)

// ② 状态机映射 —— 写错一位就会把「已退款」当「已支付」
async function statusOf(status: number) {
  const f = fakeFetch({ errcode: 0, errmsg: '', order: { ...FAKE_ORDER_BASE, status } })
  return queryVpOrder({ orderId: A_ORDER, openid: 'o' }, { accessToken: 'AT', env: apiEnv, fetchImpl: f.impl })
}
const s1 = await statusOf(1)
check('status=1 创建成功（未付款）⇒ 不算已支付', [s1.paid, s1.closed, s1.refund], [false, false, false])
const s4 = await statusOf(4)
check('status=4 已发货 ⇒ **仍算已支付**（发货后状态会从 2 走到 4）', [s4.paid, s4.closed, s4.refund], [true, false, false])
const s6 = await statusOf(6)
check('status=6 已关闭 ⇒ closed=true、不算已支付', [s6.paid, s6.closed, s6.refund], [false, true, false])
for (const st of [5, 7, 8]) {
  const s = await statusOf(st)
  check(`status=${st} 退款流程 ⇒ refund=true 且**绝不**算已支付`, [s.paid, s.refund], [false, true])
}
const s0 = await statusOf(0)
check('status=0 订单初始化（不可用于支付）⇒ 不算已支付', s0.paid, false)

// ③ 失败必须响亮 —— 绝不能把「接口报错」翻译成「没付过」
let noOpenidThrew = false
try {
  await queryVpOrder({ orderId: A_ORDER, openid: '' }, { accessToken: 'AT', env: apiEnv, fetchImpl: fakeFetch({}).impl })
} catch {
  noOpenidThrew = true
}
check('缺 openid ⇒ 抛错（官方必填，缺了回 268490001）', noOpenidThrew, true)

let noOrderThrew = false
try {
  await queryVpOrder({ orderId: '', openid: 'o' }, { accessToken: 'AT', env: apiEnv, fetchImpl: fakeFetch({}).impl })
} catch {
  noOrderThrew = true
}
check('缺 orderId ⇒ 抛错', noOrderThrew, true)

let errcodeThrew = false
try {
  await queryVpOrder(
    { orderId: A_ORDER, openid: 'o' },
    { accessToken: 'AT', env: apiEnv, fetchImpl: fakeFetch({ errcode: 268490003, errmsg: '签名错误' }).impl },
  )
} catch {
  errcodeThrew = true
}
check(
  'errcode≠0 ⇒ 抛错而不是当成「未支付」（把接口报错当 NOT_EXIST 会把真付过款的单置成过期）',
  errcodeThrew,
  true,
)

console.log('')
if (fail > 0) {
  console.error(`✗ xpay 签名自检失败：${fail} 项`)
  process.exit(1)
}
console.log('✓ xpay 签名自检全部通过')
