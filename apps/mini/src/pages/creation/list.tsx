import { useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { listCreations, type CreationItem } from '../../services/creation'
import { listStores, type StoreItem } from '../../services/store'
import { useMerchantStore } from '../../store/merchant'
import './list.scss'

/** 创作列表：跟随左上角当前门店（门店为最高层，内容全部跟门店走） */
export default function CreationList() {
  const { currentStoreId } = useMerchantStore()
  const [list, setList] = useState<CreationItem[]>([])
  const [storeMap, setStoreMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  const load = async () => {
    // 无门店：不拉数据（页面显示建店引导）
    if (!currentStoreId) {
      setList([])
      return
    }
    setLoading(true)
    try {
      const [creations, stores] = await Promise.all([
        listCreations(currentStoreId),
        listStores().catch(() => []),
      ])
      const map: Record<string, string> = {}
      ;(stores as StoreItem[]).forEach((s) => (map[s.id] = s.name))
      setStoreMap(map)
      setList(creations)
    } finally {
      setLoading(false)
    }
  }

  useDidShow(load)

  const onCreate = () => currentStoreId
    ? Taro.navigateTo({ url: '/pages/creation/edit' })
    : Taro.switchTab({ url: '/pages/home/index' })
  const onOpen = (id: string) => Taro.navigateTo({ url: `/pages/creation/edit?id=${id}` })

  return (
    <View className='clist'>
      <View className='clist__bar'>
        <Text className='clist__store'>{storeMap[currentStoreId] || '全部创作'}</Text>
        <Button className='clist__new' onClick={onCreate}>
          + 新建创作
        </Button>
      </View>
      {!currentStoreId && !loading && (
        <View className='clist__empty'>
          还没有门店，去首页左上角选择或创建门店后开始创作
          <View className='clist__gohome' onClick={onCreate}>去选门店</View>
        </View>
      )}
      {currentStoreId && loading && <View className='clist__tip'>加载中…</View>}
      {currentStoreId && !loading && list.length === 0 && (
        <View className='clist__empty'>这家门店还没有创作，点上方开始</View>
      )}
      {list.map((c) => (
        <View className='clist__card' key={c.id} onClick={() => onOpen(c.id)}>
          <View className='clist__title'>{c.title || '未命名创作'}</View>
          <View className='clist__meta'>
            <Text>{storeMap[c.storeId] || '门店'}</Text>
            <Text>分镜 {c._count?.shots ?? 0}</Text>
            <Text className='clist__status'>{c.status}</Text>
          </View>
        </View>
      ))}
    </View>
  )
}
