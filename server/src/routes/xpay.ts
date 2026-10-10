// 小程序虚拟支付 —— **发货推送**接收端点
//
// ── 这是干什么的 ────────────────────────────────────────────────
// 虚拟支付（`wx.requestVirtualPayment`）付款成功后，微信会向我们配置的地址投递一条
// `xpay_goods_deliver_notify` 事件。**这就是发货信号** —— 收到它才发积分 / 开会员。
//
// ★★ 为什么不能只靠客户端的 `success` 回调：官方原文写明它「**可能会丢失，
//   比如微信异常退出**」。丢了就是「钱收了、货没发」，而且本地连一行线索都没有。
//   所以官方要求「推送」与「查单」**至少实现一个**，建议都做 ——
//   本文件是**推送**那一半；查单那一半在 routes/orders.ts 的 `POST /:orderNo/query`
//   与 services/pay-reconcile.service.ts（对账 sweeper）。
//
// ── 四条铁律 ───────────────────────────────────────────────────
// ① **幂等**：一律走 `orderSvc.markOrderPaid()`。它用「PENDING→PAID 终态 CAS」去重，
//    所以推送 + 查单 + 人工补单同时发生也只发一次权益。绝不在本文件另写发权益逻辑。
// ② **先验金额与道具，再发货**：推送里的 `ActualPrice` / `ProductId` 必须与本地订单
//    对得上。这是「用 1 分钱买 980 元会员」的唯一拦阻点。
// ③ **应答体必须是官方那一种**：成功回
//    `<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>`
//    （JSON 格式下的等价物是 `{"ErrCode":0,"ErrMsg":"success"}`）。这是官方
//    《虚拟支付：个人》5.4.1 给出的应答体，并写明「返回 0 表示成功，否则平台会重推（最多 15 次）」。
//    ★ 早前这里回的是**纯文本 `success`** —— 那是**微信支付 APIv2 回调**的约定，被错搬到了
//      虚拟支付这条消息推送底座上。平台不认它 ⇒ 每条推送都被判「发货失败」并重推 15 次。
//    失败时按检测到的格式回非零 `ErrCode`，让微信重试。
// ④ **地址接入校验**：后台保存/测试 URL 时会发一个 **GET**
//    （`?signature=&timestamp=&nonce=&echostr=`），**原样返回 `echostr` 才算接入生效**。
//    只挂 POST 的话这个 GET 会 404 ⇒ 后台直接判「配置无效」，之后的发货逻辑写得再对也一单收不到。
//
// ── 应答策略（只有这两种结果）──────────────────────────────────
// ✅ **ACK（success）**：已处理 —— 结算成功、已 PAID 幂等命中、或**这条消息不是给我们的**
//    （未知事件类型 / 另一个环境）。后者重试也没意义，ACK 掉避免 15 次无谓重推。
// ❌ **非零（重试）**：解析失败、订单查无、金额/道具不符、内部异常。
//    每一种都会**落一条告警**（`ops_alert`），绝不静默。
import crypto from 'crypto'
import type { Request, Response } from 'express'
import { createRouter } from '../lib/async-router.js'
import { prisma } from '../db.js'
import * as orderSvc from '../services/order.service.js'
import { raiseOpsAlert } from '../services/ops-alert.service.js'
import { parseWxXml, xmlObj, xmlStr } from '../lib/wx-xml.js'
import { beanProductId, memberProductId, vpEnv } from '../lib/xpay.js'

const router = createRouter()

/** 发货推送的事件名（报文里 `Event` 的值）。 */
export const VP_DELIVER_EVENT = 'xpay_goods_deliver_notify'

