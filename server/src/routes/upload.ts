// 上传路由：取 STS 临时密钥 + 上传完成确认
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as uploadSvc from '../services/upload.service.js'

const router = Router()
router.use(auth)

const confirmInput = z.object({
  cosKey: z.string().min(1).max(512),
  storeId: z.string().min(1),
  type: z.enum(['VIDEO', 'IMAGE']),
  sizeBytes: z.number().int().min(0),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  durationMs: z.number().int().optional(),
})

router.post('/sts', async (req, res) => {
  const c = await uploadSvc.getSts(req.merchantId!)
  ok(res, c)
})

router.post('/complete', async (req, res) => {
  try {
    const input = confirmInput.parse(req.body)
    const asset = await uploadSvc.confirmUpload(prisma, req.merchantId!, {
      ...input,
      storeId: BigInt(input.storeId),
    })
    ok(res, asset)
  } catch (e) {
    if (e instanceof uploadSvc.UploadPrefixError || e instanceof uploadSvc.UploadStoreMismatchError)
      fail(res, 2008, (e as Error).message, 400)
    else fail(res, 400, '上传确认失败', 400)
  }
})

export default router
