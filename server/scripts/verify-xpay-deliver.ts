/**
 * 小程序虚拟支付「发货推送」的契约测试。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────
 * 虚拟支付的发货信号由微信**推送**给我们（事件 `xpay_goods_deliver_notify`）。
 * 这条路一旦坏了，表现是「用户付了钱、积分/会员永远不到账」，而且
 * **客户端 success 回调按官方说明可能丢失** ⇒ 没有第二条线能兜住它。
 *
 * 所以这里钉死四类性质（都是线上不会自然暴露、只能靠提前守的）：
 *   ① **报文解析**：XML 与 CDATA 的边界（`<` 在 CDATA 里是字面量、在普通文本里是转义）、
 *      一层嵌套对象（`GoodsInfo` / `WeChatPayInfo`）、实体反转义、截断报文不抛错。
 *   ② **应答格式**：成功回官方那一种
 *      `<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>`
 *      （JSON 格式下是 `{"ErrCode":0,"ErrMsg":"success"}`）；
 *      失败按推送格式回非零 `ErrCode`（否则微信不会重推，等于静默丢单）。
 *   ③ **发货判据**：金额不符 / 道具不符 / 查无此单 **必须拒绝结算并告警**；
 *      未知事件类型 **必须 ACK**（否则微信把无关消息重推 15 次）。
 *      ★ 但「ACK」≠「装作没看见」：**退款 / 投诉**这类事件必须 ACK **且落告警**，
 *      真正无关的事件（用户消息）必须 ACK **且不告警** —— 两个方向都要守。
 *   ④ **幂等**：同一条推送重复投递（微信最多重推 15 次）**只发一次权益**。
 *   ⑤ **地址接入校验**：GET 带 `echostr` 必须**原样回**（后台保存 URL 时先打它）；
 *      缺 `echostr` 回 400；配了 `WX_VP_PUSH_TOKEN` 时签名不匹配回 403。
 *
 * ── 为什么能端到端跑 ────────────────────────────────────────────
 * 本脚本按 index.ts **完全相同的方式**挂载路由（`express.raw` 取通配 MIME）挂在
 * `/api/v1/xpay`），起一个随机端口的真实 HTTP 服务，用真报文打进去，最后查库
 * 断言「订单真的变 PAID、回执真的落了、积分真的只发了一次」。
 * 唯一无法在此覆盖的是 index.ts 里那一行挂载语句本身 ⇒ 用源码断言补上（见 B 段）。
 *
 * 只造一个临时商户 + 几张临时订单，跑完硬删；不碰任何真实数据。
 * 跑法：npx tsx scripts/verify-xpay-deliver.ts
 */
import 'dotenv/config'
import crypto from 'crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { prisma } from '../src/db.js'
import xpayRouter, { VP_DELIVER_EVENT } from '../src/routes/xpay.js'
import { parseWxXml, xmlStr } from '../src/lib/wx-xml.js'
import { beanProductId, memberProductId } from '../src/lib/xpay.js'

// 与其它脚本的测试号错开：pay-openid=…9995/6 / pay-risk=…9997 / reconcile=…9998 / membership=…9999
const PHONE = '13900009994'

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

// ════════════════════════════════════════════════════════════════════
// A 段：XML 解析器（纯函数，无 DB）
// ════════════════════════════════════════════════════════════════════

