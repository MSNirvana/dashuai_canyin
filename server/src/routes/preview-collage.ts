// 免费首帧拼图预览：POST /api/v1/render/preview-collage
// 不扣豆、不写 render_task；返回每个分镜的"首帧可访问 URL"，前端按 N 列网格渲染
// 真实环境的"拼图合成"（ffmpeg tile 多帧图像为一张大图）属于进阶能力，
// 当前实现：返回结构化清单，由前端组件按列布局组装展示，已满足"提交合成前先看一眼"诉求
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { auth } from '../middleware/auth.js'
import { ok, fail } from '../lib/result.js'
import * as mediaSvc from '../services/media.service.js'
import { getCreation, CreationNotFoundError } from '../services/creation.service.js'

const router = Router()
router.use(auth)

const input = z.object({ creationId: z.string().min(1) })

/** 一个分镜的预览项：前 1 帧（封面）私有签名 URL */
interface ShotPreviewItem {
  shotId: string
  seq: number
  title: string | null
  url: string | null
  dev: boolean
}

interface PreviewCollageView {
  creationId: string
  shots: ShotPreviewItem[]
  dev: boolean
  /** 提示前端如何在网格中布局（向上取整为列数，建议 3 列起步） */
  layout: { cols: number; rows: number }
}

router.post('/preview-collage', async (req, res) => {
  try {
    const { creationId } = input.parse(req.body)
    const c = await getCreation(prisma, req.merchantId!, BigInt(creationId))
    const shots = await prisma.shot.findMany({
      where: { creationId: c.id },
      orderBy: { seq: 'asc' },
      include: { /* nothing else needed */ },
    })

    // 计算每个 shot 的预览帧 URL（按 coverKey 优先；没有 coverKey 的跳过）
    const items: ShotPreviewItem[] = []
    let devAll = true
    for (const s of shots) {
      if (!s.assetId) continue
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: s.assetId, deletedAt: null },
        select: { coverKey: true, cosKey: true },
      })
      if (!asset) continue
      // 优先用 coverKey（OSS 抓的缩略图），没有就用 cosKey（让前端用 <image> 截一帧）
      const key = asset.coverKey ?? asset.cosKey
      if (!key) continue
      try {
        const url = await mediaSvc.getPlayUrlByKey(
          req.merchantId!,
          key,
          `${req.protocol}://${req.get('host')}/api/v1/media`,
        )
        items.push({
          shotId: s.id.toString(),
          seq: s.seq,
          title: s.line ? s.line.slice(0, 30) : null,
          url: url.url,
          dev: url.dev,
        })
        if (!url.dev) devAll = false
      } catch {
        // 该分镜的预览帧不可用则跳过（不影响其他分镜）
        continue
      }
    }

    const cols = Math.min(items.length, 3) || 1
    const rows = Math.ceil(items.length / cols) || 0
    const view: PreviewCollageView = {
      creationId: c.id.toString(),
      shots: items,
      dev: devAll,
      layout: { cols, rows },
    }
    ok(res, view)
  } catch (e) {
    if (e instanceof z.ZodError) return fail(res, 400, '参数错误', 400)
    if (e instanceof CreationNotFoundError) return fail(res, 4046, '创作不存在', 404)
    return fail(res, 500, '预览失败', 500)
  }
})

export default router
