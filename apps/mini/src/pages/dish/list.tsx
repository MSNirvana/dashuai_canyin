import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { listDishes, deleteDish, type DishItem } from '../../services/dish'
import './list.scss'

export default function DishListPage() {
  const router = useRouter()
  const storeId = router.params.storeId ?? ''
  const storeName = router.params.storeName ?? ''
  const [list, setList] = useState<DishItem[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    if (!storeId) return
    setLoading(true)
    try {
      setList(await listDishes(storeId))
    } catch {
      /* 错误已 toast */
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId])

  const onDelete = (d: DishItem) => {
    Taro.showModal({
      title: '删除菜品',
      content: `确认删除「${d.name}」？`,
      confirmColor: '#e63946',
    }).then(async (r) => {
      if (!r.confirm) return
      try {
        await deleteDish(storeId, d.id)
        Taro.showToast({ title: '已删除', icon: 'success' })
        load()
      } catch {
        /* 错误已 toast */
      }
    })
  }

  const onAdd = () => {
    Taro.navigateTo({ url: `/pages/dish/edit?storeId=${storeId}&storeName=${encodeURIComponent(storeName)}` })
  }

  const onEdit = (d: DishItem) => {
    Taro.navigateTo({
      url: `/pages/dish/edit?storeId=${storeId}&storeName=${encodeURIComponent(storeName)}&id=${d.id}`,
    })
  }

  return (
    <View className='dish-list'>
      {storeName && (
        <View className='dish-list__store'>
          <Text>当前门店：{storeName}</Text>
        </View>
      )}

      {loading ? (
        <View className='dish-list__loading'>
          <Text>加载中…</Text>
        </View>
      ) : list.length === 0 ? (
        <View className='dish-list__empty'>
          <Text>还没有菜品，点下方按钮添加</Text>
        </View>
      ) : (
        <View className='dish-list__items'>
          {list.map((d) => (
            <View key={d.id} className='dish-card'>
              <View className='dish-card__main' onClick={() => onEdit(d)}>
                <Text className='dish-card__name'>{d.name}</Text>
                {d.sellingPoints && <Text className='dish-card__sp'>{d.sellingPoints}</Text>}
                {d.intro && <Text className='dish-card__intro'>{d.intro}</Text>}
              </View>
              <Text className='dish-card__del' onClick={() => onDelete(d)}>
                删除
              </Text>
            </View>
          ))}
        </View>
      )}

      <View className='dish-list__footer'>
        <View className='dish-list__add' onClick={onAdd}>
          <Text>+ 添加菜品</Text>
        </View>
      </View>
    </View>
  )
}
