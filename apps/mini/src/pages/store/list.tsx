import { useState } from 'react'
import { View, Text, Image } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useMerchantStore } from '../../store/merchant'
import { getStoreMediaUrl, type StoreItem } from '../../services/store'
import './list.scss'

export default function StoreListPage() {
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const setStore = useMerchantStore((s) => s.setStore)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const [list, setList] = useState<StoreItem[]>([])
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      // 走全局缓存：切店/建店后全站（首页/创作/菜品/人设）保持一致
      const data = await loadStores(true)
      setList(data)
      const entries = await Promise.all(data.filter((s) => s.coverKey).map(async (s) => {
        try {
          const result = await getStoreMediaUrl(s.coverKey!)
          return result.url ? [s.id, result.url] as const : null
        } catch {
          return null
        }
      }))
      setCoverUrls(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => !!entry)))
    } catch {
      /* 错误已 toast */
    } finally {
      setLoading(false)
    }
  }

  useDidShow(() => {
    load()
  })

  const onSelect = (s: StoreItem) => {
    setStore(s.id)
    Taro.showToast({ title: `已切换到「${s.name}」`, icon: 'none' })
  }

  const onEnter = (s: StoreItem) => {
    Taro.navigateTo({ url: `/pages/store/detail?id=${s.id}` })
  }

  const onCreate = () => Taro.navigateTo({ url: '/pages/store/edit' })

  return (
    <View className='store-list'>
      <View className='store-list__head'>
        <View>
          <Text className='store-list__eyebrow'>YOUR STORES</Text>
          <Text className='store-list__title'>门店资料</Text>
          <Text className='store-list__intro'>把每家店的特色，沉淀成自己的内容资产</Text>
        </View>
        <Text className='store-list__count'>{list.length} 家</Text>
      </View>
      <View className='store-list__hint'>
        <Text>当前创作数据归属所选门店，切换门店不影响其它门店内容</Text>
      </View>

      {loading ? (
        <View className='store-list__loading'>
          <Text>加载中…</Text>
        </View>
      ) : list.length === 0 ? (
        <View className='store-list__empty'>
          <Text>还没有门店，点下方按钮创建第一家</Text>
        </View>
      ) : (
        <View className='store-list__items'>
          {list.map((s) => {
            const active = s.id === currentStoreId
            const location = Array.from(new Set([s.province, s.city, s.district].filter(Boolean))).join(' · ')
            return (
              <View
                key={s.id}
                className={`store-card ${active ? 'store-card--active' : ''}`}
                onClick={() => onSelect(s)}
              >
                <View className='store-card__cover'>
                  {coverUrls[s.id] ? <Image className='store-card__cover-image' src={coverUrls[s.id]} mode='aspectFill' /> : <Text className='store-card__cover-empty'>门店</Text>}
                </View>
                <View className='store-card__main'>
                  <View className='store-card__title'>
                    <Text className='store-card__name'>{s.name}</Text>
                    {s.isDefault && <Text className='store-card__tag'>默认</Text>}
                    {active && <Text className='store-card__current'>当前</Text>}
                  </View>
                  <Text className='store-card__meta'>
                    {[s.category, location].filter(Boolean).join(' · ') || '未填写分类/地区'}
                  </Text>
                  <Text className='store-card__count'>菜品 {s._count?.dishes ?? 0} 道</Text>
                </View>
                <View className='store-card__ops'>
                  <Text
                    className='store-card__op store-card__op--enter'
                    onClick={(e) => { e.stopPropagation(); onEnter(s) }}
                  >
                    进入
                  </Text>
                </View>
              </View>
            )
          })}
        </View>
      )}

      <View className='store-list__footer'>
        <View className='store-list__add' onClick={onCreate}>
          <Text>+ 新建门店</Text>
        </View>
      </View>
    </View>
  )
}
