// 小程序虚拟支付（wx.requestVirtualPayment）—— 签名与「调起参数」构建
//
// ── 为什么必须有它（不是可选增强）──────────────────────────────
// 微信《虚拟支付业务运营指南》要求：开发者在小程序内提供的**虚拟商品**（虚拟代币、
// 解锁功能、订阅内容、付费功能、打赏、虚拟礼物……）的购买与支付**均需接入小程序虚拟支付**，
// 且**不得**引导至 app / 公众号 / h5 / 个人号 / 网站完成支付；自 **2026-04-01** 起须
// **全终端**（iOS / 安卓 / 鸿蒙 / Windows）接入。仅含虚拟类目的小程序，平台会**关闭其在
// 安卓及其余非 iOS 系统的普通微信支付能力**。
// ⇒ 本项目的两件商品都命中：**会员订阅＝订阅内容；积分加油包＝虚拟代币**。
//   所以入口页那套 `Taro.requestPayment`（lib/wxpay.ts 的 JSAPI）对这两件商品**已经不通**。
//
// ── 只走「道具直购」，不用代币 ──────────────────────────────
// · 代币（short_series_coin）：名称与兑换比例**发布后不可修改**，余额还要改由微信侧管理
//   （/xpay/query_user_balance、/xpay/currency_pay）⇒ 等于把豆账本搬出去一半；
// · 而本项目的「积分」是**内部计价单位**（AI 计费、有效期桶、赠送桶），不适合做微信代币。
// ⇒ 道具直购（short_series_goods）：现金一次买一件道具 → 发货推送 → **复用现有
//   markOrderPaid**（发积分 / 开会员 / 结算回执 / 风控告警一行都不用改）。
//
// ── 签名（官方《签名详解》）────────────────────────────────
//   paySig    = to_hex(hmac_sha256(appKey,     uri + '&' + signData))   ← 支付签名
//   signature = to_hex(hmac_sha256(sessionKey, signData))               ← 用户态签名
// · 基础库调起时 **uri 固定填 `requestVirtualPayment`**；服务端 API 才填 `/xpay/xxx`。
// · appKey 分「现网 / 沙箱」两套，按 env 选（0 现网 / 1 沙箱）。**现网 env 只能是 0**，
//   填 1 会得到 -15011。
// · session_key 由 `wx.login()` 的 code 经 code2Session 换得 —— 本项目下单口本来就在传
//   `wxLoginCode`，所以**不需要新增任何存储**，现算现用。
//
// ── 为什么所有函数都收 `env` 参数而不是直接读 process.env ──────────
// 这样「真值表」可以在守护脚本里被穷举（见 scripts/verify-xpay-signature.ts），
// 而不是只能在进程启动时验证一次。
import crypto from 'crypto'

/** 基础库调起时的 uri。官方要求**固定**填这个字符串（不是任何接口路径）。 */
export const VP_URI_REQUEST_PAYMENT = 'requestVirtualPayment'

/** 道具直购。本项目不用代币 —— 理由见文件头。 */
export type VpMode = 'short_series_goods'
export const VP_MODE_GOODS: VpMode = 'short_series_goods'

/** `outTradeNo` 的官方约束：8~32 字符，只允许 0-9a-zA-Z 与 _-|*@，且不能以 _ 开头。 */
const OUT_TRADE_NO_RE = /^[0-9a-zA-Z\-|*@][0-9a-zA-Z_\-|*@]{7,31}$/

function pick(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] ?? '').trim()
}

/**
 * 支付环境：`0` 现网 / `1` 沙箱。
 *
 * ★ 只认 0 和 1，其他值**抛错**而不是取默认。填错 env 的后果是签出一份用错 AppKey 的 paySig，
 *   现场只看到一个 `-15006 支付签名 paySig 错误` —— 排查成本极高，不如启动时就死。
 * ★ 空值视为 0（现网）：「没配」在接入完成后就是现网，这点与 `WX_VP_ENV` 的语义一致。
 */