/** 与官方文档 `xpay_goods_deliver_notify` 字段表逐字对齐的一段真实形状报文。 */
function xmlPush(o: {
  event?: string | null
  outTradeNo?: string
  env?: string
  productId?: string
  attach?: string
  transactionId?: string
  actualPrice?: number | null
  origPrice?: number | null
  /** 额外插入的一段原始文本（用来构造畸形报文） */
  extra?: string
}): string {
  const event = o.event === undefined ? VP_DELIVER_EVENT : o.event
  const lines = [
    '<ToUserName><![CDATA[gh_1234567890ab]]></ToUserName>',
    '<FromUserName><![CDATA[oWxOfficialOpenid]]></FromUserName>',
    '<CreateTime>1730000000</CreateTime>',
    '<MsgType><![CDATA[event]]></MsgType>',
    ...(event === null ? [] : [`<Event><![CDATA[${event}]]></Event>`]),
    '<OpenId><![CDATA[oUSER_abc123]]></OpenId>',
    `<OutTradeNo><![CDATA[${o.outTradeNo ?? 'BVERIFY0000001'}]]></OutTradeNo>`,
    `<Env>${o.env ?? '0'}</Env>`,
    '<WeChatPayInfo>',
    '<MchOrderNo><![CDATA[4200001_deliver]]></MchOrderNo>',
    `<TransactionId><![CDATA[${o.transactionId ?? '4200002345202601010001'}]]></TransactionId>`,
    '<PaidTime>1730000001</PaidTime>',
    '</WeChatPayInfo>',
    '<GoodsInfo>',
    `<ProductId><![CDATA[${o.productId ?? 'BEAN_10000'}]]></ProductId>`,
    '<Quantity>1</Quantity>',
    `<OrigPrice>${o.origPrice === null ? '' : (o.origPrice ?? 10000)}</OrigPrice>`,
    `<ActualPrice>${o.actualPrice === null ? '' : (o.actualPrice ?? 10000)}</ActualPrice>`,
    `<Attach><![CDATA[${o.attach ?? 'BEAN:1'}]]></Attach>`,
    '</GoodsInfo>',
    ...(o.extra ? [o.extra] : []),
  ]
  return `<xml>\n${lines.join('\n')}\n</xml>`
}

function sectionA() {
  console.log('\n── A 段：XML 解析器 ──')

  const p = parseWxXml(xmlPush({}))
  check(p.Event === VP_DELIVER_EVENT, '拆掉 <xml> 外壳：Event 直接可读')
  check(p.OutTradeNo === 'BVERIFY0000001', 'CDATA 文本正确脱壳（OutTradeNo）')
  check(p.ToUserName === 'gh_1234567890ab', 'CDATA 文本正确脱壳（ToUserName）')
  check(p.Env === '0', '非 CDATA 的标量同样解析（Env）')
  const goods = p.GoodsInfo as Record<string, unknown>
  const pay = p.WeChatPayInfo as Record<string, unknown>
  check(!!goods && goods.ProductId === 'BEAN_10000', '一层嵌套对象 GoodsInfo.ProductId')
  check(!!goods && goods.ActualPrice === '10000', '一层嵌套对象 GoodsInfo.ActualPrice')
  check(!!pay && pay.TransactionId === '4200002345202601010001', '一层嵌套对象 WeChatPayInfo.TransactionId')
  check(Object.keys(p).length === 10, `顶层字段数正确（${Object.keys(p).length} 个，含 2 个嵌套对象）`)

  // ★ CDATA 里的 `<` 是**字面量**，普通文本里的 `<` 是**转义**。两者混同就会解析错。
  const cdataLt = parseWxXml('<xml><A><![CDATA[a<b>c]]></A><B>a&lt;b&gt;c</B></xml>')
  check(cdataLt.A === 'a<b>c', 'CDATA 内的 < > 保持字面量（不被当成标签）')
  check(cdataLt.B === 'a<b>c', '普通文本内的 &lt; &gt; 被反转义')

  // ★ `&amp;` 必须最后替换：`&amp;lt;` 应还原成字面 `&lt;`，而不是被二次解码成 `<`
  const amp = parseWxXml('<xml><A>a&amp;lt;b</A><B>&#20013;&#x6587;</B></xml>')
  check(amp.A === 'a&lt;b', '&amp;lt; 只解一层（不会二次解码成 <）')
  check(amp.B === '中文', '十进制 / 十六进制数字实体都能解')

  // 自闭合标签
  const selfClose = parseWxXml('<xml><A/><B>x</B></xml>')
  check(selfClose.A === '' && selfClose.B === 'x', '自闭合标签解析为空串')

  // 没有 <xml> 外壳 / 带 <?xml ?> 声明
  const bare = parseWxXml('<?xml version="1.0" encoding="UTF-8"?><A>x</A><B>y</B>')
  check(bare.A === 'x' && bare.B === 'y', '无 <xml> 外壳 + 带 <?xml?> 声明时正确解析')

  // 截断报文：根元素没闭合 ⇒ **不抛错、返回空对象**（fail-closed）。
  // ★ 为什么不是「尽力读出已闭合的部分」：那样会读出一个**结构猜对、内容可能截断**的值
  //   （例如 OutTradeNo 只剩前几位），拿它去查订单、去发货，比直接拒绝危险得多。
  //   空对象会落到路由的 BAD_PAYLOAD 分支：回非零 + 告警 + 记录原文。
  let truncatedThrew = false
  let truncated: Record<string, unknown> = {}
  try {
    truncated = parseWxXml('<xml><Event><![CDATA[xpay_goods_deliver_notify]]></Event><OutTradeNo><![CDATA[B1')
  } catch {
    truncatedThrew = true
  }
  check(!truncatedThrew, '截断报文不抛错（避免 500 掩盖原文）')
  check(
    Object.keys(truncated).length === 0,
    '截断（根未闭合）⇒ 返回空对象，交由路由按 BAD_PAYLOAD 响亮拒绝（不做半解析）',
    `实际键：${Object.keys(truncated).join(',')}`,
  )

  // ★ 同级同名元素 ⇒ **抛错**（fail-closed）。配对靠 indexOf，同名会静默配错位，
  //   读出一个「看起来正常、实际错位」的值 —— 资金链路上这是最危险的失败方式。
  let dupSiblingThrew = false
  try {
    parseWxXml('<xml><A>1</A><A>2</A></xml>')
  } catch {
    dupSiblingThrew = true
  }
  check(dupSiblingThrew, '同级同名元素 ⇒ 抛错（拒绝静默错配对）')

  let dupNestedThrew = false
  try {
    parseWxXml('<xml><A><A>x</A></A></xml>')
  } catch {
    dupNestedThrew = true
  }
  check(dupNestedThrew, '同名嵌套元素 ⇒ 抛错（同上）')

  // 注释与空白
  const noisy = parseWxXml('<xml>\n  <!-- 注释 -->\n  <A> v </A>\n</xml>')
  check(noisy.A === 'v', '注释被跳过、标量两侧空白被裁掉')
}

