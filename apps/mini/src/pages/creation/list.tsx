import { useEffect, useState, useCallback } from 'react'
import { View, Text, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { listCreations, type CreationItem } from '../../services/creation'
import { listStores, type StoreItem } from '../../services/store'
import './list.scss'

export default function CreationList() {
  const [list, setList] = useState<CreationItem[]>([])
  const [storeMap, setStoreMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [creations, stores] = await Promise.all([listCreations(), listStores().catch(() => [])])
      const map: Record<string, string> = {}
      ;(stores as StoreItem[]).forEach((s) => (map[s.id] = s.name))
      setStoreMap(map)
      setList(creations)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])
  useDidShow(load)

  const onCreate = () => Taro.navigateTo({ url: '/pages/creation/edit' })
  const onOpen = (id: string) => Taro.navigateTo({ url: `/pages/creation/edit?id=${id}` })

  return (
    <View className='clist'>
      <View className='clist__bar'>
        <Button className='clist__new' onClick={onCreate}>
          + 新建创作
        </Button>
      </View>
      {loading && <View className='clist__tip'>加载中…</View>}
      {!loading && list.length === 0 && <View className='clist__empty'>还没有创作，点上方开始</View>}
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
