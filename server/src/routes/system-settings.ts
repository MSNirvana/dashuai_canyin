// 公开系统配置：小程序端启动时拉取，用于客户端 UI/限额常量
// 仅返回 isPublic=1 的项；分组用于前端折叠展示
import { Router } from 'express'
import { prisma } from '../db.js'
import { ok, fail } from '../lib/result.js'

const router = Router()

router.get('/', async (_req, res) => {
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { isPublic: true },
      orderBy: [{ groupKey: 'asc' }, { sort: 'asc' }, { settingKey: 'asc' }],
      select: {
        groupKey: true,
        settingKey: true,
        settingVal: true,
        valueType: true,
        displayName: true,
        sort: true,
      },
    })
    // 分组返回，便于前端折叠（其实平铺也行，这里默认折叠更友好）
    const grouped: Record<string, Array<{
      key: string
      value: string | number | boolean | null
      valueType: string
      displayName: string
    }>> = {}
    for (const r of rows) {
      const v = coerceValue(r.settingVal, r.valueType)
      if (!grouped[r.groupKey]) grouped[r.groupKey] = []
      grouped[r.groupKey]!.push({
        key: r.settingKey,
        value: v,
        valueType: r.valueType,
        displayName: r.displayName,
      })
    }
    ok(res, { updatedAt: new Date().toISOString(), groups: grouped })
  } catch {
    return fail(res, 500, '查询失败', 500)
  }
})

function coerceValue(v: string, t: string): string | number | boolean | null {
  if (t === 'INT' || t === 'DECIMAL') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  if (t === 'BOOL') return v === 'true' || v === '1'
  if (t === 'JSON') {
    try {
      const parsed = JSON.parse(v) as unknown
      // 简化为字符串返回，避免深类型在分组中传递复杂对象
      return parsed == null ? null : typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean' ? parsed : JSON.stringify(parsed)
    } catch {
      return null
    }
  }
  return v
}

export default router
