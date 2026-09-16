import { useRef, useState } from 'react'
import { Image, ScrollView, Swiper, SwiperItem, Text, View } from '@tarojs/components'
import Taro, { useDidShow, useReachBottom } from '@tarojs/taro'
import { useMerchantStore } from '../../store/merchant'
import { listCreations, type CreationItem } from '../../services/creation'
import { listWorks, listWorkCategories, markWorkClone, type WorkCategory, type WorkItem } from '../../services/work'
import { FALLBACK_SLIDE, getHomeCarousel, type HomeCarouselSlide } from '../../services/home'
import StoreSwitcher from '../../components/store-switcher'
import logoPng from '../../assets/logo.png'
import sloganBanner from '../../assets/home/slogan-banner.svg'
// 展示图走 CDN（见 src/constants/static-assets.ts 的说明）：它们不需要跟版本走，
// 留在包里会白占 2MB 主包额度、并踩「图片资源超过 200K」的代码质量建议项。
// 图片源文件仍在 src/assets/home/ 下，改图后跑 `npm run assets:upload` 重新上传即可。
// ⚠ 轮播用的图不再从这里取：改由后台配置（services/home.ts），
//   兜底那张才用 static-assets 里的 HOME_CREATE_HERO。
import {
  HOME_WORK_FOOD as workFoodPng,
  HOME_WORK_EDUCATION as workEducationPng,
  HOME_WORK_BEAUTY as workBeautyPng,
  HOME_WORK_SERVICE as workServicePng,
  HOME_WORK_LEISURE as workLeisurePng,
} from '../../constants/static-assets'
import './index.scss'

const WORK_COVER_FALLBACKS: Record<string, string> = {
  餐饮: workFoodPng,
  教培: workEducationPng,
  美业: workBeautyPng,
  生活服务: workServicePng,
  休闲娱乐: workLeisurePng,
}

/** 优秀作品每页条数（两列，即 3 行） */
const WORK_PAGE_SIZE = 6
/** 分类横滑的「全部」选项：接口只返回有作品的分类 */
const WORK_CATEGORY_ALL = ''

