import { useEffect, useState } from 'react'
import { View, Text, Image, Video } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { getWork, markWorkClone, markWorkView, type WorkDetail } from '../../services/work'
import { COMPLEXITY_OPTIONS, COPY_TRACK_OPTIONS } from '../../services/creation'
import { useMerchantStore } from '../../store/merchant'
import './detail.scss'

/** 优秀作品详情：看成片 → 看配方 → 一键套用 */
export default function WorkDetailPage() {
  const router = useRouter()
  const id = router.params.id ?? ''
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const [work, setWork] = useState<WorkDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) {
      setLoading(false)
      return
    }
    getWork(id)
      .then((w) => {
        setWork(w)
        Taro.setNavigationBarTitle({ title: '优秀作品' })
        // 浏览计数不阻塞渲染，失败也不提示
        void markWorkView(id).catch(() => undefined)
      })
      .catch(() => Taro.showToast({ title: '作品加载失败', icon: 'none' }))
      .finally(() => setLoading(false))
  }, [id])

  const goStores = () => Taro.navigateTo({ url: '/pages/store/list' })

  /** 预填：带着配方进创作页，用户自己确认后再生成 */
  const onApply = () => {
    if (!currentStoreId) {
      goStores()
      return
    }
    void markWorkClone(id).catch(() => undefined)
    Taro.navigateTo({ url: `/pages/creation/edit?workId=${id}` })
  }

  /**
   * 一键生成：下一步就会真的调 AI（消耗 AI 豆），先确认再跳。
   * 创作页本身已是「选好款式就直接生成、生成完直达拍摄」，所以这里只做预填 + 前置确认，
   * 不再需要额外的 auto 参数（款式与门店都要让用户在创作页确认一次，避免白扣豆）。
   */
  const onAutoGenerate = async () => {
    if (!currentStoreId) {
      goStores()
      return
    }
    const r = await Taro.showModal({
      title: '用 AI 直接生成',
      content: '将按这条作品的配方预填文案款式与镜头复杂度，点「生成文案与分镜」后消耗 AI 豆。继续？',
      confirmText: '继续生成',
      confirmColor: '#e1251b',
    })
    if (!r.confirm) return
    void markWorkClone(id).catch(() => undefined)
    Taro.navigateTo({ url: `/pages/creation/edit?workId=${id}` })
  }

  if (loading) return <View className='work-detail work-detail--state'>加载中…</View>
  if (!work) return <View className='work-detail work-detail--state'>作品不存在或已下架</View>

  const recipe = work.recipeJson ?? {}
  const trackLabel = COPY_TRACK_OPTIONS.find((o) => o.value === recipe.track)?.label
  const complexityLabel = COMPLEXITY_OPTIONS.find((o) => o.value === recipe.complexity)?.label
  const skeleton = recipe.shotSkeleton ?? []

  return (
    <View className='work-detail'>
      <View className='work-detail__hero'>
        {work.videoUrl ? (
          <Video className='work-detail__video' src={work.videoUrl} controls showCenterPlayBtn poster={work.coverUrl ?? undefined} />
        ) : work.coverUrl ? (
          <Image className='work-detail__cover' src={work.coverUrl} mode='aspectFill' />
        ) : (
          <View className='work-detail__placeholder'>
            <Text>该作品暂未上传视频</Text>
            <Text className='work-detail__placeholder-sub'>下面的配方仍可直接套用</Text>
          </View>
        )}
      </View>

      <View className='work-detail__body'>
        <Text className='work-detail__title'>{work.title}</Text>
        <View className='work-detail__meta'>
          <Text className='work-detail__cat'>{[work.category, work.subCategory].filter(Boolean).join(' · ')}</Text>
          {(work.tags ?? []).map((t) => (
            <Text className='work-detail__tag' key={t}>{t}</Text>
          ))}
        </View>

        {!!recipe.notes && (
          <View className='work-detail__note'>
            <Text className='work-detail__note-label'>这条作品好在哪</Text>
            <Text className='work-detail__note-text'>{recipe.notes}</Text>
          </View>
        )}

        <Text className='work-detail__label'>同款配方</Text>
        <View className='work-detail__rows'>
          <View className='work-detail__row'>
            <Text className='work-detail__row-label'>文案款式</Text>
            <Text className='work-detail__row-value'>{trackLabel || '未设置'}</Text>
          </View>
          <View className='work-detail__row'>
            <Text className='work-detail__row-label'>镜头复杂度</Text>
            <Text className='work-detail__row-value'>{complexityLabel || '未设置'}</Text>
          </View>
          <View className='work-detail__row'>
            <Text className='work-detail__row-label'>镜头结构</Text>
            <Text className='work-detail__row-value'>{skeleton.length ? `${skeleton.length} 个镜头` : '未设置'}</Text>
          </View>
        </View>

        {skeleton.length > 0 && (
          <View className='work-detail__shots'>
            {skeleton.map((s, i) => (
              <View className='work-detail__shot' key={`${s.shotType ?? 'shot'}-${i}`}>
                <View className='work-detail__shot-head'>
                  <Text className='work-detail__shot-seq'>{i + 1}</Text>
                  <Text className='work-detail__shot-type'>{s.shotType || '未分类'}</Text>
                  {!!s.shotSize && <Text className='work-detail__chip'>{s.shotSize}</Text>}
                  {!!s.durationSuggest && <Text className='work-detail__chip'>{s.durationSuggest}s</Text>}
                </View>
                {!!s.visualReq && <Text className='work-detail__shot-req'>画面：{s.visualReq}</Text>}
              </View>
            ))}
          </View>
        )}

        {(work.viewCount > 0 || work.cloneCount > 0) && (
          <Text className='work-detail__stats'>
            {work.viewCount} 次浏览 · {work.cloneCount} 人用了同款
          </Text>
        )}
      </View>

      <View className='work-detail__footer'>
        <View className='work-detail__btn work-detail__btn--ghost' onClick={onApply}>
          <Text>套用配方</Text>
        </View>
        <View className='work-detail__btn work-detail__btn--primary' onClick={onAutoGenerate}>
          <Text>AI 直接生成</Text>
        </View>
      </View>
    </View>
  )
}
