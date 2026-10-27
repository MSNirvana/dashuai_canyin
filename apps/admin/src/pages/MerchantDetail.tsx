import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Card,
  Descriptions,
  Tag,
  Button,
  Input,
  InputNumber,
  Dialog,
  Radio,
  Select,
  message,
} from 'tdesign-react'
import DataTable from '../lib/table'
import { request } from '../lib/http'
import { confirmDialog } from '../lib/confirm'
import Field, { FieldGroup } from '../components/Field'
// 时间一律走这里：后台唯一口径「2026-09-18 10:59」（原来这里混着带秒与不带秒两种写法）
import { fmtMinute, fmtDay } from '../lib/datetime'
import dayjs from 'dayjs'

interface BeanAccount {
  balance: string
  /** 会员赠积分桶（**仅会员桶**，不含注册桶）。随会员到期清零 */
  grantBalance: string
  /**
   * 注册赠积分桶：注册拉新奖励，**永久有效、不随会员到期清零**。
   * ★ 后台调账**改不到**这个桶（`adjust` 只有 RECHARGE / GRANT 两个桶，GRANT 指的是上面那个会员桶），
   *   所以界面上必须单独列出来：否则运营看到「可用 5030」却发现怎么扣都扣不到 5030。
   */
  grantRegisterBalance?: string
  frozen: string
  totalRecharge: string
  totalConsume: string
  totalGrant?: string
}
interface LedgerRow {
  id: string
  type: string
  amount: string
  balanceAfter: string
  remark: string | null
  createdAt: string
}
interface Membership {
  id: string
  package: { name: string; code: string; durationDays: number; priceFen: number }
  startAt: string
  endAt: string
  status: string
}
interface MerchantDetail {
  id: string
  phone: string
  nickname: string | null
  status: string
  createdAt: string
  stores: { id: string; name: string; isDefault: boolean; category: string | null }[]
  beanAccount: BeanAccount | null
  ledgers: LedgerRow[]
  orders: { id: string; orderNo: string; orderType: string; amountFen: number | string; status: string; paidAt: string | null; createdAt: string }[]
  memberships: Membership[]
  _count: { stores: number; creations: number; renderTasks: number }
}
interface MemberPackage {
  id: string
  code: string
  name: string
  durationDays: number
  priceFen: number
  grantBeans: string
  enabled: boolean
}
interface OpenResult {
  orderNo: string
  packageName: string
  renewed: boolean
  endAt: string
  grantPoints: string
}
/** 支付补单结果（服务端主动查微信后的结论） */
interface ReconcileResult {
  orderNo: string
  outcome: 'ALREADY_PAID' | 'SETTLED' | 'NOT_PAID' | 'CLOSED' | 'NOT_EXIST' | 'SKIPPED'
  tradeState: string | null
  status: string
  message: string
}

/**
 * 积分字段是 BigInt 序列化出来的**字符串**（`"5030"`）。
 * 直接参与算术会变成字符串拼接（`"5030" + 1 === "50301"`），所以统一过一道 Number。
 * 积分量级远小于 2^53，不存在精度问题。
 */
const num = (v: string | undefined): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * 调账幂等键：**一次「调账意图」一把键**。
 *
 * ★ 服务端按 (merchantId, bizType='ADMIN', requestId, type='ADJUST') 唯一索引去重，
 *   键一换去重就完全失效：双击一次、或请求超时后重试一次，积分真的会被改两遍，
 *   而两条流水看起来都完全正常。所以：开弹窗生成一把，成功提交后才换新的，失败重试沿用同一把。
 *   口径与 `pages/BeanLedger.tsx` 完全一致 —— 两个入口打的是同一个接口，不能有两套规矩。
 */