/** 首页 · 创作工作台：门店切换常驻左上角，全页只有一个红色实心主按钮 */
export default function HomePage() {
  const merchant = useMerchantStore((s) => s.merchant)
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const stores = useMerchantStore((s) => s.stores)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const refreshMe = useMerchantStore((s) => s.refreshMe)
  const [error, setError] = useState('')
  const [recent, setRecent] = useState<CreationItem[]>([])
  // 首页轮播（运营在后台配）：初值直接给兜底单张，首屏立刻有内容，不等接口回来才画
  const [banners, setBanners] = useState<HomeCarouselSlide[]>([FALLBACK_SLIDE])
  const bannerKeyRef = useRef('')
  // 优秀作品：分类来自接口，列表按页拉取（真分页，不再本地切片）
  const [workCats, setWorkCats] = useState<WorkCategory[]>([])
  const [workCategory, setWorkCategory] = useState(WORK_CATEGORY_ALL)
  const [works, setWorks] = useState<WorkItem[]>([])
  const [workTotal, setWorkTotal] = useState(0)
  const [workHasMore, setWorkHasMore] = useState(false)
  const [workLoading, setWorkLoading] = useState(false)
  const workPageRef = useRef(0)
  const workLoadedRef = useRef(false)
  const storeName = stores.find((s) => s.id === currentStoreId)?.name ?? ''

  /** 拉作品列表：reset=true 拉第一页并替换，否则追加下一页 */
  const loadWorks = async (opts: { reset?: boolean; category?: string } = {}) => {
    const category = opts.category ?? workCategory
    const page = opts.reset ? 1 : workPageRef.current + 1
    setWorkLoading(true)
    try {
      const r = await listWorks({ category: category || undefined, page, pageSize: WORK_PAGE_SIZE })
      workPageRef.current = r.page
      setWorkTotal(r.total)
      setWorkHasMore(r.hasMore)
      setWorks((prev) => (opts.reset ? r.items : [...prev, ...r.items]))
    } catch {
      // 作品区失败不遮挡积分与门店，仅提示
      setError('优秀作品加载失败，点此重试')
    } finally {
      setWorkLoading(false)
    }
  }

  const loadWorkCategories = async () => {
    try {
      setWorkCats(await listWorkCategories())
    } catch {
      setWorkCats([])
    }
  }

  /**
   * 拉首页轮播配置（公开接口，免登录；失败一律走兜底，见 services/home.ts）。
   *
   * 内容没变就不 setState：换一个全新的数组会让 Swiper 重挂载、把当前页跳回第一张，
   * 而 useDidShow 每次回到首页都会跑一遍，运营没改配置时不该有这种跳动。
   */
  const loadBanners = async () => {
    const slides = await getHomeCarousel()
    const key = JSON.stringify(slides)
    if (key === bannerKeyRef.current) return
    bannerKeyRef.current = key
    setBanners(slides)
  }

  const refresh = async () => {
    if (!merchant) return
    setError('')
    try {
      await Promise.all([loadStores(true), refreshMe()])
    } catch {
      setError('门店或账户刷新失败，请重试')
      return
    }
    // 最近创作：跟随当前门店（门店是最高层）。失败只影响这一块，不遮住积分与门店。
    try {
      const sid = useMerchantStore.getState().currentStoreId
      setRecent(sid ? (await listCreations(sid)).slice(0, 2) : [])
    } catch {
      setRecent([])
      setError('最近创作加载失败，请重试')
    }
  }
  useDidShow(() => {
    void refresh()
    // 轮播是运营内容，每次回首页重拉一遍（内容不变时上面会跳过 setState）
    void loadBanners()
    // 作品是公共内容，只在首次进入时拉；切分类与上拉由下面各自触发
    if (!workLoadedRef.current) {
      workLoadedRef.current = true
      void loadWorkCategories()
      void loadWorks({ reset: true })
    }
  })

  /* ── 优秀作品：分类来自接口 + 两列网格 + 真分页 ── */
  const switchWorkCategory = (c: string) => {
    if (c === workCategory) return
    setWorkCategory(c)
    setWorks([])
    workPageRef.current = 0
    void loadWorks({ reset: true, category: c })
  }

  const loadMoreWorks = () => {
    if (workLoading || !workHasMore) return
    void loadWorks()
  }
  useReachBottom(() => { loadMoreWorks() })

  const goMine = () => Taro.switchTab({ url: '/pages/mine/index' })

  if (!merchant) return <View className='home'>
    <View className='home__top home__top--guest'>
      <View className='home__topbar'>
        <View className='home__brand'>
          <Image className='home__logo' src={logoPng} mode='aspectFit' />
          <Text className='home__appname'>大帅餐饮</Text>
        </View>
        <View className='home__icon-btn' onClick={goMine}><t-icon name='user' size='20px' /></View>
      </View>
      <View className='home__guest-hero'>
        <Text className='home__eyebrow'>门店短视频创作助手</Text>
        <Text className='home__hero-title'>把今天的招牌菜，拍成明天的客流。</Text>
        <Text className='home__hero-desc'>从菜品卖点到口播、分镜和成片，一条创作流完成。</Text>
      </View>
    </View>
    <View className='ds-card home__guest'>
      <Text className='home__guest-title'>登录后开始创作</Text>
      <Text className='home__guest-desc'>进入「我的」完成微信一键登录</Text>
      <View className='ds-btn ds-btn--primary ds-btn--block' hoverClass='ds-hover' onClick={goMine}>去登录</View>
    </View>
  </View>

  const goStores = () => Taro.navigateTo({ url: '/pages/store/list' })
  const goCreations = () => Taro.switchTab({ url: '/pages/creation/list' })
  const goCreate = () => (currentStoreId ? Taro.navigateTo({ url: '/pages/creation/edit' }) : goStores())
  const openCreation = (id: string) => Taro.navigateTo({ url: `/pages/creation/edit?id=${id}` })
  // 点卡片进详情（看视频 + 配方说明）；点「生成同款」直接带着配方进创作流
  const openWork = (work: WorkItem) => Taro.navigateTo({ url: `/pages/work/detail?id=${work.id}` })
  const goCloneWork = (work: WorkItem) => {
    if (!currentStoreId) { goStores(); return }
    void markWorkClone(work.id).catch(() => undefined)
    Taro.navigateTo({ url: `/pages/creation/edit?workId=${work.id}` })
  }

  /**
   * 轮播点击：跳转目标由后台配置，但**只认白名单里的枚举**（services/home.ts::CarouselLink）。
   * 这里用 switch 穷举、而不是拿后台存的值拼 URL —— 拼 URL 的话后台一旦存了脏值，
   * 用户点下去就是一次静默失败的 navigateTo（报的还是看着像超时的 fail timeout）。
   */
  const onBannerTap = (s: HomeCarouselSlide) => {
    switch (s.link) {
      case 'CREATE': goCreate(); break
      case 'CREATIONS': goCreations(); break
      case 'STORES': goStores(); break
      case 'MEMBER': void Taro.navigateTo({ url: '/pages/recharge/index' }); break
      case 'WORK':
        // 没填作品 id 时当作纯展示，别跳一个必然不存在的详情页
        if (s.workId) void Taro.navigateTo({ url: `/pages/work/detail?id=${s.workId}` })
        break
      default: break
    }
  }
  return <View className='home'>
    {/* ── 顶栏：门店是创作上下文，但不在首页重复展示管理入口 ── */}
    <View className='home__top'>
      <View className='home__topbar'>
        <StoreSwitcher />
        <View className='home__icon-btn' onClick={goMine}><t-icon name='user' size='20px' /></View>
      </View>
      <View className='home__slogan-banner'>
        <Image className='home__slogan-image' src={sloganBanner} mode='widthFix' />
      </View>
    </View>

    <View className='home__body'>
      {/* ── 创作入口：运营可在后台配成轮播（只配一张时等于原来的静态卡片） ── */}
      <Swiper
        className='home__banner'
        // 只有一张时不轮播、也不显示圆点：一个孤零零的圆点看着像出错
        autoplay={banners.length > 1}
        circular={banners.length > 1}
        interval={4000}
        duration={420}
        indicatorDots={banners.length > 1}
        indicatorColor='rgba(255, 255, 255, 0.35)'
        indicatorActiveColor='#ffffff'
      >
        {banners.map((s) => (
          <SwiperItem key={s.id}>
            <View className='home__create-card' hoverClass='ds-hover--press' onClick={() => onBannerTap(s)}>
              <Image className='home__create-image' src={s.image} mode='aspectFill' />
              <View className='home__create-shade' />
              <View className='home__create-copy'>
                {!!s.kicker && <Text className='home__create-kicker'>{s.kicker}</Text>}
                <Text className='home__create-title'>{s.title}</Text>
                {!!s.desc && <Text className='home__create-desc'>{s.desc}</Text>}
              </View>
              {!!s.actionText && (
                <View className='home__create-action'><Text>{s.actionText}</Text><Text className='home__create-arrow'>→</Text></View>
              )}
            </View>
          </SwiperItem>
        ))}
      </Swiper>

      {!!error && (
        <View className='ds-notice home__error' onClick={() => void refresh()}>
          <Text>{error}，点此重试</Text>
        </View>
      )}

      {/* ── 最近创作 ── */}
      <View className='home__sec'>
        <View>
          <Text className='home__sec-title'>接着上次拍</Text>
          <Text className='home__sec-desc'>未完成的灵感，不用从头再来</Text>
        </View>
        <View className='home__sec-more' onClick={goCreations}><Text>全部创作 ›</Text></View>
      </View>

      {recent.length === 0 ? (
        <View className='home__recent-empty' hoverClass='ds-hover' onClick={goCreate}>
          <Text className='home__recent-empty-text'>
            {currentStoreId ? `「${storeName || '当前门店'}」还没有创作，点这里开始` : '还没有门店，先创建一家门店'}
          </Text>
        </View>
      ) : (
        <View className='home__recent'>
          {recent.map((c) => (
            <View className='home__recent-item' key={c.id} hoverClass='ds-hover' onClick={() => openCreation(c.id)}>
              <View className='home__recent-cover'><t-icon name='movie-clapper' size='36rpx' /></View>
              <View className='home__recent-main'>
                <Text className='home__recent-title'>{c.title || '未命名创作'}</Text>
                <View className='home__recent-meta'>
                  {!!c.trackLabel && <Text className='ds-pill ds-pill--red-soft'>{c.trackLabel}</Text>}
                  <Text className='home__recent-sub'>分镜 {c._count?.shots ?? 0}</Text>
                </View>
              </View>
              <Text className='home__recent-arrow'>›</Text>
            </View>
          ))}
        </View>
      )}

      {/* ── 优秀作品：分类横滑 + 两列网格 + 上拉加载更多 ── */}
      <View className='home__sec'>
        <View className='home__sec-left'>
          <Text className='home__sec-ai'>AI</Text>
          <Text className='home__sec-title'>优秀作品</Text>
        </View>
        {workTotal > 0 && <Text className='home__sec-count'>{workTotal} 个作品</Text>}
      </View>

      <ScrollView
        scrollX
        enhanced
        showScrollbar={false}
        className='home__works-tabs'
      >
        {[{ category: WORK_CATEGORY_ALL, label: '全部', count: workTotal }, ...workCats.map((c) => ({ category: c.category, label: c.category, count: c.count }))].map((c) => (
          <View
            key={c.category || 'all'}
            className={`home__work-tab ${workCategory === c.category ? 'home__work-tab--on' : ''}`}
            hoverClass={workCategory === c.category ? 'none' : 'ds-hover'}
            onClick={() => switchWorkCategory(c.category)}
          >
            <Text>{c.label}</Text>
          </View>
        ))}
      </ScrollView>

      {workLoading && works.length === 0 ? (
        <View className='home__work-empty'>
          <Text>加载中…</Text>
        </View>
      ) : works.length === 0 ? (
        <View className='home__work-empty'>
          <Text>{workCategory ? `「${workCategory}」暂无作品` : '暂无作品，运营正在挑选中'}</Text>
        </View>
      ) : (
        <View className='home__works'>
          {works.map((w) => {
            const cover = w.coverUrl || WORK_COVER_FALLBACKS[w.category]
            const hasCover = !!cover
            const hasVideo = !!w.videoKey
            return (
              <View
                className={`home__work ${hasCover ? '' : 'home__work--empty'}`}
                key={w.id}
                hoverClass='ds-hover--press'
                onClick={() => openWork(w)}
              >
                {hasCover ? (
                  <Image className='home__work-cover' src={cover} mode='aspectFill' />
                ) : (
                  <View className='home__work-ph'>
                    <Text className='home__work-ph-cat'>{w.category}</Text>
                    <Text className='home__work-ph-hint'>封面待补</Text>
                  </View>
                )}
                {hasCover && <View className='home__work-scrim' />}

                <View className='home__work-top'>
                  <View className='home__work-tags'>
                    {(w.tags ?? []).slice(0, 2).map((t) => (
                      <Text className='home__work-tag' key={t}>{t}</Text>
                    ))}
                  </View>
                </View>

                {hasVideo && (
                  <View className='home__work-play'>
                    <View className='home__work-play-icon'>
                      <View className='home__work-play-triangle' />
                    </View>
                  </View>
                )}

                <View className='home__work-bottom'>
                  <Text className='home__work-title'>{w.title}</Text>
                  <View className='home__work-cta' onClick={(e) => { e.stopPropagation(); goCloneWork(w); }}>
                    <Text>生成同款</Text>
                  </View>
                </View>
              </View>
            )
          })}
        </View>
      )}

      {/* 上拉加载更多：也可点击加载 */}
      {works.length > 0 && (
        <View className='home__works-more' onClick={loadMoreWorks}>
          {workLoading ? (
            <Text className='home__works-more-txt'>正在加载…</Text>
          ) : workHasMore ? (
            <Text className='home__works-more-txt home__works-more-txt--link'>上拉或点击加载更多</Text>
          ) : (
            <Text className='home__works-more-txt'>已经到底了 · 共 {workTotal} 个作品</Text>
          )}
        </View>
      )}
    </View>
  </View>
}
