import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from './http'

/**
 * 运维告警的数据层。
 *
 * 服务端一年前只有「落库 + 企业微信 webhook」两个出口（见 deploy/支付风控告警-运维说明.md）。
 * 问题在于：**没配 webhook 就等于没人看得见** —— 而告警里最要紧的那几条
 * （扣款成功但开通失败 / 已支付却没有结算回执）恰恰是真金白银。
 * 所以后台补上这一页：不依赖任何外部渠道，登录后台就能看到未处理告警。
 *
 * ★ 这里**不重复维护「告警码 → 含义」的映射表**。
 *   服务端的 `raiseOpsAlert()` 已经在写库时把 title 写成了人话
 *   （如「窗口外订单取证失败：可能已收款但无法开通，需人工核对」），
 *   再在前端抄一份映射，改一处漏一处就会出现「页面上说的和实际报的不是一回事」。
 *   前端只负责把 `severity` 翻译成颜色、把 `pushStatus` 翻译成「有没有推到手机」。
 */

export type OpsAlertSeverity = 'CRITICAL' | 'WARN'

/** OPEN = 未处理（默认）；ACKED = 已处理；ALL = 全部 */
export type OpsAlertStatus = 'OPEN' | 'ACKED' | 'ALL'

/** 处理/新增告警后广播的窗口事件名（页 ↔ 顶栏角标解耦，见 notifyOpsAlertsChanged） */
const OPS_ALERTS_CHANGED = 'ops-alerts:changed'

export interface OpsAlertView {
  id: string
  code: string
  severity: OpsAlertSeverity
  title: string
  detail: string | null
  /** 关联对象（如 ORDER / RENDER），用于人肉回查是哪一笔 */
  refType: string | null
  refId: string | null
  /** 去重窗口内累计触发次数。≥2 说明不是偶发，是持续故障 */
  occurrences: number
  firstSeenAt: string
  lastSeenAt: string
  pushStatus: string
  pushError: string | null
  ackedAt: string | null
  ackedBy: string | null
  ackNote: string | null
}

export interface OpsAlertList {
  items: OpsAlertView[]
  /** ★ 未处理总数。****注意：它恒等于「未处理告警的总数」，与 status/severity 筛选无关** ——
   *  服务端是 `count({ ackedAt: null })`，方便在任何视图下都能看到「还有多少没处理」。 */
  openCount: number
}

export function fetchOpsAlerts(params: {
  status?: OpsAlertStatus
  code?: string
  severity?: OpsAlertSeverity
  limit?: number
  /** 常驻轮询用：失败不弹 toast（原因见 useOpsAlertSummary）。silent 不参与查询参数 */
  silent?: boolean
}): Promise<OpsAlertList> {
  const { silent, ...query } = params
  return request<OpsAlertList>({ url: '/ops-alerts', params: query, silent })
}

export function ackOpsAlert(id: string, note?: string): Promise<unknown> {
  // 空备注就不传这个键 —— 服务端是 `z.string().max(255).optional()`，
  // 传 `{ note: '' }` 也能过，但库里会留下一个空字符串，与「没写备注」难以区分。
  return request({
    url: `/ops-alerts/${id}/ack`,
    method: 'POST',
    data: note && note.trim() ? { note: note.trim() } : {},
  })
}

/** `CRITICAL` → 中文。只有 CRITICAL/WARN 两种取值（服务端写死） */
export function severityText(sev: string): string {
  return sev === 'CRITICAL' ? '严重' : '警告'
}

/**
 * 推送状态 → 人话。★ 这里必须说清「有没有到手机」，因为运营的所有动作都基于这一点：
 *   · 后台能看到 ⇒ 到不了手机也不影响处理，但不能让人以为「没看到就是没发生」。
 *   · `SKIPPED` 的 `pushError` 是原因（未配置 OPS_ALERT_WEBHOOK / 每分钟推送上限），
 *     两者处置完全不同：前者要去配机器人，后者等下一轮就行 —— 所以要把原因透出来。
 */
export function pushStatusText(pushStatus: string, pushError: string | null): string {
  switch (pushStatus) {
    case 'SENT':
      return '已推到手机'
    case 'FAILED':
      return `推送失败${pushError ? `（${pushError}）` : ''}`
    case 'SKIPPED':
      return `未推送${pushError ? `（${pushError}）` : '（未配置推送渠道）'}`
    case 'PENDING':
      return '推送中'
    default:
      return pushStatus || '—'
  }
}

/** 处理/新增告警后广播一次，让顶栏角标立刻跟上（否则要等下一轮 60s 轮询） */
export function notifyOpsAlertsChanged(): void {
  window.dispatchEvent(new Event(OPS_ALERTS_CHANGED))
}

export interface OpsAlertSummary {
  /** 未处理总数（服务端给的权威值） */
  open: number
  /** 其中 CRITICAL 的条数。★ 由已拉回的列表里数出来的，列表被 limit 截断时**只是下限** */
  critical: number
  /** 已经成功拉到过一次数据（用于区分「确实没有告警」与「还没查」） */
  loaded: boolean
  reload: () => void
}

/**
 * 顶栏与菜单角标用的轻量轮询。
 *
 * ★ 三个刻意的取舍：
 *  1. `silent: true` —— 轮询失败**不弹 toast**。http 拦截器默认每次失败都弹，
 *     而这里是每 60s 一次的常驻请求：后端一挂，运营就会每分钟被弹一次，
 *     最后的结果是把整个后台的消息关掉，连真正的报错也看不见了。
 *     失败时静默保留上一次的数字（宁可是旧的，也不要 0 —— 0 会被读成「已经没事了」）。
 *  2. 拉 `limit: 200` 而不是只拉 1 条：这样能顺带数出 CRITICAL 的条数，
 *     顶栏横幅才能区分「有钱卡住了」和「只是通道抖动」。
 *  3. 页面不可见时不轮询（`visibilitychange`）：后台长期开在某个标签页里是常态，
 *     没人看的页面没必要每分钟打一次接口。
 */
export function useOpsAlertSummary(intervalMs = 60_000): OpsAlertSummary {
  const [open, setOpen] = useState(0)
  const [critical, setCritical] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const aliveRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const r = await fetchOpsAlerts({ status: 'OPEN', limit: 200, silent: true })
      if (!aliveRef.current) return
      setOpen(r?.openCount ?? 0)
      setCritical((r?.items ?? []).filter((a) => a.severity === 'CRITICAL').length)
      setLoaded(true)
    } catch {
      // 静默：保留上一次的数字，等下一轮
      if (aliveRef.current) setLoaded((v) => v)
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, intervalMs)
    // 告警页里 ack 掉一条之后，顶栏那个数字要立刻掉下来 —— 等 60s 会让人怀疑「是不是没生效」
    const onChanged = () => void load()
    window.addEventListener(OPS_ALERTS_CHANGED, onChanged)
    return () => {
      aliveRef.current = false
      window.clearInterval(timer)
      window.removeEventListener(OPS_ALERTS_CHANGED, onChanged)
    }
  }, [load, intervalMs])

  return { open, critical, loaded, reload: () => void load() }
}
