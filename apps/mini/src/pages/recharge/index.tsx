import { useEffect, useRef, useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import {
  listBeanPackages,
  listMemberPlans,
  createBeanOrder,
  createMemberOrder,
  type BeanPackage,
  type MemberPlan,
  getOrderStatus,
} from '../../services/order'
import { useMerchantStore } from '../../store/merchant'
import Segmented from '../../components/segmented'
import './index.scss'

type Tab = 'subscribe' | 'bean'

function fenToYuan(fen: number): string {
  return (fen / 100).toFixed(fen % 100 === 0 ? 0 : 2)
}

function fmtDate(s: string | null): string {
  if (!s) return ''
  const d = new Date(s)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function Recharge() {
  const router = useRouter()
  const redirect = router.params.redirect ? decodeURIComponent(router.params.redirect) : ''
  const balance = useMerchantStore((s) => s.available)
  const isMember = useMerchantStore((s) => s.isMember)
  const grantBalance = useMerchantStore((s) => s.grantBalance)
  const memberEndAt = useMerchantStore((s) => s.memberEndAt)
  const refreshMe = useMerchantStore((s) => s.refreshMe)

  const [tab, setTab] = useState<Tab>('subscribe')
  const [beans, setBeans] = useState<BeanPackage[]>([])
  const [plans, setPlans] = useState<MemberPlan[]>([])
  const [busy, setBusy] = useState(false)
  // P0-7 同类：`if (busy) return` 依赖异步 state，连点两次会各自下出一笔订单。
  // 用同步 ref 做真正的闸门。（开发环境的演示支付会自动置 PAID 并发积分，连点等于重复发积分。）
  const busyLock = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const [pendingOrderNo, setPendingOrderNo] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current)
  }, [])

  const confirmOrder = (orderNo: string, attempt = 0): void => {
    getOrderStatus(orderNo).then((order) => {
      if (order.status === 'PAID') {
        setConfirming(false)
        setPendingOrderNo(null)
        void refreshMe()
        Taro.showToast({ title: '到账成功', icon: 'success' })
        if (redirect) setTimeout(() => Taro.redirectTo({ url: redirect }), 500)
        return
      }
      if (['CANCELLED', 'EXPIRED', 'REFUNDED'].includes(order.status)) {
        setConfirming(false)
        Taro.showToast({ title: '订单未完成，请勿重复支付', icon: 'none' })
        return
      }
      if (attempt < 8) {
        pollTimer.current = setTimeout(() => confirmOrder(orderNo, attempt + 1), 1500)
      }
    }).catch(() => {
      if (attempt < 8) pollTimer.current = setTimeout(() => confirmOrder(orderNo, attempt + 1), 2000)
    })
  }

  const load = () => {
    Promise.all([listBeanPackages(), listMemberPlans()])
      .then(([b, p]) => {
        setBeans(b)
        setPlans(p)
      })
      .catch(() => undefined)
  }

  useEffect(() => {
    Taro.setNavigationBarTitle({ title: '订阅与积分' })
  }, [])

  useEffect(() => {
    load()
    refreshMe().catch(() => undefined)
  }, [refreshMe])

  const pay = async (kind: Tab, packageId: string) => {
    if (busyLock.current) return
    // v5：加油包仅订阅用户可买
    if (kind === 'bean' && !isMember) {
      Taro.showToast({ title: '加油包仅订阅用户可购买', icon: 'none' })
      return
    }
    busyLock.current = true
    setBusy(true)
    try {
      const r = kind === 'bean' ? await createBeanOrder(packageId) : await createMemberOrder(packageId)
      if (r.dev) {
        setPendingOrderNo(r.orderNo)
        setConfirming(true)
        Taro.showToast({ title: '测试订单确认中', icon: 'none' })
        confirmOrder(r.orderNo)
        return
      }
      if (!r.payParams) {
        Taro.showToast({ title: '下单失败', icon: 'none' })
        return
      }
      let paymentSucceeded = false
      await new Promise<void>((resolve) => {
        Taro.requestPayment({
          ...r.payParams!,
          success: () => {
            paymentSucceeded = true
            Taro.showToast({ title: '支付完成，等待到账', icon: 'none' })
            resolve()
          },
          fail: (e) => {
            Taro.showToast({ title: e.errMsg?.includes('cancel') ? '已取消' : '支付失败', icon: 'none' })
            resolve()
          },
        })
      })
      if (paymentSucceeded) {
        setPendingOrderNo(r.orderNo)
        setConfirming(true)
        confirmOrder(r.orderNo)
        Taro.showToast({ title: '支付完成，订单确认中', icon: 'none' })
      }
    } catch {
      /* 2005/3006/3007 已 toast */
    } finally {
      busyLock.current = false
      setBusy(false)
    }
  }

  return (
    <View className='recharge'>
      {confirming && (
        <View className='ds-notice recharge__confirming'>
          支付已完成，订单 {pendingOrderNo ?? ''} 确认中，正在核对到账状态，请勿重复购买。
        </View>
      )}
      <View className='recharge__balance'>
        <Text className='recharge__balabel'>当前可用积分</Text>
        <Text className='recharge__banum'>{balance}</Text>
        {Number(grantBalance) > 0 && <Text className='recharge__bagrant'>（赠积分 {grantBalance}）</Text>}
      </View>

      <Segmented
        className='recharge__tabs'
        options={[
          { value: 'subscribe', label: '订阅' },
          { value: 'bean', label: '加油包' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
      />

      {tab === 'subscribe' && (
        <View className='recharge__list'>
          {isMember && (
            <View className='recharge__hint'>已订阅 · 至 {fmtDate(memberEndAt)}，续费可叠加时长与赠积分</View>
          )}
          {plans.length === 0 && <View className='recharge__empty'>暂无订阅套餐（后台未配置）</View>}
          {plans.map((p, idx) => {
            const rec = idx === 0
            return (
              <View className={`recharge__card ${rec ? 'recharge__card--rec' : ''}`} key={p.id}>
                {rec && <Text className='recharge__badge'>最超值</Text>}
                <View className='recharge__cardtop'>
                  <View className='recharge__cardmain'>
                    <Text className='recharge__name'>{p.name}</Text>
                    <Text className='recharge__sub'>有效期 {p.durationDays} 天 · 赠积分 {p.grantBeans}</Text>
                  </View>
                  <View className='recharge__price'>
                    <View className='recharge__now'>
                      <Text className='recharge__cny'>¥</Text>
                      <Text className='recharge__num ds-num'>{fenToYuan(p.priceFen)}</Text>
                    </View>
                    {!!p.tag && <Text className='recharge__tag'>{p.tag}</Text>}
                  </View>
                </View>
                <Button
                  className={`recharge__buy ${rec ? 'recharge__buy--rec' : ''}`}
                  loading={busy}
                  disabled={busy}
                  onClick={() => pay('subscribe', p.id)}
                >
                  {isMember ? (rec ? '立即续费' : '续费') : (rec ? '立即开通' : '开通')}
                </Button>
              </View>
            )
          })}
        </View>
      )}

      {tab === 'bean' && (
        <View className='recharge__list'>
          {!isMember && (
            <View className='recharge__locktip' onClick={() => setTab('subscribe')}>
              加油包仅订阅用户可购买，先开通订阅 ›
            </View>
          )}
          {beans.length === 0 && <View className='recharge__empty'>暂无加油包（后台未配置）</View>}
          {beans.map((p) => (
            <View className={`recharge__card ${!isMember ? 'recharge__card--off' : ''}`} key={p.id}>
              <View className='recharge__cardtop'>
                <View className='recharge__cardmain'>
                  <Text className='recharge__name'>{Number(p.beans) + Number(p.bonusBeans)} 积分</Text>
                  <Text className='recharge__sub'>1 元 = 100 积分{Number(p.bonusBeans) > 0 ? ` · 额外赠送 ${p.bonusBeans}` : ''}</Text>
                </View>
                <View className='recharge__price'>
                  <View className='recharge__now'>
                    <Text className='recharge__cny'>¥</Text>
                    <Text className='recharge__num ds-num'>{fenToYuan(p.priceFen)}</Text>
                  </View>
                  {!!p.tag && <Text className='recharge__tag'>{p.tag}</Text>}
                </View>
              </View>
              <Button
                className='recharge__buy'
                loading={busy}
                disabled={!isMember || busy}
                onClick={() => pay('bean', p.id)}
              >
                购买
              </Button>
            </View>
          ))}
        </View>
      )}

      <View className='recharge__footer'>
        <Text className='recharge__rule'>· 订阅是文案、分镜、合成能力的前置条件</Text>
        <Text className='recharge__rule'>· 1 元 = 100 积分，加油包仅订阅用户可购买</Text>
        <Text className='recharge__rule'>· 机器合成按素材有效时长计费，失败全额返还</Text>
        <Text className='recharge__rule'>· 支付以服务端订单状态为准，重复下载不扣积分</Text>
      </View>
    </View>
  )
}
