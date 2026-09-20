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
  queryOrder,
} from '../../services/order'
import { useMerchantStore } from '../../store/merchant'
import Segmented from '../../components/segmented'
// 到期日只要「到日为止」，但仍走统一入口（原来这里有一份自己的 fmtDate，三个页面各写一份必然漂移）
import { formatDay } from '../../utils/time'
// 同理：金额的「分 → 元」也收进 utils/money.ts（套餐价上线后会出现第二个用价的地方）
import { fenToYuan } from '../../utils/money'
import './index.scss'

type Tab = 'subscribe' | 'bean'

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
    // 离开页面：作废代次，让**已经在飞**的那次 queryOrder 回包也不再 setState
    // （只 clearTimeout 只能拦住「还没发出的下一次」，拦不住当前这次请求的回包）
    confirmGen.current += 1
    if (pollTimer.current) clearTimeout(pollTimer.current)
  }, [])

  // 支付完成后的确认轮询。
  //
  // ★ 用 queryOrder（主动查单）而不是 getOrderStatus（只读本地库）：
  //   本地库在「回调丢了」时会永远停在 PENDING，只读本地等于让用户干等一笔已经付过的钱。
  //   主动查单会让服务端去微信确认并当场补发权益，正常情况下第 1 次就能到账。
  //   后端返回 5xx（微信超时/验签不通过）时走 catch 继续重试，绝不把「查不到」当成「没付」。
  const MAX_CONFIRM_ATTEMPTS = 6
  /**
   * 确认轮询的代次。
   *
   * ★ 为什么必须有序号：一轮轮询最长要 6×2s ≈ 12s，而 busyLock 在支付回调一返回就放开了，
   *   用户完全可能在「第一笔还在确认中」时又买第二笔。两条链同时在飞有两个很坏的后果：
   *   · 第一条链查到 PAID 就 `setPendingOrderNo(null)` + 弹「到账成功」—— 那是用户**上一笔**的钱，
   *     而当前这笔还在路上。用户会以为第二笔也到账了，其实只是页面不再提它；
   *     反过来，第一条链走到失败分支会把第二条链的「确认中」关掉、弹「暂未查到支付结果」。
   *   · `pollTimer` 只有一个 ref 槽位，被后一条链覆盖后前一条就再也取消不掉 ——
   *     页面卸载时 clearTimeout 只清得掉最后一条。
   *   ⇒ 发起新的一轮时作废旧的（清定时器 + 代次自增），过期代次的回包一律丢弃。
   */
  const confirmGen = useRef(0)
  const confirmOrder = (orderNo: string): void => {
    confirmGen.current += 1
    if (pollTimer.current) {
      clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
    pollOrder(orderNo, 0, confirmGen.current)
  }
  const pollOrder = (orderNo: string, attempt: number, gen: number): void => {
    if (gen !== confirmGen.current) return
    queryOrder(orderNo).then((order) => {
      // 已被新的一轮取代：这一笔的状态既不该显示、也不该据此改「确认中」
      if (gen !== confirmGen.current) return
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
      if (attempt < MAX_CONFIRM_ATTEMPTS) {
        pollTimer.current = setTimeout(() => pollOrder(orderNo, attempt + 1, gen), 2000)
      } else {
        // 已经反复向微信查过单仍未支付成功：交给后台对账兜底，别让用户一直盯着「确认中」
        setConfirming(false)
        Taro.showToast({ title: '暂未查到支付结果，到账后会自动开通', icon: 'none' })
      }
    }).catch(() => {
      if (gen !== confirmGen.current) return
      if (attempt < MAX_CONFIRM_ATTEMPTS) {
        pollTimer.current = setTimeout(() => pollOrder(orderNo, attempt + 1, gen), 2500)
      }
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
            <View className='recharge__hint'>已订阅 · 至 {formatDay(memberEndAt)}，续费可叠加时长与赠积分</View>
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
            <View className={`recharge__card recharge__card--row ${!isMember ? 'recharge__card--off' : ''}`} key={p.id}>
              <View className='recharge__cardmain'>
                <Text className='recharge__name'>{Number(p.beans) + Number(p.bonusBeans)} 积分</Text>
                <Text className='recharge__sub'>1 元 = 100 积分{Number(p.bonusBeans) > 0 ? ` · 额外赠送 ${p.bonusBeans}` : ''}</Text>
              </View>
              <View className='recharge__price'>
                <View className='recharge__now'>
                  <Text className='recharge__cny'>¥</Text>
                  <Text className='recharge__num recharge__num--row ds-num'>{fenToYuan(p.priceFen)}</Text>
                </View>
                {!!p.tag && <Text className='recharge__tag'>{p.tag}</Text>}
              </View>
              {/* 行内小按钮刻意不挂原生 loading：它会在文字前插一个图标，把「贴着文字」的按钮撑宽（点一下跳一下）。
                  反馈交给 disabled 态（原生 disabled 样式会把按钮压灰）与顶部「订单确认中」横幅。 */}
              <Button
                className='recharge__buy recharge__buy--row'
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
