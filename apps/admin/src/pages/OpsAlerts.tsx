import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Dialog, Radio, Select, Tag, Textarea, Tooltip, message } from 'tdesign-react'
import { ErrorCircleFilledIcon } from 'tdesign-icons-react'
import DataTable from '../lib/table'
import { fmtMinute } from '../lib/datetime'
import {
  ackOpsAlert,
  fetchOpsAlerts,
  notifyOpsAlertsChanged,
  pushStatusText,
  severityText,
  type OpsAlertSeverity,
  type OpsAlertStatus,
  type OpsAlertView,
} from '../lib/ops-alert'

/**
 * 运维告警 · 后台页。
 *
 * ── 这一页要解决的问题 ───────────────────────────────────────────────────
 * 告警原先只有两个出口：落库 + 企业微信群机器人。**没配 webhook 就等于没人看得见**，
 * 而告警里最要紧的几条（「扣款成功但开通失败」「订单显示已支付却查不到结算回执」）
 * 每一笔都是真金白银 —— 它们不是「日志里有就行」的东西，必须有人主动去看、去处理、
 * 留下处理记录。所以这一页是**不依赖任何外部渠道**的那条路：登录后台就能看到。
 *
 * ── 页面的四个判断口径（都要与后端一致，别在前端重算）────────────────────
 * 1. **未处理数看服务端的 `openCount`**，不是 `items.length`（列表会被 limit 截断）。
 * 2. **告警码不在这里翻译**：服务端写库时 title 已经是人话，前端再抄一份映射
 *    迟早会出现「页面说的和实际报的不是一回事」。
 * 3. **`occurrences` 是最重要的排序信号之一**：一次是偶发，137 次是持续故障。
 * 4. **「已处理」不是「已解决」**：`ack` 只表示有人看过并认领，资金问题仍需人工核实，
 *    所以这一页**只提供 ack、不提供删除** —— 删掉等于销毁证据。
 */

const STATUS_TABS: { label: string; value: OpsAlertStatus }[] = [
  { label: '未处理', value: 'OPEN' },
  { label: '已处理', value: 'ACKED' },
  { label: '全部', value: 'ALL' },
]