// ════════════════════════════════════════════════════════════════════
// B 段：源码接线（唯一无法在 HTTP 层覆盖的部分）
// ════════════════════════════════════════════════════════════════════

async function sectionB() {
  console.log('\n── B 段：index.ts 的挂载接线 ──')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const indexSrc = await readFile(path.join(here, '..', 'src', 'index.ts'), 'utf8')

  const mountRe = /app\.use\(\s*'\/api\/v1\/xpay'\s*,\s*express\.raw\(/
  const mountIdx = indexSrc.search(mountRe)
  check(mountIdx >= 0, "index.ts 以 express.raw 把 xpayRouter 挂在 '/api/v1/xpay'")
  check(indexSrc.includes("import xpayRouter from './routes/xpay.js'"), 'xpayRouter 已被 import')

  // ★ 顺序是**硬约束**：挂到 `express.json()` 之后的话，XML 原文会被 json 解析器
  //   吃成 `{}`（或直接 400），我们会拿不到 OutTradeNo ⇒ 一单也发不出去。
  const jsonIdx = indexSrc.indexOf('app.use(express.json(')
  check(jsonIdx >= 0 && mountIdx >= 0 && mountIdx < jsonIdx, '挂载位置在 express.json() **之前**（保留原始字节）')

  // 与普通支付回调同族（同样免鉴权、公网可达），但路径前缀不同
  check(indexSrc.includes("app.use('/api/v1/pay'"), '普通支付回调的挂载未被破坏')
}

// ════════════════════════════════════════════════════════════════════
// C 段：HTTP 端到端（真 DB + 真 HTTP）
// ════════════════════════════════════════════════════════════════════

const OUR_ALERT_CODES = [
  'VP_DELIVER_BAD_PAYLOAD',
  'VP_DELIVER_ENCRYPTED',
  'VP_DELIVER_ENV_MISMATCH',
  'VP_DELIVER_ORDER_NOT_FOUND',
  'VP_DELIVER_PRODUCT_MISMATCH',
  'PAY_AMOUNT_MISMATCH',
  'VP_EVENT_UNHANDLED',
]

async function cleanup(merchantId: bigint | null, orderNos: string[]) {
  // ops_alert 没有 merchantId ⇒ 按「本次代码新增的码」删。其中 PAY_AMOUNT_MISMATCH
  // 是 JSAPI 链路也在用的老码，务必再按 refId 限死在本次的订单号上。
  await prisma.opsAlert.deleteMany({ where: { code: { in: OUR_ALERT_CODES }, refId: { in: orderNos } } })
  await prisma.opsAlert.deleteMany({
    where: { code: { in: OUR_ALERT_CODES.filter((c) => c !== 'PAY_AMOUNT_MISMATCH') } },
  })
  if (merchantId === null) return
  await prisma.membershipReminder.deleteMany({ where: { merchantId } })
  await prisma.membership.deleteMany({ where: { merchantId } })
  await prisma.orderSettlement.deleteMany({ where: { merchantId } })
  await prisma.order.deleteMany({ where: { merchantId } })
  await prisma.beanLedger.deleteMany({ where: { merchantId } })
  await prisma.beanAccount.deleteMany({ where: { merchantId } })
  await prisma.merchant.deleteMany({ where: { id: merchantId } })
}

async function sectionC() {
  console.log('\n── C 段：HTTP 端到端（真库 / 真报文）──')

  // ★ 先清一次历史残留：`VP_DELIVER_*` 里的环境不符 / 畸形报文用的是**跨订单稳定**的
  //   去重键（不含订单号），上一次跑残留下来的行会让本次断言**假通过**。
  await cleanup(null, [])

  const beanPkg = await prisma.beanPackage.findFirst({ where: { enabled: true }, orderBy: { sort: 'asc' } })
  const memberPkg = await prisma.memberPackage.findFirst({ where: { enabled: true }, orderBy: { sort: 'asc' } })
  if (!beanPkg || !memberPkg) {
    check(false, '本地库缺少启用的加油包 / 会员套餐，无法跑端到端（先 db:seed）')
    return
  }

  const merchant = await prisma.merchant.create({ data: { phone: PHONE, nickname: '虚拟支付发货用例' } })
  const mid = merchant.id
  // ★ 建出来就登记（不是等函数返回才登记）：断言中途抛错时 teardown 仍能清干净
  tempMerchantId = mid

  const mkOrder = async (opts: {
    prefix: 'B' | 'M'
    orderType: 'BEAN' | 'MEMBER'
    refId: bigint
    amountFen: number
    beans: bigint
  }) => {
    const orderNo = `${opts.prefix}XV${Date.now().toString().slice(-9)}${tempOrderNos.length}`
    await prisma.order.create({
      data: {
        orderNo,
        merchantId: mid,
        orderType: opts.orderType,
        refId: opts.refId,
        amountFen: opts.amountFen,
        originalAmountFen: opts.amountFen,
        memberDiscountApplied: false,
        beans: opts.beans,
        status: 'PENDING',
        expireAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    })
    tempOrderNos.push(orderNo)
    return orderNo
  }

  // ★ 用与 index.ts 完全相同的挂载方式起服务
  const app = express()
  app.use('/api/v1/xpay', express.raw({ type: '*/*', limit: '1mb' }), xpayRouter)
  const server = app.listen(0)
  await new Promise<void>((r) => server.once('listening', () => r()))
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}/api/v1/xpay/deliver`

  const post = async (body: string, contentType = 'text/xml') => {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': contentType }, body })
    const text = await resp.text()
    return { status: resp.status, text }
  }
  const get = async (query: string) => {
    const resp = await fetch(`${url}?${query}`)
    const text = await resp.text()
    return { status: resp.status, text }
  }
  /**
   * 成功应答的判据：官方《虚拟支付：个人》5.4.1 给出的应答体是
   * `<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>`，
   * JSON 格式下的等价物是 `{"ErrCode":0,"ErrMsg":"success"}`。
   *
   * ★ 判据取 **ErrCode === 0**，而不是「正文里出现 `success` 字样」——
   *   要钉的正是「平台认的成功」这件事本身。
   */
  const isAck = (text: string) => {
    const t = text.trim()
    if (t.startsWith('<')) return xmlStr(parseWxXml(t), 'ErrCode') === '0'
    try {
      return Number((JSON.parse(t) as { ErrCode?: unknown }).ErrCode) === 0
    } catch {
      return false
    }
  }
  const orderOf = (orderNo: string) =>
    prisma.order.findUnique({
      where: { orderNo },
      select: { status: true, paidAt: true, beans: true, orderType: true, merchantId: true, amountFen: true },
    })
  const alertOf = (code: string, refId: string) =>
    prisma.opsAlert.findFirst({ where: { code, refId }, orderBy: { id: 'desc' } })

  try {
    // ── ⓪ 地址接入校验（GET echostr）─────────────────────────────
    // ★ 后台保存 URL 时会先打这个 GET；只挂 POST 时它 404 ⇒ 后台判「配置无效」，
    //   于是后面那套发货逻辑写得再对也一单都收不到。
    // ★ 闸门类用例：临时改 process.env 必须在 finally 还原（原值可能是 .env 带来的）。
    const savedPushToken = process.env.WX_VP_PUSH_TOKEN
    try {
      delete process.env.WX_VP_PUSH_TOKEN
      const g1 = await get('signature=abc&timestamp=1700000000&nonce=42&echostr=ECHO_VERIFY_123')
      check(
        g1.status === 200 && g1.text.trim() === 'ECHO_VERIFY_123',
        '⓪ GET 接入校验：未配 Token 时原样回 echostr',
        `实际 ${g1.status} ${g1.text.slice(0, 60)}`,
      )
      const g2 = await get('signature=abc&timestamp=1700000000&nonce=42')
      check(g2.status === 400, '⓪ 缺 echostr ⇒ 400（不伪装成「已接通」）', `实际 ${g2.status}`)

      process.env.WX_VP_PUSH_TOKEN = 'TOKEN_FOR_VERIFY'
      const good = crypto
        .createHash('sha1')
        .update(['TOKEN_FOR_VERIFY', '1700000000', '42'].sort().join(''))
        .digest('hex')
      const g3 = await get(`signature=${good}&timestamp=1700000000&nonce=42&echostr=OK_1`)
      check(
        g3.status === 200 && g3.text.trim() === 'OK_1',
        '⓪ 配了 Token ⇒ 签名正确才放行',
        `实际 ${g3.status} ${g3.text.slice(0, 60)}`,
      )
      const g4 = await get('signature=deadbeef&timestamp=1700000000&nonce=42&echostr=OK_2')
      check(g4.status === 403, '⓪ 配了 Token ⇒ 签名错误回 403', `实际 ${g4.status}`)
    } finally {
      if (savedPushToken === undefined) delete process.env.WX_VP_PUSH_TOKEN
      else process.env.WX_VP_PUSH_TOKEN = savedPushToken
    }

    // ── ① 快乐路径：XML 报文 → 发货 ──
    const beanOrder = await mkOrder({
      prefix: 'B',
      orderType: 'BEAN',
      refId: beanPkg.id,
      amountFen: beanPkg.priceFen,
      beans: beanPkg.beans,
    })
    const r1 = await post(
      xmlPush({
        outTradeNo: beanOrder,
        productId: beanProductId(beanPkg.beans),
        attach: `BEAN:${mid}`,
        actualPrice: beanPkg.priceFen,
        origPrice: beanPkg.priceFen,
      }),
    )
    check(r1.status === 200 && isAck(r1.text), '① XML 推送返回官方成功应答（ErrCode=0）', `实际 ${r1.status} ${r1.text.slice(0, 80)}`)

    const o1 = await orderOf(beanOrder)
    check(o1?.status === 'PAID', '① 订单变为 PAID', `实际 ${o1?.status}`)
    check(!!o1?.paidAt, '① paidAt 已写入')

    const settle1 = await prisma.orderSettlement.findMany({ where: { orderNo: beanOrder } })
    check(settle1.length === 1, '① 结算回执恰好 1 条（PAID ⟺ 有回执）')
    check(settle1[0]?.source === 'NOTIFY', '① 回执来源记为 NOTIFY（微信主动告知）')
    check(
      settle1[0]?.grantedBeans === beanPkg.beans,
      `① 回执记下实发积分数（${settle1[0]?.grantedBeans}）`,
    )

    const acct1 = await prisma.beanAccount.findUnique({ where: { merchantId: mid } })
    check(acct1?.balance === beanPkg.beans, `① 积分已入账（${acct1?.balance}）`)

    // ── ② 幂等：微信最多重推 15 次，只能发一次权益 ──
    const r2 = await post(xmlPush({ outTradeNo: beanOrder, productId: beanProductId(beanPkg.beans), actualPrice: beanPkg.priceFen }))
    check(isAck(r2.text), '② 重复推送仍回成功应答')
    const settle2 = await prisma.orderSettlement.findMany({ where: { orderNo: beanOrder } })
    const acct2 = await prisma.beanAccount.findUnique({ where: { merchantId: mid } })
    check(settle2.length === 1, '② 回执仍是 1 条（未重复结算）')
    check(acct2?.balance === beanPkg.beans, `② 积分未被重复发放（${acct2?.balance}）`)

    // ── ③ JSON 格式（消息推送后台可配 XML/JSON） ──
    const beanOrder2 = await mkOrder({
      prefix: 'B',
      orderType: 'BEAN',
      refId: beanPkg.id,
      amountFen: beanPkg.priceFen,
      beans: beanPkg.beans,
    })
    const jsonBody = JSON.stringify({
      ToUserName: 'gh_1234567890ab',
      FromUserName: 'oWxOfficialOpenid',
      CreateTime: 1730000000,
      MsgType: 'event',
      Event: VP_DELIVER_EVENT,
      OpenId: 'oUSER_abc123',
      OutTradeNo: beanOrder2,
      Env: 0,
      WeChatPayInfo: { MchOrderNo: 'm1', TransactionId: '4200002345202601010002', PaidTime: 1730000001 },
      GoodsInfo: {
        ProductId: beanProductId(beanPkg.beans),
        Quantity: 1,
        OrigPrice: beanPkg.priceFen,
        ActualPrice: beanPkg.priceFen,
        Attach: `BEAN:${mid}`,
      },
    })
    const r3 = await post(jsonBody, 'application/json')
    check(isAck(r3.text), '③ JSON 推送返回成功应答', `实际 ${r3.text.slice(0, 80)}`)
    check((await orderOf(beanOrder2))?.status === 'PAID', '③ JSON 格式同样能发货')

    // ── ④ 会员订单：道具映射走 member_package.code ──
    const memberOrder = await mkOrder({
      prefix: 'M',
      orderType: 'MEMBER',
      refId: memberPkg.id,
      amountFen: memberPkg.priceFen,
      beans: 0n,
    })
    const r4 = await post(
      xmlPush({
        outTradeNo: memberOrder,
        productId: memberProductId(memberPkg.code),
        attach: `MEMBER:${mid}`,
        actualPrice: memberPkg.priceFen,
        origPrice: memberPkg.priceFen,
        // iOS 走 Apple 支付时 WeChatPayInfo 可能整块缺席 —— 这里用一个空块模拟
        transactionId: '',
      }),
    )
    check(isAck(r4.text), '④ 会员推送成功')
    check((await orderOf(memberOrder))?.status === 'PAID', '④ 会员订单变为 PAID')
    const mship = await prisma.membership.findMany({ where: { merchantId: mid } })
    check(mship.length === 1, `④ 会员已开通（${mship.length} 行）`)

    // ── ⑤ 金额不符 ⇒ 拒绝结算 + CRITICAL 告警（★ 用 1 分钱买 980 元会员的拦阻点） ──
    const badAmount = await mkOrder({
      prefix: 'B',
      orderType: 'BEAN',
      refId: beanPkg.id,
      amountFen: beanPkg.priceFen,
      beans: beanPkg.beans,
    })
    const r5 = await post(
      xmlPush({ outTradeNo: badAmount, productId: beanProductId(beanPkg.beans), actualPrice: 1, origPrice: 1 }),
    )
    check(!isAck(r5.text), '⑤ 金额不符 ⇒ 回非零 ErrCode（要求微信重推）', `实际 ${r5.text.slice(0, 80)}`)
    check((await orderOf(badAmount))?.status === 'PENDING', '⑤ 金额不符 ⇒ 拒绝结算，订单仍为 PENDING')
    const a5 = await alertOf('PAY_AMOUNT_MISMATCH', badAmount)
    check(a5?.severity === 'CRITICAL', '⑤ 落一条 CRITICAL 告警')
    check(
      a5?.dedupeKey === `PAY_AMOUNT_MISMATCH:${badAmount}`,
      '⑤ 去重键与 JSAPI 回调/查单**同一条**（三条通道谁先发现都只留一条）',
    )

    // ── ⑥ 道具不符 ⇒ 拒绝结算（防「小额道具的付款换走大额权益」） ──
    const badProduct = await mkOrder({
      prefix: 'B',
      orderType: 'BEAN',
      refId: beanPkg.id,
      amountFen: beanPkg.priceFen,
      beans: beanPkg.beans,
    })
    const r6 = await post(
      xmlPush({ outTradeNo: badProduct, productId: 'BEAN_99999999', actualPrice: beanPkg.priceFen }),
    )
    check(!isAck(r6.text), '⑥ 道具不符 ⇒ 回非零 ErrCode')
    check((await orderOf(badProduct))?.status === 'PENDING', '⑥ 道具不符 ⇒ 拒绝结算')
    check(
      (await alertOf('VP_DELIVER_PRODUCT_MISMATCH', badProduct))?.severity === 'CRITICAL',
      '⑥ 落一条 CRITICAL 告警',
    )

    // ── ⑦ 查无此单 ⇒ 拒绝 + CRITICAL 告警（钱可能真的付了） ──
    const ghost = 'BXVVERIFYGHOST01'
    tempOrderNos.push(ghost)
    const r7 = await post(xmlPush({ outTradeNo: ghost, actualPrice: 10000 }))
    check(!isAck(r7.text), '⑦ 查无此单 ⇒ 回非零 ErrCode')
    check(
      (await alertOf('VP_DELIVER_ORDER_NOT_FOUND', ghost))?.severity === 'CRITICAL',
      '⑦ 落一条 CRITICAL 告警（「付了钱却不会发货」必须有人知道）',
    )

    // ── ⑧ 未知事件类型 ⇒ ACK（与「消息推送」共用地址时会收到一堆无关事件） ──
    const untouched = await mkOrder({
      prefix: 'B',
      orderType: 'BEAN',
      refId: beanPkg.id,
      amountFen: beanPkg.priceFen,
      beans: beanPkg.beans,
    })
    const r8 = await post(xmlPush({ event: 'user_enter_tempsession', outTradeNo: untouched }))
    check(isAck(r8.text), '⑧ 未知事件类型 ⇒ ACK（避免无关消息被重推 15 次）')
    check((await orderOf(untouched))?.status === 'PENDING', '⑧ 未知事件不动任何订单')

    // ── ⑧b 「收到但不处理」的**业务相关**事件必须留痕（退款 / 投诉）──────
    // ★ 那个地址就是微信「消息推送」的地址 ⇒ 这些事件现在**真的会到达**。
    //   从前是安静 ACK ⇒「用户退款了、积分/会员还留在他账上」没有任何人知道。
    const r8b = await post(
      xmlPush({ event: 'xpay_refund_notify', outTradeNo: untouched, productId: '' }),
    )
    check(isAck(r8b.text), '⑧b 退款事件仍然 ACK（我们不会自动处理它，重推没有意义）')
    const a8b = await prisma.opsAlert.findFirst({
      where: { code: 'VP_EVENT_UNHANDLED', refId: untouched, severity: 'CRITICAL' },
      orderBy: { id: 'desc' },
    })
    check(!!a8b, '⑧b 退款 ⇒ 落一条 CRITICAL 告警（钱退了、权益还在，必须有人知道）')
    check(
      (a8b?.detail ?? '').includes('xpay_refund_notify') &&
        (a8b?.detail ?? '').includes('人工回收') &&
        (a8b?.detail ?? '').includes(untouched),
      '⑧b 告警正文点名事件 / 订单号，并给出可执行处置（人工回收）',
    )

    const r8c = await post(xmlPush({ event: 'xpay_complaint_notify', outTradeNo: untouched }))
    check(isAck(r8c.text), '⑧c 投诉事件仍然 ACK')
    const a8c = await prisma.opsAlert.findFirst({
      where: { code: 'VP_EVENT_UNHANDLED', refId: untouched, severity: 'WARN' },
      orderBy: { id: 'desc' },
    })
    check(!!a8c, '⑧c 投诉 ⇒ 落一条 WARN 告警')
    check((a8c?.detail ?? '').includes('xpay_complaint_notify'), '⑧c 告警正文点名投诉事件')

    // ★ 反向判据：真正无关的事件（用户消息）**不得**产生告警 ——
    //   否则「消息推送」一开，告警页立刻被用户消息淹没，等于没有告警。
    const cntBefore = await prisma.opsAlert.count({ where: { code: 'VP_EVENT_UNHANDLED' } })
    await post(xmlPush({ event: 'user_enter_tempsession', outTradeNo: untouched }))
    const cntAfter = await prisma.opsAlert.count({ where: { code: 'VP_EVENT_UNHANDLED' } })
    check(cntAfter === cntBefore, '⑧d 无关事件（用户消息）不产生告警（避免告警页被淹没）')
    check((await orderOf(untouched))?.status === 'PENDING', '⑧d 以上事件都不动订单')

    // ── ⑨ 加密报文（消息推送「安全模式」）⇒ 非零 + CRITICAL + 可执行提示 ──
    const r9 = await post('<xml><ToUserName><![CDATA[gh_1]]></ToUserName><Encrypt><![CDATA[abc]]></Encrypt></xml>')
    check(!isAck(r9.text), '⑨ 加密报文 ⇒ 回非零（不静默丢单）')
    const a9 = await prisma.opsAlert.findFirst({
      where: { code: 'VP_DELIVER_ENCRYPTED' },
      orderBy: { id: 'desc' },
    })
    check(a9?.severity === 'CRITICAL', '⑨ 落 CRITICAL 告警')
    check(
      (a9?.detail ?? '').includes('EncodingAESKey') && (a9?.detail ?? '').includes('明文模式'),
      '⑨ 告警正文给出可执行的处置办法（不只是一句「解析失败」）',
    )

    // ── ⑩ 环境不符 ⇒ ACK + 告警（重推改变不了任何事） ──
    const r10 = await post(xmlPush({ outTradeNo: beanOrder, env: '1', actualPrice: beanPkg.priceFen }))
    check(isAck(r10.text), '⑩ 环境不符 ⇒ ACK（不制造 15 次无谓重推）')
    const a10 = await prisma.opsAlert.findFirst({
      where: { code: 'VP_DELIVER_ENV_MISMATCH' },
      orderBy: { id: 'desc' },
    })
    check(a10 !== null, '⑩ 环境不符仍留一条告警（配置串了必须有人知道）')

    // ── ⑪ 读不到 Event / 空报文 / 垃圾字节 ⇒ 非零 + 告警 ──
    const r11a = await post(xmlPush({ event: null, outTradeNo: beanOrder }))
    check(!isAck(r11a.text), '⑪ 读不到 Event ⇒ 回非零（不能当成「别人的事件」静默 ACK）')
    const r11b = await post('<xml><OutTradeNo><![CDATA[B1', 'text/xml')
    check(!isAck(r11b.text), '⑪ 截断报文 ⇒ 回非零')
    const r11c = await post('')
    check(!isAck(r11c.text), '⑪ 空报文 ⇒ 回非零')
    check(
      (await prisma.opsAlert.findFirst({ where: { code: 'VP_DELIVER_BAD_PAYLOAD' }, orderBy: { id: 'desc' } })) !== null,
      '⑪ 畸形报文落 VP_DELIVER_BAD_PAYLOAD 告警',
    )

    // ── ⑫ 非法订单号（缺 OutTradeNo）⇒ 非零 ──
    const noOut = '<xml><Event><![CDATA[xpay_goods_deliver_notify]]></Event><Env>0</Env></xml>'
    const r12 = await post(noOut)
    check(!isAck(r12.text), '⑫ 缺 OutTradeNo ⇒ 回非零')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

// ════════════════════════════════════════════════════════════════════

let tempMerchantId: bigint | null = null
let tempOrderNos: string[] = []

async function teardown() {
  console.log('\n（清理临时数据…）')
  await cleanup(tempMerchantId, tempOrderNos)
}

async function main() {
  sectionA()
  await sectionB()
  await sectionC()
}

main()
  .then(async () => {
    await teardown()
    console.log(`\n★ ${failed === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${failed} 失败\n`)
    await prisma.$disconnect()
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch(async (e) => {
    console.error('\n脚本异常：', e)
    await teardown().catch((x) => console.error('清理失败，请手动删除临时数据：', (x as Error).message))
    await prisma.$disconnect()
    process.exit(1)
  })