/**
 * 我们**收到但不处理**的虚拟支付事件 —— 收到就**必须留痕**，绝不安静 ACK。
 *
 * ★★ 为什么必须有这张表：发货推送地址就是微信「消息推送」的地址，**一旦启用**，
 *   这些事件是**真的会到达**的（在配地址之前，它们根本无处可推）。而在此之前的写法是
 *   「非发货事件一律安静 ACK」—— 不重推、不处理、**也不告警**，于是
 *   「用户退款了、积分/会员还留在他账上」这件事**没有任何人知道**。
 *
 * ★ 仍然 ACK（不要求重推）：这些事件我们**没有能力**自动处理，重推 15 次也改变不了什么；
 *   「留痕 + 人工介入」才是正确的收口。
 *
 * ★ 为什么用**固定**的告警 code（`VP_EVENT_UNHANDLED`）而不是把事件名拼进 code：
 *   后台「异常告警」是按 code 聚合展示的；事件名放 `detail`，去重靠 `dedupeKey`。
 */
const VP_UNHANDLED_EVENTS: Record<
  string,
  { severity: 'WARN' | 'CRITICAL'; title: string; hint: string }
> = {
  xpay_refund_notify: {
    severity: 'CRITICAL',
    title: '虚拟支付发生退款，但本服务不会自动回收权益',
    hint:
      '请到 MP 后台【虚拟支付 → 交易订单】核对该单，并**人工回收**已发放的积分 / 会员时长' +
      '（本服务未实现自动回收；钱已退、权益仍在用户账上，属资金口径分叉）。',
  },
  xpay_complaint_notify: {
    severity: 'WARN',
    title: '虚拟支付收到用户投诉',
    hint: '请到 MP 后台查看投诉详情并在时限内处理 —— 超时未处理可能被平台处罚。',
  },
  xpay_coin_pay_notify: {
    severity: 'WARN',
    title: '收到代币支付事件，但本项目不使用代币',
    hint:
      '本项目只走「道具直购（short_series_goods）」，不该出现代币支付。' +
      '出现即说明有人走了代币通道 ⇒ 请核对 MP 后台的道具 / 代币配置是否被改动。',
  },
  xpay_subscribe_signing_result_notify: {
    severity: 'WARN',
    title: '收到会员订阅签约结果事件，但本项目未开通订阅（自动续费）',
    hint:
      '本项目的会员是「一次付 980 买 1095 天」＝单次购买，不该有签约。' +
      '请核对 MP 后台是否误把道具类型建成了「会员订阅道具」。',
  },
  xpay_subscribe_pay_fail_notify: {
    severity: 'WARN',
    title: '收到订阅扣费失败事件，但本项目未开通订阅（自动续费）',
    hint: '同上：本项目不该有自动续费 ⇒ 请核对 MP 后台的道具类型。',
  },
  xpay_subscribe_ios_refund_query_notify: {
    severity: 'CRITICAL',
    title: '收到 iOS 订阅退款问询，本服务不会处理（也不该出现）',
    hint:
      '官方要求该事件在 **3 秒内**按专属格式（`IosRefundQueryResponse`）应答，本服务未实现，' +
      'Apple 会因此拿到「不确定」；本项目未开通订阅 ⇒ 本不该出现。若确实出现请立刻人工介入。',
  },
}

type PayloadFormat = 'json' | 'xml'

interface NormalizedPush {
  event: string
  outTradeNo: string
  env: string
  openId: string
  productId: string
  attach: string
  /** 微信支付单号。非微信支付渠道（iOS Apple）可能没有 ⇒ 空串 */
  transactionId: string
  /** 实付（分）。缺失为 null */
  actualPrice: number | null
  /** 原价（分）。缺失为 null */
  origPrice: number | null
}