export default function OpsAlertsPage() {
  const [status, setStatus] = useState<OpsAlertStatus>('OPEN')
  const [severity, setSeverity] = useState<OpsAlertSeverity | undefined>(undefined)
  const [items, setItems] = useState<OpsAlertView[]>([])
  const [openCount, setOpenCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const [ackTarget, setAckTarget] = useState<OpsAlertView | null>(null)

  // 竞态防护：切换筛选会并发多个请求，慢的旧响应可能后到并覆盖新结果。
  // 版本号用 ref 而不是 state —— setState 是异步的，同一轮事件里的并发挡不住。
  const seqRef = useRef(0)

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      const seq = ++seqRef.current
      if (!opts.silent) setLoading(true)
      try {
        const r = await fetchOpsAlerts({
          status,
          severity,
          limit: 200,
          // 自动刷新（60s）用 silent：后端抖一下不该每分钟弹一次 toast，弹到最后
          // 运营会把整个提示通道关掉，连真报错也看不见了
          silent: true,
        })
        if (seq !== seqRef.current) return
        setItems(r?.items ?? [])
        setOpenCount(r?.openCount ?? 0)
        setLoadedAt(new Date())
      } catch {
        if (seq !== seqRef.current) return
        // 失败时**不清空列表**：留着上一次的结果，比一片空白更有用
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    },
    [status, severity],
  )

  useEffect(() => {
    void load()
  }, [load])

  // 常驻自动刷新：这一页是「盯着看」的页面，不该逼人手动点刷新
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load({ silent: true })
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [load])

  const criticalCount = items.filter((a) => a.severity === 'CRITICAL').length

  return (
    <div>
      <div className="page-header">
        <h2>
          运维告警
          {openCount > 0 && (
            <span className="ops-alert-count">
              <ErrorCircleFilledIcon /> 未处理 {openCount} 条
            </span>
          )}
        </h2>
        <div>
          <Select
            placeholder="级别"
            clearable
            value={severity}
            onChange={(v) => setSeverity((v as OpsAlertSeverity) || undefined)}
            style={{ width: 130, marginRight: 12 }}
            options={[
              { label: '严重', value: 'CRITICAL' },
              { label: '警告', value: 'WARN' },
            ]}
          />
          <Radio.Group
            variant="default-filled"
            size="small"
            value={status}
            onChange={(v) => setStatus(v as OpsAlertStatus)}
          >
            {STATUS_TABS.map((t) => (
              <Radio.Button key={t.value} value={t.value}>
                {t.label}
              </Radio.Button>
            ))}
          </Radio.Group>
          <Button size="small" variant="outline" style={{ marginLeft: 12 }} onClick={() => void load()}>
            刷新
          </Button>
        </div>
      </div>

      <div className="page-tip">
        这里的每一条都是<b>已经发生过的异常</b>，不是预警。最要紧的是两条：
        <b>「窗口外订单取证失败」</b>（可能已收款但无法开通，该订单不会再被任何自动流程重试）
        与<b>「已支付却查不到结算回执」</b>（钱可能收了、权益没发）。看到它们请按
        <code>deploy/支付风控告警-运维说明.md</code>核实对应订单号。
        <br />
        「标记已处理」只是<b>认领</b>（记录谁看过），不代表问题已解决 ——
        本页<b>刻意不提供删除</b>，处理记录就是事后查证的凭据。
        {loadedAt && (
          <span className="muted" style={{ marginLeft: 8 }}>
            最近更新 {fmtMinute(loadedAt)}（每 60 秒自动刷新）
          </span>
        )}
      </div>

      {status !== 'ACKED' && criticalCount > 0 && (
        <div className="ops-alert-banner">
          <ErrorCircleFilledIcon />
          <span>
            当前列表里有 <b>{criticalCount}</b> 条<b>严重</b>告警
            —— 涉及资金，请优先处理（先看「次数」，次数高的说明还在持续发生）。
          </span>
        </div>
      )}

      <DataTable
        rowKey="id"
        data={items}
        loading={loading}
        /*
         * ★ 列宽必须**全部显式给**，且总和要克制。
         *   之前「告警内容」是唯一没写 width 的列 —— 其余列一多（总量超过容器），
         *   剩余空间就被压到几十像素，中文标题被折成竖排（「向微信 / 查单失 / 败」），
         *   整张表反而看不出哪条更严重。显式宽度 + 让表格横向滚动才可读。
         *   同理把「首次/最近」「告警码」「关联单号」并进已有列：
         *   一列一件事在 7 列以内成立，超过之后每列都窄得没法读。
         */
        columns={[
          {
            colKey: 'severity',
            title: '级别',
            width: 78,
            render: ({ row }: { row: OpsAlertView }) => (
              <Tag theme={row.severity === 'CRITICAL' ? 'danger' : 'warning'}>
                {severityText(row.severity)}
              </Tag>
            ),
          },
          {
            colKey: 'content',
            title: '告警内容',
            width: 380,
            render: ({ row }: { row: OpsAlertView }) => (
              <div>
                <div style={{ fontWeight: 500 }}>{row.title}</div>
                {row.detail && <div className="ops-alert-detail">{row.detail}</div>}
                <div className="ops-alert-meta">
                  <code className="ops-alert-code">{row.code}</code>
                  {row.refId && (
                    <span className="muted">
                      {row.refType ?? ''} <span className="ops-alert-ref">{row.refId}</span>
                    </span>
                  )}
                </div>
              </div>
            ),
          },
          {
            colKey: 'occurrences',
            title: '次数',
            width: 100,
            render: ({ row }: { row: OpsAlertView }) =>
              row.occurrences > 1 ? (
                <Tooltip content="同一问题在去重窗口内重复触发的次数 —— 越高说明它还在持续发生">
                  <Tag theme="danger" variant="light-outline">
                    ×{row.occurrences}
                  </Tag>
                </Tooltip>
              ) : (
                <span className="muted">1</span>
              ),
          },
          {
            colKey: 'pushStatus',
            title: '推送',
            width: 88,
            render: ({ row }: { row: OpsAlertView }) => {
              const text = pushStatusText(row.pushStatus, row.pushError)
              // ⚠「没推到手机」必须一眼可见：把「没收到提醒」误解成「没事」是最危险的
              return row.pushStatus === 'SENT' ? (
                <Tooltip content={text}>
                  <span className="success-text">已推</span>
                </Tooltip>
              ) : (
                <Tooltip content={text}>
                  <span className="danger-text">{row.pushStatus === 'FAILED' ? '失败' : '未推'}</span>
                </Tooltip>
              )
            },
          },
          {
            colKey: 'seen',
            title: '最近 / 首次',
            width: 156,
            render: ({ row }: { row: OpsAlertView }) => (
              <div>
                <div>{fmtMinute(row.lastSeenAt)}</div>
                <div className="muted">首次 {fmtMinute(row.firstSeenAt)}</div>
              </div>
            ),
          },
          {
            colKey: 'ackedAt',
            title: '处理',
            width: 190,
            render: ({ row }: { row: OpsAlertView }) =>
              row.ackedAt ? (
                <div>
                  <span className="success-text">已处理 {fmtMinute(row.ackedAt)}</span>
                  {row.ackNote && <div className="muted">{row.ackNote}</div>}
                </div>
              ) : (
                <span className="danger-text">未处理</span>
              ),
          },
          {
            colKey: 'op',
            title: '操作',
            width: 108,
            render: ({ row }: { row: OpsAlertView }) =>
              row.ackedAt ? (
                <span className="muted">—</span>
              ) : (
                <Button size="small" variant="text" theme="primary" onClick={() => setAckTarget(row)}>
                  标记已处理
                </Button>
              ),
          },
        ]}
      />

      <AckDialog
        alert={ackTarget}
        onClose={() => setAckTarget(null)}
        onDone={() => {
          setAckTarget(null)
          // 顶栏角标与这一页都要立刻跟上
          notifyOpsAlertsChanged()
          void load({ silent: true })
        }}
      />
    </div>
  )
}

