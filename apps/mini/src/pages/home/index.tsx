import { useEffect, useState } from 'react'
import { Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useMerchantStore } from '../../store/merchant'
import { listStores } from '../../services/store'
import logoPng from '../../assets/logo.png'
import './index.scss'

export default function HomePage() {
  const { merchant, available, grantBalance, isMember, currentStoreId, refreshMe, logout } = useMerchantStore()
  const [storeName, setStoreName] = useState('')
  const [error, setError] = useState('')
  const refresh = async () => {
    if (!merchant) return
    setError('')
    try {
      const [stores] = await Promise.all([listStores(), refreshMe()])
      setStoreName(stores.find((store) => store.id === currentStoreId)?.name || '')
    } catch { setError('门店或账户刷新失败，请重试') }
  }
  useEffect(() => {
    if (!merchant) void Taro.redirectTo({ url: '/pages/login/index' })
  }, [merchant])
  useDidShow(() => { void refresh() })
  if (!merchant) return null
  const goStores = () => Taro.navigateTo({ url: '/pages/store/list' })
  const goCreations = () => Taro.switchTab({ url: '/pages/creation/list' })
  const goRecharge = () => Taro.navigateTo({ url: '/pages/recharge/index' })
  const goMine = () => Taro.switchTab({ url: '/pages/mine/index' })
  const goDishes = () => currentStoreId
    ? Taro.navigateTo({ url: `/pages/dish/list?storeId=${currentStoreId}` })
    : goStores()
  const goCreate = () => Taro.navigateTo({ url: '/pages/creation/edit' })
  return <View className='home'>
    <View className='home__hero'>
      <View className='home__topbar'>
        <View className='home__brand'><Image className='home__logo' src={logoPng} mode='aspectFit' /><Text className='home__appname'>大帅餐饮</Text></View>
        <View className='home__icon-btn' onClick={goMine}><t-icon name='user' size='20px' /></View>
      </View>
      <View className='home__hero-title'><Text className='home__hero-main'>商家短视频创作</Text><Text className='home__hero-sub'>门店资料 · 口播文案 · 分镜素材 · 成片</Text></View>
    </View>
    <View className='ds-card home__info'>
      <View className='home__info-row'>
        <View className='home__info-store'>
          <View className='home__info-avatar'>{merchant.nickname?.[0] ?? '店'}</View>
          <View><Text className='home__info-name'>{merchant.nickname || '我的门店'}</Text>
            <View className='home__info-meta'>
              <View className='home__info-store-name' onClick={goStores}><Text>{storeName || '选择门店'} ›</Text></View>
              <Text className='ds-pill ds-pill--gold home__info-member' onClick={goRecharge}>{isMember ? '已订阅' : '未订阅'}</Text>
            </View>
          </View>
        </View>
        <View className='home__info-bean' onClick={goRecharge}><Text className='home__info-bean-num'>{available}</Text><Text className='home__info-bean-unit'>可用积分</Text>{Number(grantBalance) > 0 && <Text className='home__info-bean-gift'>赠积分余额 {grantBalance}</Text>}</View>
      </View>
      {error && <Text>{error}</Text>}
      <View className='home__info-actions'><View className='ds-btn ds-btn--primary ds-btn--sm' onClick={goCreate}>新建创作</View><View className='ds-btn ds-btn--ghost ds-btn--sm' onClick={() => void refresh()}>刷新</View></View>
    </View>
    <View className='ds-section'><View className='ds-section__title'><View className='ds-section__title-bar' /><Text>创作工作台</Text></View></View>
    <View className='home__grid'>
      <View className='home__grid-cell' onClick={goCreations}><View className='home__grid-icon'><t-icon name='movie-clapper' size='40px' /></View><Text className='home__grid-title'>我的创作</Text><Text className='home__grid-sub'>文案 · 分镜 · 出片</Text></View>
      <View className='home__grid-cell' onClick={goStores}><View className='home__grid-icon'><t-icon name='shop' size='40px' /></View><Text className='home__grid-title'>门店管理</Text><Text className='home__grid-sub'>建店 · 切换</Text></View>
      <View className='home__grid-cell' onClick={goDishes}><View className='home__grid-icon'><t-icon name='noodle' size='40px' /></View><Text className='home__grid-title'>菜品库</Text><Text className='home__grid-sub'>招牌菜 · 卖点</Text></View>
      <View className='home__grid-cell' onClick={() => Taro.navigateTo({ url: '/pages/persona/index' })}><View className='home__grid-icon'><t-icon name='smile' size='40px' /></View><Text className='home__grid-title'>老板人设</Text><Text className='home__grid-sub'>标签 · 门店活动</Text></View>
    </View>
    <View className='home__logout' onClick={logout}><Text>退出登录</Text></View>
  </View>
}
