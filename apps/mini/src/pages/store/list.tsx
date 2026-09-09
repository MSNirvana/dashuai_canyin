import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMerchantStore } from '../../store/merchant'
import { listStores, deleteStore, type StoreItem } from '../../services/store'
import './list.scss'

export default function StoreListPage() {
  const { currentStoreId, setStore } = useMerchantStore()
  const [list, setList] = useState<StoreItem[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const data = await listStores()
      setList(data)
      // 没有当前门店时，默认选中首个（通常是默认门店）
      if (!currentStoreId && data.length) setStore(data[0].id)
    } catch {
      /* 错误已 toast */
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const onSelect = (s: StoreItem) => {
    setStore(s.id)
    Taro.showToast({ title: `已切换到「${s.name}」`, icon: 'none' })
  }

  const onEdit = (s: StoreItem) => {
    Taro.navigateTo({ url: `/pages/store/edit?id=${s.id}` })
  }

  const onDishes = (s: StoreItem) => {
    Taro.navigateTo({ url: `/pages/dish/list?storeId=${s.id}&storeName=${encodeURIComponent(s.name)}` })
  }

  const onDelete = (s: StoreItem) => {
    if (s.isDefault) {
      Taro.showToast({ title: '默认门店不可删除', icon: 'none' })
      return
    }
    Taro.showModal({
      title: '删除门店',
      content: `确认删除「${s.name}」？该门店下的菜品也会一并隐藏。`,
      confirmColor: '#e63946',
    }).then(async (r) => {
      if (!r.confirm) return
      try {
        await deleteStore(s.id)
        Taro.showToast({ title: '已删除', icon: 'success' })
        load()
      } catch {
        /* 错误已 toast */
      }
    })
  }

  const onCreate = () => Taro.navigateTo({ url: '/pages/store/edit' })

  return (
    <View className='store-list'>
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
            return (
              <View
                key={s.id}
                className={`store-card ${active ? 'store-card--active' : ''}`}
                onClick={() => onSelect(s)}
              >
                <View className='store-card__main'>
                  <View className='store-card__title'>
                    <Text className='store-card__name'>{s.name}</Text>
                    {s.isDefault && <Text className='store-card__tag'>默认</Text>}
                    {active && <Text className='store-card__current'>当前</Text>}
                  </View>
                  <Text className='store-card__meta'>
                    {[s.category, s.city, s.district].filter(Boolean).join(' · ') || '未填写分类/地区'}
                  </Text>
                  <Text className='store-card__count'>菜品 {s._count?.dishes ?? 0} 道</Text>
                </View>
                <View className='store-card__ops'>
                  <Text className='store-card__op' onClick={(e) => { e.stopPropagation(); onDishes(s) }}>
                    菜品
                  </Text>
                  <Text className='store-card__op' onClick={(e) => { e.stopPropagation(); onEdit(s) }}>
                    编辑
                  </Text>
                  <Text
                    className='store-card__op store-card__op--del'
                    onClick={(e) => { e.stopPropagation(); onDelete(s) }}
                  >
                    删除
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