export function vpEnv(env: NodeJS.ProcessEnv = process.env): 0 | 1 {
  const raw = pick(env, 'WX_VP_ENV')
  if (raw === '' || raw === '0') return 0
  if (raw === '1') return 1
  throw new Error(
    `WX_VP_ENV 取值无法识别：${JSON.stringify(env.WX_VP_ENV)}（只接受 0 现网 / 1 沙箱）`,
  )
}

/** 按当前 env 选中的 AppKey。★ 沙箱与现网是**两把不同的钥匙**，不能混用。 */
export function vpAppKey(env: NodeJS.ProcessEnv = process.env): string {
  return vpEnv(env) === 1 ? pick(env, 'WX_VP_APP_KEY_SANDBOX') : pick(env, 'WX_VP_APP_KEY')
}

/** `offerId`（MP → 虚拟支付 → 基本配置）。它就是文档里的「支付应用 ID」。 */
export function vpOfferId(env: NodeJS.ProcessEnv = process.env): string {
  return pick(env, 'WX_VP_OFFER_ID')
}

/**
 * 虚拟支付凭据是否齐备。缺一即 false —— **绝不猜测意图、绝不静默降级**。
 *
 * ★ 刻意**不抛错**：本函数会在请求路径上被调用（下单口），抛错会把一次「配置没配好」
 *   变成 500。配置错误的**响亮报错**放在启动期（lib/config.ts 的 validateProductionConfig）。
 */
export function vpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return Boolean(vpOfferId(env) && vpAppKey(env) && pick(env, 'WX_APPID'))
  } catch {
    return false
  }
}

/**
 * 老客户端（不认识虚拟支付四件套）是否**仍允许**走普通微信支付。**默认允许**。
 *
 * ★★ 为什么必须有这个开关，而不是「配了 `WX_VP_*` 就全线切 vp」：
 *   通道判定若只看 `vpEnabled(env)`，它就是**进程级**的 —— 一旦填上凭据并重启，
 *   **所有**新订单立刻开始下发 `{signData,paySig,signature,mode}`。而线上随时有大量
 *   **已安装、尚未升级**的客户端：它们会把四件套当成 JSAPI 参数交给 `Taro.requestPayment`，
 *   结果是「点了付款没反应 / 支付失败」⇒ **全体用户付不了款**。
 *   出包与发布在微信侧不受我们控制（用户下次冷启动才拉到新版本），所以「切通道」
 *   必须是**按请求**的、且默认落在安全侧。
 *
 * ★ 默认 `true`（= 放行旧通道）。切齐时刻显式置 `WX_VP_LEGACY_JSAPI=false`，
 *   ★ 且**只能在小程序后台已全量发布新版本、且线上已无旧版本流量之后**再动 ——
 *   置 false 后旧客户端会拿到它无法调起的参数，没有任何回落余地。
 * ★ 只认 `false` / `0` 为关闭：写错值（`flase`）会退回默认的「允许」，
 *   即错误方向指向**安全**，不会因为一个拼写错误把线上打通。
 */
export function vpLegacyJsapiAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = pick(env, 'WX_VP_LEGACY_JSAPI').toLowerCase()
  return raw !== 'false' && raw !== '0'
}

/**
 * 「半配置」检测：**只要动过**任何一个 `WX_VP_*`，就必须配齐。
 *
 * ★ 为什么单独做这件事：如果只填了 `WX_VP_OFFER_ID` 而漏了 AppKey，`vpEnabled()` 会返回 false，
 *   于是下单口**静默退回普通微信支付** —— 而平台已经关停了虚拟类目的普通支付能力，
 *   表现为「配置填了一半、用户全部付不了款，日志里一个字都没有」。必须让它在启动时死。
 * ★ 四个变量一个都没配 ⇒ 返回空数组（表示「本环境不用虚拟支付」，不是错误）。
 */
