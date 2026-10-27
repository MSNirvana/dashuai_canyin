import { useEffect, useRef, useState } from 'react'
import { CoverView, Image, ScrollView, Swiper, SwiperItem, Text, Video, View } from '@tarojs/components'
import Taro, { useDidHide, useDidShow, useReachBottom } from '@tarojs/taro'
import { useMerchantStore } from '../../store/merchant'
import { STORAGE_KEYS } from '../../config'
import { guideLogin } from '../../utils/login-guide'
import { GuideDialogHost, useGuideDialogVisible } from '../../components/guide-dialog'
import { useAppShare } from '../../utils/app-share'
import { listCreations, type CreationItem } from '../../services/creation'
import { getWork, listWorks, listWorkCategories, markWorkView, type WorkCategory, type WorkItem } from '../../services/work'
import {
  FALLBACK_SLIDE,
  getHomeLayout,
  type HomeCarouselSlide,
} from '../../services/home'
// 展示图走 CDN（见 src/constants/static-assets.ts 的说明）：它们不需要跟版本走，
// 留在包里会白占 2MB 主包额度、并踩「图片资源超过 200K」的代码质量建议项。
// 图片源文件仍在 src/assets/home/ 下，改图后跑 `npm run assets:upload` 重新上传即可。
// ⚠ 轮播这张**不再由页面直接引用 static-assets**：它改由后台配置，
//   取值与兜底都在 services/home.ts（页面只拿解析好的地址）。
// ★ 2026-09-24 按需求：**口号图整块下线**（页面不再渲染）。
//   2026-09-29 善后完成：`getHomeLayout()` 也不再返回 sloganBanner 字段 ——
//   后台页 / 上传接口 / seed 配置行 / 内置图常量与生成脚本都已一并删除。
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
 * ★ 2026-10-26：**不显示给顾客**的作品标签。
 *
 * 「成片入库」是后台「从成片入库」时自动打上的**内部来源标记**
 * （`server/src/services/work.service.ts` 里 `tags: ['成片入库']`），
 * 它回答的是「运营这条作品怎么来的」，对看视频的顾客零信息量，
 * 压在封面上还挡内容 —— 用户要求删掉它。
 * ★ 只在前端过滤、不动库里的数据：后台仍靠这个标签区分来源。
 */
const HIDDEN_WORK_TAGS = ['成片入库']
/**
 * 已取到的作品播放地址的复用窗口。
 * 详情接口签出来的地址 1 小时后失效，这里按 45 分钟保守复用 —— 复用窗口若超过签名有效期，
 * 就会变成「点了播放却播不了」这种最难查的静默失败。
 */
const WORK_PLAY_URL_TTL_MS = 45 * 60 * 1000
/**
 * 全屏播放器那颗 `<Video>` 的 id。
 * ★ 必须与 JSX 里的 `id={...}` 一致：`Taro.createVideoContext(id)` 靠它找节点。
 * ★ 为什么非要这个 id：**`autoplay` 属性不可靠** —— 开发工具 / 部分基础库下
 *   「节点刚挂上 + 地址刚塞进去」这一帧它不一定肯自己播，表现出来就是**纯黑、没有控制条**
 *   （这正是 2026-10-26 用户报的「点开还是黑屏」）。成片页（pages/render/compose.tsx）
 *   早就踩过同一条：那里也是 `autoplay` + 显式 `play()` 双保险，照抄它。
 */
const HOME_PLAYER_VIDEO_ID = 'home-work-player'
/** 分类横滑的「全部」选项：接口只返回有作品的分类 */
const WORK_CATEGORY_ALL = ''

