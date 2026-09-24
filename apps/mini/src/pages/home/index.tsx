import { useRef, useState } from 'react'
import { CoverView, Image, ScrollView, Swiper, SwiperItem, Text, Video, View } from '@tarojs/components'
import Taro, { useDidHide, useDidShow, useReachBottom } from '@tarojs/taro'
import { useMerchantStore } from '../../store/merchant'
import { STORAGE_KEYS } from '../../config'
import { guideLogin } from '../../utils/login-guide'
import { listCreations, type CreationItem } from '../../services/creation'
import { getWork, listWorks, listWorkCategories, markWorkClone, type WorkCategory, type WorkItem } from '../../services/work'
import {
  DEFAULT_SLOGAN_BANNER,
  FALLBACK_SLIDE,
  getHomeLayout,
  type HomeCarouselSlide,
} from '../../services/home'
// 展示图走 CDN（见 src/constants/static-assets.ts 的说明）：它们不需要跟版本走，
// 留在包里会白占 2MB 主包额度、并踩「图片资源超过 200K」的代码质量建议项。
// 图片源文件仍在 src/assets/home/ 下，改图后跑 `npm run assets:upload` 重新上传即可。
// ⚠ 轮播与口号图这两张**不再由页面直接引用 static-assets**：它们改由后台配置，
//   取值与兜底都在 services/home.ts（页面只拿解析好的地址）。
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
/**
 * 已取到的作品播放地址的复用窗口。
 * 详情接口签出来的地址 1 小时后失效，这里按 45 分钟保守复用 —— 复用窗口若超过签名有效期，
 * 就会变成「点了播放却播不了」这种最难查的静默失败。
 */
const WORK_PLAY_URL_TTL_MS = 45 * 60 * 1000
/** 分类横滑的「全部」选项：接口只返回有作品的分类 */
const WORK_CATEGORY_ALL = ''

