// 合成任务在后台的共用类型与文案。
//
// 为什么单独一份：同一个「任务行」现在有两个页面在展示 ——
// 「合成任务」（全档位）与「精品接单」（只做 PREMIUM 的人工工作台）。
// 两份各自维护一份 STATUS_LABELS / slaLeft 的话，早晚出现
// 「一个页面把 SLA_TIMEOUT 显示成 SLA_TIMEOUT、另一个显示成已超时」这种
// 同一份数据两种说法的偏差，而这类偏差不会有任何报错。
import dayjs from 'dayjs'

export interface RenderRow {
  id: string
  merchantId: string
  status: string
  grade: string
  progress: number
  beanCharged: string
  cacheHit: boolean
  durationMs: number | null
  errorCode: string | null
  errorMsg: string | null
  createdAt: string
  finishAt: string | null
  assignedAt: string | null
  deadlineAt: string | null
  merchant: { phone: string; nickname: string | null } | null
}

/** 素材清单的一行（`GET /render/tasks/:id/materials`） */
export interface Material {
  seq: number
  shotId: string
  line: string | null
  trimStartMs: number
  trimEndMs: number | null
  durationMs: number | null
  cosKey: string
  playUrl: string | null
}

export type TagTheme = 'default' | 'success' | 'warning' | 'danger' | 'primary'

export const STATUS_COLORS: Record<string, TagTheme> = {
  QUEUED: 'default',
  RUNNING: 'warning',
  SUCCESS: 'success',
  FAILED: 'danger',
  TIMEOUT: 'danger',
  // SLA_TIMEOUT 是精品超时退款后的终态，和 TIMEOUT 一样该是红的；
  // 列表页的状态下拉用它做选项，这里必须同时登记（见 STATUS_LABELS 的注释）
  SLA_TIMEOUT: 'danger',
  CANCELLED: 'default',
  MANUAL_PENDING: 'primary',
  MANUAL_DOING: 'primary',
}

export const STATUS_LABELS: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '合成中',
  SUCCESS: '已完成',
  FAILED: '失败',
  TIMEOUT: '超时',
  // ⚠ SLA_TIMEOUT 是**独立**状态码，不是 TIMEOUT 的别名：精品超时退款走的是它。
  //   漏登记的话页面上会直接把英文码显示给运营（`STATUS_LABELS[s] ?? s`）。
  SLA_TIMEOUT: '超时退款',
  CANCELLED: '已取消',
  MANUAL_PENDING: '待接单',
  MANUAL_DOING: '剪辑中',
}

export const GRADE_LABELS: Record<string, string> = { BASIC: '基础', AI: 'AI', PREMIUM: '精品' }

/**
 * 精品接单的语义视图。
 *
 * 「进行中」= 待接单 + 剪辑中。这是剪辑师每天真正要看的那一格（「手上还有活吗」），
 * 所以给「精品接单」页做默认视图；其余选项是围着它展开的。
 * ⚠ 这两个状态码与 `render/premium.ts` 的状态机、以及 premium-delivery.service.ts 的
 *   DELIVERABLE_STATUSES 必须一致 —— 三处任一处漂了，都会表现为
 *   「列表里点的到、但操作被拒」或者「能操作但传素材被拒」。
 */
export const PREMIUM_ACTIVE_STATUSES = ['MANUAL_PENDING', 'MANUAL_DOING'] as const

/** 终态（交付完成 / 失败退款 / 超时退款）——这些行不该再出现在「进行中」里 */
export const PREMIUM_DONE_STATUSES = ['SUCCESS', 'FAILED', 'SLA_TIMEOUT'] as const

/** SLA 剩余时间的人类写法；没有截止时间（非精品 / 已终态）返回 `—` */
export function slaLeft(deadlineAt: string | null): string {
  if (!deadlineAt) return '—'
  const hours = dayjs(deadlineAt).diff(dayjs(), 'hour', true)
  if (hours < 0) return '已超时'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`
  return `${Math.round(hours)} 小时`
}

/** 这一行是否还能做「交付 / 传素材」这类动作 */
export function isPremiumActionable(row: RenderRow): boolean {
  return (
    row.grade === 'PREMIUM' &&
    (row.status === 'MANUAL_PENDING' || row.status === 'MANUAL_DOING')
  )
}
