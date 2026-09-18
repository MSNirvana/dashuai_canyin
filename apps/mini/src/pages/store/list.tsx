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
  /**
   * 加载失败的原因。
   * ★ 必须与「一家门店都还没有」分开：旧实现把失败整段吞掉（catch 里只有一句注释说
   *   「错误已 toast」），`list` 保持空、`loading` 转 false，界面落进空态
   *   「还没有门店，点下方按钮创建第一家」—— 用户明明有两家店，却被告知一家都没有，
   *   于是跑去重复创建门店。请求层那句 toast 一闪而过，页面本身还在说错话。
   */
  const [loadError, setLoadError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      // 走全局缓存：切店/建店后全站（首页/创作/菜品/人设）保持一致
      const data = await loadStores(true)
      setList(data)
      setLoadError('')
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
      // 已 toast 过一句，但页面不能继续假装「你没有门店」—— 给一个原地重试的出口
      setLoadError('门店加载失败，点这里重试')
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

      {!!loadError && (
        <View className='store-list__empty' onClick={() => void load()}>
          <Text>{loadError}</Text>
        </View>
      )}
      {loading ? (
        <View className='store-list__loading'>
          <Text>加载中…</Text>
        </View>
      ) : list.length === 0 ? (
        // 加载失败时 list 也是空的 —— 只有**确实没失败**才敢说「还没有门店」
        !loadError && (
          <View className='store-list__empty'>
            <Text>还没有门店，点下方按钮创建第一家</Text>
          </View>
        )
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
