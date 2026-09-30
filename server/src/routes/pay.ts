// 微信支付回调（免鉴权，公网可访问）
// 微信会 POST 原始 JSON（含 resource 密文）到 WX_PAY_NOTIFY_URL
// 注意：本路由在 index.ts 中以 express.raw 挂载，req.body 为 Buffer（原始报文）
import { createRouter } from '../lib/async-router.js'
import { prisma } from '../db.js'
import { ok, fail } from '../lib/result.js'
import * as orderSvc from '../services/order.service.js'
import { verifyNotify, wxpayEnabled, describeNotifySerial } from '../lib/wxpay.js'

const router = createRouter()

router.post('/notify', async (req, res) => {
  try {
    const rawBody = (req.body as Buffer).toString('utf8')
    const serial = req.headers['wechatpay-serial'] as string | undefined
    // 记录微信侧声明的签名钥匙标识。**只记录不拒绝** —— 灰度期该头可能返回平台证书
    // 序列号而非公钥 ID，据此拒绝会把合法回调误判为伪造（用户付了钱拿不到积分）。
    console.log(`[pay/notify] 收到回调 ${describeNotifySerial(serial)}`)
    const verified = verifyNotify(req.headers as Record<string, string | undefined>, rawBody)
    // 配置了微信侧验签凭据且真实支付开启时，必须验签通过；dev（无凭据）放行
    if (wxpayEnabled && !verified) {
      return fail(res, 401, '签名校验失败', 401)
    }
    const r = await orderSvc.handleNotify(prisma, rawBody)
    if (r.code === 'SUCCESS') return ok(res, { code: 'SUCCESS' })
    /**
     * ★ 不要把内部 message 原样回给调用方。
     *   这个接口**免鉴权、公网可访问**，而 r.message 可能夹带 Prisma/MySQL 错误、
     *   环境变量名、内部订单状态或第三方接口细节。内部细节只落日志，
     *   对微信固定回一句「处理失败」，让它按自己的重试策略重发即可。
     */
    console.error('[pay/notify] 处理失败:', r.message)
    return fail(res, 500, '处理失败', 500)
  } catch (e) {
    console.error('[pay/notify] 异常:', e)
    return fail(res, 500, '处理失败', 500)
  }
})

export default router