/** 首页 · 创作工作台：第一屏是轮播（运营在后台配）+ 轮播下方那颗「开始创作」主按钮；全页只有一个红色实心主按钮 */
export default function HomePage() {
  // ★ 分享能力：必须放在组件最顶部**无条件**调用（Hooks 规则），
  //   且不能放在任何 early return 之后，否则部分路径下声明不上去、转发仍会置灰。
  useAppShare()

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
  // ★ 2026-09-24：原来这里还有一个 sloganBanner 状态（口号图）。口号图整块下线后一并删除 ——
  //   留着它等于每次 useDidShow 都把一个没人看的字符串 setState 一遍。
  //   2026-09-29 已补齐善后：`getHomeLayout()` 的返回类型里也不再带 sloganBanner
  //   （见 services/home.ts），整条数据线在代码里已无残留。
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
  /**
   * 全屏播放器**是否真的开始出画面**了（由 `<Video onPlay>` 置真）。
   * 用途只有一个：决定「加载中…」那行提示还要不要盖在黑底上。
   * ★ 没有它的话，`autoplay` 一旦不生效，用户看到的就是**一块什么都没有的纯黑**
   *   （播放键也被 `showCenterPlayBtn={false}` 关掉了）—— 分不清是坏了还是在加载。
   */
  const [playerStarted, setPlayerStarted] = useState(false)
  /**
   * 播放器**元数据已就绪**（`onLoadedMetadata` 置真）。
   * ★ 它和 `playerStarted` 是两件事，缺一不可：
   *   · 元数据到了 ⇒ 说明地址和容器都没问题，**「加载中」这行字就该收掉**，
   *     否则它是一层盖在视频上的 cover-view，会把「居中播放键」和视频的点击全挡住；
   *   · 真的在播 ⇒ 才说明 `autoplay` / `play()` 成功了。
   *   ⇒ 两个信号分开记，「自动播失败但能手动点播」这种中间态才有人接得住。
   */
  const [playerLoaded, setPlayerLoaded] = useState(false)
  /** 播放器报错时的原文（weapp 的 `onError` 会带 detail.errMsg），显示出来便于对症 */
  const [playerError, setPlayerError] = useState('')
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

  /**
   * 「优秀作品这一块**此刻在不在页面上**」的快照（真值见下面 `hasWorks`）。
   *
   * ★ 给 `loadWorks` 的 catch 用：这一块根本没显示时，它的加载失败**不该冒到顶部** ——
   *   否则用户会看到「优秀作品加载失败，点此重试」，可页面上压根没有「优秀作品」这一块
   *   （线上作品数为 0 时整块隐藏，这是 2026-09-28 定的行为），自相矛盾。
   * ★ 为什么用 ref 而不是直接读 state：catch 是异步回调，闭包里那两份
   *   `workCats / workTotal` 是**请求发起时**的旧值（切分类、触底翻页都会改），拿它判断会失准。
   */
  const hasWorksRef = useRef(false)

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
      // ★ 这一块此刻根本没显示（没有任何已上架作品）⇒ **静默**，不上报。
      //   否则用户会看到「优秀作品加载失败」，但页面上根本没有这一块。
      //   ★ `workLoadedRef` 刻意留 false：下次回首页（useDidShow）会自动重试，
      //     等真的拉到作品、区块出现之后，再失败才值得提示。
      if (!hasWorksRef.current) return
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
   * 拉首页的运营配置：**只剩轮播**（公开接口，免登录；失败一律走兜底，见 services/home.ts）。
   * ★ 2026-09-24：口号图整块下线后，这里不再有第二个字段要写。
   *
   * 轮播内容没变就不 setState：换一个全新的数组会让 Swiper 重挂载、把当前页跳回第一张，
   * 而 useDidShow 每次回到首页都会跑一遍，运营没改配置时不该有这种跳动。
   */
  const loadHomeLayout = async () => {
    const cfg = await getHomeLayout()
    const key = JSON.stringify(cfg.slides)
    if (key !== bannerKeyRef.current) {
      bannerKeyRef.current = key
      setBanners(cfg.slides)
    }
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
      setRecent(sid ? (await listCreations(sid)).slice(0, 3) : [])
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
    // 轮播是运营内容，每次回首页重拉一遍（内容没变时上面会跳过 setState）
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

  /**
   * 全屏播放器的**起播兜底**。
   *
   * ★★★ 为什么光有 `autoplay` 不够（2026-10-26 用户报「点开还是黑屏」的真正原因）：
   *   `autoplay` 是**属性**，只在节点初次挂载那一刻被消费一次；而这条路径是
   *   「点了之后才 setState 挂出一个新 Video、并且地址是同时塞进去的」，
   *   开发工具和部分基础库下这一帧不一定肯自己播 —— 于是没有任何报错，
   *   只剩一块黑底（播放键又被 `showCenterPlayBtn={false}` 关掉了）。
   *   ⇒ 与 `pages/render/compose.tsx` 同一个结论、同一个写法：地址就绪后**显式 `play()` 一次**。
   *     已经在播时它是幂等空操作。
   * ★ 300ms 不是玄学：原生 video 节点由 Taro 在本次渲染后才创建，取 context 需要它已经在场
   *   （与 compose 页同值）。
   */
  useEffect(() => {
    if (!playing) {
      setPlayerStarted(false)
      setPlayerLoaded(false)
      setPlayerError('')
      return
    }
    const timer = setTimeout(() => {
      try {
        Taro.createVideoContext(HOME_PLAYER_VIDEO_ID).play()
      } catch {
        // 取不到 context（节点还没挂上）：不补救，`autoplay` 仍是第一道
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [playing])

  // ★ 2026-10-15：全局说明弹窗（自绘）一打开，先把播放中的视频收掉。
  //   自绘弹窗靠**同层渲染**盖住原生组件（官方口径见 components/guide-dialog/index.tsx
  //   文件头 ★），而同层渲染在 iOS 页面节点树不稳定时**存在失败率**（官方原文）。
  //   真失手的话，弹窗恰好会被这张 autoplay 的 `<Video>` 压住 —— 与其赌它，
  //   不如在弹窗出现前直接把播放态收掉（顺带也是更合理的行为：整屏都要被弹窗盖住了）。
  const guideVisible = useGuideDialogVisible()
  useEffect(() => { if (guideVisible) setPlaying(null) }, [guideVisible])

  // ★ 2026-10-01：原 `goMine`（跳「我的」去登录）只服务于首页那张「登录后开始创作 /
  //   去登录」卡。该卡已按微信审核要求删除（未浏览即要求授权，见 goCreate 与页面底部
  //   未登录分支的说明），故一并删掉。

  /**
   * 账号还没有门店时的唯一出路：去**创建门店**。
   * ★ 单店模型（2026-09-24）：原来这里跳的是「门店列表」页，该页已删除 ——
   *   一个账号只有一家门店，没有列表可看，有店就直接进详情，没店才来这儿建。
   */
  const goNewStore = () => Taro.navigateTo({ url: '/pages/store/edit' })
  /**
   * 「门店」这个入口（首页轮播的 STORES 项等）。
   * ★ 单店模型下它有两义，必须分开：有门店 → 进那家店的**详情**（门店信息）；
   *   还没有门店 → 去创建页。原来两种都跳「门店列表」，该页已删除。
   */
  const goStoreEntry = () => currentStoreId
    ? Taro.navigateTo({ url: `/pages/store/detail?id=${currentStoreId}` })
    : goNewStore()
  const goDishes = () => currentStoreId
    ? Taro.navigateTo({ url: `/pages/dish/list?storeId=${currentStoreId}` })
    : goNewStore()
  const goCreations = () => Taro.switchTab({ url: '/pages/creation/list' })
  /**
   * ★★ 2026-10-01（微信审核驳回整改）：未登录时**只给一句解释，等用户自己点确认**才去登录。
   *
   * 驳回原文：「一进入【首页】页面，未浏览体验功能服务，即要求授权手机号码、头像、昵称
   * 进行授权登录，请在用户体验浏览功能服务后，再自行选择授权登录。」
   *
   * 原来这里直接走 `goNewStore()`（未登录时 currentStoreId 必为空）⇒ 用户被丢去门店创建页
   * 吃一个 401 ⇒ 请求层 redirectToLogin() 把他弹到「我的」再弹登录框 ——
   * 这正是「还没看任何功能就被要求授权」的那条连锁。
   */
  const goCreate = () => {
    // ★ 2026-10-16 按需求改文案：正文由「开始创作需要先登录」→「**可添加客服领取试用**」。
    //   原句已删。注意这个框的 title 仍是「登录后可用」、确认键仍是「去登录」，所以
    //   「为什么要点去登录」这层意思还在，只是重心从「解释」挪到了「给一条别的路」。
    //   ⚠ 正文与底部小字（note）现在是同一件事的两种写法，形近重复 —— 见日志 2026-10-16。
    //   （另两处 guideLogin 已在 2026-10-26 随之删除：作品卡片上的「生成同款」和详情页的
    //     「套用配方」都不存在了 —— 本页只剩这一处登录引导。）
    if (!isLoggedIn) { guideLogin({ reason: '可添加客服领取试用', note: '联系客服领取试用' }); return }
    if (!currentStoreId) { goNewStore(); return }
    Taro.navigateTo({ url: '/pages/creation/edit' })
  }
  const openCreation = (id: string) => Taro.navigateTo({ url: `/pages/creation/edit?id=${id}` })

  const stopPlay = () => setPlaying(null)

  /**
   * 滚到「优秀作品」这一块的顶部。
   * ★ 只有一个用处：轮播里配了某条作品（`CarouselLink` 的 `WORK`），而那条作品**不在**
   *   当前这一页列表里 —— 详情页已经删了，没有单独的落地页可跳，只能把人带到作品区。
   * ★ 写法照抄 `pages/render/compose.tsx::scrollToPlayer`（同样是先量位置再滚，项目里已验证）：
   *   直接 `pageScrollTo({selector})` 在部分基础库上不生效，量出绝对 scrollTop 才稳。
   */
  const scrollToWorks = () => {
    const query = Taro.createSelectorQuery()
    query.select('.home__works').boundingClientRect()
    query.selectViewport().scrollOffset()
    query.exec((res) => {
      const rect = res?.[0] as { top?: number } | null
      const offset = res?.[1] as { scrollTop?: number } | null
      if (!rect || typeof rect.top !== 'number' || !offset || typeof offset.scrollTop !== 'number') return
      // 留 24rpx 呼吸空间，别让卡片贴着屏幕上沿
      void Taro.pageScrollTo({ scrollTop: Math.max(0, offset.scrollTop + rect.top - 24), duration: 300 })
    })
  }

  /**
   * 播放一条作品：**不跳页**，点一下就在**全屏播放器**里自动播放。
   *
   * ★ 2026-10-26 用户要求（三步演进，别往回改）：
   *   ① 「优秀作品详情页删掉，用户直接点击优秀作品直接播放就可以了，不需要额外一个页面」
   *   ② 「点击了之后应该自动放大播放」
   *   ③ 「点击之后自动播放，不需要闪过封面，然后右上角需要有关闭按钮」
   *
   * ★★★ 为什么最后是自己搭全屏播放器、而不是 `Taro.previewMedia`：
   *   原生预览器**不接受 autoplay 之外的组合** —— 它一定会先把 `poster` 铺出来再起播
   *   （就是用户说的「闪过封面」），而且它的关闭方式是「点一下屏幕」，
   *   没有右上角那颗按钮。两条要求它都满足不了，所以只能自己盖一层全屏 `<Video>`。
   *
   * ★★★ 也别退回去用卡片内的 `<Video>` 就地播（更早一版的做法，实测**整块黑屏**）：
   *   `.home__work` 有 `overflow: hidden` + 圆角，原生 `<video>` 装在这种父级里，
   *   iOS 上会渲染成黑底不出帧。全屏播放器是 `position: fixed` 的独立层，绕过这个坑。
   *   ⇒ 所以：卡片**永远只显示封面**，播放态是一个盖在最上面的全屏层。
   *
   * 为什么这里要请求一次详情拿地址：列表接口**刻意只签封面**（见后端 routes/works.ts 的说明），
   * 不带 videoUrl。若为了「列表能直接播」而让列表把每条作品的视频都签一遍，等于每次翻页
   * 都白签一批 1 小时有效的地址，只为那少数几次点击。所以改成点播时才取，并按作品缓存
   * （签名会过期，缓存窗口见 WORK_PLAY_URL_TTL_MS）。
   */
  const playWork = async (work: WorkItem) => {
    if (playPending) return
    setPlayPending(work.id)
    try {
      const cached = playUrlRef.current[work.id]
      // 缓存命中就复用；没命中（或过了 45 分钟）才去取一次新签名的地址
      // ★ 类型要写成 `string | null`：`getWork().videoUrl` 就是可能为 null（未上传成片），
      //   收窄成 string 会在下面那条赋值处报 TS2322。
      let url: string | null = cached && Date.now() - cached.at < WORK_PLAY_URL_TTL_MS ? cached.url : ''
      const needFetch = !url
      if (!url) url = (await getWork(work.id)).videoUrl
      if (!url) throw new Error('这条作品还没有可播放的成片')
      playUrlRef.current[work.id] = { url, at: Date.now() }
      /**
       * ★ 浏览计数挂到「真的播了一次」上。
       *   原来它只在详情页 `onLoad` 里计一次；详情页删掉后如果不换落点，这个统计就永久停在
       *   2026-10-26 之前的数据上（后台看到的「浏览数」会以为没人看）。
       *   只在**需要重新取地址**时计一次 ⇒ 同一条反复点播不刷数；失败也不影响播放。
       */
      if (needFetch) void markWorkView(work.id).catch(() => undefined)
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
   * 轮播里配的「某条作品」该怎么落地。
   * ★ 详情页删掉之后没有单条作品的落地页了 ——
   *   那条作品若已在当前列表里 ⇒ 直接就地播；不在（可能在后几页、或已被下架）
   *   ⇒ 把人带到「优秀作品」这一块，别留下一颗点了没反应的轮播。
   */
  const openWorkById = (id: string) => {
    const hit = works.find((w) => w.id === id)
    if (hit) { void playWork(hit); return }
    scrollToWorks()
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
      case 'STORES': goStoreEntry(); break
      case 'MEMBER': void Taro.navigateTo({ url: '/pages/recharge/index' }); break
      case 'WORK':
        // 没填作品 id 时当作纯展示（详情页已删除，不能再去跳一个不存在的页面）
        if (s.workId) openWorkById(s.workId)
        break
      default: break
    }
  }
  /**
   * 「优秀作品」整块要不要出现 —— 由**有没有已上架的作品**决定。
   *
   * ★★ 为什么需要这个开关（2026-09-28）：
   *   原来这一块**永远渲染**，没有作品时显示一句「暂无作品，运营正在挑选中」。
   *   但库里那 28 条是**没有素材的配方模板**（seed 造的），它们曾经是 `enabled: true`，
   *   于是首页整块全是「封面待补」的灰块、点进去也播不了 ——
   *   对一个刚注册、还没人看过账号的商户，这是最糟的第一印象。
   *   现在：没有已上架作品 ⇒ **整块消失**（连标题和分类横滑一起），
   *   后台传了作品并上架 ⇒ **自动出现**，前端不需要任何额外开关。
   *
   * ★ 为什么用 `workCats` 而不是 `works.length`：
   *   `works` 是**当前分类当前页**的条目，`workTotal` 也带分类过滤
   *   （`listWorks` 的 total 是分类内的计数）—— 用户切到某个空分类时它们都会是 0，
   *   那时若按它们判，会**把整块连分类横滑一起藏掉**，用户就再也切不回「全部」了。
   *   `workCats` 来自 `/works/categories`，它对「有没有已上架作品」是**全局**判断
   *   （服务端 groupBy 的 where 同样是 `enabled: true, deletedAt: null`），
   *   而且这条请求本来就在拉，**不多花一次请求**。两个信号取或：任一能证明有作品就显示，
   *   免得某一条请求偶发失败就把整块误藏。
   */
  const hasWorks = workCats.length > 0 || workTotal > 0

  // 把「这一块在不在页面上」同步进 ref —— `loadWorks` 的 catch 用它决定要不要上报失败
  // （见 hasWorksRef 的注释：区块没显示时，它的加载失败不该冒到顶部）
  useEffect(() => { hasWorksRef.current = hasWorks }, [hasWorks])

  return <View className='home'>
    {/* ── 口号图整块下线（2026-09-24 按需求，2026-09-29 连数据线一并清完）──
        原来这里是一张「顶部口号海报」：运营可在后台「首页口号图」上传替换，
        没配时用内置那张红/白/黑海报（代码合成，源码 scripts/slogan-banner.html）。
        现在这张图、后台页、上传接口、内置图常量与生成脚本**全部已删除**，
        首页第一屏直接从轮播开始。
        原顶栏（门店切换 pill + 圆形头像按钮）更早之前已去掉，理由见 git 历史。 */}

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
              </View>
            </View>
          </View>
          <View
            className='home__setup-action'
            hoverClass='ds-hover--press'
            onClick={setupStage === 'STORE' ? goNewStore : goDishes}
          >
            <Text>{setupStage === 'STORE' ? '去创建' : '去添加'}</Text>
            <Text className='home__setup-arrow'>→</Text>
          </View>
        </View>
      ) : (
        <>
        {/* ── 创作入口：完成门店与菜品准备后再开放 ── */}
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
              </View>
            </SwiperItem>
          ))}
        </Swiper>

        {/* ── 主按钮「开始创作」──
            ★ 2026-09-24 按需求：从轮播卡片里**摘出来**放到轮播下面、并放大。
              原来它长在卡片里（绝对定位在左下角、26rpx 字），跟着 336rpx 的卡片一起变小，
              还得跟标题抢地盘；底色与通栏交给 .ds-btn--primary / --block，但**几何已被页面
              作用域的 .home__create 覆写**（见 index.scss：09-29 起高度 139rpx、字号 68rpx、
              字重 700 —— 已**不等于** .ds-btn--lg 的 104rpx / 34rpx，改这颗按钮请改那边）。
            ★ 2026-10-01（微信审核驳回整改）：**未登录也展示这一颗**。理由两条 ——
              ① 审核要求「先让用户体验浏览，再自行选择是否授权登录」。首页不能一进来就摆一张
                 「去登录」卡，更不该点什么都弹登录框。现在未登录用户看到的是完整首页
                 （轮播 + 优秀作品），点这颗按钮时才由 goCreate → guideLogin 征求他同意；
              ② 原 onClick 落到 goNewStore / 编辑页，未登录会被 401 弹到「我的」
                 （正是 utils/login-guide.ts 要避免的那条连锁）。 */}
        <View
          className='ds-btn ds-btn--primary ds-btn--lg ds-btn--block home__create'
          hoverClass='ds-hover'
          onClick={goCreate}
        >
          <Text>开始创作</Text>
          <Text className='home__create-arrow'>→</Text>
        </View>
        </>
      )}

      {!!error && (
        <View className='ds-notice home__error' onClick={retryHome}>
          <Text>{error}</Text>
        </View>
      )}

      {!isLoggedIn ? (
        /* ★★ 2026-10-01（微信审核驳回整改）：未登录时这一块**什么都不放**。
           原来这里是一张「登录后开始创作 / 去登录」卡，它就是审核的判定点 ——
           「一进入【首页】页面，未浏览体验功能服务，即要求授权手机号码、头像、昵称进行授权登录」。
           用户打开小程序、什么都还没看，第一屏就在要他登录。
           现在未登录用户看到的是轮播 + 优秀作品（公开内容），想用的时候点上面的「开始创作」，
           那一刻才由 guideLogin 征求他同意。 */
        null
      ) : setupStage === 'READY' ? (
        <>
          {/* ── 近期作品（★ 2026-09-25 由「接着上次拍」改名；同日「两条→三条 + 竖版缩略图」）──
              旧名名不副实：这里列的是 `listCreations(...).slice(0, 3)` —— **最近三条**创作，
              不是「上一次拍的那一条」；下面 `home__recent-*` 那一整套是「近来的一批」。
              ★ 而 `recent` 这个 state 名、`home__recent-*` 这组类名**都不动** ——
                改的只是对外文案（与「对外称号只换 label、不动标识符」同一条约定）。 */}
          <View className='home__sec'>
            <View>
              <Text className='home__sec-title'>近期作品</Text>
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
                  {/* 有已上传的视频就显示它的封面（与创作列表同一份服务端字段），没有才退回默认图标。
                      ★ mode 用 aspectFit 而**不是** aspectFill：封面是竖屏视频抽出来的帧
                        （线上实测 5 张全是 9:16），把盒子也做成 9:16 ⇒ 同比例、不裁也不留边；
                        万一遇到别的比例，宁可留一点底色也要让整张图**完整可见**
                        （原先是横盒子 + aspectFill，竖屏封面被裁到只剩中间一条横带）。 */}
                  <View className='home__recent-cover'>
                    {c.coverUrl ? (
                      <Image className='home__recent-cover-image' src={c.coverUrl} mode='aspectFit' />
                    ) : (
                      /* 无封面（还没传素材）走占位图标：占位框跟着缩略图一起变成 9:16 竖版后
                         高了 2.3 倍（168rpx → 392rpx），36rpx 的小图标丢在深色大框里会像
                         「图片加载失败」⇒ 放大到 64rpx。 */
                      <t-icon name='movie-clapper' size='64rpx' />
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

      {/* ── 优秀作品：分类横滑 + 两列网格 + 上拉加载更多 ──
          ★ 整块由 `hasWorks` 决定出现与否（没有任何已上架作品时连标题一起消失，
            理由见上面 `hasWorks` 的注释）。前端不需要任何额外开关：
            后台补上素材并上架 ⇒ 接口开始返回 ⇒ 这块自动出现。
          ⚠ 里面那个「暂无作品」分支**必须留着**：它管的是「有已上架作品、但当前分类为空」，
            与「整块要不要出现」是两件事 —— 删了它，用户切到空分类会看到一片空白。
          ⚠ 这里用 `{hasWorks && <>…</>}` 而**不重排缩进**：本文件此刻还有别的会话在改，
            重排 130 行会让 diff 变成一整片、双方都没法合。 */}
      {hasWorks && <>
      <View className='home__sec'>
        <View className='home__sec-left'>
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
            /* ★ 2026-10-26：卡片**永远只显示封面**，点下去由页面顶层的全屏播放器接管
               （见 playWork 与 bottom 那个 `home__player` 层）。
               原来这里有一个「播放态换成 Video」的分支 —— 已删除：
               原生 video 装在 `overflow:hidden` + 圆角的卡片里会整块黑屏（实测）。 */
            return (
              <View
                className={`home__work ${hasCover ? '' : 'home__work--empty'}`}
                key={w.id}
                hoverClass='ds-hover--press'
                /* ★ 2026-10-26：整张卡片就是播放命中区（详情页已删除，见 playWork 的说明）。
                   没有成片时也会走到这里 ⇒ playWork 里抛「这条作品还没有可播放的成片」并 toast，
                   不给用户一个点了全然没反应的卡片。 */
                onClick={() => { void playWork(w) }}
              >
                {hasCover ? (
                  /* ★ 2026-10-26 用户要求「封面要显示完全」：
                     `aspectFill` 会按容器比例裁掉溢出部分（竖版封面被切掉上下/左右），
                     改成 `aspectFit` 让整张封面都在。比例不一致时留下的空白由卡片黑底吃掉
                     （见 index.scss 的 `&__work` background）。 */
                  <Image className='home__work-cover' src={cover} mode='aspectFit' />
                ) : (
                  <View className='home__work-ph'>
                    <Text className='home__work-ph-cat'>{w.category}</Text>
                    <Text className='home__work-ph-hint'>封面待补</Text>
                  </View>
                )}
                {hasCover && <View className='home__work-scrim' />}

                <View className='home__work-top'>
                  <View className='home__work-tags'>
                    {(w.tags ?? [])
                      .filter((t) => !HIDDEN_WORK_TAGS.includes(t))
                      .slice(0, 2)
                      .map((t) => (
                        <Text className='home__work-tag' key={t}>{t}</Text>
                      ))}
                  </View>
                </View>

                {hasVideo && (
                  /* 播放按钮只是**视觉提示**（告诉用户这张能播），点了和点卡片效果一样。
                     `stopPropagation` 仍要留着：卡片自己也挂着 playWork，两次一起触发会
                     并发发两个详情请求（`playPending` 是异步 setState，同一次事件里挡不住）。
                     ★ 它同时是 `playPending` 的加载态载体：取地址期间那个三角会淡掉。 */
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
                  {/* ★ 2026-10-26 用户要求：删掉压在封面上的「生成同款」按钮。
                      封面现在是用来**看**的，不再兼任入口 —— 整张卡片点了就播（详情页已删除）。 */}
                  <Text className='home__work-title'>{w.title}</Text>
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
      </>}
    </View>

    {/* ── 全屏播放器（点优秀作品卡片后盖上来的那一层）──
        ★ 2026-10-26 用户要求：「点击之后自动播放，不需要闪过封面，然后右上角需要有关闭按钮」。
        三个要求对应的写法：
          ① **自动播放** = `autoplay`，且**不传 `poster`** —— 传了就会先铺封面（就是「闪过封面」）；
          ② **不闪封面** ⇒ 外层直接铺黑底 + `objectFit='contain'`，视频起帧即可见；
          ③ **右上角关闭** ⇒ `<CoverView>`。原生 `<Video>` 是最高层级，普通 `<View>` 盖不住它，
             全项目里只有 cover-view 能可靠压在 video 之上（沿用原来「收起」那套结论）。
        ★ 为什么 `top` 是 140rpx 而不是 16rpx：屏幕右上角那块是**微信胶囊按钮**（原生、
          盖不掉），关闭按钮放太低会被它压住点不到 ⇒ 往下让出一颗胶囊的高度。
        ★ `catchMove`：全屏层铺满屏幕，不拦一下手势的话，手指在视频上滑动会把**下面的列表**
          一起滚走，关掉播放器回来位置全变了。 */}
    {playing && (
      <View className='home__player' catchMove>
        <Video
          /* ★ id 是给上面那个 effect 的 `createVideoContext(id).play()` 用的，别删 */
          id={HOME_PLAYER_VIDEO_ID}
          className='home__player-video'
          src={playing.url}
          autoplay
          controls
          /* ⚠ 不要写 `showCenterPlayBtn={false}`：`autoplay` 一旦没生效，那块黑屏上
             就**一个可点的东西都没有**（2026-10-26 踩过这个坑）。留默认的居中播放键，
             自动播失败时它还能救一次。 */
          objectFit='contain'
          /* 真正出画面的信号：到了才算「在播」 */
          onPlay={() => setPlayerStarted(true)}
          /* 元数据到了 ⇒ 地址和容器都没问题，把「加载中」那行收掉（它在挡点击）
             ⚠ Taro 这个属性的名字是 `onLoadedMetaData`（大写 D），不是 W3C 的 onLoadedMetadata */
          onLoadedMetaData={() => setPlayerLoaded(true)}
          /* ★ 播完**不自动关**：用户要的是「右上角有关闭按钮」= 退出由他掌握。
             播完后原生控制条会停最后一帧并给出重播键，比把人弹回列表更自然。 */
          onError={(e) => {
            /* 不直接关掉：把原生 errMsg 亮出来（这块黑屏到底病在哪，看这行字最快），
               用户想退出随时按右上角 ×。 */
            const detail = (e as unknown as { detail?: { errMsg?: string } }).detail
            setPlayerError(detail?.errMsg || '视频加载失败')
            void Taro.showToast({ title: '播放失败，请稍后重试', icon: 'none', duration: 2500 })
          }}
        >
          {/* ★ 提示条只在「还没就绪、也没报错」时出现，且**只占底部一条**（不做满屏）：
              满屏的 cover-view 会把居中播放键和视频点击全挡住。 */}
          {playerError ? (
            <CoverView className='home__player-tip home__player-tip--error'>{playerError}</CoverView>
          ) : (!playerLoaded && !playerStarted) ? (
            <CoverView className='home__player-tip'>加载中…</CoverView>
          ) : null}
          <CoverView className='home__player-close' onClick={stopPlay}>×</CoverView>
        </Video>
      </View>
    )}

    {/* ★ 自绘说明弹窗的宿主（login-guide 那层「登录后可用」）。
        必须挂在**页面里** —— 挂 app.tsx 小程序端不渲染（依据见
        components/guide-dialog/index.tsx 文件头 ★ 挂载点与 app.tsx 的注释）。
        关闭时它渲染 null，不占位、不影响布局。
        ★ 放在播放器**之后**：两者都要压在原生组件之上，后渲染的那层在上面。 */}
    <GuideDialogHost />
  </View>
}