export function vpConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const touched = ['WX_VP_OFFER_ID', 'WX_VP_APP_KEY', 'WX_VP_APP_KEY_SANDBOX', 'WX_VP_ENV'].some(
    (k) => pick(env, k) !== '',
  )
  if (!touched) return []

  const problems: string[] = []
  if (!vpOfferId(env)) problems.push('WX_VP_OFFER_ID 未配置')

  let e: 0 | 1 = 0
  try {
    e = vpEnv(env)
  } catch (err) {
    problems.push((err as Error).message)
  }
  const key = e === 1 ? pick(env, 'WX_VP_APP_KEY_SANDBOX') : pick(env, 'WX_VP_APP_KEY')
  if (!key) {
    problems.push(e === 1 ? 'WX_VP_APP_KEY_SANDBOX 未配置（WX_VP_ENV=1 时需要沙箱 AppKey）' : 'WX_VP_APP_KEY 未配置')
  }
  if (!pick(env, 'WX_APPID')) problems.push('WX_APPID 未配置（用户态签名要按 AppID 换 session_key）')
  return problems
}

// ── 签名 ────────────────────────────────────────────────────────────

/**
 * 支付签名。`uri` 在**基础库调起**时固定为 `requestVirtualPayment`，
 * 在**服务端 API**（/xpay/query_order 等）时填接口路径 —— 两种情况都**不带 query**。
 *
 * ⚠ `signDataJson` 必须与「真正发出去的那串」**逐字节一致**。本项目把它当成不透明字符串
 *   一路透传到客户端（客户端 `JSON.parse` 都不做，直接原样交给 wx），就是这个原因。
 */
export function calcPaySig(uri: string, signDataJson: string, appKey: string): string {
  return crypto.createHmac('sha256', appKey).update(`${uri}&${signDataJson}`).digest('hex')
}

/** 用户态签名。`sessionKey` 取自 code2Session，**绝不下发给客户端**。 */
export function calcSignature(signDataJson: string, sessionKey: string): string {
  return crypto.createHmac('sha256', sessionKey).update(signDataJson).digest('hex')
}

// ── 商品 → 道具ID 的映射（唯一出处）────────────────────────────────

/**
 * 会员套餐 → 微信道具 ID。直接用套餐的 `code`（库里 `member_package.code` 有唯一索引，
 * 且它已经是「跨环境稳定」的业务标识 —— 用它而不是自增 id，换环境/重建库时不会错位）。
 */
export function memberProductId(packageCode: string): string {
  const code = packageCode.trim()
  if (!code) throw new Error('member_package.code 为空，无法映射微信道具ID')
  return code
}

/**
 * 加油包 → 微信道具 ID：`BEAN_<积分数>`（基础积分数，**不含赠送**）。
 *
 * ★ 为什么用积分数而不是自增 id：`bean_package` 没有 code 列，而 id 是库内序号 ——
 *   重建库或用测试库时会指向另一个商品，价格与道具对不上就是 `-15013 道具价格错误`。
 *   积分数是业务语义、跨环境稳定，在 MP 后台建道具时也一眼能认。
 * ★ 代价：改了「积分数」就等于换了一个道具，必须在 MP 后台同步新建并发布。
 *   这条约束与 `goodsPrice` 一致性的约束是同一类（详见下面的 VP_PRODUCT_CONTRACT）。
 */
export function beanProductId(beans: bigint | number | string): string {
  const n = typeof beans === 'bigint' ? beans.toString() : String(beans)
  if (!/^\d+$/.test(n)) throw new Error(`加油包积分数不是整数：${n}`)
  return `BEAN_${n}`
}

/**
 * ★★ 上线前必须逐条核对的「道具契约」。
 *
 * 微信侧的道具（productId / 价格）是在 **MP 后台**建的，本项目读不到它，**没有任何接口能校验**。
 * 两边不一致时下单直接失败：`goodsPrice` 对不上 ⇒ `-15013`；道具没发布 ⇒ `-15010`。
 * 所以约定为：**MP 后台的道具 ID 与价格，必须与本函数的产物逐字一致**。
 */
