import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, CalendarDays, Check, Coins, Crown, Fuel, RefreshCw, ShieldCheck } from 'lucide-react'
import { api, ApiError, getPendingPayment, isWechatBrowser, savePendingPayment } from './api'
import { useAuth } from './auth'
import { ErrorBlock, formatMoney, formatNumber, LoadingBlock, PageHeader } from './components'
import type { AccountInfo, Catalog, OrderKind, PayOrder, PayScene } from './types'

/**
 * 套餐页。
 *
 * ★ 文案按「30-50 岁门店经营者」写：每块只留一句人话（「开通后可以用全部功能」），
 *   不写「价格与权益均实时读取服务端配置」这种给审计看的句子。
 *   ⚠ 但**价格与积分数字本身一个字都不能改**——它们直接来自服务端目录。
 */
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
        api<Catalog>('/web/catalog', { auth: false }),
        session ? api<AccountInfo>('/orders/me').catch(() => null) : Promise.resolve(null),
      ])
      setCatalog(catalogResult); setAccount(accountResult)
    } catch (e) { setError(messageOf(e)) } finally { setLoading(false) }
  }, [session])

  useEffect(() => { void load() }, [load])

  const buy = async (kind: OrderKind, packageId: string, title: string) => {
    setActionError('')
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
        <PageHeader eyebrow="套餐" title="选一个方案" description="价格以服务端为准，就是实际要付的金额。" />
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
                    <div className="price"><strong>{formatMoney(plan.priceFen)}</strong></div>
                    <ul>
                      <li><CalendarDays /><span>有效期 <b>{plan.durationDays} 天</b></span></li>
                      <li><Coins /><span>赠送 <b>{formatNumber(plan.grantBeans)} 积分</b></span></li>
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
                      <div><h3>{pkg.name}</h3><strong>{formatMoney(pkg.priceFen)}</strong></div>
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
