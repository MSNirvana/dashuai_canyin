// 上传路由：取 STS 临时密钥 + 上传完成确认
import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as uploadSvc from '../services/upload.service.js'
import {
  extensionForUpload,
  isLocalStorage,
  localPathForKey,
  localStorageRoot,
  removeLocalFile,
} from '../lib/local-storage.js'

const router = Router()
router.use(auth)

const localUpload = multer({
  dest: join(localStorageRoot(), '.incoming'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
})

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
  try {
    const c = await uploadSvc.getSts(req.merchantId!)
    ok(res, c)
  } catch (e) {
    console.error('[upload] 获取存储凭证失败:', e)
    fail(res, 500, '对象存储未配置', 503)
  }
})

/** 本地开发上传：multipart file → server/storage/uploads/{merchantId}/... */
router.post('/local', localUpload.single('file'), async (req, res) => {
  const file = req.file
  if (!isLocalStorage()) {
    if (file) await removeLocalFile(file.path)
    return fail(res, 400, '当前未启用本地存储', 400)
  }
  if (!file) return fail(res, 3001, '缺少上传文件', 400)

  let finalPath = ''
  try {
    const input = z.object({
      storeId: z.string().min(1),
      type: z.enum(['VIDEO', 'IMAGE']),
      width: z.coerce.number().int().optional(),
      height: z.coerce.number().int().optional(),
      durationMs: z.coerce.number().int().optional(),
    }).parse(req.body)
    const key = `uploads/${req.merchantId!.toString()}/${Date.now()}_${randomUUID().replaceAll('-', '')}${extensionForUpload(file.originalname, input.type)}`
    finalPath = localPathForKey(key)
    await mkdir(dirname(finalPath), { recursive: true })
    await rename(file.path, finalPath)
    const asset = await uploadSvc.confirmUpload(prisma, req.merchantId!, {
      cosKey: key,
      storeId: BigInt(input.storeId),
      type: input.type,
      sizeBytes: file.size,
      width: input.width,
      height: input.height,
      durationMs: input.durationMs,
    })
    return ok(res, asset)
  } catch (e) {
    await removeLocalFile(finalPath || file.path)
    if (e instanceof z.ZodError) return fail(res, 400, '上传参数错误', 400)
    if (e instanceof uploadSvc.UploadPrefixError || e instanceof uploadSvc.UploadStoreMismatchError)
      return fail(res, 2008, (e as Error).message, 400)
    console.error('[upload] 本地上传失败:', e)
    return fail(res, 400, '上传失败', 400)
  }
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