export const VP_PRODUCT_CONTRACT = [
  { productId: 'SUBSCRIPTION', goodsPriceFen: 98000, 说明: '订阅 · 3年（member_package.code）' },
  { productId: 'BEAN_10000', goodsPriceFen: 10000, 说明: '100元 · 10000积分' },
  { productId: 'BEAN_30000', goodsPriceFen: 30000, 说明: '300元 · 32000积分' },
  { productId: 'BEAN_50000', goodsPriceFen: 50000, 说明: '500元 · 50000积分' },
] as const

/**
 * 断言「本地套餐 ↔ MP 后台道具」一致，不一致就**抛错**，绝不把注定失败的参数发下去。
 *
 * ★★ 为什么必须 fail-closed：两边不一致时微信**必然**拒绝，只是错误码不同 ——
 *   `-15010 道具不存在` / `-15013 道具价格错误`。而这两个码在客户端只表现为
 *   「支付失败」，排查的人手里只有一句「用户说付不了款」，看不出是后台少建了一个道具。
 *   与其把注定失败的参数发出去再等微信回一个码，不如在**构建参数的那一刻**就带着
 *   「去建哪个道具、价格该填多少」的指令失败 —— 后者是可以照着做的。
 *
 * ★ 为什么连价格一起比：只用 productId 判存在性会把「后台改价了」漏过去，
 *   而改价的后果（-15013）与道具缺失的修法完全不同（一个要去改道具价、一个要新建道具）。
 *
 * ★ 线上实测（2026-10-10）：`bean_package` 三行 10000 / 30000 / 50000 与
 *   `member_package` 的 `SUBSCRIPTION` / 98000 与本表**逐条吻合** ⇒ 这道闸门当前是绿的。
 *   它的价值在**未来漂移**：后台改价、或新增档位却忘了在 MP 后台建道具。
 */
export function assertVpProductContract(productId: string, goodsPriceFen: number): void {
  const entry = VP_PRODUCT_CONTRACT.find((c) => c.productId === productId)
  if (!entry) {
    throw new Error(
      `微信道具未登记：productId=${productId}（${goodsPriceFen} 分）。` +
        `请先在 MP 后台【虚拟支付 → 基本配置 → 道具管理】新建并**发布现网**该道具（ID 必须逐字一致），` +
        `再加进 src/lib/xpay.ts 的 VP_PRODUCT_CONTRACT —— 未发布时微信下单会回 -15010。`,
    )
  }
  if (entry.goodsPriceFen !== goodsPriceFen) {
    throw new Error(
      `微信道具价格不一致：${productId} 本地 ${goodsPriceFen} 分、契约登记 ${entry.goodsPriceFen} 分（微信会回 -15013）。` +
        `改本地套餐价 ⇒ 必须同步改 MP 后台的道具价，并更新 VP_PRODUCT_CONTRACT。`,
    )
  }
}

// ── 调起参数 ────────────────────────────────────────────────────────

/** 交给前端的「调起虚拟支付」四件套。字段名与官方 API 一致。 */
export interface VirtualPayParams {
  signData: string
  paySig: string
  signature: string
  mode: VpMode
}

export interface BuildVpParamsInput {
  /** 微信道具 ID（见 VP_PRODUCT_CONTRACT） */
  productId: string
  /** 道具单价（分）。★ 必须与 MP 后台该道具的价格**完全一致**，否则 -15013 */
  goodsPriceFen: number
  /** 业务订单号。要求 8~32 字符，只允许 0-9a-zA-Z 与 _-|*@，不能以 _ 开头，一单只能用一次 */
  outTradeNo: string
  /** 透传数据，发货推送会原样带回。用来在推送里二次确认「这单确实是我们下的」 */
  attach: string
  /** 本次付款人的 session_key（code2Session 换得）。**不下发**，只用于算 signature */
  sessionKey: string
  env?: NodeJS.ProcessEnv
}

