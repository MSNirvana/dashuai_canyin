import { useEffect, useRef, useState } from 'react'
import { Button, Image, Input, View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import * as authApi from '../../services/auth'
import { pickAndUploadAvatar } from '../../services/profile'
import { listMembershipReminders, markMembershipReminderRead, type MembershipReminder } from '../../services/account'
import { STORAGE_KEYS } from '../../config'
import { useMerchantStore } from '../../store/merchant'
import logoPng from '../../assets/logo.png'
import './index.scss'

function fmtDate(s: string | null): string {
  if (!s) return ''
  const d = new Date(s)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function humanBytes(b: string): string {
  const n = Number(b)
  const GB = 1024 * 1024 * 1024
  if (n >= GB) return `${(n / GB).toFixed(2)}GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  if (n > 0) return `${Math.round(n / 1024)}KB`
  return '0B'
}

const PHONE_RE = /^1[3-9]\d{9}$/
const CODE_RE = /^\d{6}$/
/** 开发登录固定使用的演示账号。刻意**不**取短信输入框的值 —— 否则「开发登录」与
 *  「手机号登录」两个入口共用一个输入框，测短信时会静默登成演示账号。 */
const DEV_PHONE = '13800000000'

export default function Mine() {
  const merchant = useMerchantStore((s) => s.merchant)
  const isMember = useMerchantStore((s) => s.isMember)
  const memberPlanName = useMerchantStore((s) => s.memberPlanName)
  const memberEndAt = useMerchantStore((s) => s.memberEndAt)
  const storageUsed = useMerchantStore((s) => s.storageUsed)
  const storageQuota = useMerchantStore((s) => s.storageQuota)
  const storageSubscribed = useMerchantStore((s) => s.storageSubscribed)
  const refreshMe = useMerchantStore((s) => s.refreshMe)
  const refreshProfile = useMerchantStore((s) => s.refreshProfile)
  const setProfile = useMerchantStore((s) => s.setProfile)
  const avatarUrl = useMerchantStore((s) => s.avatarUrl)
  const token = useMerchantStore((s) => s.token)
  const setLogin = useMerchantStore((s) => s.setLogin)
  const logout = useMerchantStore((s) => s.logout)

  const [loading, setLoading] = useState(true)
  const [showLogin, setShowLogin] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [devMode, setDevMode] = useState(false)
  const [reminders, setReminders] = useState<MembershipReminder[]>([])
  const loginRequest = useRef(0)

  // ── 短信登录（备选通道）──
  // 存在理由：微信一键登录拿的是**本人**微信绑定的手机号，员工帮店主管理 / 代运营时
  // 无法登录他人账号，所以需要一个不依赖微信的入口。
  const [mode, setMode] = useState<'wechat' | 'sms'>('wechat')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [smsSubmitting, setSmsSubmitting] = useState(false)

  // 再入闸门必须用**同步 ref**：React setState 是异步的，且 Taro 经 native setData 下发属性
  // （双异步），仅靠 state / disabled 挡不住连点。
  // 连点「获取验证码」的代价是实打实的：用户多收一条、我们多花一条钱、还会撞上 60s 冷却。
  const sendLock = useRef(false)
  const smsLoginLock = useRef(false)
  /** 换头像的门闩：上传要几百毫秒，连点会并发发两次，后到的覆盖先到的（用户看到的不是自己选的那张） */
  const avatarLock = useRef(false)
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useDidShow(() => {
    const currentToken = Taro.getStorageSync<string>(STORAGE_KEYS.token) || ''
    if (!currentToken && useMerchantStore.getState().token) logout()
    setShowLogin(!currentToken)
    if (currentToken) {
      Promise.all([
        refreshMe(),
        // 昵称与头像不在 /orders/me 里，必须单独拉一次；失败不能连累整页（头像空着也能用）
        refreshProfile().catch(() => undefined),
        listMembershipReminders().then(setReminders),
      ]).catch(() => undefined).finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  })

  useEffect(() => {
    if (!showLogin) return
    authApi.getDevMode().then((r) => setDevMode(r.enabled)).catch(() => setDevMode(false))
    // 每次**重新打开**弹窗都回到微信入口：留着上次输入的手机号/验证码只会让人困惑，
    // 而验证码 5 分钟就失效了。注意这个 effect 只在 showLogin false→true 时跑，
    // 从协议页返回时弹窗一直是 true，不会把用户正在输入的短信表单清掉。
    setMode('wechat')
    setCode('')
  }, [showLogin])

  // 卸载时清掉冷却定时器：它每秒 setState，组件没了还在跑就是内存泄漏
  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current)
    }
  }, [])

  useEffect(() => {
    const requireLogin = () => {
      logout()
      setShowLogin(true)
    }
    Taro.eventCenter.on('auth:required', requireLogin)
    return () => {
      Taro.eventCenter.off('auth:required', requireLogin)
    }
  }, [logout])

  const onGetPhoneNumber = async (e: { detail: { code?: string } }) => {
    const phoneCode = e.detail?.code
    if (!phoneCode) {
      Taro.showToast({ title: '需要授权手机号才能登录', icon: 'none' })
      return
    }
    if (submitting) return
    const requestNo = ++loginRequest.current
    setSubmitting(true)
    try {
      const loginRes = await Taro.login()
      const res = await authApi.wechatLogin({ phoneCode, wxLoginCode: loginRes.code })
      if (requestNo !== loginRequest.current) return
      setLogin(res)
      setShowLogin(false)
      await refreshMe().catch(() => undefined)
      Taro.showToast({ title: '登录成功', icon: 'success' })
    } catch (err) {
      Taro.showToast({ title: (err as { message?: string })?.message ?? '登录失败，请重试', icon: 'none', duration: 2500 })
    } finally {
      if (requestNo === loginRequest.current) setSubmitting(false)
    }
  }

  const onDevLogin = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      const res = await authApi.devLogin(DEV_PHONE)
      setLogin(res)
      setShowLogin(false)
      await refreshMe().catch(() => undefined)
      Taro.showToast({ title: '开发登录成功', icon: 'success' })
    } catch (err) {
      Taro.showToast({ title: (err as { message?: string })?.message ?? '开发登录失败', icon: 'none', duration: 2500 })
    } finally {
      setSubmitting(false)
    }
  }

  const toastErr = (err: unknown, fallback: string) => {
    Taro.showToast({ title: (err as { message?: string })?.message ?? fallback, icon: 'none', duration: 2500 })
  }

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
      Taro.showToast({ title: '验证码已发送', icon: 'success' })
    } catch (err) {
      toastErr(err, '发送失败，请稍后重试')
    } finally {
      sendLock.current = false
    }
  }

  /** 手机号 + 验证码登录（登录他人账号的唯一通道） */
  const onSmsLogin = async () => {
    if (!PHONE_RE.test(phone)) {
      Taro.showToast({ title: '请输入正确的手机号', icon: 'none' })
      return
    }
    if (!CODE_RE.test(code)) {
      Taro.showToast({ title: '请输入 6 位验证码', icon: 'none' })
      return
    }
    if (smsLoginLock.current) return
    smsLoginLock.current = true
    setSmsSubmitting(true)
    try {
      const res = await authApi.loginByPhone(phone, code)
      setLogin(res)
      setShowLogin(false)
      await refreshMe().catch(() => undefined)
      Taro.showToast({ title: '登录成功', icon: 'success' })
    } catch (err) {
      toastErr(err, '登录失败，请重试')
    } finally {
      smsLoginLock.current = false
      setSmsSubmitting(false)
    }
  }

  // 带上 fail：跳转失败时把目标 url 打进日志。
  // 否则失败会以「navigateTo:fail timeout」的形式被抛到 App.onError，
  // 控制台里只有一堆 WAServiceMainContext 的栈，看不到是哪个页面挂了。
  const go = (url: string) =>
    Taro.navigateTo({ url, fail: (e) => console.warn('[nav] 跳转失败', url, e?.errMsg) })

  /**
   * 点头像直接换头像（不跳页）。
   *
   * 与个人主页共用 `pickAndUploadAvatar()`：选图 + multipart 上传 + 服务端写 merchant.avatar_key。
   * 一并在本页做，是因为用户对这个入口的预期是「点头像就能换」，多一跳反而多一次犹豫。
   * 服务端返回的是**最新完整资料**，所以顺手把昵称也同步了（避免两处显示不一致）。
   */
  const onChangeAvatar = async () => {
    // 未登录时弹窗可以被 × 关掉，页面上仍留着这个头像位；没有 token 就先别发起上传
    if (!token) return
    if (avatarLock.current) return
    avatarLock.current = true
    try {
      const p = await pickAndUploadAvatar()
      // null = 用户在选图器里点了取消，不是失败：静默返回，不弹错误
      if (!p) return
      setProfile({ nickname: p.nickname, avatarUrl: p.avatarUrl })
      Taro.showToast({ title: '头像已更新', icon: 'success' })
    } catch (err) {
      toastErr(err, '头像上传失败')
    } finally {
      avatarLock.current = false
    }
  }

  /**
   * 退出登录。
   *
   * 只清**本地**会话（store.logout() → clearSession() 清 token/refreshToken/商户信息 +
   * store 重置）。服务端的 refreshToken 是**无状态 JWT**（30 天有效期），
   * 目前没有吊销接口，所以退出后旧 refreshToken 在有效期内仍可换新 token ——
   * 见「服务端无 /auth/logout」的遗留说明，不要以为这里已经把它作废了。
   *
   * 三处必须一起清，否则会出现「换账号登录后看到上一个人的数据」：
   *   · store.logout()      商户信息 / 积分 / 会员 / 门店
   *   · setReminders([])    会员到期提醒（本页状态，来自上一个账号）
   *   · setPhone('')        短信登录输入框里残留的上一个手机号
   */
  const onLogout = () => {
    // 二次确认：退出不可逆（要重新走微信授权或短信验证码），误触代价明显
    Taro.showModal({
      title: '退出登录',
      content: '退出后需要重新登录才能继续使用 AI 创作。',
      confirmText: '退出',
      confirmColor: '#c21b12',
      success: (r) => {
        if (!r.confirm) return
        logout()
        setReminders([])
        setPhone('')
        setCode('')
        // 本页的「未登录态」就是登录弹窗（与 useDidShow 里 setShowLogin(!token) 保持一致），
        // 必须显式置 true：退出时页面不会重新 onShow，否则会停在一个不刷新的空壳页上。
        setShowLogin(true)
        Taro.showToast({ title: '已退出登录', icon: 'none' })
      },
    })
  }
  const quotaNum = Number(storageQuota)
  const usedNum = Number(storageUsed)
  const pct = quotaNum > 0 ? Math.min(100, Math.round((usedNum / quotaNum) * 100)) : 0

  return (
    <View className='mine'>
      {/* ── 头像区 ── */}
      <View className='mine__head'>
        <View className='mine__head-deco' />
        {/* 点头像 = 直接换头像（不跳页）；点用户名 = 进个人主页改昵称等 */}
        <View className='mine__avatarbox' onClick={onChangeAvatar} hoverClass='ds-hover'>
          <View className='mine__avatar'>
            {avatarUrl ? (
              <Image className='mine__avatar-img' src={avatarUrl} mode='aspectFill' />
            ) : (
              <Text>{merchant?.nickname?.[0] ?? (merchant?.phone?.[0] ?? '客')}</Text>
            )}
          </View>
          {/* 角标放在裁剪容器外：圆形 overflow:hidden 会把圆外的角标裁掉 */}
          <View className='mine__avatar-badge'>
            <t-icon name='camera' size='22rpx' color='#ffffff' />
          </View>
        </View>
        <View className='mine__info'>
          <Text className='mine__name' onClick={() => go('/pages/profile/index')}>
            {merchant?.nickname || merchant?.phone || '未登录'}
          </Text>
          {isMember ? (
            <View className='mine__vipwrap'>
              <Text className='ds-pill ds-pill--gold mine__vip--on'>
                <t-icon name='user-vip' size='24rpx' color='#a8741f' /> {memberPlanName}
              </Text>
              <Text className='mine__vipend'>至 {fmtDate(memberEndAt)}</Text>
            </View>
          ) : (
            <View className='mine__vipwrap' onClick={() => go('/pages/recharge/index')}>
              <Text className='ds-pill ds-pill--red-outline'>未订阅</Text>
              <Text className='mine__vipend mine__vipend--cta'>去开通 ›</Text>
            </View>
          )}
        </View>
      </View>

      {/* 积分卡（余额概览 + 充值入口）已整体搬到「个人主页」；本页保留下方菜单里的「订阅与积分」入口 */}
      {reminders.map((item) => (
        <View key={item.id} className='mine__tip' onClick={() => {
          void markMembershipReminderRead(item.id)
          setReminders((items) => items.filter((v) => v.id !== item.id))
        }}>
          会员将在 {item.reminderDays} 天后到期，点击前往续费 ›
        </View>
      ))}
      {/* ── 空间 ── */}
      <View className='mine__storage'>
        <View className='mine__storagehead'>
          <Text className='mine__storagetitle'>
            <t-icon name='cloud' size='14px' color='#646a73' /> 上传空间{storageSubscribed ? ' · 订阅 5GB' : ' · 普通 1GB'}
          </Text>
          <Text className='mine__storageval'>{humanBytes(storageUsed)} / {humanBytes(storageQuota)}</Text>
        </View>
        <View className='mine__storagebar'>
          <View
            className='mine__storagefill'
            style={{ width: `${pct}%`, background: pct >= 90 ? '#c4892c' : undefined }}
          />
        </View>
      </View>

      {/* ── 账户与门店资料：这里管理“我是谁”和“我的资产”，不重复首页创作入口 ── */}
      <View className='ds-label'>我的资料</View>
      <View className='mine__menu'>
        <View className='mine__item' onClick={() => go('/pages/store/list')}>
          <View className='mine__item-icon mine__item-icon--red'><t-icon name='shop' size='32rpx' /></View>
          <View className='mine__item-copy'><Text className='mine__item-title'>门店资料</Text><Text className='mine__item-desc'>门店信息与老板人设</Text></View>
          <Text className='mine__arrow'>›</Text>
        </View>
        <View className='mine__item' onClick={() => go('/pages/dish/list')}>
          <View className='mine__item-icon mine__item-icon--green'><t-icon name='rice' size='32rpx' /></View>
          <View className='mine__item-copy'><Text className='mine__item-title'>菜品管理</Text><Text className='mine__item-desc'>维护菜品图片与卖点</Text></View>
          <Text className='mine__arrow'>›</Text>
        </View>
        <View className='mine__item' onClick={() => go('/pages/recharge/index')}>
          <View className='mine__item-icon mine__item-icon--gold'><t-icon name='wallet' size='32rpx' /></View>
          <View className='mine__item-copy'><Text className='mine__item-title'>订阅与积分</Text><Text className='mine__item-desc'>管理会员权益与创作额度</Text></View>
          <Text className='mine__arrow'>›</Text>
        </View>
      </View>
      {/* ── 退出登录 ── 只在已登录时显示（未登录态本页被登录弹窗覆盖） */}
      {token && <View className='mine__logout' onClick={onLogout}>退出登录</View>}

      {loading && <View className='mine__tip'>加载中…</View>}

      {showLogin && !token && <View className='mine__login-mask' catchMove>
        <View className='mine__login-modal'>
          <View className='mine__login-close' onClick={() => setShowLogin(false)}>×</View>
          <Image className='mine__login-logo' src={logoPng} mode='aspectFit' />
          <Text className='mine__login-title'>登录大帅餐饮</Text>
          <Text className='mine__login-desc'>
            {mode === 'sms' ? '用手机号验证码登录，可管理他人账号' : '登录后管理门店并开始创作'}
          </Text>

          {mode === 'sms' ? (
            <>
              <View className='mine__login-field'>
                <Input
                  className='mine__login-input'
                  type='number'
                  maxlength={11}
                  value={phone}
                  placeholder='请输入手机号'
                  onInput={(e) => setPhone(e.detail.value)}
                />
              </View>
              <View className='mine__login-field'>
                <Input
                  className='mine__login-input'
                  type='number'
                  maxlength={6}
                  value={code}
                  placeholder='请输入 6 位验证码'
                  onInput={(e) => setCode(e.detail.value)}
                />
                <Text
                  className={`mine__login-code${cooldown > 0 ? ' is-disabled' : ''}`}
                  onClick={onSendCode}
                >
                  {cooldown > 0 ? `${cooldown}s 后重发` : '获取验证码'}
                </Text>
              </View>
              <Button className='mine__login-primary' onClick={onSmsLogin} disabled={smsSubmitting}>
                {smsSubmitting ? '登录中…' : '登录'}
              </Button>
              <View className='mine__login-switch' onClick={() => setMode('wechat')}>
                {devMode ? '返回本地开发登录' : '返回微信一键登录'}
              </View>
            </>
          ) : (
            <>
              {devMode ? (
                <Button className='mine__login-primary' onClick={onDevLogin} disabled={submitting}>
                  {submitting ? '登录中…' : '进入本地开发环境'}
                </Button>
              ) : (
                <Button className='mine__login-primary' openType='getPhoneNumber' onGetPhoneNumber={onGetPhoneNumber} disabled={submitting}>
                  {submitting ? '登录中…' : '微信一键登录'}
                </Button>
              )}
              {/* 代运营 / 帮店主管理时，微信一键登录只能拿到本人手机号 ⇒ 必须留这条不依赖微信的通道 */}
              <View className='mine__login-switch' onClick={() => setMode('sms')}>
                使用其他手机号登录
              </View>
            </>
          )}

          {devMode && mode === 'wechat' && (
            <View className='mine__login-devtip'>当前为本地开发账号，不触发微信手机号授权</View>
          )}
          <Text className='mine__login-tip'>授权即表示同意<Text className='mine__login-link' onClick={() => go('/pages/agreement/index?type=user')}>《用户协议》</Text>和<Text className='mine__login-link' onClick={() => go('/pages/agreement/index?type=privacy')}>《隐私政策》</Text></Text>
        </View>
      </View>}
    </View>
  )
}
