// 门店切换器（左上角）：门店是最高层，切换后菜品/创作/老板人设等内容全部跟随
// 用法：<StoreSwitcher /> / <StoreSwitcher className='xx' variant='light' />

import { useEffect } from 'react'
import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMerchantStore } from '../../store/merchant'
import logoPng from '../../assets/logo.png'
import './index.scss'

interface Props {
  /** 外层附加类名，便于各页微调间距 */
  className?: string
  /** 未选门店时的占位文案 */
  emptyText?: string
}

export default function StoreSwitcher({ className = '', emptyText = '选择门店' }: Props) {
  const stores = useMerchantStore((s) => s.stores)
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const setStore = useMerchantStore((s) => s.setStore)

  // 组件挂载即预热门店列表（命中缓存不会重复请求）
  useEffect(() => {
    void loadStores().catch(() => undefined)
  }, [loadStores])

  const current = stores.find((s) => s.id === currentStoreId)

  const goStores = () => Taro.navigateTo({ url: '/pages/store/list' })

  const onTap = async () => {
    // ★ 失败 ≠ 没有门店：catch 给空数组会把「网络抖了一下」显示成「还没有门店」，
    //   用户跟着「去建店」就会建出重复门店。失败给 null，单独提示重试。
    const list = await loadStores(true).catch(() => null)
    if (!list) {
      Taro.showToast({ title: '门店列表加载失败，请重试', icon: 'none' })
      return
    }
    if (!list.length) {
      const r = await Taro.showModal({
        title: '还没有门店',
        content: '先创建一家门店',
        confirmText: '去建店',
      })
      if (r.confirm) goStores()
      return
    }
    // 微信 ActionSheet 最多 6 项：5 家门店 + 管理入口
    const shown = list.slice(0, 5)
    const itemList = [
      ...shown.map((s) => (s.isDefault ? `${s.name}（默认）` : s.name || '未命名门店')),
      '管理门店',
    ]
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
    } catch {
      /* 用户取消 */
    }
  }

  return (
    <View className={`store-switcher ${className}`} hoverClass='store-switcher--hover' onClick={onTap}>
      <Image className='store-switcher__logo' src={logoPng} mode='aspectFit' />
      <Text className='store-switcher__name'>{current?.name || emptyText}</Text>
      <t-icon name='chevron-down' size='14px' />
    </View>
  )
}
