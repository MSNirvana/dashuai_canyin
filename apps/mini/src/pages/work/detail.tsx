import { useEffect, useState } from 'react'
import { View, Text, Image, Video, Button } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { getWork, markWorkClone, markWorkView, type WorkDetail } from '../../services/work'
import { COMPLEXITY_OPTIONS, COPY_TRACK_OPTIONS, normalizeTrack } from '../../services/creation'
import { useMerchantStore } from '../../store/merchant'
import { guideLogin } from '../../utils/login-guide'
import { readRouteId, isBrokenRouteId } from '../../utils/route-id'
import './detail.scss'

/** 优秀作品详情：看成片 → 看配方 → 一键套用 */
export default function WorkDetailPage() {
  const router = useRouter()
  // ★ 编号当场校验：`?id=undefined` 拼出来的 URL 看着正常，但服务端 idParam 会回 4000。
  //   本页是**免登录可读**的引流页（首页/分享都会进来），拿这种编号去请求只会得到
  //   一句「参数不合法」，用户不知道该点哪里（详见 utils/route-id.ts）。
  const id = readRouteId(router.params)
  const idBroken = isBrokenRouteId(router.params)
  const merchant = useMerchantStore((s) => s.merchant)
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

  /**
   * 账号还没有门店时的唯一出路：去**创建门店**。
   * ★ 单店模型（2026-09-24）：原来跳「门店列表」页，该页已删除 —— 有店就直接进门店详情，
   *   没店才来这儿建（一个账号只能一家门店，建第二家会被服务端拒绝）。
   */
  const goNewStore = () => Taro.navigateTo({ url: '/pages/store/edit' })

  /**
   * 未登录时点「套用配方 / AI 直接生成」的引导。
   *
   * 原来这两种情况都只会走门店页（那时的门店列表页）：用户被送到门店页，门店页的请求再吃一个 401，
   * 请求层才把他 switchTab 到「我的」并弹登录框 —— 结果是
   * 「点了按钮 → 闪两下 → 落在『我的』」，用户根本不知道中间发生了什么，
   * 甚至以为按钮坏了。这里直接说清楚，一步到位。
   *
   * 本页现在**免登录也能看**（服务端 routes/works.ts 故意不鉴权，见该文件头注释），
   * 所以「未登录点按钮」不是边缘情况，而是首页引流进来的用户的必经一步。
   */
  const needLogin = () => guideLogin({ reason: '套用同款配方需要先登录' })

  /** 预填：带着配方进创作页，用户自己确认后再生成 */
  const onApply = () => {
    // 编号为空时两个按钮本来就不该出现在页面上（`!work` 会先渲染成「作品不存在」），
    // 这里再挡一道，避免把 `workId=null` 拼进下一个 URL 重演同一个坑
    if (!id) return
    if (!merchant) {
      needLogin()
      return
    }
    if (!currentStoreId) {
      goNewStore()
      return
    }
    void markWorkClone(id).catch(() => undefined)
    Taro.navigateTo({ url: `/pages/creation/edit?workId=${id}` })
  }

  /**
   * 一键生成：下一步就会真的调 AI（消耗积分），先确认再跳。
   * 创作页本身已是「选好款式就直接生成、生成完直达拍摄」，所以这里只做预填 + 前置确认，
   * 不再需要额外的 auto 参数（款式与门店都要让用户在创作页确认一次，避免白扣积分）。
   *
   * ★ 文案里要写明「分镜沿用这条作品的，不再另外生成」：这条作品的配方带分镜骨架时，
   *   创作页会直接把它落成初始分镜并跳过 AI 分镜那一笔。用户对扣费最敏感，
   *   这里少说一句，他就会以为「跟以前一样扣两次」而不敢点。
   */
  const onAutoGenerate = async () => {
    if (!id) return
    if (!merchant) {
      needLogin()
      return
    }
    if (!currentStoreId) {
      goNewStore()
      return
    }
    const shotCount = (work?.recipeJson?.shotSkeleton ?? []).length
    const r = await Taro.showModal({
      title: '用 AI 直接生成',
      content: shotCount
        ? `将预填这条作品的文案款式与镜头复杂度，并直接套用它的 ${shotCount} 个分镜（不再另外生成分镜）。点「生成」后只消耗文案的积分。继续？`
        : '将按这条作品的配方预填文案款式与镜头复杂度，点「生成」后消耗积分。继续？',
      confirmText: '继续生成',
      confirmColor: '#e1251b',
    })
    if (!r.confirm) return
    void markWorkClone(id).catch(() => undefined)
    Taro.navigateTo({ url: `/pages/creation/edit?workId=${id}` })
  }

  if (loading) return <View className='work-detail work-detail--state'>加载中…</View>
  if (!work) {
    return (
      <View className='work-detail work-detail--state'>
        {idBroken ? '链接里的作品编号有误，请从优秀作品列表重新进入' : '作品不存在或已下架'}
        <Button size='mini' onClick={() => Taro.switchTab({ url: '/pages/home/index' })}>回首页看优秀作品</Button>
      </View>
    )
  }

  const recipe = work.recipeJson ?? {}
  // ★ 走 normalizeTrack：配方的 track 可能是改型前的老值（INTRO/QUALITY/NORMAL），
  //   直接 find 会得到 undefined ⇒ 这一行**整行空白**，看着像这条作品缺配方。
  const normalizedTrack = normalizeTrack(recipe.track)
  const trackLabel = COPY_TRACK_OPTIONS.find((o) => o.value === normalizedTrack)?.label
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