/** 标记已处理：备注是可选的，但**引导写一句**——「谁为什么判定它没问题」才是事后最需要的信息 */
function AckDialog({
  alert,
  onClose,
  onDone,
}: {
  alert: OpsAlertView | null
  onClose: () => void
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setNote('')
  }, [alert?.id])

  async function submit() {
    if (!alert) return
    setSubmitting(true)
    try {
      await ackOpsAlert(alert.id, note)
      message.success('已标记为已处理')
      onDone()
    } catch {
      // http 拦截器已经弹过原因（重复 ack 会返回 404「告警不存在或已处理」）
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      header="标记为已处理"
      visible={!!alert}
      onClose={onClose}
      onCancel={onClose}
      onConfirm={submit}
      confirmBtn={{ content: '确认', loading: submitting }}
      cancelBtn="取消"
      width={560}
    >
      {alert && (
        <div>
          <div style={{ marginBottom: 12 }}>
            <Tag theme={alert.severity === 'CRITICAL' ? 'danger' : 'warning'}>{severityText(alert.severity)}</Tag>
            <span style={{ marginLeft: 8, fontWeight: 500 }}>{alert.title}</span>
          </div>
          {alert.detail && <div className="ops-alert-detail" style={{ marginBottom: 12 }}>{alert.detail}</div>}
          {alert.refId && (
            <div style={{ marginBottom: 12, fontSize: 13 }}>
              关联：{alert.refType} <code className="ops-alert-code">{alert.refId}</code>
            </div>
          )}
          <div className="muted" style={{ marginBottom: 8 }}>
            标记只是「认领」：表示已经有人看过。若涉及资金，请先按运维说明核实订单再标记。
          </div>
          <Textarea
            value={note}
            onChange={(v) => setNote(v as string)}
            placeholder="处理备注（可选，建议写一句核实结论，例如「已手工补发权益」）"
            maxlength={255}
            autosize={{ minRows: 2, maxRows: 4 }}
          />
        </div>
      )}
    </Dialog>
  )
}
