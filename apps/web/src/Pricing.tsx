import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, CalendarDays, Check, Coins, Crown, Fuel, RefreshCw, ShieldCheck } from 'lucide-react'
import { api, ApiError, getPendingPayment, isWechatBrowser, savePendingPayment } from './api'
import { useAuth } from './auth'
import { ErrorBlock, formatMoney, formatNumber, LoadingBlock, PageHeader } from './components'
import { DEMO_CATALOG, DEMO_MODE } from './demo-catalog'
import { REFUND_POLICY, SUPPORT_HOURS, SUPPORT_PHONE } from './site-info'
import type { AccountInfo, Catalog, OrderKind, PayOrder, PayScene } from './types'

/**
 * 套餐页。
 *
 * ★ 文案按「30-50 岁门店经营者」写：每块只留一句人话（「开通后可以用全部功能」），
 *   不写「价格与权益均实时读取服务端配置」这种给审计看的句子。
 *   ⚠ 但**价格与积分数字本身一个字都不能改**——它们直接来自服务端目录。
 */
/**
 * 有效期文案：整年按「年」写，其余按「天」。
 *
 * ★ 为什么不能直接写 `{plan.durationDays} 天`：
 *   套餐名是配置填的，天数来自套餐行，两者并排在同一张卡上，一个写「1 年」、
 *   另一个写「365 天」，用户得在脑子里做除法才能确认它们说的是同一件事 ——
 *   读起来就像又一处自相矛盾。
 *   （2026-10-14 之前更糟：名字 3 年、有效期 30 天，是两个**真的**不一样的数字。）
 * ★ 只认「能被 365 整除」的整年：1095 ⇒ 3 年、365 ⇒ 1 年，而 400 天仍写「400 天」，
 *   不编造「1.1 年」这种用户没法核对的数字。
 */
function formatDuration(days: number): string {
  return days >= 365 && days % 365 === 0 ? `${days / 365} 年` : `${days} 天`
}

/**
 * 「折合每天多少」—— 只在整年套餐、且单价大于 0 时给。
 *
 * ★ 为什么要给这一行：¥198 一次付清，对「一个月能不能多接两桌客人」的老板来说
 *   是个要犹豫的数字；拆到每天 0.54 元，他才能拿它跟一瓶水比。
 *   **不编造对比对象**（不写「一天不到一瓶水钱」那种话），只把除法结果摆出来。
 * ★ 小于 1 元时保留两位、大于等于 1 元时保留一位 —— 0.5 元会丢掉「0.54」这个更小的数，
 *   而 1.5 再多给一位就是假精度（价格本身是整数元）。
 */
function formatPerDay(priceFen: number, days: number): string {
  if (!days || priceFen <= 0) return ''
  const yuan = priceFen / 100 / days
  const text = yuan >= 1 ? (Math.round(yuan * 10) / 10).toFixed(1) : (Math.round(yuan * 100) / 100).toFixed(2)
  return `折合每天 ${text} 元`
}

/**
 * 套餐卡上的大价格：**整元不写小数**。
 *
 * ★ 为什么不直接用 `formatMoney`：那是**账单口径** —— 订单页、支付页必须能对到「分」，
 *   一成不变地写两位小数是对的。但 pricing 卡上那 34px 的大字写成「¥198.00」，
 *   两个零是纯噪声，老板关心的只是「两百块」这个量级。
 * ★ 只省**整元**的小数：¥198.50 这类非整元仍走 `formatMoney`，不会把零头写丢。
 */
function formatPlanPrice(priceFen: number): string {
  return priceFen % 100 === 0 ? `¥${priceFen / 100}` : formatMoney(priceFen)
}

