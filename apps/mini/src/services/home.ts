// 首页运营配置：轮播图（首页顶部「创作入口」那张卡片）。
//
// 数据源复用**公开系统配置**（`GET /api/v1/system/settings`，免登录）——
// 不新建表、不新开接口：运营在后台「首页轮播图」页里改，小程序拉到的就是同一份。
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
  /** 门店列表 */
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

/** 没有任何后台配置时用的兜底单张：与改造前的静态卡片逐字一致 */
export const FALLBACK_SLIDE: HomeCarouselSlide = {
  id: 'fallback',
  image: HOME_CREATE_HERO,
  kicker: '从一道菜开始',
  title: '做一条能带来客人的视频',
  desc: 'AI 帮你想文案、排分镜，现场拍完就能出片',
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

/**
 * 拉首页轮播配置。
 *
 * 三条失败路径都必须**不抛**，且都退到 `FALLBACK_SLIDE`：
 *   1. 接口失败（离线 / 后端没起）—— 首页是 App 第一屏，不能因此空白或弹错误；
 *   2. 配置项不存在（运营还没配）—— 等价于改造前的行为；
 *   3. value 不是合法 JSON（有人直接把普通文本填进去过）—— 解析异常在这里吞掉。
 */
export async function getHomeCarousel(): Promise<HomeCarouselSlide[]> {
  try {
    const settings = await getPublicSettings()
    const item = settings.groups?.home?.find((i) => i.key === 'carousel')
    if (!item) return [FALLBACK_SLIDE]
    // 服务端按理给的是字符串；但它可能把已是数组的值原样传出，两条都兜住
    const raw = typeof item.value === 'string' ? JSON.parse(item.value) : item.value
    const slides = normalize(raw)
    return slides.length > 0 ? slides : [FALLBACK_SLIDE]
  } catch {
    return [FALLBACK_SLIDE]
  }
}