/** 把（可能是 XML 也可能是 JSON 的）原始报文统一成一个扁平结构。 */
function normalize(raw: string, format: PayloadFormat): NormalizedPush {
  const node: Record<string, unknown> = format === 'json'
    ? (JSON.parse(raw) as Record<string, unknown>)
    : parseWxXml(raw)
  const goods = xmlObj(node, 'GoodsInfo')
  const pay = xmlObj(node, 'WeChatPayInfo')
  const num = (v: string): number | null => (v === '' ? null : Number(v))
  return {
    event: xmlStr(node, 'Event'),
    outTradeNo: xmlStr(node, 'OutTradeNo'),
    env: xmlStr(node, 'Env'),
    openId: xmlStr(node, 'OpenId'),
    productId: xmlStr(goods, 'ProductId'),
    attach: xmlStr(goods, 'Attach'),
    // 微信支付单号。iOS 走 Apple 支付时这一整块可能缺席 —— 那就留空，
    // 结算时 `wx_transaction_id` 落 NULL（该列可空；MySQL 唯一索引允许多个 NULL）。
    transactionId: xmlStr(pay, 'TransactionId') || xmlStr(pay, 'MchOrderNo'),
    actualPrice: num(xmlStr(goods, 'ActualPrice')),
    origPrice: num(xmlStr(goods, 'OrigPrice')),
  }
}

/**
 * 报文里出现 `Encrypt` ⇒ 这条推送走了「消息推送」的**加密模式**。
 *
 * ★ 这是一个**极高概率**的接入事故，必须给出可执行的提示而不是一句「解析失败」：
 *   微信「消息推送」后台的加解密方式若选「安全模式」，推送体是 `<Encrypt>` 密文，
 *   需要 EncodingAESKey 才能解；而虚拟支付的发货推送地址若与消息推送共用同一处配置，
 *   就会撞上这个模式。此时我们**读不到 OutTradeNo** ⇒ 一单也发不出去。
 */
function isEncrypted(node: Record<string, unknown>): boolean {
  return typeof node.Encrypt === 'string' && node.Encrypt.trim() !== ''
}

/**
 * 成功应答 —— 必须是官方那一种：
 * `<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>`。
 *
 * ★ 官方《虚拟支付：个人》5.4.1 逐字给出上面这个应答体，并写明「返回 `0` 表示成功，
 *   否则平台会重试（最多 15 次）」。
 * ★ 这里原本回的是**纯文本 `success`** —— 那是**微信支付 APIv2 回调**的约定，
 *   被错搬到了虚拟支付这条消息推送底座上。平台不认 ⇒ 每条推送都被判「发货失败」
 *   并重推 15 次：`markOrderPaid` 的终态 CAS 保证了不会重复发货，但平台侧的
 *   「发货状态」会一直停在未发货（iOS 退款问询里的 `provide_status` 就取自它）。
 */
function ackSuccess(res: Response, format: PayloadFormat): void {
  if (format === 'json') {
    res.status(200).json({ ErrCode: 0, ErrMsg: 'success' })
    return
  }
  res
    .status(200)
    .type('application/xml; charset=utf-8')
    .send('<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>')
}

/** 失败应答：按推送格式回非零 ErrCode，让微信按其策略重推。 */
function ackFail(res: Response, format: PayloadFormat, message: string): void {
  const msg = message.slice(0, 200)
  if (format === 'json') {
    res.status(200).json({ ErrCode: -1, ErrMsg: msg })
    return
  }
  res
    .status(200)
    .type('application/xml; charset=utf-8')
    .send(`<xml><ErrCode>-1</ErrCode><ErrMsg><![CDATA[${msg.replace(/\]\]>/g, ']]&gt;')}]]></ErrMsg></xml>`)
}

/**
 * 「消息推送」接入校验的签名（经典算法；虚拟支付复用同一套消息推送底座）：
 *   `signature = sha1( sort([token, timestamp, nonce]).join('') )`
 * 只在配置了 `WX_VP_PUSH_TOKEN`（＝后台「令牌」）时才用得上。
 */
function calcPushSignature(token: string, timestamp: string, nonce: string): string {
  return crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
}

