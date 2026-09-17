// 个人资料路由（个人主页）：昵称 / 头像 —— **商户级**，与门店无关。
//
// 为什么另开一个路由文件，而不是塞进 routes/account.ts：
//   account.ts 的文件头写着「全部只读，不影响余额」，是账户**查询**路由；
//   本路由要写 merchant 表，混进去会让那个契约失效（后来人按注释理解就会踩坑）。
//
// 为什么不复用 upload.ts：
//   那里的 /upload/complete 走 media_asset（storeId 必填、计存储配额、ownerType 只有
//   CREATION/STORE/DISH）。头像是商户级的、可能一张门店都还没有，硬塞会污染素材池与空间条。
import type { Request } from 'express'
import { join } from 'node:path'
import { z } from 'zod'
import multer from 'multer'
import { createRouter } from '../lib/async-router.js'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import { nullableText } from '../lib/validators.js'
import { localStorageRoot } from '../lib/local-storage.js'
import * as profileSvc from '../services/profile.service.js'

const router = createRouter()
router.use(auth)

// 与 upload.ts 同一个中转目录；体积上限交给 multer，超限的文件根本不会落盘
const avatarUpload = multer({
  dest: join(localStorageRoot(), '.incoming'),
  limits: { fileSize: profileSvc.AVATAR_MAX_BYTES },
})

// export 出去是为了让 profile:verify 直接拿**线上同一份** schema 做契约测试，
// 而不是在测试里手抄一遍长度上限（手抄必然漂移）
export const profilePatch = z.object({
  // 传 null 或 "" 都表示「清空昵称」（展示时回落到手机号），见 profile.service 的归一化
  nickname: nullableText(20),
  // 对象键是**存储标识**：前后空格属于键本身，trim 会指向另一个对象，所以刻意不 trim
  avatarKey: z.string().max(512).optional(),
})

/**
 * 本地存储模式下签名 URL 必须指回 `/api/v1/media/file`，而不是本路由前缀 ——
 * media.service 只是拿 baseUrl 拼字符串，给错了会得到 404 的头像地址。
 */
function mediaBaseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? ''}/api/v1/media`
}

/**
 * 包一层是为了把 multer 的错误（超限、字段名不对）转成 400。
 * multer 的 `single()` 是用 `next(err)` 报错的，不拦的话会一路走到全局 errorHandler，
 * 变成「服务器内部错误」(5001/500) —— 用户看到 500 完全不知道是自己图片太大。
 */
function uploadAvatar(req: Request, res: Parameters<typeof fail>[0], next: (err?: unknown) => void): void {
  avatarUpload.single('file')(req, res, (err: unknown) => {
    if (!err) return next()
    const tooLarge = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
    fail(
      res,
      400,
      tooLarge
        ? `头像不能超过 ${Math.round(profileSvc.AVATAR_MAX_BYTES / 1024 / 1024)}MB`
        : '头像上传失败，请重试',
      400,
    )
  })
}

/** GET /profile/me — 当前商户资料（头像回的是**现签**的展示地址，1 小时过期） */
router.get('/me', async (req, res) => {
  ok(res, await profileSvc.getProfile(prisma, req.merchantId!, mediaBaseUrl(req)))
})

/** PATCH /profile/me — 改昵称 / 头像。`nickname: null` 或 `""` = 清空 */
router.patch('/me', async (req, res) => {
  try {
    const input = profilePatch.parse(req.body)
    ok(res, await profileSvc.updateProfile(prisma, req.merchantId!, input, mediaBaseUrl(req)))
  } catch (e) {
    // 只吞「越权引用别人的对象」这一种业务错，其余（zod 4000、非法对象键 4000）交给全局映射
    if (e instanceof profileSvc.AvatarKeyNotOwnedError) return fail(res, 2008, e.message, 400)
    throw e
  }
})

/** POST /profile/avatar — multipart 上传头像本体，写库后返回最新资料 */
router.post('/avatar', uploadAvatar, async (req, res) => {
  const file = req.file
  if (!file) return fail(res, 3001, '缺少上传文件', 400)
  try {
    ok(
      res,
      await profileSvc.saveAvatarUpload(
        prisma,
        req.merchantId!,
        { path: file.path, size: file.size },
        mediaBaseUrl(req),
      ),
    )
  } catch (e) {
    if (e instanceof profileSvc.AvatarKeyNotOwnedError) return fail(res, 2008, e.message, 400)
    if (e instanceof profileSvc.AvatarTooLargeError || e instanceof profileSvc.AvatarNotImageError) {
      return fail(res, 400, e.message, 400)
    }
    console.error('[profile] 头像上传失败:', e)
    return fail(res, 500, '头像上传失败', 500)
  }
})

export default router