/**
 * 构建 `wx.requestVirtualPayment` 的入参。
 *
 * ★ `signData` 以 **string** 形态返回（官方要求），且**签名与发送用的是同一串**。
 *   客户端必须原样透传，**不许再 JSON.stringify 一次** —— 重新序列化的 key 顺序或转义一变，
 *   签名就废了（现场只会看到 -15005/-15006）。
 */
export function buildVirtualPayParams(input: BuildVpParamsInput): VirtualPayParams {
  const env = input.env ?? process.env
  const offerId = vpOfferId(env)
  if (!offerId) throw new Error('WX_VP_OFFER_ID 未配置，无法构建虚拟支付参数')

  if (!input.productId) throw new Error('productId 为空')
  if (!Number.isInteger(input.goodsPriceFen) || input.goodsPriceFen <= 0) {
    throw new Error(`goodsPriceFen 必须为正整数（分）：${input.goodsPriceFen}`)
  }
  if (!OUT_TRADE_NO_RE.test(input.outTradeNo)) {
    throw new Error(
      `outTradeNo 不满足官方约束（8~32 字符，0-9a-zA-Z 与 _-|*@，不能以 _ 开头）：${input.outTradeNo}`,
    )
  }
  if (!input.sessionKey) throw new Error('session_key 缺失：用户态签名必须有它（下单口需先传 wxLoginCode）')
  if (input.attach.length > 128) throw new Error('attach 过长（>128）')

  // ★ 与 MP 后台道具的一致性 —— `-15010` / `-15013` 的唯一防线，见 assertVpProductContract。
  //   放在这里（而不是下单口）是因为它是**唯一**的构建出口：将来新增调用方也自动受管。
  assertVpProductContract(input.productId, input.goodsPriceFen)

  // ★ 字段顺序**显式固定**：虽然 JSON 的 key 顺序不影响语义，但固定顺序让
  //   「签名用的串」在日志与守护脚本里可直接比对，出问题时不用猜是哪一步变了。
  const signData = JSON.stringify({
    offerId,
    buyQuantity: 1,
    env: vpEnv(env),
    currencyType: 'CNY',
    productId: input.productId,
    goodsPrice: input.goodsPriceFen,
    outTradeNo: input.outTradeNo,
    attach: input.attach,
  })

  return {
    signData,
    paySig: calcPaySig(VP_URI_REQUEST_PAYMENT, signData, vpAppKey(env)),
    signature: calcSignature(signData, input.sessionKey),
    mode: VP_MODE_GOODS,
  }
}

// ── 服务端 API 签名（/xpay/*）─────────────────────────────────────
//
// 发货兜底要用 /xpay/query_order 查单。它与基础库调起**共用同一套签名**，只有三点不同：
//   ① uri 填接口路径（如 `/xpay/query_order`）而不是 `requestVirtualPayment`；
//   ② **URL 上必须带 `access_token`**（Query String：`access_token` + `pay_sig`）；
//   ③ signData 换成该接口的 post body。
//
// ★ 为什么 `accessToken` 由调用方**注入**、本模块不自己去取：
//   取 access_token 需要 appid/secret + Redis 缓存（见 auth/wechat.ts::getWxAccessToken），
//   把它塞进来会让这个模块从「纯签名/报文」变成「有 IO 依赖」—— 守护脚本就得连 Redis 才能跑。
//   注入之后，verify 脚本可以用假 fetch 把 URL 与报文**逐字**断言下来。

/** 服务端 API 基址。 */
export const VP_API_BASE = 'https://api.weixin.qq.com'

/** 出站超时（毫秒）。与 wxpay 同口径：裸 fetch 会给「下单页转圈不停」埋雷。 */
const VP_TIMEOUT_MS = Number(process.env.WX_VP_TIMEOUT_MS ?? 10_000)

export interface XpayApiDeps {
  /** `client_credential` access_token。见文件头「为什么注入」。 */
  accessToken: string
  env?: NodeJS.ProcessEnv
  /** 仅供守护脚本注入假实现；生产走全局 fetch。 */
  fetchImpl?: typeof fetch
}