/**
 * 发货推送地址的**接入校验** —— 微信在保存配置 / 点「模拟推送」时会打这个 GET。
 *
 * ★ 为什么必须有它：后台保存 URL 时会先发一个 GET
 *   （`?signature=&timestamp=&nonce=&echostr=`），**原样返回 `echostr` 才算接入生效**。
 *   在本路由只挂 POST 时，这个 GET 会 404 ⇒ 后台判「配置无效」，
 *   于是后面那套发货逻辑写得再对也**一单都收不到**。
 *
 * ★ 签名校验是**可选加固**：配了 `WX_VP_PUSH_TOKEN`（与后台「令牌」一字不差）就严格比对；
 *   没配则原样回 `echostr` 并留一条 warn —— 先让配置能通过，不至于卡在这一步。
 *   （回 `echostr` 不泄露任何东西：攻击者拿到的是他自己发来的那个串。）
 */
router.get('/deliver', (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>
  const echostr = q.echostr ?? ''
  const token = (process.env.WX_VP_PUSH_TOKEN ?? '').trim()

  if (!echostr) {
    // 不是接入校验（或参数被剥掉了）：明确 400，别让它看起来像「已接通」
    console.warn('[xpay/deliver] GET 收到但缺少 echostr，按非接入校验处理')
    res.status(400).type('text/plain; charset=utf-8').send('missing echostr')
    return
  }

  if (token) {
    const expect = calcPushSignature(token, q.timestamp ?? '', q.nonce ?? '')
    if (expect !== (q.signature ?? '')) {
      console.warn('[xpay/deliver] GET 接入校验签名不匹配，已拒绝（核对 WX_VP_PUSH_TOKEN 与后台「令牌」）')
      res.status(403).type('text/plain; charset=utf-8').send('signature mismatch')
      return
    }
    console.log('[xpay/deliver] GET 接入校验通过（签名已核对）')
  } else {
    console.warn(
      '[xpay/deliver] GET 接入校验：未配置 WX_VP_PUSH_TOKEN ⇒ 未校验签名，直接回 echostr。' +
        '建议把后台「令牌」填进该环境变量以启用校验。',
    )
  }
  res.status(200).type('text/plain; charset=utf-8').send(echostr)
})

