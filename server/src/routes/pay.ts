// 微信支付回调（免鉴权，公网可访问）
// 微信会 POST 原始 JSON（含 resource 密文）到 WX_PAY_NOTIFY_URL
// 注意：本路由在 index.ts 中以 express.raw 挂载，req.body 为 Buffer（原始报文）
import { Router } from 'express'
import { prisma } from '../db.js'
import { ok, fail } from '../lib/result.js'
import * as orderSvc from '../services/order.service.js'
import { verifyNotify, wxpayEnabled } from '../lib/wxpay.js'

const router = Router()

router.post('/notify', async (req, res) => {
  try {
    const rawBody = (req.body as Buffer).toString('utf8')
    const verified = verifyNotify(req.headers as Record<string, string | undefined>, rawBody)
    // 配置了平台证书且真实支付开启时，必须验签通过；dev（无证书）放行
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
