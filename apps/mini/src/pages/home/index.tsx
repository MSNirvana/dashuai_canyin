import { useState } from 'react'
import { Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useMerchantStore } from '../../store/merchant'
import { listStores, type StoreItem } from '../../services/store'
import logoPng from '../../assets/logo.png'
import './index.scss'

export default function HomePage() {
  const { merchant, available, grantBalance, isMember, currentStoreId, setStore, refreshMe, logout } = useMerchantStore()
  const [stores, setStores] = useState<StoreItem[]>([])
  const [error, setError] = useState('')
  const storeName = stores.find((s) => s.id === currentStoreId)?.name ?? ''

  const refresh = async () => {
    if (!merchant) return
    setError('')
    try {
      const [list] = await Promise.all([listStores(), refreshMe()])
      setStores(list)
      // 没有当前门店时默认选中首个
      if (!currentStoreId && list.length) setStore(list[0].id)
    } catch { setError('门店或账户刷新失败，请重试') }
  }
  useDidShow(() => { void refresh() })

  const goMine = () => Taro.switchTab({ url: '/pages/mine/index' })
  if (!merchant) return <View className='home'>
    <View className='home__hero'>
      <View className='home__topbar'>
        <View className='home__brand'><Image className='home__logo' src={logoPng} mode='aspectFit' /><Text className='home__appname'>大帅餐饮</Text></View>
        <View className='home__icon-btn' onClick={goMine}><t-icon name='user' size='20px' /></View>
      </View>
      <View className='home__hero-title'><Text className='home__hero-main'>商家短视频创作</Text><Text className='home__hero-sub'>门店资料 · 口播文案 · 分镜素材 · 成片</Text></View>
    </View>
    <View className='ds-card home__info home__guest'>
      <Text className='home__guest-title'>登录后开始创作</Text>
      <Text className='home__guest-desc'>进入“我的”完成微信一键登录</Text>
      <View className='ds-btn ds-btn--primary ds-btn--sm' onClick={goMine}>去登录</View>
    </View>
  </View>

  const goStores = () => Taro.navigateTo({ url: '/pages/store/list' })
  const goCreations = () => Taro.switchTab({ url: '/pages/creation/list' })
  const goRecharge = () => Taro.navigateTo({ url: '/pages/recharge/index' })
  const goDishes = () => currentStoreId
    ? Taro.navigateTo({ url: `/pages/dish/list?storeId=${currentStoreId}` })
    : (void pickStore())
  const goCreate = () => currentStoreId
    ? Taro.navigateTo({ url: '/pages/creation/edit' })
    : (void pickStore())

  /** 左上角门店切换：ActionSheet 列出门店（最多 5 家 + 管理入口） */
  const pickStore = async () => {
    const list = await listStores().catch(() => [] as StoreItem[])
    setStores(list)
    if (!list.length) {
      Taro.showModal({ title: '还没有门店', content: '先创建一家门店，菜品、创作、人设都会挂在门店下', confirmText: '去建店' })
        .then((r) => { if (r.confirm) goStores() })
      return
    }
    const shown = list.slice(0, 5)
    const itemList = [...shown.map((s) => s.name || '未命名门店'), '管理门店']
    try {
      const { tapIndex } = await Taro.showActionSheet({ itemList })
      if (tapIndex < 0) return
      if (tapIndex < shown.length) {
        const target = shown[tapIndex]
        if (target && target.id !== currentStoreId) {
          setStore(target.id)
          Taro.showToast({ title: `已切换到「${target.name}」`, icon: 'none' })
        }
      } else {
        goStores()
      }
    } catch { /* 用户取消 */ }
  }

  return <View className='home'>
    <View className='home__hero'>
      <View className='home__topbar'>
        <View className='home__brand home__storebtn' onClick={pickStore}>
          <Image className='home__logo' src={logoPng} mode='aspectFit' />
          <Text className='home__storename'>{storeName || '选择门店'}</Text>
          <t-icon name='chevron-down' size='14px' />
        </View>
        <View className='home__topbar-actions'>
          <View className='home__icon-btn' onClick={goMine}><t-icon name='user' size='20px' /></View>
        </View>
      </View>
      <View className='home__hero-title'><Text className='home__hero-main'>商家短视频创作</Text><Text className='home__hero-sub'>门店资料 · 口播文案 · 分镜素材 · 成片</Text></View>
    </View>
    <View className='ds-card home__info'>
      <View className='home__info-row'>
        <View className='home__info-store'>
          <View className='home__info-avatar'>{merchant.nickname?.[0] ?? '店'}</View>
          <View><Text className='home__info-name'>{storeName || merchant.nickname || '我的门店'}</Text>
            <View className='home__info-meta'>
              <View className='home__info-store-name' onClick={pickStore}><Text>切换门店 ›</Text></View>
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