/** 对 /xpay/* 发起一次已签名的 POST。body 必须与参与签名的那串**逐字节一致**。 */
export async function callXpayApi(
  uri: string,
  body: Record<string, unknown>,
  deps: XpayApiDeps,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const env = deps.env ?? process.env
  const bodyJson = JSON.stringify(body)
  const paySig = calcPaySig(uri, bodyJson, vpAppKey(env))
  const doFetch = deps.fetchImpl ?? fetch
  // ★ 顺序与官方示例一致（`?access_token=…&pay_sig=…`）。`pay_sig` 与 `access_token`
  //   都是 Query String 参数，**不参与**签名 —— 参与签名的只有 `uri + '&' + body`。
  const url = `${VP_API_BASE}${uri}?access_token=${encodeURIComponent(deps.accessToken)}&pay_sig=${encodeURIComponent(paySig)}`
  const resp = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyJson,
    signal: AbortSignal.timeout(VP_TIMEOUT_MS),
  })
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: resp.ok, status: resp.status, data }
}

/**
 * 微信侧的订单状态（官方 `Res.order.status` 枚举）。
 *
 * ★ 这张表**不能靠猜**：它与「订单创建成功 / 已支付 / 已发货 / 已退款」是四种不同的编码，
 *   写错一位就会把「已退款」当成「已支付」（或反过来）—— 前者是白送权益，后者是钱收了不发货。
 */
export const VP_ORDER_STATUS = {
  /** 0 订单初始化（未创建成功，**不可用于支付**） */
  INIT: 0,
  /** 1 订单创建成功（用户尚未付款） */
  CREATED: 1,
  /** 2 订单已经支付，待发货 */
  PAID: 2,
  /** 3 订单发货中 */
  DELIVERING: 3,
  /** 4 订单已发货 */
  DELIVERED: 4,
  /** 5 订单退款：商户侧扣款完成 */
  REFUND_MCH_DONE: 5,
  /** 6 订单已经关闭（**不可再使用**） */
  CLOSED: 6,
  /** 7 订单退款失败 */
  REFUND_FAILED: 7,
  /** 8 订单退款：用户侧收款完成 */
  REFUND_USER_DONE: 8,
  /** 9 回收广告金完成 */
  RECLAIM_AD_DONE: 9,
  /** 10 分账回退完成 */
  SPLIT_REVERSED: 10,
} as const

/** 已支付的状态集合：2 待发货 / 3 发货中 / 4 已发货。**发货后仍是 4**，不是「已支付」以外的状态。 */
export const VP_PAID_STATUSES: readonly number[] = [
  VP_ORDER_STATUS.PAID,
  VP_ORDER_STATUS.DELIVERING,
  VP_ORDER_STATUS.DELIVERED,
]

/** 已进入退款流程的状态集合。★ 这些**绝不能**被当成「已支付」自动结算。 */
export const VP_REFUND_STATUSES: readonly number[] = [
  VP_ORDER_STATUS.REFUND_MCH_DONE,
  VP_ORDER_STATUS.REFUND_FAILED,
  VP_ORDER_STATUS.REFUND_USER_DONE,
]

