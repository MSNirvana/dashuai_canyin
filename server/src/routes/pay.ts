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
    return fail(res, 500, r.message ?? '处理失败', 500)
  } catch (e) {
    return fail(res, 500, (e as Error).message, 500)
  }
})

export default router