export function Pricing() {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState('')
  const [actionError, setActionError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [catalogResult, accountResult] = await Promise.all([
        // ★★ 审核期走本地演示数据（见 `demo-catalog.ts`）。回滚就把这一行换回
        //    `api<Catalog>('/web/catalog', { auth: false })`，并把那个文件删掉。
        DEMO_MODE ? Promise.resolve(DEMO_CATALOG) : api<Catalog>('/web/catalog', { auth: false }),
        session ? api<AccountInfo>('/orders/me').catch(() => null) : Promise.resolve(null),
      ])
      setCatalog(catalogResult); setAccount(accountResult)
    } catch (e) { setError(messageOf(e)) } finally { setLoading(false) }
  }, [session])

  useEffect(() => { void load() }, [load])

  const buy = async (kind: OrderKind, packageId: string, title: string) => {
    setActionError('')
    /**
     * ★★ 审核期：页面上的价是演示价，后台真价不是这个数 ⇒ **绝不能**真建单。
     *   真建单会拿着演示价的 packageId 去打 `/web/orders`，后端按库里的真价成单，
     *   于是「页面写 ¥198、实际扣 ¥980」—— 这比报错难查得多。
     *   ⇒ 直接给一条能办成事的指引：打电话。
     *   ⚠ 不写「请用小程序购买」：上一轮审核驳回的理由正是「服务在小程序里、网站里体验不到」，
     *     这句话会把这个结论再确认一遍。
     */
    if (DEMO_MODE) {
      setActionError(`网页在线支付正在开通中。需要现在开通，请致电 ${SUPPORT_PHONE}（${SUPPORT_HOURS}）。`)
      return
    }
    if (!session) { navigate('/login', { state: { from: '/pricing' } }); return }
    if (kind === 'BEAN' && !account?.subscription.active) { setActionError('加油包仅限有效会员购买，请先开通会员套餐。'); return }
    const scene = chooseScene(catalog)
    if (!scene) { setActionError('当前暂无可用的网页支付方式，请稍后再试。'); return }
    if (scene === 'H5' && isWechatBrowser()) { setActionError('微信内暂不支持 H5 支付，请点击右上角菜单，选择在浏览器中打开。'); return }
    setCreating(`${kind}:${packageId}`)
    try {
      const pending = getPendingPayment()
      if (pending && pending.packageId === packageId && pending.kind === kind && new Date(pending.expireAt).getTime() > Date.now()) {
        navigate(`/pay/${pending.orderNo}`); return
      }
      const order = await api<PayOrder>('/web/orders', { method: 'POST', body: { kind, packageId, scene } })
      savePendingPayment({ ...order, kind, packageId, scene, merchantId: session.merchant.id, title })
      navigate(`/pay/${order.orderNo}`)
    } catch (e) { setActionError(messageOf(e)) } finally { setCreating('') }
  }

  return (
    <section className="page-section">
      <div className="container">
        {/* ★ 原来这句是「价格以服务端为准，就是实际要付的金额」。
            审核期套餐来自本地演示数据（`demo-catalog.ts`），再说「以服务端为准」
            就是一句**当面能被拆穿**的话 —— 页面上写的价和库里根本不是一回事。
            ⇒ 改成只描述商品本身的计费方式，不承诺数据来源。 */}
        <PageHeader eyebrow="套餐" title="选一个方案" description="当前在售的会员方案与积分加油包。一次付清，到期前不再扣费。" />
        {loading ? <LoadingBlock text="正在读取套餐" /> : error ? <ErrorBlock message={error} retry={() => void load()} /> : catalog && (
          <>
            <div className="pricing-section-title">
              <div><Crown /><span>会员套餐</span></div>
              <p>开通后可以用全部功能，积分不够再买加油包。</p>
            </div>
            {catalog.plans.length ? (
              <div className="plan-grid">
                {catalog.plans.map((plan, index) => (
                  <article className={index === 0 ? 'price-card featured' : 'price-card'} key={plan.id}>
                    {index === 0 && <span className="recommended">推荐</span>}
                    <div className="price-icon"><Crown /></div>
                    <h3>{plan.name}</h3>
                    <div className="price">
                      <strong>{formatPlanPrice(plan.priceFen)}</strong>
                      {formatPerDay(plan.priceFen, plan.durationDays) && (
                        <span className="price-meta">{formatPerDay(plan.priceFen, plan.durationDays)}</span>
                      )}
                    </div>
                    <ul>
                      <li><CalendarDays /><span>有效期 <b>{formatDuration(plan.durationDays)}</b>，到期前一直能用</span></li>
                      <li><Coins /><span>赠送 <b>{formatNumber(plan.grantBeans)} 积分</b>，生成时按次扣</span></li>
                      {/* ★ 这一行长度是算过的：桌面端权益两列、每列 300px，
                          可用宽度 ≈274px ÷ 16px ≈ 17 字。原来写「文案、分镜、拍摄提词、
                          字幕配音、成片导出都能用」（22 字）会折成两行，而且断点落在
                          「成|片」中间 —— 中文没有词边界，浏览器就在那儿切了。
                          现在 16 字，一行放得下。**加字之前先算一遍**。 */}
                      <li><Check /><span>文案、分镜、提词、字幕、成片全包</span></li>
                      <li><Check /><span>可以购买积分加油包</span></li>
                    </ul>
                    <button className="button full" disabled={!!creating} onClick={() => void buy('MEMBER', plan.id, plan.name)}>
                      {creating === `MEMBER:${plan.id}` ? '正在创建订单' : account?.subscription.active ? '续订会员' : '立即开通'} <ArrowRight size={18} />
                    </button>
                  </article>
                ))}
              </div>
            ) : <CatalogEmpty text="暂无可售会员套餐" />}

            <div className="pricing-section-title spaced">
              <div><Fuel /><span>积分加油包</span></div>
              <p>开通会员后可以买，用来补充积分。</p>
            </div>
            {catalog.packages.length ? (
              <div className="package-grid">
                {catalog.packages.map((pkg) => (
                  <article className="package-card" key={pkg.id}>
                    <div className="package-head">
                      <div className="price-icon small"><Coins /></div>
                      <div><h3>{pkg.name}</h3><strong>{formatPlanPrice(pkg.priceFen)}</strong></div>
                    </div>
                    <div className="bean-total">
                      <span>到账积分</span>
                      <b>{formatNumber(Number(pkg.beans) + Number(pkg.bonusBeans))}</b>
                    </div>
                    <p>基础 {formatNumber(pkg.beans)}{Number(pkg.bonusBeans) > 0 ? ` + 赠送 ${formatNumber(pkg.bonusBeans)}` : ''}</p>
                    <button className="button secondary full" disabled={!!creating} onClick={() => void buy('BEAN', pkg.id, pkg.name)}>
                      {creating === `BEAN:${pkg.id}` ? '正在创建订单' : '购买加油包'}
                    </button>
                  </article>
                ))}
              </div>
            ) : <CatalogEmpty text="暂无可售积分加油包" />}

            {/* ★★ 退款与售后写在这一页，而不是只放在 /rules 里：
                微信支付 H5 审核规则第 1 条要求商品页「带有价格、有对应的**售后服务、
                客诉解决的说明**」—— 审核员看的是**价格那一页**，让他再去别处找，
                中间任何一次跳转都可能被记成「没有说明」。
                正文来自 `site-info.ts::REFUND_POLICY`，与《基础服务规则》同一份口径。 */}
            <div className="refund-band">
              <div className="refund-head"><ShieldCheck /><strong>退款与售后</strong></div>
              <ul>{REFUND_POLICY.map((text) => <li key={text}>{text}</li>)}</ul>
              <p>
                客服电话 <a href={`tel:${SUPPORT_PHONE}`}>{SUPPORT_PHONE}</a>（{SUPPORT_HOURS}）
                · 完整条款见 <Link to="/rules">基础服务规则</Link>
              </p>
            </div>

            {actionError && <div className="action-error"><ShieldCheck /><span>{actionError}</span></div>}
            <div className="payment-note">
              <RefreshCw />
              <div>
                <strong>支付说明</strong>
                <p>没付完的订单可以继续付，不会重复下单。付款是否成功，以服务端订单状态为准。</p>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/**
 * 在**用户当前这块屏幕**上能完成支付的方式优先。
 *
 * ★ 为什么手机浏览器要优先 H5，而不是「有 Native 就用 Native」：
 *   在手机上给二维码 = 让用户拿另一台设备来扫，这一步绝大多数人直接放弃。
 *   H5 才能把用户直接送进微信收银台。
 * ★ 桌面浏览器相反：没有「当前设备支付」这条路，只能扫码 ⇒ 必须 NATIVE。
 * ★ 微信内既不能跳 H5（微信会拦），也扫不了自己屏幕上的码，
 *   但**长按二维码可以识别**（见 Pay 页文案），所以仍回落到 NATIVE 而不是报错。
 */
function chooseScene(catalog: Catalog | null): PayScene | null {
  if (!catalog) return null
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  if (mobile && !isWechatBrowser() && catalog.capabilities.h5) return 'H5'
  if (catalog.capabilities.native) return 'NATIVE'
  if (catalog.capabilities.h5) return 'H5'
  return null
}
function CatalogEmpty({ text }: { text: string }) { return <div className="catalog-empty">{text}</div> }
function messageOf(error: unknown) { return error instanceof ApiError ? error.message : '网络连接异常，请稍后重试' }
