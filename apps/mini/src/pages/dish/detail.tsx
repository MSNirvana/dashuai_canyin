import { useEffect, useState } from 'react'
import { View, Text, Image, Video } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { getDish, getDishMediaUrl, type DishItem, type DishMedia } from '../../services/dish'
import { useMerchantStore } from '../../store/merchant'
import { readRouteId, isBrokenRouteId } from '../../utils/route-id'
import './detail.scss'

interface MediaView extends DishMedia { url: string; coverUrl?: string }
export default function DishDetailPage() {
  // ★ 两个编号都要过 readRouteId：`?id=undefined` / `?storeId=undefined` 拼出来的 URL
  //   看着正常，但服务端 idParam 对非纯数字串一律回 4000「参数不合法」——
  //   页面上只会显示一句「菜品加载失败」，看不出是链接坏了（详见 utils/route-id.ts）。
  const router = useRouter(); const { currentStoreId } = useMerchantStore(); const storeId = readRouteId(router.params, 'storeId') ?? currentStoreId; const id = readRouteId(router.params)
  const idBroken = isBrokenRouteId(router.params) || isBrokenRouteId(router.params, 'storeId')
  const [dish, setDish] = useState<DishItem | null>(null); const [media, setMedia] = useState<MediaView[]>([]); const [loading, setLoading] = useState(true)
  useEffect(() => { if (!id) { setLoading(false); return }; getDish(storeId, id).then(async (d) => { setDish(d); const legacy: DishMedia[] = d.media?.length ? d.media : [...(d.coverKey ? [{ type: 'IMAGE' as const, cosKey: d.coverKey, sort: 0 }] : []), ...(d.videoKey ? [{ type: 'VIDEO' as const, cosKey: d.videoKey, sort: 0 }] : [])]; const views = await Promise.all(legacy.map(async (m) => { const r = await getDishMediaUrl(m.cosKey).catch(() => ({ url: null })); const c = m.coverKey ? await getDishMediaUrl(m.coverKey).catch(() => ({ url: null })) : { url: null }; return { ...m, url: r.url || '', coverUrl: c.url || undefined } })); setMedia(views) }).catch(() => Taro.showToast({ title: '菜品加载失败', icon: 'none' })).finally(() => setLoading(false)) }, [id, storeId])
  const images = media.filter((m) => m.type === 'IMAGE' && m.url); const videos = media.filter((m) => m.type === 'VIDEO')
  const imageUrls = images.map((m) => m.url)
  // ★ 被点的那张必须排到 urls[0]。
  // wx.previewImage 的 current 只接受「图片链接」，靠「能在 urls 里精确匹配到」来定位；
  // 匹配不上（或平台实现压根忽略 current）时会静默回落到 urls[0] —— 表现就是「点第 2、3 张却从第 1 张开始」。
  // 实测这条链路本身没有错（源码、产物、Taro 透传都核过），所以不去赌微信的匹配行为：
  // 把被点的挪到 0 号位后，「匹配成功」与「回落 urls[0]」两条路都落在同一张上。
  const previewImages = (index: number) => {
    const ordered = [imageUrls[index], ...imageUrls.filter((_, i) => i !== index)]
    Taro.previewImage({ current: ordered[0], urls: ordered })
  }
  // 编号为空时不该再拼 URL（否则会把 'undefined' / 'null' 带进下一个页面，重演同一个坑）
  const edit = () => { if (!id || !storeId) return; Taro.navigateTo({ url: '/pages/dish/edit?storeId=' + storeId + '&id=' + id }) }
  if (loading) return <View className='dish-detail dish-detail--state'>加载中…</View>
  if (!dish) return <View className='dish-detail dish-detail--state'>{idBroken ? '链接里的菜品编号有误，请从菜品列表重新进入' : '菜品不存在'}</View>
  return <View className='dish-detail'><View className='dish-detail__hero'>{images[0] ? <Image src={images[0].url} mode='aspectFill' onClick={() => previewImages(0)} /> : <View className='dish-detail__placeholder'>暂无封面</View>}</View><View className='dish-detail__body'><Text className='dish-detail__name'>{dish.name}</Text>{dish.sellingPoints && <View className='dish-detail__section'><Text className='dish-detail__label'>卖点</Text><Text>{dish.sellingPoints}</Text></View>}{dish.intro && <View className='dish-detail__section'><Text className='dish-detail__label'>简介</Text><Text>{dish.intro}</Text></View>}<View className='dish-detail__section'><Text className='dish-detail__label'>建议出镜</Text><Text>{dish.sellingPoints ? '先拍卖点，再拍一口下饭' : '补充卖点后，生成更贴合的分镜'}</Text></View><Text className='dish-detail__label'>全部图片</Text><View className='dish-detail__gallery'>{images.length ? images.map((m, i) => <Image key={m.cosKey} src={m.url} mode='aspectFill' onClick={() => previewImages(i)} />) : <Text className='dish-detail__muted'>暂无图片</Text>}</View><Text className='dish-detail__label'>全部视频</Text><View className='dish-detail__videos'>{videos.length ? videos.map((m) => <View className='dish-detail__video' key={m.cosKey}>{m.url ? <Video src={m.url} controls showCenterPlayBtn poster={m.coverUrl} /> : <Text>视频暂不可播放</Text>}</View>) : <Text className='dish-detail__muted'>暂无视频</Text>}</View></View><View className='dish-detail__footer'><View onClick={edit}>编辑菜品</View></View></View>
}