/** 首页 · 创作工作台：顶部只有口号海报（原顶栏的门店切换与头像按钮已去掉），全页只有一个红色实心主按钮 */
export default function HomePage() {
  const token = useMerchantStore((s) => s.token)
  const hydrate = useMerchantStore((s) => s.hydrate)
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const stores = useMerchantStore((s) => s.stores)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const refreshMe = useMerchantStore((s) => s.refreshMe)
  const [error, setError] = useState('')
  /**
   * 顶部提示条这条消息**是谁写的**。
   * ★ 首页顶部只有一个提示条，但它背后是三条互相独立的数据线（门店/账户、最近创作、优秀作品），
   *   而 retryHome 又是三路并发。只用 setError('') 清空的话，后到的那条成功会把另一条
   *   已经报出来的失败顺手擦掉 —— 表现为「门店明明没加载出来，提示却自己消失了」。
   *   所以清空必须限定来源：只有写这条消息的那一块成功了，才允许清。
   */
  const errorFromRef = useRef<'' | 'home' | 'recent' | 'works'>('')
  const showError = (from: 'home' | 'recent' | 'works', msg: string) => {
    errorFromRef.current = from
    setError(msg)
  }
  const clearError = (from: 'home' | 'recent' | 'works') => {
    if (errorFromRef.current !== from) return
    errorFromRef.current = ''
    setError('')
  }
  const [recent, setRecent] = useState<CreationItem[]>([])
  // 首页轮播（运营在后台配）：初值直接给兜底单张，首屏立刻有内容，不等接口回来才画
  const [banners, setBanners] = useState<HomeCarouselSlide[]>([FALLBACK_SLIDE])
  const bannerKeyRef = useRef('')
  // 口号图：初值同样是**内置默认图**（首屏立刻有内容），拉到运营配置后原地换 src。
  // 这里不需要 bannerKeyRef 那种去重 ref：值是个字符串，setState 同值 React 会直接跳过；
  // 而轮播是数组，每次都是新引用，不去重就会让 Swiper 重挂载、跳回第一张。
  const [sloganBanner, setSloganBanner] = useState(DEFAULT_SLOGAN_BANNER)
  // 优秀作品：分类来自接口，列表按页拉取（真分页，不再本地切片）
  const [workCats, setWorkCats] = useState<WorkCategory[]>([])
  const [workCategory, setWorkCategory] = useState(WORK_CATEGORY_ALL)
  const [works, setWorks] = useState<WorkItem[]>([])
  const [workTotal, setWorkTotal] = useState(0)
  const [workHasMore, setWorkHasMore] = useState(false)
  const [workLoading, setWorkLoading] = useState(false)
  const workPageRef = useRef(0)
  const workLoadedRef = useRef(false)
  /**
   * 正在卡片里就地播放的作品。**同一时刻只允许一个** —— 小卡片里同时播几个视频既看不清、
   * 又白费流量，而且 Video 是原生组件、层级最高，多开几个会把整块网格的点击搞得很难预测。
   */
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null)
  /** 正在取播放地址的作品 id：取地址要发一次请求，期间让按钮有反馈 */
  const [playPending, setPlayPending] = useState<string | null>(null)
  const playUrlRef = useRef<Record<string, { url: string; at: number }>>({})
  const currentStore = stores.find((s) => s.id === currentStoreId)
  const storeName = currentStore?.name ?? ''
  const currentDishCount = currentStore?._count?.dishes ?? 0
  // token 是当前会话的权威登录态；merchant 资料可能在冷启动或资料刷新期间暂未恢复。
  const persistedToken = Taro.getStorageSync<string>(STORAGE_KEYS.token) ?? ''
  const isLoggedIn = !!token || !!persistedToken
  /** 创作依赖真实业务上下文：必须先有门店，再有当前门店的至少一道菜。 */
  const setupStage: 'STORE' | 'DISH' | 'READY' = !stores.length || !currentStore
    ? 'STORE'
    : currentDishCount > 0
      ? 'READY'
      : 'DISH'

  /**
   * 作品列表的请求代次。
   * ★ 切分类与「触底加载下一页」会并发在飞，而它们没有顺序保证：
   *   旧分类的慢响应后到，会把新分类的 items 追加到列表里（或反过来把新分类的首页结果覆盖掉），
   *   表现为「切了分类，列表里混进了别类的作品」「翻页翻出重复内容」。
   *   只接受最后一次请求的响应。
   */
  const workReqRef = useRef(0)

  /** 拉作品列表：reset=true 拉第一页并替换，否则追加下一页 */
  const loadWorks = async (opts: { reset?: boolean; category?: string } = {}) => {
    const category = opts.category ?? workCategory
    const page = opts.reset ? 1 : workPageRef.current + 1
    const my = ++workReqRef.current
    setWorkLoading(true)
    try {
      const r = await listWorks({ category: category || undefined, page, pageSize: WORK_PAGE_SIZE })
      if (my !== workReqRef.current) return // 已被更新的一次请求取代，丢弃本次回包
      workPageRef.current = r.page
      setWorkTotal(r.total)
      setWorkHasMore(r.hasMore)
      setWorks((prev) => (opts.reset ? r.items : [...prev, ...r.items]))
      // ★ 只有真的拉到数据才算「首次加载完成」。
      //   原来是在 useDidShow 的 if 里置位，于是一次网络抖动（或接口报错）就等于
      //   「作品区一直空白到杀进程重开」：useDidShow 每次回首页都会跑，但那个 ref 已经是 true。
      //   失败时留着 false，下次回首页自动重试。
      workLoadedRef.current = true
      clearError('works')
    } catch {
      if (my !== workReqRef.current) return
      // 作品区失败不遮挡积分与门店，仅提示
      showError('works', '优秀作品加载失败，点此重试')
    } finally {
      // 只有「最后一次请求」才有资格关掉 loading：否则先到的那次会把还在加载的
      // 新请求的 loading 提前关掉，界面看起来像已经加载完了
      if (my === workReqRef.current) setWorkLoading(false)
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
   * 拉首页的运营配置：轮播 + 口号图（公开接口，免登录；失败一律走兜底，见 services/home.ts）。
   *
   * 轮播内容没变就不 setState：换一个全新的数组会让 Swiper 重挂载、把当前页跳回第一张，
   * 而 useDidShow 每次回到首页都会跑一遍，运营没改配置时不该有这种跳动。
   * （口号图是字符串，同值 setState 本身就不会触发重渲染，不用额外去重。）
   */
  const loadHomeLayout = async () => {
    const cfg = await getHomeLayout()
    const key = JSON.stringify(cfg.slides)
    if (key !== bannerKeyRef.current) {
      bannerKeyRef.current = key
      setBanners(cfg.slides)
    }
    setSloganBanner(cfg.sloganBanner)
  }

  const refresh = async () => {
    // 首页可能先于 App 的 launch hydrate 完成显示；先从本地会话恢复，再决定是否请求业务数据。
    if (!token && persistedToken) hydrate()
    const sessionToken = useMerchantStore.getState().token
    if (!sessionToken) return
    // 重试前先把「上一次失败留下的」提示收掉（只收自己这两块；作品区的提示由 loadWorks 负责清理）
    clearError('home')
    clearError('recent')
    try {
      await Promise.all([loadStores(true), refreshMe()])
    } catch {
      showError('home', '门店或账户刷新失败，请重试')
      return
    }
    // 最近创作：跟随当前门店（门店是最高层）。失败只影响这一块，不遮住积分与门店。
    try {
      const sid = useMerchantStore.getState().currentStoreId
      setRecent(sid ? (await listCreations(sid)).slice(0, 2) : [])
    } catch {
      setRecent([])
      showError('recent', '最近创作加载失败，请重试')
    }
  }
  /**
   * 顶部提示条的统一点击动作。
   * 原来只调 refresh()（门店 / 账户），而首页最常失败的其实是作品区 ——
   * 那时候点提示条等于什么都没重试，用户只会觉得「点了没反应」。
   */
  const retryHome = () => {
    void refresh()
    void loadWorkCategories()
    void loadWorks({ reset: true })
  }

  useDidShow(() => {
    void refresh()
    // 轮播与口号图都是运营内容，每次回首页重拉一遍（内容没变时上面会跳过 setState）
    void loadHomeLayout()
    // ★ 作品是**公开内容**（服务端 routes/works.ts 故意不鉴权），所以这里**不看登录态**：
    //   未登录也照样拉、照样渲染 —— 作品区就是给未登录用户的引流素材。
    //   反过来如果让它按登录态早退，代价是一次 401 引发的连锁：
    //   请求层 redirectToLogin() → 300ms 后 switchTab 到「我的」——
    //   用户一打开小程序就被从首页弹走，连口号都留不住。
    //   ref 的置位在 loadWorks 的**成功分支**里（失败要能自动重试，见那里）。
    if (!workLoadedRef.current) {
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
    // 列表被整体替换，正在播的那条多半已不在新列表里 —— 停掉，
    // 别留一个看不见、却还在后台播的实例
    setPlaying(null)
    void loadWorks({ reset: true, category: c })
  }

  const loadMoreWorks = () => {
    if (workLoading || !workHasMore) return
    void loadWorks()
  }
  useReachBottom(() => { loadMoreWorks() })

  // 离开首页就把播放态收掉：Video 不会因为页面切走而自己停，留着它继续吃流量，
  // 回来还会看到一张「播完停在最后一帧」的卡片。
  useDidHide(() => { setPlaying(null) })

  // 未登录时它是「登录后开始创作」那张引导卡上的按钮（原来首页未登录是整页早退，现在只换这一块）
  const goMine = () => Taro.switchTab({ url: '/pages/mine/index' })

  const goStores = () => Taro.navigateTo({ url: '/pages/store/list' })
  const goDishes = () => currentStoreId
    ? Taro.navigateTo({ url: `/pages/dish/list?storeId=${currentStoreId}` })
    : goStores()
  const goCreations = () => Taro.switchTab({ url: '/pages/creation/list' })
  const goCreate = () => (currentStoreId ? Taro.navigateTo({ url: '/pages/creation/edit' }) : goStores())
  const openCreation = (id: string) => Taro.navigateTo({ url: `/pages/creation/edit?id=${id}` })
  // 点卡片进详情（看视频 + 配方说明）；点「生成同款」直接带着配方进创作流
  const openWork = (work: WorkItem) => Taro.navigateTo({ url: `/pages/work/detail?id=${work.id}` })
  const goCloneWork = (work: WorkItem) => {
    // 未登录先给一句解释，别把用户丢去门店页吃一个 401、再被请求层弹到「我的」（见 utils/login-guide.ts）
    if (!isLoggedIn) { guideLogin({ reason: '生成同款需要先登录' }); return }
    if (!currentStoreId) { goStores(); return }
    void markWorkClone(work.id).catch(() => undefined)
    Taro.navigateTo({ url: `/pages/creation/edit?workId=${work.id}` })
  }

  const stopPlay = () => setPlaying(null)

  /**
   * 点卡片**正中间那个播放按钮**：不跳页，就地换成 video 播放。
   * 卡片其他地方仍然是「进详情」—— 两者的区别只由 `stopPropagation` 决定，
   * 与下面「生成同款」按钮用的是同一套写法（本项目已验证可用）。
   *
   * 为什么这里要请求一次详情拿地址：列表接口**刻意只签封面**（见后端 routes/works.ts 的说明），
   * 不带 videoUrl。若为了「列表能直接播」而让列表把每条作品的视频都签一遍，等于每次翻页
   * 都白签一批 1 小时有效的地址，只为那少数几次点击。所以改成点播时才取，并按作品缓存
   * （签名会过期，缓存窗口见 WORK_PLAY_URL_TTL_MS）。
   */
  const playWork = async (work: WorkItem) => {
    if (playPending) return
    // 重复点正在播的那条 = 收起。播放中按钮已被 Video 盖住，这一步主要挡快速连点
    if (playing?.id === work.id) { setPlaying(null); return }
    setPlayPending(work.id)
    try {
      const cached = playUrlRef.current[work.id]
      const url = cached && Date.now() - cached.at < WORK_PLAY_URL_TTL_MS
        ? cached.url
        : (await getWork(work.id)).videoUrl
      if (!url) throw new Error('这条作品还没有可播放的成片')
      playUrlRef.current[work.id] = { url, at: Date.now() }
      setPlaying({ id: work.id, url })
    } catch (error) {
      // 拿不到地址就把缓存清掉：留着一个坏地址，用户下次点还是同一条死路
      delete playUrlRef.current[work.id]
      setPlaying(null)
      void Taro.showToast({ title: (error as Error).message || '播放失败，请稍后重试', icon: 'none', duration: 2500 })
    } finally {
      setPlayPending(null)
    }
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
    {/* ── 顶部：只留口号海报 ──
        原来这里还有一条顶栏（左侧门店切换 pill + 右侧圆形头像按钮），已按需求去掉：
        首页是「看内容、点创作」的台子，门店是创作上下文但不是首页的入口，
        头像更是与底部「我的」tab 重复；两者都在别的页面/底部 tab 有入口。 */}
    <View className='home__top'>
      {/* 品牌口号海报：运营可在后台「首页口号图」上传替换（services/home.ts）。
          没配时用的是内置那张红/白/黑三色海报 —— 它由代码合成，别手工改 PNG
          （源码 scripts/slogan-banner.html，见 src/assets/home/README.md）。
          src 变化时会自动换图，不用 key 或强制刷新。 */}
      <View className='home__slogan-banner'>
        <Image className='home__slogan-image' src={sloganBanner} mode='aspectFit' />
      </View>
    </View>

    <View className='home__body'>
      {isLoggedIn && setupStage !== 'READY' ? (
        <View className='home__setup'>
          {/* ★ 2026-09-24 按需求：卡头整块删除（kicker「开始创作前」+ 标题「先把你的生意资料准备好」），
              只留下面两条步骤与一个动作按钮 —— 步骤名本身已经说清要做什么，卡头只是把同一件事再说一遍。 */}
          <View className='home__setup-steps'>
            <View className={`home__setup-step ${setupStage === 'STORE' ? 'home__setup-step--active' : 'home__setup-step--done'}`}>
              <View className='home__setup-index'><Text>{setupStage === 'STORE' ? '1' : '✓'}</Text></View>
              <View className='home__setup-step-copy'>
                <Text className='home__setup-step-title'>创建门店</Text>
              </View>
            </View>
            <View className={`home__setup-step ${setupStage === 'DISH' ? 'home__setup-step--active' : 'home__setup-step--locked'}`}>
              <View className='home__setup-index'><Text>2</Text></View>
              <View className='home__setup-step-copy'>
                <Text className='home__setup-step-title'>添加菜品</Text>
                <Text className='home__setup-step-desc'>至少添加一道招牌菜，创作才有内容依据</Text>
              </View>
            </View>
          </View>
          <View
            className='home__setup-action'
            hoverClass='ds-hover--press'
            onClick={setupStage === 'STORE' ? goStores : goDishes}
          >
            <Text>{setupStage === 'STORE' ? '去创建' : '去添加'}</Text>
            <Text className='home__setup-arrow'>→</Text>
          </View>
        </View>
      ) : (
        /* ── 创作入口：完成门店与菜品准备后再开放 ── */
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
      )}

      {!!error && (
        <View className='ds-notice home__error' onClick={retryHome}>
          <Text>{error}</Text>
        </View>
      )}

      {!isLoggedIn ? (
        /* 未登录：原来这里是一整页的早退分支（文字 hero + 登录卡），现在只替换
           「接着上次拍」这一块。首页其余部分 —— 口号海报、轮播、优秀作品 ——
           对未登录用户同样是有效内容，尤其作品区：那才是给未登录用户的引流素材。 */
        <View className='ds-card home__guest home__guest--inline'>
          <Text className='home__guest-title'>登录后开始创作</Text>
          <Text className='home__guest-desc'>进入「我的」完成微信一键登录</Text>
          <View className='ds-btn ds-btn--primary ds-btn--block' hoverClass='ds-hover' onClick={goMine}>去登录</View>
        </View>
      ) : setupStage === 'READY' ? (
        <>
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
                  {/* 有已上传的视频就显示它的封面（与创作列表同一份服务端字段），没有才退回默认图标 */}
                  <View className='home__recent-cover'>
                    {c.coverUrl ? (
                      <Image className='home__recent-cover-image' src={c.coverUrl} mode='aspectFill' />
                    ) : (
                      <t-icon name='movie-clapper' size='36rpx' />
                    )}
                  </View>
                  <View className='home__recent-main'>
                    <Text className='home__recent-title'>{c.title || '未命名创作'}</Text>
                    <View className='home__recent-meta'>
                      {!!c.trackLabel && <Text className='ds-pill ds-pill--red-soft'>{c.trackLabel}</Text>}
                      <Text className='home__recent-sub'>分镜 {c.shotsTotal}</Text>
                    </View>
                  </View>
                  <Text className='home__recent-arrow'>›</Text>
                </View>
              ))}
            </View>
          )}
        </>
      ) : /* 已登录但门店/菜品还没备好：上面已经有 setup 卡在手把手指引，
             这里不再出任何卡片 —— ★ 原来这个分支落进「去登录」卡，
             已登录用户会看到「登录后开始创作」，与上面的 setup 卡自相矛盾（已实测复现） */
        null}

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
            const playingUrl = playing?.id === w.id ? playing.url : null
            /**
             * 播放态**单独一个分支 return**，不去改常态那棵 DOM 树。
             * 原因：Video 是原生组件、层级最高，会把标签 / 标题 / 播放按钮统统盖住 ——
             * 与其再加一套 display:none 去藏（小程序 wxss 的选择器支持面本来就窄），
             * 不如播放时根本不渲染它们。顺带也保证了「点其他地方进详情」在播放时不会误触发。
             */
            if (playingUrl) {
              return (
                <View className='home__work home__work--playing' key={w.id}>
                  <Video
                    className='home__work-video'
                    src={playingUrl}
                    autoplay
                    controls
                    objectFit='cover'
                    onEnded={stopPlay}
                    onError={() => {
                      stopPlay()
                      void Taro.showToast({ title: '播放失败，请稍后重试', icon: 'none', duration: 2500 })
                    }}
                  >
                    {/* cover-view 是唯一能覆盖在原生组件之上的元素，所以退出播放的入口只能是它 */}
                    <CoverView className='home__work-stop' onClick={stopPlay}>收起</CoverView>
                  </Video>
                </View>
              )
            }
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
                  /* 播放按钮是**独立命中区**：它吃掉这次点击（stopPropagation），
                     其余区域留给卡片自己的「进详情」—— 与下面「生成同款」是同一套写法。 */
                  <View
                    className={`home__work-play ${playPending === w.id ? 'home__work-play--pending' : ''}`}
                    hoverClass='ds-hover--press'
                    onClick={(e) => { e.stopPropagation(); void playWork(w); }}
                  >
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