router.post('/deliver', async (req: Request, res: Response) => {
  // routes/xpay.ts 在 index.ts 中以 express.raw 挂载 ⇒ req.body 是 Buffer。
  // 兜一手：若上游改成了解析过的 body（对象），直接 stringify 回原文。
  const body = req.body as Buffer | Record<string, unknown> | undefined
  const raw = Buffer.isBuffer(body)
    ? body.toString('utf8')
    : typeof body === 'object' && body !== null
      ? JSON.stringify(body)
      : ''
  const trimmed = raw.trim()
  // 数据格式由「消息推送」后台决定：`{` 开头是 JSON，`<` 开头是 XML。
  const format: PayloadFormat = trimmed.startsWith('{') ? 'json' : 'xml'

  if (trimmed === '') {
    console.error('[xpay/deliver] 空报文')
    await raiseOpsAlert(prisma, {
      code: 'VP_DELIVER_BAD_PAYLOAD',
      severity: 'WARN',
      title: '虚拟支付发货推送收到空报文',
      detail: '收到一条内容为空的发货推送，无法解析。请核对「消息推送 / 发货推送」地址与数据格式配置。',
    })
    return ackFail(res, format, 'empty body')
  }

  let push: NormalizedPush
  try {
    const node: Record<string, unknown> = format === 'json'
      ? (JSON.parse(trimmed) as Record<string, unknown>)
      : parseWxXml(trimmed)
    if (isEncrypted(node)) {
      console.error('[xpay/deliver] 收到加密推送（Encrypt 字段存在）')
      await raiseOpsAlert(prisma, {
        code: 'VP_DELIVER_ENCRYPTED',
        severity: 'CRITICAL',
        title: '虚拟支付发货推送是加密报文，无法解析 ⇒ 一单也发不出去',
        detail:
          '发货推送体里出现了 `Encrypt` 字段，说明它走了微信「消息推送」的**安全模式**（密文）。' +
          '本服务没有实现 EncodingAESKey 解密 ⇒ 收到这类推送等于收不到任何发货信号。' +
          '处理：把发货推送地址单独配置（不要与「消息推送」共用），或把消息推送的加解密方式改为「明文模式」。',
      })
      return ackFail(res, format, 'encrypted push not supported')
    }
    push = normalize(trimmed, format)
  } catch (e) {
    console.error('[xpay/deliver] 报文解析失败:', (e as Error).message)
    await raiseOpsAlert(prisma, {
      code: 'VP_DELIVER_BAD_PAYLOAD',
      severity: 'WARN',
      title: '虚拟支付发货推送解析失败',
      detail:
        `解析异常：${(e as Error).message}。原文（前 500 字符）：${trimmed.slice(0, 500)}。` +
        '请核对「消息推送 / 发货推送」的数据格式是 XML 还是 JSON。',
    })
    return ackFail(res, format, 'parse failed')
  }

  // ── 报文不可识别：非零 + 告警 ────────────────────────────────────
  // ★ 与下面「别人的事件」必须分开：`Event` 为空说明**我们根本没读懂这条报文**
  //   （截断、编码不对、格式与配置不符）。此时 ACK 掉等于把一条可能真实的发货信号
  //   静默丢弃 —— 而那正是「钱收了、货没发」。
  if (push.event === '') {
    console.error('[xpay/deliver] 报文里读不到 Event 字段')
    await raiseOpsAlert(prisma, {
      code: 'VP_DELIVER_BAD_PAYLOAD',
      severity: 'WARN',
      title: '虚拟支付发货推送无法识别（读不到 Event），已要求重推',
      detail:
        '报文里没有 `Event` 字段 ⇒ 大概率是格式不符（消息推送后台的数据格式与推送体不一致）' +
        `或被截断。原文（前 500 字符）：${trimmed.slice(0, 500)}。`,
    })
    return ackFail(res, format, 'unrecognizable payload')
  }

  // ── 不是发货事件：一律 ACK，但「我们业务上关心」的要留痕 ─────────────
  // ★ 这个地址就是微信「消息推送」的地址 ⇒ 会收到用户消息、订阅事件等**其它**事件。
  //   必须 ACK —— 回非零会让微信把这批无关消息重推 15 次。
  // ★★ 但「ACK」不等于「装作没看见」：退款 / 投诉这类事件里藏着资金与合规风险，
  //   必须落一条告警，见 VP_UNHANDLED_EVENTS。
  if (push.event !== VP_DELIVER_EVENT) {
    const unhandled = VP_UNHANDLED_EVENTS[push.event]
    if (!unhandled) {
      // 真的与我们无关（用户消息 / 其它订阅事件）：一行日志即可。
      console.log(`[xpay/deliver] 忽略无关事件 Event=${push.event}`)
      return ackSuccess(res, format)
    }
    console.error(`[xpay/deliver] 收到未处理的事件 Event=${push.event} order=${push.outTradeNo || '-'}`)
    await raiseOpsAlert(prisma, {
      code: 'VP_EVENT_UNHANDLED',
      severity: unhandled.severity,
      title: unhandled.title,
      detail:
        `事件 ${push.event}（Env=${push.env || '-'}，订单号 ${push.outTradeNo || '（报文未给）'}，` +
        `用户 ${push.openId || '-'}，道具 ${push.productId || '-'}，` +
        `实付 ${push.actualPrice ?? '?'} 分，交易号 ${push.transactionId || '-'}）。` +
        unhandled.hint,
      refType: 'order',
      refId: push.outTradeNo || undefined,
      // 同一事件 + 同一订单只留一条：微信会重推，退款/投诉本身也可能反复推。
      dedupeKey: `VP_EVENT_UNHANDLED:${push.event}:${push.outTradeNo || push.openId || 'unknown'}`,
    })
    return ackSuccess(res, format)
  }

  // ── 环境不符：ACK + 告警 ─────────────────────────────────────────
  // 沙箱推送打到现网（或反之）。重推改变不了任何事，但要让人知道配置串了。
  const ourEnv = String(vpEnv())
  if (push.env !== '' && push.env !== ourEnv) {
    console.warn(`[xpay/deliver] 环境不符 push.Env=${push.env} 本环境=${ourEnv}`)
    await raiseOpsAlert(prisma, {
      code: 'VP_DELIVER_ENV_MISMATCH',
      severity: 'WARN',
      title: '虚拟支付发货推送的环境与本服务不一致，已忽略',
      detail:
        `推送携带 Env=${push.env}，本服务 WX_VP_ENV=${ourEnv}（0 现网 / 1 沙箱），订单号 ${push.outTradeNo}。` +
        '该推送不处理（重推也不会变），请核对是否把沙箱/现网的推送地址配成了同一个。',
      refType: 'order',
      refId: push.outTradeNo || undefined,
      dedupeKey: `VP_DELIVER_ENV_MISMATCH:${push.env}:${ourEnv}`,
    })
    return ackSuccess(res, format)
  }

  if (!push.outTradeNo) {
    console.error('[xpay/deliver] 报文缺少 OutTradeNo')
    await raiseOpsAlert(prisma, {
      code: 'VP_DELIVER_BAD_PAYLOAD',
      severity: 'WARN',
      title: '虚拟支付发货推送缺少业务订单号',
      detail: `报文里没有 OutTradeNo，无法定位订单。原文（前 500 字符）：${trimmed.slice(0, 500)}。`,
    })
    return ackFail(res, format, 'missing OutTradeNo')
  }

  // ── 定位订单 + 校验「这笔钱换的确实是这个道具」────────────────────
  const order = await prisma.order.findUnique({
    where: { orderNo: push.outTradeNo },
    select: { orderNo: true, orderType: true, refId: true, merchantId: true, amountFen: true, status: true },
  })
  if (!order) {
    // 本地没有这张单 ⇒ 不是在给我们的推送（换过库 / 另一套环境 / 误配地址）。
    // 回非零让微信重推几轮（万一是极短暂的写读竞态），同时留告警。
    console.error(`[xpay/deliver] 订单不存在 order=${push.outTradeNo}`)
    await raiseOpsAlert(prisma, {
      code: 'VP_DELIVER_ORDER_NOT_FOUND',
      severity: 'CRITICAL',
      title: '虚拟支付发货推送指向一张本地不存在的订单',
      detail:
        `收到订单号 ${push.outTradeNo} 的发货推送（道具 ${push.productId}，实付 ${push.actualPrice ?? '?'} 分，` +
        `attach=${push.attach || '-'}），但本地查无此单。` +
        '可能原因：推送地址配到了另一套环境/另一个库、或该单被清理过。' +
        '**若这笔钱是真的，用户付了钱却永远不会发货** —— 请立即人工核对。',
      refType: 'order',
      refId: push.outTradeNo,
      dedupeKey: `VP_DELIVER_ORDER_NOT_FOUND:${push.outTradeNo}`,
    })
    return ackFail(res, format, 'order not found')
  }

  // 期望的道具 ID（与 order.service.ts 下单时用的是同一对映射函数，避免两处各写一份）
  const expectedProductId =
    order.orderType === 'BEAN'
      ? await beanProductIdForOrder(order.refId)
      : order.orderType === 'MEMBER'
        ? await memberProductIdForOrder(order.refId)
        : ''
  if (expectedProductId && push.productId && push.productId !== expectedProductId) {
    console.error(
      `[xpay/deliver] 道具不符 order=${order.orderNo} 期望=${expectedProductId} 推送=${push.productId}`,
    )
    await raiseOpsAlert(prisma, {
      code: 'VP_DELIVER_PRODUCT_MISMATCH',
      severity: 'CRITICAL',
      title: '虚拟支付发货推送的道具与本地订单不符，已拒绝发货',
      detail:
        `订单 ${order.orderNo}（本地 ${order.amountFen} 分 / ${order.orderType}）期望道具 ${expectedProductId}，` +
        `推送却是 ${push.productId}。拒绝结算以防「用小额道具的付款换走大额权益」。` +
        '常见原因：MP 后台的道具 ID 与本地套餐对不上（见 lib/xpay.ts 的 VP_PRODUCT_CONTRACT）。',
      refType: 'order',
      refId: order.orderNo,
      dedupeKey: `VP_DELIVER_PRODUCT_MISMATCH:${order.orderNo}`,
    })
    return ackFail(res, format, 'product mismatch')
  }

  // ── 金额校验（与 JSAPI 的 handleNotify 同口径：不一致就拒绝结算）──
  // 优先比对「实付」（ActualPrice）；报文没给实付时退回「原价」（OrigPrice）。
  const paidFen = push.actualPrice ?? push.origPrice
  if (paidFen !== null && paidFen !== order.amountFen) {
    console.error(
      `[xpay/deliver] 金额不符 order=${order.orderNo} 本地=${order.amountFen} 推送=${paidFen}`,
    )
    await raiseOpsAlert(prisma, {
      code: 'PAY_AMOUNT_MISMATCH',
      severity: 'CRITICAL',
      title: '虚拟支付推送金额与本地订单不一致，已拒绝结算',
      detail:
        `订单 ${order.orderNo}：推送实付 ${paidFen} 分（原价 ${push.origPrice ?? '?'} 分），本地订单 ${order.amountFen} 分。` +
        '已按「拒绝结算」处理（防止用错误金额发放权益），该单会一直停在待支付直到人工介入。' +
        `微信交易号 ${push.transactionId || '-'}。`,
      refType: 'order',
      refId: order.orderNo,
      // ★ 与 handleNotify / pay-reconcile 用**同一个**去重键：三条通道谁先发现都只留一条告警
      dedupeKey: `PAY_AMOUNT_MISMATCH:${order.orderNo}`,
    })
    return ackFail(res, format, 'amount mismatch')
  }

  // ── 发货 ────────────────────────────────────────────────────────
  // ★ 幂等交给 markOrderPaid 的终态 CAS：本地已 PAID 时它直接 return（不重复发权益），
  //   这正是微信重推 15 次、以及推送与查单并发时要依赖的行为。
  // ★ 结算来源仍记 `NOTIFY` —— 这条推送在语义上就是「微信告诉我们付款成功了」，
  //   与 JSAPI 的异步回调同族；通道差异由日志与 wxTransactionId 体现。
  await orderSvc.markOrderPaid(prisma, order.orderNo, push.transactionId || null, false, undefined, 'NOTIFY')
  console.log(
    `[xpay/deliver] 已处理 order=${order.orderNo} 道具=${push.productId} 实付=${paidFen ?? '?'}分 ` +
      `attach=${push.attach || '-'} 本地状态=${order.status} 交易号=${push.transactionId || '-'} 用户=${push.openId || '-'}`,
  )
  return ackSuccess(res, format)
})

// ── 订单 → 期望道具 ID（在两个套餐表里查，失败返回 '' 表示「无法判定」）──
// ★ 查不到时返回 ''（而不是抛错）：宁可不校验道具、也要把**金额**这条更硬的判据走完，
//   让订单能正常发货；「套餐被删了」这类异常另有日志（当前 markOrderPaid 也会因
//   找不到 refId 而失败并告警）。这里不制造第二条静默路径。

async function beanProductIdForOrder(refId: bigint): Promise<string> {
  const pkg = await prisma.beanPackage.findUnique({ where: { id: refId }, select: { beans: true } })
  return pkg ? beanProductId(pkg.beans) : ''
}

async function memberProductIdForOrder(refId: bigint): Promise<string> {
  const pkg = await prisma.memberPackage.findUnique({ where: { id: refId }, select: { code: true } })
  return pkg ? memberProductId(pkg.code) : ''
}

export default router
