import { useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useMerchantStore } from '../../store/merchant'
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

  const [loading, setLoading] = useState(true)

  useDidShow(() => {
    refreshMe()
      .catch(() => undefined)
      .finally(() => setLoading(false))
  })

  const go = (url: string) => Taro.navigateTo({ url })
  // creation/list 是 tabBar 页，必须用 switchTab
  const goTab = (url: string) => Taro.switchTab({ url })

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
                <t-icon name='user-vip' size='24rpx' color='#b27c2b' /> {memberPlanName}
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
      <View className='mine__bean' onClick={() => go('/pages/recharge/index')}>
        <View className='mine__beancell'>
          <Text className='mine__beannum'>{available}</Text>
          <Text className='mine__beanlabel'>可用积分</Text>
        </View>
        <View className='mine__beandiv' />
        <View className='mine__beancell'>
          <Text className='mine__beannum mine__beannum--gold'>{grantBalance}</Text>
          <Text className='mine__beanlabel'>赠积分</Text>
        </View>
        <View className='ds-btn ds-btn--primary ds-btn--sm mine__beanbtn'>订阅 / 加油包</View>
      </View>

      <View className='mine__tip'>购买积分 {rechargeBalance} · 冻结积分 {frozen}{memberEndAt ? ' · 赠积分到期 ' + fmtDate(memberEndAt) : ''}</View>
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
            style={{ width: `${pct}%`, background: pct >= 90 ? '#cf8a2d' : undefined }}
          />
        </View>
      </View>

      {/* ── 菜单 ── */}
      <View className='ds-section'>
        <View className='ds-section__title'>
          <View className='ds-section__title-bar' />
          <Text>常用功能</Text>
        </View>
      </View>
      <View className='mine__menu'>
        <View className='mine__item' onClick={() => goTab('/pages/creation/list')}>
          <View className='mine__item-icon mine__item-icon--red'><t-icon name='movie-clapper' size='32rpx' /></View>
          <Text className='mine__item-title'>我的创作</Text>
          <Text className='mine__item-desc'>文案 · 分镜 · 成片</Text>
          <Text className='mine__arrow'>›</Text>
        </View>
        <View className='mine__item' onClick={() => go('/pages/store/list')}>
          <View className='mine__item-icon mine__item-icon--red'><t-icon name='shop' size='32rpx' /></View>
          <Text className='mine__item-title'>我的门店</Text>
          <Text className='mine__item-desc'>门店 · 菜品库</Text>
          <Text className='mine__arrow'>›</Text>
        </View>
        <View className='mine__item' onClick={() => go('/pages/persona/index')}>
          <View className='mine__item-icon mine__item-icon--gold'><t-icon name='smile' size='32rpx' /></View>
          <Text className='mine__item-title'>老板人设</Text>
          <Text className='mine__item-desc'>标签 · 门店活动</Text>
          <Text className='mine__arrow'>›</Text>
        </View>
        <View className='mine__item' onClick={() => go('/pages/recharge/index')}>
          <View className='mine__item-icon mine__item-icon--gold'><t-icon name='wallet' size='32rpx' /></View>
          <Text className='mine__item-title'>订阅与积分</Text>
          <Text className='mine__item-desc'>加油包 · 续费</Text>
          <Text className='mine__arrow'>›</Text>
        </View>
      </View>

      {loading && <View className='mine__tip'>加载中…</View>}
    </View>
  )
}