export interface VpOrderQueryResult {
  /** 微信侧原始状态码（见 VP_ORDER_STATUS） */
  status: number
  /** true ＝ 微信侧确认这单**已经付过钱**（status ∈ {2,3,4}） */
  paid: boolean
  /** true ＝ 微信侧已关闭（status = 6，不可再使用）⇒ 本地可安全置终态 */
  closed: boolean
  /** true ＝ 已进入退款流程（status ∈ {5,7,8}）⇒ **不自动结算**，交人工 */
  refund: boolean
  /** 用户支付金额（分）；未知 null。★ 与本地订单金额比对时用这个，而不是 order_fee */
  paidFen: number | null
  /** 订单金额（分）；未知 null */
  orderFeeFen: number | null
  /**
   * 微信支付交易单号（用户微信支付详情页上的**交易单号**）。
   * ⇒ 结算时写进 `order.wx_transaction_id` 的就是它（不是 `wx_order_id`）。
   * ★ iOS 走 Apple 支付时可能为空。
   */
  wxpayOrderId: string | null
  /** 微信**内部单号**（可用它作为下次查单的 `wx_order_id`，与 `order_id` 二选一） */
  wxOrderId: string | null
  /**
   * `order_type`：0 普通虚拟支付 / 1 普通退款 / **7 苹果 iOS 支付** / 8 苹果 iOS 退款。
   * ★ 需要它才能回答「这笔是安卓还是 iOS」—— 两者结算周期差 45~60 天。
   */
  orderType: number | null
}

export interface QueryVpOrderInput {
  /** 业务订单号（＝下单时的 `outTradeNo`）。★ 官方字段名是 `order_id`，**不是** `out_trade_no`。 */
  orderId: string
  /** 付款人的 openid。★ **必填** —— 少了它官方直接回 `268490001 openid错误`。 */
  openid: string
}

/**
 * 【只读】按业务订单号查虚拟支付订单 —— `/xpay/query_order`。
 *
 * 存在的意义与 JSAPI 那条查单完全一样：**success 回调与发货推送都不是可靠通道**
 * （官方原文：「由 success 回调触发，可能会丢失，比如微信异常退出」），推送也可能因我们
 * 的 URL 不可达而耗尽 15 次重试。查单是唯一能主动纠正它的手段。
 *
 * ── 两个必须说清的不确定点（别在这里自行猜测）──────────────────
 * ① **「查无此单」用什么表示**：官方错误码表里**没有**「订单不存在」这一项
 *    （只有 `268490002 请求参数字段错误`、`268490003 签名错误`…）。所以本函数遇到
 *    `errcode !== 0` 一律**抛错**，绝不翻译成「没付过」—— 把一次接口报错当成 NOT_EXIST，
 *    会直接导致「真实付过款的单被本地置为过期」。语义要靠**真机实测**补上，不是靠猜。
 * ② **虚拟支付没有「关单」接口**：官方服务端接口清单里只有 `refund_order`（退款）与
 *    `cancel_currency_pay`（**代币**支付的逆操作），**没有**现金单的取消/关闭。
 *    所以对账侧那条「先把微信侧关掉、成功了才允许本地置过期」的不变量，VP 单**做不到**。
 */
export async function queryVpOrder(
  input: QueryVpOrderInput,
  deps: XpayApiDeps,
): Promise<VpOrderQueryResult> {
  const env = deps.env ?? process.env
  if (!input.orderId) throw new Error('queryVpOrder 缺少 orderId')
  if (!input.openid) throw new Error('queryVpOrder 缺少 openid（官方必填，缺少会回 268490001）')

  const r = await callXpayApi(
    '/xpay/query_order',
    // ★ 字段名与顺序照抄官方请求体示例：openid / env / order_id
    { openid: input.openid, env: vpEnv(env), order_id: input.orderId },
    deps,
  )
  const errcode = Number(r.data.errcode ?? -1)
  if (!r.ok || errcode !== 0) {
    throw new Error(
      `虚拟支付查单失败（errcode=${errcode} errmsg=${String(r.data.errmsg ?? '')} http=${r.status}）`,
    )
  }

  const order = (r.data.order ?? {}) as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  const status = num(order.status) ?? -1

  return {
    status,
    paid: VP_PAID_STATUSES.includes(status),
    closed: status === VP_ORDER_STATUS.CLOSED,
    refund: VP_REFUND_STATUSES.includes(status),
    paidFen: num(order.paid_fee),
    orderFeeFen: num(order.order_fee),
    wxpayOrderId: str(order.wxpay_order_id),
    wxOrderId: str(order.wx_order_id),
    orderType: num(order.order_type),
  }
}
