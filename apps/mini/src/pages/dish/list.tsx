import { useState } from 'react'
import { View, Text, Image } from '@tarojs/components'
import Taro, { useRouter, useDidShow } from '@tarojs/taro'
import { listDishes, deleteDish, getDishMediaUrl, type DishItem } from '../../services/dish'
import { useMerchantStore } from '../../store/merchant'
import './list.scss'

export default function DishListPage() {
  const router = useRouter(); const { currentStoreId } = useMerchantStore(); const storeId = router.params.storeId ?? currentStoreId; const storeName = router.params.storeName ?? ''
  const [list, setList] = useState<DishItem[]>([]); const [coverUrls, setCoverUrls] = useState<Record<string, string>>({}); const [loading, setLoading] = useState(true)
  const load = async () => { if (!storeId) return; setLoading(true); try { const data = await listDishes(storeId); setList(data); const entries = await Promise.all(data.map(async (d) => { const key = d.media?.find((m) => m.type === 'IMAGE')?.cosKey || d.coverKey; if (!key) return null; try { const r = await getDishMediaUrl(key); return r.url ? [d.id, r.url] as const : null } catch { return null } })); setCoverUrls(Object.fromEntries(entries.filter((x): x is readonly [string, string] => !!x))) } finally { setLoading(false) } }
  useDidShow(load)
  const onDelete = (d: DishItem) => Taro.showModal({ title: '删除菜品', content: '确认删除「' + d.name + '」？', confirmColor: '#e63946' }).then(async (r) => { if (!r.confirm) return; try { await deleteDish(storeId, d.id); Taro.showToast({ title: '已删除', icon: 'success' }); load() } catch { /* request layer */ } })
  const onAdd = () => Taro.navigateTo({ url: '/pages/dish/edit?storeId=' + storeId + '&storeName=' + encodeURIComponent(storeName) })
  const onDetail = (d: DishItem) => Taro.navigateTo({ url: '/pages/dish/detail?storeId=' + storeId + '&storeName=' + encodeURIComponent(storeName) + '&id=' + d.id })
  return <View className='dish-list'>{storeName && <View className='dish-list__store'><Text>当前门店：{storeName}</Text></View>}{loading ? <View className='dish-list__loading'><Text>加载中…</Text></View> : list.length === 0 ? <View className='dish-list__empty'><Text>还没有菜品，点下方按钮添加</Text></View> : <View className='dish-list__items'>{list.map((d) => <View key={d.id} className='dish-card' onClick={() => onDetail(d)}><View className='dish-card__cover'>{coverUrls[d.id] ? <Image className='dish-card__cover-image' src={coverUrls[d.id]} mode='aspectFill' /> : <Text className='dish-card__cover-empty'>菜品</Text>}</View><View className='dish-card__main'><Text className='dish-card__name'>{d.name}</Text>{d.sellingPoints && <Text className='dish-card__sp'>{d.sellingPoints}</Text>}{d.intro && <Text className='dish-card__intro'>{d.intro}</Text>}<Text className='dish-card__hint'>点击查看详情</Text></View><Text className='dish-card__del' onClick={(e) => { e.stopPropagation(); onDelete(d) }}>删除</Text></View>)}</View>}<View className='dish-list__footer'><View className='dish-list__add' onClick={onAdd}><Text>+ 添加菜品</Text></View></View></View>
}
