import { useEffect, useState } from 'react'
import { View, Text, Image, Video } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { getDish, getDishMediaUrl, type DishItem, type DishMedia } from '../../services/dish'
import './detail.scss'

interface MediaView extends DishMedia { url: string; coverUrl?: string }
export default function DishDetailPage() {
  const router = useRouter(); const storeId = router.params.storeId ?? ''; const id = router.params.id
  const [dish, setDish] = useState<DishItem | null>(null); const [media, setMedia] = useState<MediaView[]>([]); const [loading, setLoading] = useState(true)
  useEffect(() => { if (!id) { setLoading(false); return }; getDish(storeId, id).then(async (d) => { setDish(d); const legacy: DishMedia[] = d.media?.length ? d.media : [...(d.coverKey ? [{ type: 'IMAGE' as const, cosKey: d.coverKey, sort: 0 }] : []), ...(d.videoKey ? [{ type: 'VIDEO' as const, cosKey: d.videoKey, sort: 0 }] : [])]; const views = await Promise.all(legacy.map(async (m) => { const r = await getDishMediaUrl(m.cosKey).catch(() => ({ url: null })); const c = m.coverKey ? await getDishMediaUrl(m.coverKey).catch(() => ({ url: null })) : { url: null }; return { ...m, url: r.url || '', coverUrl: c.url || undefined } })); setMedia(views) }).catch(() => Taro.showToast({ title: '菜品加载失败', icon: 'none' })).finally(() => setLoading(false)) }, [id, storeId])
  const images = media.filter((m) => m.type === 'IMAGE' && m.url); const videos = media.filter((m) => m.type === 'VIDEO')
  const previewImages = (index: number) => Taro.previewImage({ current: images[index]?.url, urls: images.map((m) => m.url) })
  const edit = () => Taro.navigateTo({ url: '/pages/dish/edit?storeId=' + storeId + '&id=' + id })
  if (loading) return <View className='dish-detail dish-detail--state'>加载中…</View>
  if (!dish) return <View className='dish-detail dish-detail--state'>菜品不存在</View>
  return <View className='dish-detail'><View className='dish-detail__hero'>{images[0] ? <Image src={images[0].url} mode='aspectFill' onClick={() => previewImages(0)} /> : <View className='dish-detail__placeholder'>暂无封面</View>}</View><View className='dish-detail__body'><Text className='dish-detail__name'>{dish.name}</Text>{dish.sellingPoints && <View className='dish-detail__section'><Text className='dish-detail__label'>卖点</Text><Text>{dish.sellingPoints}</Text></View>}{dish.intro && <View className='dish-detail__section'><Text className='dish-detail__label'>简介</Text><Text>{dish.intro}</Text></View>}<Text className='dish-detail__label'>全部图片</Text><View className='dish-detail__gallery'>{images.length ? images.map((m, i) => <Image key={m.cosKey} src={m.url} mode='aspectFill' onClick={() => previewImages(i)} />) : <Text className='dish-detail__muted'>暂无图片</Text>}</View><Text className='dish-detail__label'>全部视频</Text><View className='dish-detail__videos'>{videos.length ? videos.map((m) => <View className='dish-detail__video' key={m.cosKey}>{m.url ? <Video src={m.url} controls showCenterPlayBtn poster={m.coverUrl} /> : <Text>视频暂不可播放</Text>}</View>) : <Text className='dish-detail__muted'>暂无视频</Text>}</View></View><View className='dish-detail__footer'><View onClick={edit}>编辑菜品</View></View></View>
}
