import { useEffect, useRef, useState } from 'react'
import { Button, Image, View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import * as authApi from '../../services/auth'
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

export default function Mine() {
  const merchant = useMerchantStore((s) => s.merchant)
  const available = useMerchantStore((s) => s.available)
  const rechargeBalance = useMerchantStore((s) => s.rechargeBalance)
  const frozen = useMerchantStore((s) => s.frozen)
  const grantBalance = useMerchantStore((s) => s.grantBalance)
  const isMember = useMerchantStore((s) => s.isMember)
  const memberPlanName = useMerchantStore((s) => s.memberPlanName)
  const memberEndAt = useMerchantStore((s) => s.memberEndAt)
  const storageUsed = useMerchantStore((s) => s.storageUsed)
  const storageQuota = useMerchantStore((s) => s.storageQuota)
  const storageSubscribed = useMerchantStore((s) => s.storageSubscribed)
  const refreshMe = useMerchantStore((s) => s.refreshMe)
  const token = useMerchantStore((s) => s.token)
  const setLogin = useMerchantStore((s) => s.setLogin)
  const logout = useMerchantStore((s) => s.logout)

  const [loading, setLoading] = useState(true)
  const [showLogin, setShowLogin] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [devMode, setDevMode] = useState(false)
  const [reminders, setReminders] = useState<MembershipReminder[]>([])
  const [phone] = useState('')
  const loginRequest = useRef(0)

  useDidShow(() => {
    const currentToken = Taro.getStorageSync<string>(STORAGE_KEYS.token) || ''
    if (!currentToken && useMerchantStore.getState().token) logout()
    setShowLogin(!currentToken)
    if (currentToken) {
      Promise.all([
        refreshMe(),
        listMembershipReminders().then(setReminders),
      ]).catch(() => undefined).finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  })

  useEffect(() => {
    if (!showLogin) return
    authApi.getDevMode().then((r) => setDevMode(r.enabled)).catch(() => setDevMode(false))
  }, [showLogin])

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
      const res = await authApi.devLogin(/^1[3-9]\d{9}$/.test(phone) ? phone : '13800000000')
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

  const go = (url: string) => Taro.navigateTo({ url })
  const quotaNum = Number(storageQuota)
  const usedNum = Number(storageUsed)
  const pct = quotaNum > 0 ? Math.min(100, Math.round((usedNum / quotaNum) * 100)) : 0

  return (
    <View className='mine'>
      {/* ── 头像区 ── */}
      <View className='mine__head'>
        <View className='mine__head-deco' />
        <View className='mine__avatar'>{merchant?.nickname?.[0] ?? (merchant?.phone?.[0] ?? '客')}</View>
        <View className='mine__info'>
          <Text className='mine__name'>{merchant?.nickname || merchant?.phone || '未登录'}</Text>
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

      {/* ── 积分卡 ── */}
      <View className='mine__bean'>
        <View className='mine__beantop'>
          <View className='mine__beancell'>
            <Text className='mine__beannum'>{available}</Text>
            <Text className='mine__beanlabel'>可用积分</Text>
          </View>
          <View className='mine__beandiv' />
          <View className='mine__beancell'>
            <Text className='mine__beannum mine__beannum--gold'>{grantBalance}</Text>
            <Text className='mine__beanlabel'>赠积分</Text>
          </View>
          <View className='mine__beandiv' />
          <View className='mine__beancell'>
            <Text className='mine__beannum'>{frozen}</Text>
            <Text className='mine__beanlabel'>冻结中</Text>
          </View>
        </View>
        <View
          className='ds-btn ds-btn--soft ds-btn--block mine__beanbtn'
          hoverClass='ds-hover'
          onClick={() => go('/pages/recharge/index')}
        >
          订阅 / 加油包
        </View>
      </View>

      <View className='mine__tip'>购买积分 {rechargeBalance}{memberEndAt ? ' · 赠积分到期 ' + fmtDate(memberEndAt) : ''}</View>
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
          <View className='mine__item-copy'><Text className='mine__item-title'>门店资料</Text><Text className='mine__item-desc'>门店信息、菜品库与老板人设</Text></View>
          <Text className='mine__arrow'>›</Text>
        </View>
        <View className='mine__item' onClick={() => go('/pages/recharge/index')}>
          <View className='mine__item-icon mine__item-icon--gold'><t-icon name='wallet' size='32rpx' /></View>
          <View className='mine__item-copy'><Text className='mine__item-title'>订阅与积分</Text><Text className='mine__item-desc'>管理会员权益与创作额度</Text></View>
          <Text className='mine__arrow'>›</Text>
        </View>
      </View>
      <View className='mine__privacy'>你的门店资料只用于生成更贴合本店的内容</View>

      {loading && <View className='mine__tip'>加载中…</View>}

      {showLogin && !token && <View className='mine__login-mask' catchMove>
        <View className='mine__login-modal'>
          <View className='mine__login-close' onClick={() => setShowLogin(false)}>×</View>
          <Image className='mine__login-logo' src={logoPng} mode='aspectFit' />
          <Text className='mine__login-title'>登录大帅餐饮</Text>
          <Text className='mine__login-desc'>登录后管理门店并开始创作</Text>
          {devMode ? (
            <Button className='mine__login-primary' onClick={onDevLogin} disabled={submitting}>
              {submitting ? '登录中…' : '进入本地开发环境'}
            </Button>
          ) : (
            <Button className='mine__login-primary' openType='getPhoneNumber' onGetPhoneNumber={onGetPhoneNumber} disabled={submitting}>
              {submitting ? '登录中…' : '微信一键登录'}
            </Button>
          )}
          {devMode && <View className='mine__login-devtip'>当前为本地开发账号，不触发微信手机号授权</View>}
          <Text className='mine__login-tip'>授权即表示同意<Text className='mine__login-link' onClick={() => void Taro.showModal({ title: '用户协议', content: '我们仅使用登录所需信息，为你提供门店管理、内容创作与成片服务。具体条款以上线版本为准。', showCancel: false })}>《用户协议》</Text>和<Text className='mine__login-link' onClick={() => void Taro.showModal({ title: '隐私政策', content: '我们仅在提供服务所必需的范围内处理手机号、门店资料和上传素材，不会将其用于无关用途。具体政策以上线版本为准。', showCancel: false })}>《隐私政策》</Text></Text>
        </View>
      </View>}
    </View>
  )
}
