import { useCallback, useEffect, useState } from 'react'
import { View, Text, Image, Video, Button } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { getStore, getStoreMediaUrl, type StoreItem } from '../../services/store'
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
  // ★ 2026-09-24 单店模型：原「切换到该门店」与「删除」两个操作已删除 ——
  //   账号只有一家门店，没有可切换的对象；而那家店也删不掉（服务端 deleteStore 对默认门店一律拒绝，
  //   而单店模型下唯一门店必然是默认门店），留一个点了必然报错的按钮只会让人以为功能坏了。
  const previewCover = () => {
    if (coverUrl) Taro.previewImage({ current: coverUrl, urls: [coverUrl] })
  }

  if (loading) return <View className='store-detail store-detail--state'>加载中…</View>
  if (!detail) {
    return (
      <View className='store-detail store-detail--state'>
        {idBroken ? '链接里的门店编号有误，请从「我的 → 门店资料」重新进入' : '门店不存在'}
        {/* ★ 单店模型下没有「门店列表」可回，再建一家也会被服务端拒（一个账号只能一家门店）——
            唯一总是成立的出路是回「我的」，从门店资料重新进入。 */}
        <Button size='mini' onClick={() => Taro.switchTab({ url: '/pages/mine/index' })}>返回我的</Button>
      </View>
    )
  }

  const location = Array.from(new Set([detail.province, detail.city, detail.district].filter(Boolean))).join(' · ')
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
      </View>

      <View className='store-detail__body'>
        {/* ★ 2026-09-24 单店模型：原「默认」「当前」两个标签一并删除 ——
            账号只有一家门店，它既是默认也永远是当前，两个标签说的都是没有信息量的事。 */}
        <View className='store-detail__title'>
          <Text className='store-detail__name'>{detail.name}</Text>
        </View>
        {/* ★ 2026-09-24 按需求，门店标题区下面这两块内容一并删除：
            ① 「品类 · 省市县」副标题 —— 地址在下面「到店信息 › 地址」里已完整给过一次；
            ② 「品牌资料完整度」卡片 —— 它算的是主图/视频/介绍/品类/地址五项资料的填写比例，
               是「催你把资料填全」的运营提示，不是门店信息本身。 */}

        <View className='store-detail__section-head'>
          <View><Text className='store-detail__label'>门店视频</Text></View>
          <Text className='store-detail__section-no'>01</Text>
        </View>
        {/* ★ 2026-09-24 按需求精简：视频 / 介绍两处空态只留「未上传」「未填写」——
            原来各带一句「可在编辑页补充」，等于在每个没填的字段下重复同一条指引；
            去哪儿补是编辑页自己的事，不在这里说。
            ⚠ 注释必须留在三元**外面**：问号冒号那对括号各自只接受**一个**表达式，
              往里塞 JSX 块注释会变成两个相邻表达式，直接语法错误（本页踩过）。 */}
        {videoUrl ? (
          <View className='store-detail__video'>
            <Video className='store-detail__video-player' src={videoUrl} controls showCenterPlayBtn />
          </View>
        ) : (
          <Text className='store-detail__muted'>未上传</Text>
        )}

        <View className='store-detail__section-head'>
          <View><Text className='store-detail__label'>门店故事</Text></View>
          <Text className='store-detail__section-no'>02</Text>
        </View>
        {detail.intro ? (
          <Text className='store-detail__intro'>{detail.intro}</Text>
        ) : (
          <Text className='store-detail__muted'>未填写</Text>
        )}

        <View className='store-detail__section-head'>
          <View><Text className='store-detail__label'>到店信息</Text></View>
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
        <View className='store-detail__btn-row'>
          <View className='store-detail__btn store-detail__btn--ghost' onClick={onDishes}>
            <Text>管理菜品</Text>
          </View>
          <View className='store-detail__btn store-detail__btn--primary' onClick={onEdit}>
            <Text>编辑门店</Text>
          </View>
        </View>
      </View>
    </View>
  )
}