const newAdjustRequestId = () => `adj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** 调账目标桶。GRANT = 会员赠积分桶（随会员到期清零）；RECHARGE = 充值积分桶（永久） */
type BeanBucket = 'GRANT' | 'RECHARGE'

/** 打开弹窗时的初始表单 */
const emptyGrant = () => ({
  direction: 'IN' as 'IN' | 'OUT',
  /** 恒为正数，提交时才按 direction 取符号——避免运营在这里输错负号再输一次 */
  amount: 0,
  bucket: 'GRANT' as BeanBucket,
  remark: '',
  requestId: newAdjustRequestId(),
})

export default function MerchantDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<MerchantDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [plan, setPlan] = useState<MemberPackage | null>(null)
  const [remark, setRemark] = useState('')
  const [opening, setOpening] = useState(false)
  /** 正在补单的订单号（用于按钮 loading） */
  const [reconciling, setReconciling] = useState<string | null>(null)
  /** 赠送 / 扣减积分弹窗 */
  const [grantOpen, setGrantOpen] = useState(false)
  const [grantSubmitting, setGrantSubmitting] = useState(false)
  const [grant, setGrant] = useState(emptyGrant())

  /**
   * 改任何一个字段 = 换了**调账意图** ⇒ 必须换一把幂等键。
   *
   * ★ 不能省这一步。服务端命中同一个 requestId 会**直接返回上次的余额快照、不再改账**，
   *   所以「同一把键 + 改过的数量」会被当成重放：运营把 100 改成 200 提交，
   *   页面回「调账成功」，库里却仍是 100 —— 静默的金额不符，比重复扣加更难发现。
   *   反过来，一个字段都不动直接重试沿用同一把键，才是幂等真正要保护的那个场景。
   */
  const setGrantField = (patch: Partial<ReturnType<typeof emptyGrant>>) =>
    setGrant((s) => ({ ...s, ...patch, requestId: newAdjustRequestId() }))

  const load = () => {
    if (!id) return
    setLoading(true)
    request<MerchantDetail>({ url: `/merchants/${id}` })
      .then(setData)
      .catch(() => message.error('加载失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    void load()
    // 会员套餐是全局配置，取一次即可；用于在界面上显示「开通 30 天会送 98000 积分」
    request<MemberPackage[]>({ url: '/member-packages' })
      .then((list) => setPlan(list.find((p) => p.code === 'SUBSCRIPTION' && p.enabled) ?? list[0] ?? null))
      .catch(() => setPlan(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const toggleStatus = async () => {
    if (!data) return
    const next = data.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'
    const r = await request<{ status: string }>({
      url: `/merchants/${data.id}/status`,
      method: 'POST',
      data: { status: next },
    })
    message.success(`已${next === 'ACTIVE' ? '启用' : '禁用'}`)
    setData((d) => d ? { ...d, status: r.status } : d)
  }

  // 后台手动开通 / 续期会员：支付未开放期间用户线下付款后的兜底通道。
  // 走的是与微信支付回调完全相同的结算链（赠积分进会员桶、随会员到期清零、重复开通＝顺延）。
  const openMembership = async () => {
    if (!data) return
    const current = data.memberships.find((m) => m.status === 'ACTIVE' && dayjs(m.endAt).isAfter(dayjs()))
    const days = plan?.durationDays ?? 30
    const feeYuan = plan ? (plan.priceFen / 100).toFixed(0) : '980'
    const grantPoints = plan?.grantBeans ?? '98000'
    const base = current ? dayjs(current.endAt) : dayjs()
    const willEnd = base.add(days, 'day')
    const okd = await confirmDialog(
      current ? '续期会员' : '手动开通会员',
      `确认为「${data.phone}」${current ? '续期' : '开通'}会员？\n\n` +
        `套餐：${plan?.name ?? '订阅会员'}（¥${feeYuan} / ${days} 天）\n` +
        `将立即赠送 ${grantPoints} 积分（会员积分，随会员到期清零）\n` +
        `到期时间：${fmtMinute(willEnd)}` +
        (current ? `\n（在现有到期时间 ${fmtDay(current.endAt)} 上顺延 ${days} 天）` : '') +
        `\n\n此操作会生成一张 0 元会员订单用于留痕，不可撤销。`,
    )
    if (!okd) return
    setOpening(true)
    try {
      const r = await request<OpenResult>({
        url: `/merchants/${data.id}/membership`,
        method: 'POST',
        data: { remark: remark.trim() || undefined },
      })
      message.success(
        `已${r.renewed ? '续期' : '开通'}会员，有效期至 ${fmtDay(r.endAt)}，赠送 ${r.grantPoints} 积分`,
      )
      setRemark('')
      load()
    } catch {
      // http 层已统一提示
    } finally {
      setOpening(false)
    }
  }

  // 支付补单：用户付了钱但权益没到账时的最后兜底。
  //
  // 典型场景：微信的支付回调**不是可靠通道** —— notify_url 域名不可达（备案被拦）、
  // 网络抖动、微信重试耗尽，任何一种都会让回调静默丢失。此时用户钱已付、微信侧是 SUCCESS，
  // 而这里看到的订单仍然是「待支付」。
  // 服务端只读微信查单接口，再走与回调**完全相同**的结算链 ⇒ 幂等，重复点不会双发权益。
  const reconcileOrder = async (orderNo: string) => {
    setReconciling(orderNo)
    try {
      const r = await request<ReconcileResult>({
        url: `/orders/${encodeURIComponent(orderNo)}/reconcile`,
        method: 'POST',
      })
      if (r.outcome === 'SETTLED') {
        message.success(`补单成功：${r.message}`)
        load()
      } else if (r.outcome === 'ALREADY_PAID') {
        message.info(r.message)
      } else {
        // NOT_PAID / CLOSED / NOT_EXIST / SKIPPED 都要如实说明，别让操作者以为补单生效了
        message.warning(r.message)
        if (r.status !== 'PENDING') load()
      }
    } catch {
      // http 层已统一提示
    } finally {
      setReconciling(null)
    }
  }

  if (loading) return <div>加载中…</div>
  if (!data) return <div className="danger-text">未找到商家</div>

  const acc = data.beanAccount
  const now = dayjs()
  const current = data.memberships.find((m) => m.status === 'ACTIVE' && dayjs(m.endAt).isAfter(now))
  const history = data.memberships.filter((m) => m.id !== current?.id)

  // ── 赠送 / 扣减积分的派生值与预校验 ──────────────────────────────
  //
  // ★ 这些校验**不是**为了替代服务端：服务端在账户行锁内重算一次（见 bean.service.ts::adjust）。
  //   这里的意义只是「点确定之前就把话说清楚」——服务端的错误信息虽然也是中文，
  //   但它出现在提交之后、弹窗已关的那一刻，运营还得重新打开弹窗再填一遍。
  const frozenNow = num(acc?.frozen)
  const availableNow =
    num(acc?.balance) + num(acc?.grantBalance) + num(acc?.grantRegisterBalance) - frozenNow
  /** 目标桶当前余额：调账只能改这两个桶之一，扣减也不能把该桶扣成负数 */
  const bucketBalance = grant.bucket === 'GRANT' ? num(acc?.grantBalance) : num(acc?.balance)
  const bucketLabel =
    grant.bucket === 'GRANT' ? '会员赠积分（随会员到期清零）' : '充值积分（永久有效）'
  const amountAbs = Math.abs(Math.trunc(grant.amount || 0))
  const afterBucket = grant.direction === 'OUT' ? bucketBalance - amountAbs : bucketBalance + amountAbs
  const afterAvailable = grant.direction === 'OUT' ? availableNow - amountAbs : availableNow + amountAbs
  const grantError = !acc
    ? '该商家还没有积分账户，无法调账'
    : amountAbs <= 0
      ? '请填写大于 0 的积分数量'
      : !grant.remark.trim()
        ? '请填写原因——它会写进积分流水，是这次调账唯一的审计依据'
        : grant.direction === 'OUT' && amountAbs > bucketBalance
          ? `「${bucketLabel}」只有 ${bucketBalance} 积分，扣不了 ${amountAbs}（另一个桶的积分不通用）`
          : grant.direction === 'OUT' && afterAvailable < 0
            ? `扣减后可用积分会变成 ${afterAvailable}：其中 ${frozenNow} 正被在途任务冻结、不能扣，最多可扣 ${availableNow > 0 ? availableNow : 0}`
            : ''

  const openGrantDialog = () => {
    setGrant(emptyGrant())
    setGrantOpen(true)
  }

  const submitGrant = async () => {
    if (grantSubmitting || grantError) return
    const signed = grant.direction === 'OUT' ? -amountAbs : amountAbs
    // 扣减不可撤销，多问一次；赠送是加法，留痕足够，不再拦一道
    if (grant.direction === 'OUT') {
      const okd = await confirmDialog(
        '确认扣减积分',
        `确认从「${data.phone}」扣减 ${amountAbs} 积分？\n\n` +
          `目标桶：${bucketLabel}\n` +
          `该桶余额：${bucketBalance} → ${afterBucket}\n` +
          `可用合计：${availableNow} → ${afterAvailable}\n\n` +
          `会写入一条 ADJUST 流水留痕，不可撤销。`,
      )
      if (!okd) return
    }
    setGrantSubmitting(true)
    try {
      const r = await request<{ balanceAfter: string; grantAfter: string; duplicated: boolean }>({
        url: '/bean/adjust',
        method: 'POST',
        data: {
          merchantId: data.id,
          amount: String(signed),
          bucket: grant.bucket,
          remark: grant.remark.trim(),
          requestId: grant.requestId,
        },
      })
      // 服务端如实回报是不是重放：不区分的话，运营会以为「又调了一次」，然后手动再调一次
      message.success(
        r?.duplicated
          ? '这笔调账之前已生效，本次没有重复扣加'
          : `已${grant.direction === 'OUT' ? '扣减' : '赠送'} ${amountAbs} 积分`,
      )
      setGrantOpen(false)
      setGrant(emptyGrant())
      load()
    } catch {
      // http 层已统一提示；**保留同一把 requestId**：用户点「重试」是接着同一次调账意图
    } finally {
      setGrantSubmitting(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>商家详情 · {data.phone}</h2>
        <Button
          theme={data.status === 'ACTIVE' ? 'danger' : 'primary'}
          onClick={toggleStatus}
        >
          {data.status === 'ACTIVE' ? '禁用账号' : '恢复账号'}
        </Button>
      </div>

      <Card title="基本信息" style={{ marginBottom: 16 }}>
        <Descriptions column={2}>
          <Descriptions.DescriptionsItem label="手机号">{data.phone}</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="昵称">{data.nickname ?? '—'}</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="状态">
            <Tag theme={data.status === 'ACTIVE' ? 'success' : 'danger'}>{data.status}</Tag>
          </Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="注册时间">{fmtMinute(data.createdAt)}</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="门店 / 创作 / 合成任务">
            {data._count.stores} / {data._count.creations} / {data._count.renderTasks}
          </Descriptions.DescriptionsItem>
        </Descriptions>
      </Card>

      <Card
        title="会员"
        style={{ marginBottom: 16 }}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input
              value={remark}
              onChange={(v) => setRemark(v as string)}
              placeholder="备注（如：微信转账 980）"
              style={{ width: 200 }}
            />
            <Button theme="primary" loading={opening} onClick={openMembership}>
              {current ? '续期会员' : '手动开通会员'}
            </Button>
          </div>
        }
      >
        <Descriptions column={4}>
          <Descriptions.DescriptionsItem label="会员状态">
            <Tag theme={current ? 'success' : 'warning'}>{current ? '有效' : '未开通'}</Tag>
          </Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="套餐">{current?.package.name ?? '—'}</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="到期时间">
            {current ? fmtMinute(current.endAt) : '—'}
          </Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="剩余天数">
            {current ? `${dayjs(current.endAt).diff(dayjs(), 'day')} 天` : '—'}
          </Descriptions.DescriptionsItem>
        </Descriptions>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          {plan
            ? `开通/续期一次 = ${plan.durationDays} 天 + ${plan.grantBeans} 积分（¥${(plan.priceFen / 100).toFixed(0)}）。积分进会员桶，随会员到期清零；已有会员则在其到期时间上顺延。`
            : '未取到会员套餐配置，请先到「会员套餐」页确认 SUBSCRIPTION 已启用。'}
        </div>
        {data.memberships.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <DataTable
              rowKey="id"
              data={data.memberships}
              columns={[
                { colKey: 'package', title: '套餐', render: ({ row }: any) => row.package?.name ?? '—' },
                { colKey: 'startAt', title: '开始', width: 170, render: ({ row }: any) => fmtMinute(row.startAt) },
                { colKey: 'endAt', title: '到期', width: 170, render: ({ row }: any) => fmtMinute(row.endAt) },
                { colKey: 'status', title: '状态', width: 100, render: ({ row }: any) => (row.status === 'ACTIVE' && dayjs(row.endAt).isAfter(dayjs()) ? '有效' : row.status) },
              ]}
            />
          </div>
        )}
      </Card>

      <Card
        title="积分账户"
        style={{ marginBottom: 16 }}
        actions={
          <Button theme="primary" variant="outline" onClick={openGrantDialog}>
            赠送 / 扣减积分
          </Button>
        }
      >
        {acc ? (
          <>
            <Descriptions column={4}>
              <Descriptions.DescriptionsItem label="可用合计">{availableNow}</Descriptions.DescriptionsItem>
              <Descriptions.DescriptionsItem label="充值积分（永久）">{acc.balance}</Descriptions.DescriptionsItem>
              <Descriptions.DescriptionsItem label="会员赠积分（到期清零）">
                {acc.grantBalance}
              </Descriptions.DescriptionsItem>
              <Descriptions.DescriptionsItem label="注册赠积分（永久·不可调账）">
                {acc.grantRegisterBalance ?? '0'}
              </Descriptions.DescriptionsItem>
              <Descriptions.DescriptionsItem label="冻结中">{acc.frozen}</Descriptions.DescriptionsItem>
              <Descriptions.DescriptionsItem label="累计充值">{acc.totalRecharge}</Descriptions.DescriptionsItem>
              <Descriptions.DescriptionsItem label="累计消耗">{acc.totalConsume}</Descriptions.DescriptionsItem>
              <Descriptions.DescriptionsItem label="累计赠出">
                {acc.totalGrant ?? '—'}
              </Descriptions.DescriptionsItem>
            </Descriptions>
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              可用合计 = 充值积分 + 会员赠积分 + 注册赠积分 − 冻结中。
              手动调账只能改「充值积分」和「会员赠积分」两个桶；注册赠积分由注册流程写入，后台改不到。
            </div>
          </>
        ) : (
          <span className="muted">暂无账务</span>
        )}
      </Card>

      <Card title={`门店 (${data.stores.length})`} style={{ marginBottom: 16 }}>
        <DataTable
          rowKey="id"
          data={data.stores}
          columns={[
            { colKey: 'name', title: '门店名' },
            { colKey: 'category', title: '品类', render: ({ row }: any) => row.category ?? '—' },
            { colKey: 'isDefault', title: '默认', render: ({ row }: any) => row.isDefault ? '✓' : '' },
          ]}
        />
      </Card>

      <Card title="最近流水（50 条）" style={{ marginBottom: 16 }}>
        <DataTable
          rowKey="id"
          data={data.ledgers}
          columns={[
            { colKey: 'createdAt', title: '时间', width: 170, render: ({ row }: any) => fmtMinute(row.createdAt) },
            { colKey: 'type', title: '类型', width: 100 },
            { colKey: 'amount', title: '变动' },
            { colKey: 'balanceAfter', title: '余额' },
            { colKey: 'remark', title: '备注' },
          ]}
        />
      </Card>

      <Card title="最近订单（20 条）">
        <div style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>
          待支付的订单可点「补单」：服务端会去微信查这笔单，确认已支付就当场补发权益。
          用于微信回调丢失（notify_url 不可达、网络抖动、重试耗尽）导致「钱付了但没到账」的情况。
        </div>
        <DataTable
          rowKey="id"
          data={data.orders}
          columns={[
            { colKey: 'orderNo', title: '订单号' },
            { colKey: 'orderType', title: '类型' },
            { colKey: 'amountFen', title: '金额(分)' },
            { colKey: 'status', title: '状态' },
            { colKey: 'paidAt', title: '支付时间', render: ({ row }: any) => fmtMinute(row.paidAt) },
            {
              colKey: 'action',
              title: '操作',
              render: ({ row }: any) =>
                row.status === 'PENDING' ? (
                  <Button
                    size='small'
                    variant='outline'
                    loading={reconciling === row.orderNo}
                    onClick={() => void reconcileOrder(row.orderNo)}
                  >
                    补单
                  </Button>
                ) : (
                  <span style={{ color: '#bbb' }}>—</span>
                ),
            },
          ]}
        />
      </Card>

      <Dialog
        header="赠送 / 扣减积分"
        visible={grantOpen}
        onClose={() => setGrantOpen(false)}
        onConfirm={submitGrant}
        // 提交中禁用「确定」：服务端虽然按 requestId 幂等，但让运营看到两条「调账成功」本身就是误导
        //
        // ★ `content` 不能省。TDesign 的 confirmBtn 传**对象**时走的是
        //   `renderDialogButton` 的 isObject 分支 ⇒ `createElement(Button, {...defaultProps, ...btn})`,
        //   **不带 children**。所以只写 `{ loading }` 会渲染出一个光秃秃的红方块、一个字都没有
        //   （实测截图确认）。文本要么直接传字符串，要么在对象里点名 `content`。
        confirmBtn={{ content: '确定', loading: grantSubmitting, disabled: Boolean(grantError) }}
        width={600}
      >
        <FieldGroup labelWidth={96}>
          <Field label="当前账户">
            <div style={{ fontSize: 13, lineHeight: '22px' }}>
              可用合计 <strong>{availableNow}</strong>（充值 {num(acc?.balance)} · 会员赠{' '}
              {num(acc?.grantBalance)} · 注册赠 {num(acc?.grantRegisterBalance)} − 冻结 {frozenNow}）
            </div>
          </Field>
          <Field label="操作" required>
            <Radio.Group
              variant="default-filled"
              value={grant.direction}
              onChange={(v) => setGrantField({ direction: v as 'IN' | 'OUT' })}
            >
              <Radio.Button value="IN">赠送</Radio.Button>
              <Radio.Button value="OUT">扣减</Radio.Button>
            </Radio.Group>
          </Field>
          <Field label="数量" required help="恒填正数，方向由上面的「赠送 / 扣减」决定（不用自己敲负号）">
            <InputNumber
              value={grant.amount}
              min={0}
              step={100}
              onChange={(v) => setGrantField({ amount: Number(v) || 0 })}
              style={{ width: 200 }}
            />
          </Field>
          <Field
            label="目标桶"
            required
            help={
              grant.bucket === 'GRANT'
                ? '会员赠积分：会员到期时会被清零（续期不会补回来）。只在这一档有会员时才适合攒。'
                : '充值积分：永久有效，不随会员到期清零。手滑多送也追不回，确认数量再提交。'
            }
          >
            <Select
              value={grant.bucket}
              onChange={(v) => setGrantField({ bucket: v as BeanBucket })}
              options={[
                { label: '会员赠积分（随会员到期清零）', value: 'GRANT' },
                { label: '充值积分（永久有效）', value: 'RECHARGE' },
              ]}
            />
          </Field>
          <Field label="原因" required help="必填。会写进这条积分流水的备注，是事后唯一能查到的依据">
            <Input
              value={grant.remark}
              onChange={(v) => setGrantField({ remark: v as string })}
              placeholder="如：微信转账补差 2000 积分 / 误发回收"
            />
          </Field>
          <Field label="调后预估">
            <div style={{ fontSize: 13, lineHeight: '22px' }}>
              {bucketLabel}：{bucketBalance} → <strong>{afterBucket}</strong>
              <br />
              可用合计：{availableNow} → <strong>{afterAvailable}</strong>
            </div>
          </Field>
        </FieldGroup>
        {grantError ? (
          <div className="danger-text" style={{ fontSize: 12, marginTop: 4 }}>
            {grantError}
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
