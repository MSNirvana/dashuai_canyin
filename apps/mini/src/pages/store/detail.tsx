import { useCallback, useEffect, useState } from 'react'
import { View, Text, Image, Video, Button } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { getStore, getStoreMediaUrl, type StoreItem } from '../../services/store'
import { readRouteId, isBrokenRouteId } from '../../utils/route-id'
import { ratioToPaddingTop, readRatioFromMeta } from '../../utils/video-ratio'
import './detail.scss'

interface InfoRow {
  label: string
  value: string
}

/** 门店详情页：门店资料（门头图片 / 视频 / 介绍 / 地址）的统一展示入口 */
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
  /** 门店视频的真实宽高比（宽/高）；null = 元数据还没到，样式层会退回 16:9 兜底 */
  const [videoRatio, setVideoRatio] = useState<number | null>(null)
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

  // ★ 换源先清掉上一次的比例：否则重新加载后，旧视频的比例会先套到新视频上，
  //   盒子会先错一下再跳正。null → 样式层退回 16:9 兜底。
  useEffect(() => {
    setVideoRatio(null)
  }, [videoUrl])

  const onEdit = () => Taro.navigateTo({ url: `/pages/store/edit?id=${id}` })
  const onDishes = () =>
    Taro.navigateTo({ url: `/pages/dish/list?storeId=${id}&storeName=${encodeURIComponent(detail?.name ?? '')}` })
  // ★ 2026-09-24 单店模型：原「切换到该门店」与「删除」两个操作已删除 ——
  //   账号只有一家门店，没有可切换的对象；而那家店也删不掉（服务端 deleteStore 对默认门店一律拒绝，
  //   而单店模型下唯一门店必然是默认门店），留一个点了必然报错的按钮只会让人以为功能坏了。
  const previewCover = () => {
    if (coverUrl) Taro.previewImage({ current: coverUrl, urls: [coverUrl] })
  }

  /**
   * 视频元数据（宽/高）到了 —— 按视频自己的比例撑盒子，横版竖版都自动适配。
   * ★ 只能走播放器元数据，不能读 `media_asset.width/height`：
   *   小程序上报那两列是后来的事，线上存量门店视频在库里全是 NULL ⇒ 读库对存量无效。
   * ★ 事件名 Taro 侧是 `onLoadedMetaData`（大写 D）—— 小程序编译成 `bindloadedmetadata`。
   */
  const onVideoMeta = (e: unknown) => {
    const ratio = readRatioFromMeta(e)
    if (ratio) setVideoRatio(ratio)
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
          <View className='store-detail__placeholder'>添加一张门头图片，让顾客先认识你的店</View>
        )}
      </View>

      <View className='store-detail__body'>
        {/* ★ 2026-09-24 单店模型：原「默认」「当前」两个标签一并删除 ——
            账号只有一家门店，它既是默认也永远是当前，两个标签说的都是没有信息量的事。 */}
        {/* ★ 2026-09-28 视觉层级整理：外层 `store-detail__title`（flex 包裹层）已删除 ——
            它原本是给「门店名 + 默认/当前标签 + 「品类 · 省市县」副标题」排一行用的，
            那两样东西在单店模型里先后下线（见上一条注释），这层就只剩门店名一个子节点，
            成了空壳包裹。门店名直接坐在卡片里。 */}
        <Text className='store-detail__name'>{detail.name}</Text>
        {/* ★ 2026-09-24 按需求，门店标题区下面这两块内容一并删除：
            ① 「品类 · 省市县」副标题 —— 地址在下面「到店信息 › 地址」里已完整给过一次；
            ② 「品牌资料完整度」卡片 —— 它算的是门头图片/视频/介绍/品类/地址五项资料的填写比例，
               是「催你把资料填全」的运营提示，不是门店信息本身。 */}

        {/* ★ 2026-09-28 视觉层级整理：区块标题改用全站统一规格 —— **品牌色圆角竖条 + 34rpx/700**，
            与创作页 `cedit__spec-head` / `cedit__spec-bar`、合成页 `rcompose__sechead` 一致。
            改前是 `<View><Text className='store-detail__label'>…</Text></View>`：
            26rpx/600 的黑字，比正文（28rpx）还小，且外面那层 `<View>` 是只包一个 `<Text>` 的空壳。
            ⚠ 竖条必须是**单独一个节点**（`Text` 在 weapp 编译成 `<text>`，`::before` 伪元素不渲染）；
              竖条 + 文字要先收进 `__sechead` **成组**，否则会被行容器的 `space-between` 撕到两端。
            ★ 行右侧的序号 01/02/03 原样保留。 */}
        <View className='store-detail__section-head'>
          <View className='store-detail__sechead'>
            <View className='store-detail__secbar' />
            <Text className='store-detail__sectitle'>门店视频</Text>
          </View>
          <Text className='store-detail__section-no'>01</Text>
        </View>
        {/* ★ 2026-09-24 按需求精简：视频 / 介绍两处空态只留「未上传」「未填写」——
            原来各带一句「可在编辑页补充」，等于在每个没填的字段下重复同一条指引；
            去哪儿补是编辑页自己的事，不在这里说。
            ⚠ 注释必须留在三元**外面**：问号冒号那对括号各自只接受**一个**表达式，
              往里塞 JSX 块注释会变成两个相邻表达式，直接语法错误（本页踩过）。
            ★ 2026-09-28 视频盒高度改由视频自身宽高比决定（内联 padding-top 百分比）：
              横版 16:9 → 345rpx，竖版 9:16 → 1091rpx（本盒内容宽 614rpx），
              元数据未到时用样式层的 16:9 兜底。 */}
        {videoUrl ? (
          <View className='store-detail__video' style={{ paddingTop: ratioToPaddingTop(videoRatio) }}>
            <Video
              className='store-detail__video-player'
              src={videoUrl}
              controls
              showCenterPlayBtn
              objectFit='contain'
              onLoadedMetaData={onVideoMeta}
            />
          </View>
        ) : (
          <Text className='store-detail__muted'>未上传</Text>
        )}

        <View className='store-detail__section-head'>
          <View className='store-detail__sechead'>
            <View className='store-detail__secbar' />
            <Text className='store-detail__sectitle'>门店故事</Text>
          </View>
          <Text className='store-detail__section-no'>02</Text>
        </View>
        {detail.intro ? (
          <Text className='store-detail__intro'>{detail.intro}</Text>
        ) : (
          <Text className='store-detail__muted'>未填写</Text>
        )}

        <View className='store-detail__section-head'>
          <View className='store-detail__sechead'>
            <View className='store-detail__secbar' />
            <Text className='store-detail__sectitle'>到店信息</Text>
          </View>
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
