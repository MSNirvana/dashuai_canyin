import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from '@tarojs/taro'
import * as authApi from '../../services/auth'
import AgreeCheckbox from '../../components/agree-checkbox'
import { listOrders, type OrderListItem } from '../../services/order'
import { STORAGE_KEYS } from '../../config'
import { useMerchantStore } from '../../store/merchant'
import { fenToYuan } from '../../utils/money'
import { formatMinute } from '../../utils/time'
import './list.scss'

/**
 * 订单中心（微信「订单中心页」）。
 *
 * ★★ 这一页不是普通功能页，它承担一条**平台合规要求**：
 *   微信 2022-12-31《关于小程序订单中心页设置的公告》——有「选择商品/服务 → 下单 → 支付」
 *   完整流程的小程序，须在小程序内设置订单中心页并把 path（本页＝`pages/order/list`）
 *   同步给平台，且该页须展示**所有涉及资金交易的订单明细**。
 *
 * ★★ 本页必须满足平台的「跳转规范」，写任何改动前先看这三条：
 *   ① 通过 path（**不拼参数**）进入可访问 —— 所以本页**不依赖任何 query**；
 *   ② 进入后**不得自动跳到首页**等其他页面；
 *   ③ 检测到无登录态时，要**在本页**引导登录，登录后**停留在本页**。
 *   ⇒ 这就是为什么下面要单独做一块「页内登录」，而不是把用户甩去「我的」tab：
 *     甩过去那一刻，平台校验看到的就是「订单中心页自动跳走了」，直接判不合规。
 *
 * ★ 无 token 时**绝不发请求**：`services/request.ts` 撞到 1001 会 `redirectToLogin()`，
 *   那是 `switchTab('/pages/mine/index')` —— 正好踩在上面的 ② 上。
 */

const PHONE_RE = /^1[3-9]\d{9}$/
const CODE_RE = /^\d{6}$/
const PAGE_SIZE = 20

/** 订单状态 → 文案。未收录的状态原样显示，不吞掉（后台加状态时前端不该白屏）。 */
const STATUS_TEXT: Record<string, string> = {
  PENDING: '待支付',
  PAID: '已支付',
  CANCELLED: '已取消',
  EXPIRED: '已超时',
  REFUNDED: '已退款',
  CLOSED: '已关闭',
}

/** 状态 → 样式修饰。只有「已支付」算正结果，「待支付」是进行中，其余都算终止。 */
function statusMod(status: string): string {
  if (status === 'PAID') return 'is-paid'
  if (status === 'PENDING') return 'is-pending'
  return 'is-dead'
}

const TYPE_TEXT: Record<string, string> = { MEMBER: '会员订阅', BEAN: '积分加油包' }

