// 首页运营配置：轮播图（首页顶部「创作入口」那张卡片）。
//
// 数据源复用**公开系统配置**（`GET /api/v1/system/settings`，免登录）——
// 不新建表、不新开接口：运营在后台「首页轮播图」页里改，小程序拉到的就是同一份。
//
// ★ 2026-09-29：原来的**口号图**（`home.sloganBanner`，`valueType='STRING'`）整条数据线
//   已删除。它的消费端 2026-09-24 就摘掉了（首页第一屏直接从轮播开始），这里只是善后：
//   后台页、上传接口、seed 配置行、内置图常量与生成脚本一并清理，`getHomeLayout()` 也
//   不再返回 `sloganBanner` 字段。下面只剩轮播一块配置。
//
// ⚠ 服务端对 `valueType='JSON'` 的项做了一次「简化」：它 `JSON.parse` 之后又
//   `JSON.stringify` 回去，所以拿到手的是**字符串**而不是对象
//   （见 server/src/routes/system-settings.ts::coerceValue）。这里必须自己再 parse 一次。
import { getPublicSettings } from './account'
import { HOME_CREATE_HERO } from '../constants/static-assets'

/**
 * 轮播的跳转目标。**这是一份白名单**，必须与后台下拉里的选项逐一对应
 * （apps/admin/src/pages/HomeCarousel.tsx::LINK_OPTIONS）。
 *
 * 不做「自由填页面路径」：小程序跳到未注册的路由会失败，而路由清单在
 * src/app.config.ts 里、且分了分包 —— 让运营手填路径迟早填错。
 */
export type CarouselLink =
  /** 纯展示，点了不动 */
  | 'NONE'
  /** 开始创作（没有门店时自动落到「建店」） */
  | 'CREATE'
  /** 全部创作（tabBar） */
  | 'CREATIONS'
  /** 门店：有门店 → 进那家店的详情（门店信息）；还没有门店 → 去创建门店（单店模型 2026-09-24） */
  | 'STORES'
  /** 订阅与积分 */
  | 'MEMBER'
  /** 指定优秀作品详情，需要 workId */
  | 'WORK'

const LINKS: readonly CarouselLink[] = ['NONE', 'CREATE', 'CREATIONS', 'STORES', 'MEMBER', 'WORK']

export interface HomeCarouselSlide {
  id: string
  image: string
  kicker: string
  title: string
  desc: string
  actionText: string
  link: CarouselLink
  workId: string
}

/**
 * 没有任何后台配置时用的兜底单张。
 *
 * ★ 2026-09-24：**这条兜底才是线上真正在渲染的标题** —— 线上库的 `system_setting`
 *   里没有 `home` 分组（实测 groupBy 只有 bean/render/storage/subscription），
 *   所以 getHomeLayout() 拿不到 carousel 配置、直接回落到这里。
 *   改文案时**必须先改这里**，只改数据库/seed 在线上是不生效的。
 *   ⚠ 标题已按需求改为「让餐饮门店轻松拍视频」（原「做一条能带来客人的视频」）。
 *   ⚠ 2026-09-25 上方小字（kicker）改为「每天5分钟」（原「从一道菜开始」）——
 *     同批改齐了后台 HomeCarousel 的默认值与 placeholder、prisma/seed.ts 的种子值。
 */
export const FALLBACK_SLIDE: HomeCarouselSlide = {
  id: 'fallback',
  image: HOME_CREATE_HERO,
  kicker: '每天5分钟',
  title: '让餐饮门店轻松拍视频',
  // 副标题已按需求下线（2026-09-16）。置空即可 —— home/index.tsx 对 desc 是
  // 条件渲染（`{!!s.desc && ...}`），不会留下空隙。
  desc: '',
  actionText: '开始创作',
  link: 'CREATE',
  workId: '',
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 把后台存的任意 JSON 收敛成「能安全渲染」的幻灯片数组 */
function normalize(raw: unknown): HomeCarouselSlide[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object' && !Array.isArray(it))
    // 后台可单张停用：停用的不下发，运营不必删掉重配
    .filter((it) => it.enabled !== false)
    // 没图的幻灯片渲染出来是一块纯色底，不如不要
    .filter((it) => asText(it.image) !== '')
    .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
    .map((it, i) => ({
      id: asText(it.id) || `slide-${i}`,
      image: asText(it.image),
      kicker: asText(it.kicker),
      title: asText(it.title),
      desc: asText(it.desc),
      actionText: asText(it.actionText),
      link: LINKS.includes(it.link as CarouselLink) ? (it.link as CarouselLink) : 'NONE',
      workId: asText(it.workId),
    }))
    // 没标题的同上：整块只剩背景图与按钮，看不出想说什么
    .filter((s) => s.title !== '')
}

export interface HomeLayoutConfig {
  slides: HomeCarouselSlide[]
}

/**
 * 拉齐首页的运营配置（当前只有轮播一块，口号图那条线 2026-09-29 已整体删除）。
 *
 * 三条失败路径都必须**不抛**，且都退到内置默认：
 *   1. 接口失败（离线 / 后端没起）—— 首页是 App 第一屏，不能因此空白或弹错误；
 *   2. 配置项不存在（运营还没配）—— 等价于改造前的行为；
 *   3. value 不是合法 JSON（有人直接把普通文本填进去过）—— 解析异常在这里吞掉。
 */
export async function getHomeLayout(): Promise<HomeLayoutConfig> {
  try {
    const settings = await getPublicSettings()
    const home = settings.groups?.home ?? []

    // 轮播：服务端按理给的是字符串；但它可能把已是数组的值原样传出，两条都兜住
    const carousel = home.find((i) => i.key === 'carousel')
    let slides: HomeCarouselSlide[] = []
    if (carousel) {
      const raw = typeof carousel.value === 'string' ? JSON.parse(carousel.value) : carousel.value
      slides = normalize(raw)
    }

    return { slides: slides.length > 0 ? slides : [FALLBACK_SLIDE] }
  } catch {
    return { slides: [FALLBACK_SLIDE] }
  }
}
