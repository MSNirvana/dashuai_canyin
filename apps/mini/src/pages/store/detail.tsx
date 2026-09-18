import { useCallback, useEffect, useState } from 'react'
import { View, Text, Image, Video, Button } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { getStore, getStoreMediaUrl, deleteStore, type StoreItem } from '../../services/store'
import { useMerchantStore } from '../../store/merchant'
import { readRouteId, isBrokenRouteId } from '../../utils/route-id'
import './detail.scss'

interface InfoRow {
  label: string
  value: string
}

/** 门店详情页：门店资料（主图 / 视频 / 介绍 / 地址）的统一展示入口 */
export default function StoreDetailPage() {
  const router = useRouter()
  // ★ 编号必须当场校验，不能拿「路由里的原值」直接去请求：
  //   `?id=undefined` 会让 URL 看着完全正常，但服务端 idParam 对非纯数字串一律回 4000
  //   「参数不合法」—— 用户看到的是一句指向不了任何操作的报错（详见 utils/route-id.ts）。
  const id = readRouteId(router.params)
  /** 带了编号但不合法（例如 `?id=undefined`）：这是坏跳转，得说「链接有问题」，而不是「门店不存在」 */
  const idBroken = isBrokenRouteId(router.params)
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const setStore = useMerchantStore((s) => s.setStore)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const [detail, setDetail] = useState<StoreItem | null>(null)
  const [coverUrl, setCoverUrl] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!id) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const s = await getStore(id)
      setDetail(s)
      Taro.setNavigationBarTitle({ title: s.name || '门店详情' })
      const [cover, video] = await Promise.all([
        s.coverKey ? getStoreMediaUrl(s.coverKey).then((r) => r.url || '').catch(() => '') : Promise.resolve(''),
        s.videoKey ? getStoreMediaUrl(s.videoKey).then((r) => r.url || '').catch(() => '') : Promise.resolve(''),
      ])
      setCoverUrl(cover)
      setVideoUrl(video)
    } catch {
      Taro.showToast({ title: '门店加载失败', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  // 从编辑页返回时立即看到最新内容
  useDidShow(() => {
    void load()
  })

  const onEdit = () => Taro.navigateTo({ url: `/pages/store/edit?id=${id}` })
  const onDishes = () =>
    Taro.navigateTo({ url: `/pages/dish/list?storeId=${id}&storeName=${encodeURIComponent(detail?.name ?? '')}` })
  const onSwitch = () => {
    if (!detail) return
    setStore(detail.id)
    Taro.showToast({ title: `已切换到「${detail.name}」`, icon: 'none' })
  }
  const onDelete = () => {
    if (!detail) return
    if (detail.isDefault) {
      Taro.showToast({ title: '默认门店不可删除', icon: 'none' })
      return
    }
    Taro.showModal({
      title: '删除门店',
      content: `确认删除「${detail.name}」？该门店下的菜品也会一并隐藏。`,
      confirmColor: '#e1251b',
    }).then(async (r) => {
      if (!r.confirm) return
      try {
        await deleteStore(detail.id)
        Taro.showToast({ title: '已删除', icon: 'success' })
        // 强制刷新全局门店缓存（若当前门店被删，loadStores 会自动回落到默认门店 / 清空）
        await loadStores(true).catch(() => undefined)
        Taro.navigateBack()
      } catch {
        /* request 层已 toast */
      }
    })
  }
  const previewCover = () => {
    if (coverUrl) Taro.previewImage({ current: coverUrl, urls: [coverUrl] })
  }

  if (loading) return <View className='store-detail store-detail--state'>加载中…</View>
  if (!detail) {
    return (
      <View className='store-detail store-detail--state'>
        {idBroken ? '链接里的门店编号有误，请从门店列表重新进入' : '门店不存在'}
        <Button size='mini' onClick={() => Taro.navigateTo({ url: '/pages/store/list' })}>去门店列表</Button>
      </View>
    )
  }

  const location = Array.from(new Set([detail.province, detail.city, detail.district].filter(Boolean))).join(' · ')
  const isCurrent = detail.id === currentStoreId
  const rows: InfoRow[] = [
    { label: '地址', value: [location, detail.address].filter(Boolean).join(' ') || '未填写' },
    { label: '菜品', value: `${detail._count?.dishes ?? 0} 道` },
  ]

  return (
    <View className='store-detail'>
      <View className='store-detail__hero' onClick={previewCover}>
        {coverUrl ? (
          <Image className='store-detail__hero-image' src={coverUrl} mode='aspectFill' />
        ) : (
          <View className='store-detail__placeholder'>添加一张主图，让顾客先认识你的店</View>
        )}
        <View className='store-detail__hero-caption'>
          <Text className='store-detail__hero-kicker'>STORE STORY</Text>
          <Text className='store-detail__hero-tip'>{coverUrl ? '点击查看门店主图' : '主图会用于门店展示与内容创作'}</Text>
        </View>
      </View>

      <View className='store-detail__body'>
        <View className='store-detail__title'>
          <Text className='store-detail__name'>{detail.name}</Text>
          {detail.isDefault && <Text className='store-detail__tag'>默认</Text>}
          {isCurrent && <Text className='store-detail__tag store-detail__tag--current'>当前</Text>}
        </View>
        <Text className='store-detail__meta'>
          {[detail.category, location].filter(Boolean).join(' · ') || '未填写品类/地区'}
        </Text>

        <View className='store-detail__health'>
          <View className='store-detail__health-copy'>
            <Text className='store-detail__health-title'>品牌资料完整度</Text>
            <Text className='store-detail__health-desc'>资料越完整，AI 越懂你的门店</Text>
          </View>
          <Text className='store-detail__health-value'>{Math.round(([coverUrl, videoUrl, detail.intro, detail.category, detail.address].filter(Boolean).length / 5) * 100)}%</Text>
        </View>

        <View className='store-detail__section-head'>
          <View><Text className='store-detail__label'>门店视频</Text><Text className='store-detail__section-desc'>让顾客先看到环境、烟火气和真实氛围</Text></View>
          <Text className='store-detail__section-no'>01</Text>
        </View>
        {videoUrl ? (
          <View className='store-detail__video'>
            <Video className='store-detail__video-player' src={videoUrl} controls showCenterPlayBtn />
          </View>
        ) : (
          <Text className='store-detail__muted'>未上传门店视频，可在编辑页补充（选填）</Text>
        )}

        <View className='store-detail__section-head'>
          <View><Text className='store-detail__label'>门店故事</Text><Text className='store-detail__section-desc'>这段介绍会帮助 AI 写出更像本店的话</Text></View>
          <Text className='store-detail__section-no'>02</Text>
        </View>
        {detail.intro ? (
          <Text className='store-detail__intro'>{detail.intro}</Text>
        ) : (
          <Text className='store-detail__muted'>未填写门店介绍，可在编辑页补充</Text>
        )}

        <View className='store-detail__section-head'>
          <View><Text className='store-detail__label'>到店信息</Text><Text className='store-detail__section-desc'>顾客找到你需要的信息</Text></View>
          <Text className='store-detail__section-no'>03</Text>
        </View>
        <View className='store-detail__rows'>
          {rows.map((row) => (
            <View className='store-detail__row' key={row.label}>
              <Text className='store-detail__row-label'>{row.label}</Text>
              <Text className='store-detail__row-value'>{row.value}</Text>
            </View>
          ))}
        </View>
      </View>

      <View className='store-detail__footer'>
        {!isCurrent && (
          <View className='store-detail__btn store-detail__btn--ghost' onClick={onSwitch}>
            <Text>切换到该门店</Text>
          </View>
        )}
        <View className='store-detail__btn-row'>
          <View className='store-detail__btn store-detail__btn--ghost' onClick={onDishes}>
            <Text>管理菜品</Text>
          </View>
          <View className='store-detail__btn store-detail__btn--primary' onClick={onEdit}>
            <Text>编辑门店</Text>
          </View>
          <View className='store-detail__btn store-detail__btn--danger' onClick={onDelete}>
            <Text>删除</Text>
          </View>
        </View>
      </View>
    </View>
  )
}