export default function OrderList() {
  const setLogin = useMerchantStore((s) => s.setLogin)
  const refreshMe = useMerchantStore((s) => s.refreshMe)

  const [needLogin, setNeedLogin] = useState(false)
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<OrderListItem[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  /** 拿不到数据时的页内提示。★ 不用 toast：平台校验爬这一页时看到的应是页面内容，不是一闪而过的提示 */
  const [failed, setFailed] = useState('')

  /** 已加载到第几页 */
  const pageRef = useRef(0)
  /** 请求在飞——**必须用 ref**：`setLoading` 是异步的，靠它挡不住 onReachBottom 的连点 */
  const inflightRef = useRef(false)

  // ── 页内登录（平台跳转规范 ③ 的唯一实现）──
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  /**
   * 是否已**主动勾选**同意《用户协议》和《隐私政策》。
   * ★ 默认 false，且本页的登录表单每次都是新挂载的 ⇒ 天然「每次都要重新勾」。
   * ★ 未勾选时「获取验证码」（会把手机号发给服务端）与「登录」都要挡住 ——
   *   这是第二个登录入口，与「我的」那个弹窗**共用同一个组件**，判据不会漂。
   */
  const [agreed, setAgreed] = useState(false)
  /** 未勾选同意时的统一拦截（与「我的」页同一句话） */
  const needAgree = () => {
    Taro.showToast({ title: '请先阅读并勾选同意《用户协议》和《隐私政策》', icon: 'none', duration: 2500 })
  }
  const sendLock = useRef(false)
  const loginLock = useRef(false)
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (page: number, mode: 'reset' | 'append') => {
    if (inflightRef.current) return
    inflightRef.current = true
    setLoading(true)
    try {
      const r = await listOrders(page, PAGE_SIZE)
      // ★ `mode === 'reset'` 用服务端回的整页覆盖；append 才拼 —— 否则下拉刷新会叠出重复订单
      setItems((prev) => (mode === 'reset' ? r.list : [...prev, ...r.list]))
      setTotal(r.total)
      setHasMore(r.hasMore)
      pageRef.current = r.page
      setFailed('')
    } catch (e) {
      setFailed((e as { message?: string })?.message ?? '订单加载失败，请下拉刷新重试')
    } finally {
      inflightRef.current = false
      setLoading(false)
    }
  }, [])

  useDidShow(() => {
    const token = Taro.getStorageSync<string>(STORAGE_KEYS.token) || ''
    setNeedLogin(!token)
    // 没有 token 就到此为止：见文件头 ③，这时候发请求会把页面跳走
    if (token) void load(1, 'reset')
  })

  useReachBottom(() => {
    if (needLogin || !hasMore) return
    void load(pageRef.current + 1, 'append')
  })

  usePullDownRefresh(() => {
    if (needLogin) {
      Taro.stopPullDownRefresh()
      return
    }
    void load(1, 'reset').finally(() => Taro.stopPullDownRefresh())
  })

  // 卸载时清掉冷却定时器：它每秒 setState，组件没了还在跑就是内存泄漏
  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current)
    }
  }, [])

  const startCooldown = (sec: number) => {
    if (cooldownTimer.current) clearInterval(cooldownTimer.current)
    setCooldown(sec)
    cooldownTimer.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          if (cooldownTimer.current) clearInterval(cooldownTimer.current)
          cooldownTimer.current = null
          return 0
        }
        return c - 1
      })
    }, 1000)
  }

  /** 获取短信验证码。冷却时长以后端返回的 cooldownSec 为准，不在前端写死。 */
  const onSendCode = async () => {
    if (cooldown > 0) return
    // ★ 未勾选同意就不发：这一步会把手机号发给服务端，属于「收集」
    if (!agreed) return needAgree()
    if (!PHONE_RE.test(phone)) {
      Taro.showToast({ title: '请输入正确的手机号', icon: 'none' })
      return
    }
    if (sendLock.current) return
    sendLock.current = true
    try {
      const r = await authApi.sendSmsCode(phone)
      const sec = typeof r?.cooldownSec === 'number' && r.cooldownSec > 0 ? r.cooldownSec : 60
      startCooldown(sec)
      // ★ 演示账号：服务端**没有**发短信。照旧弹「验证码已发送」会让人盯着一台不会响的手机等
      //   —— 正确的做法（直接把那枚码敲进去）就摆在眼前，这里必须说真话。
      Taro.showToast({
        title: r?.demoLogin ? '演示账号无需验证码，直接输码登录' : '验证码已发送',
        icon: r?.demoLogin ? 'none' : 'success',
        duration: r?.demoLogin ? 3000 : 1500,
      })
    } catch (err) {
      Taro.showToast({ title: (err as { message?: string })?.message ?? '发送失败，请稍后重试', icon: 'none', duration: 2500 })
    } finally {
      sendLock.current = false
    }
  }

  /**
   * 页内登录。登录成功后**停留本页**并立即加载订单（不跳转、不 switchTab）。
   */
  const onLogin = async () => {
    // ★ 提交给服务端前必须先取得同意
    if (!agreed) return needAgree()
    if (!PHONE_RE.test(phone)) {
      Taro.showToast({ title: '请输入正确的手机号', icon: 'none' })
      return
    }
    if (!CODE_RE.test(code)) {
      Taro.showToast({ title: '请输入 6 位验证码', icon: 'none' })
      return
    }
    if (loginLock.current) return
    loginLock.current = true
    setSubmitting(true)
    try {
      const res = await authApi.loginByPhone(phone, code)
      setLogin(res)
      // 余额/会员这些全局态刷新失败不该把「已登录」也拖失败，单独吞掉
      await refreshMe().catch(() => undefined)
      setNeedLogin(false)
      setCode('')
      Taro.showToast({ title: '登录成功', icon: 'success' })
      await load(1, 'reset')
    } catch (err) {
      Taro.showToast({ title: (err as { message?: string })?.message ?? '登录失败，请重试', icon: 'none', duration: 2500 })
    } finally {
      loginLock.current = false
      setSubmitting(false)
    }
  }

  const copyOrderNo = (orderNo: string) => {
    Taro.setClipboardData({ data: orderNo })
      .then(() => Taro.showToast({ title: '订单号已复制', icon: 'none' }))
      .catch(() => undefined)
  }

  const goSubscribe = () => {
    Taro.navigateTo({ url: '/pages/recharge/index', fail: () => undefined }).catch(() => undefined)
  }

  // ── 未登录：页内引导（平台跳转规范 ③）──
  if (needLogin) {
    return (
      <View className='order order--login'>
        <View className='order__login'>
          <Text className='order__login-title'>登录后查看订单</Text>
          <Text className='order__login-hint'>订单中心展示你账号下的全部资金交易记录</Text>
          <View className='order__field'>
            <Input
              className='order__input'
              type='number'
              maxlength={11}
              value={phone}
              placeholder='请输入手机号'
              onInput={(e) => setPhone(e.detail.value)}
            />
          </View>
          <View className='order__field'>
            <Input
              className='order__input'
              type='number'
              maxlength={6}
              value={code}
              placeholder='请输入 6 位验证码'
              onInput={(e) => setCode(e.detail.value)}
            />
            <Text className={`order__code${cooldown > 0 ? ' is-disabled' : ''}`} onClick={onSendCode}>
              {cooldown > 0 ? `${cooldown}s 后重发` : '获取验证码'}
            </Text>
          </View>
          <AgreeCheckbox checked={agreed} onChange={setAgreed} />
          <Button className='order__primary' onClick={onLogin} disabled={submitting}>
            {submitting ? '登录中…' : '登录'}
          </Button>
        </View>
      </View>
    )
  }

  return (
    <View className='order'>
      <View className='order__summary'>
        <Text className='order__summary-label'>全部订单</Text>
        <Text className='order__summary-num'>{total}</Text>
        <View className='order__summary-cta' onClick={goSubscribe}>
          <t-icon name='wallet' size='28rpx' color='#c21b12' />
          <Text className='order__summary-cta-text'>订阅与积分</Text>
        </View>
      </View>

      {!!failed && <View className='order__failed'>{failed}</View>}

      {items.map((o) => (
        <View key={o.orderNo} className='order__card'>
          <View className='order__row1'>
            <Text className='order__title'>{o.title}</Text>
            <Text className={`order__status ${statusMod(o.status)}`}>
              {STATUS_TEXT[o.status] ?? o.status}
            </Text>
          </View>

          <View className='order__row2'>
            <Text className='order__type'>{TYPE_TEXT[o.orderType] ?? o.orderType}</Text>
            {o.beans !== '0' && <Text className='order__beans'>积分 +{o.beans}</Text>}
          </View>

          <View className='order__row3'>
            <View className='order__metas'>
              <Text className='order__meta'>下单 {formatMinute(o.createdAt)}</Text>
              {!!o.paidAt && <Text className='order__meta'>支付 {formatMinute(o.paidAt)}</Text>}
            </View>
            <Text className={`order__amount ${o.status === 'PAID' ? 'is-paid' : ''}`}>
              ¥{fenToYuan(o.amountFen)}
            </Text>
          </View>

          <View className='order__row4' onClick={() => copyOrderNo(o.orderNo)}>
            <Text className='order__no'>订单号 {o.orderNo}</Text>
            <Text className='order__copy'>复制</Text>
          </View>
        </View>
      ))}

      {!loading && items.length === 0 && !failed && (
        <View className='order__empty'>
          <Text className='order__empty-title'>还没有订单</Text>
          <Text className='order__empty-hint'>开通会员或购买积分加油包后，记录会出现在这里</Text>
        </View>
      )}

      {items.length > 0 && (
        <View className='order__foot'>
          {loading ? '加载中…' : hasMore ? '上拉加载更多' : '没有更多了'}
        </View>
      )}

      {loading && items.length === 0 && <View className='order__foot'>加载中…</View>}
    </View>
  )
}
