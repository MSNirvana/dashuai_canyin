// 参考视频：我的页分组列表 + 分类下的内容清单。
//
// ── 为什么这里**没有任何播放器**（2026-10-22 改）─────────────────────────────
// 内容是发在微信视频号上的，小程序只负责「列出来 + 点一下跳过去看」：
//   · 小程序与视频号**不是同一主体**（视频号是个人未认证＝没有主体），
//     `<channel-video>` 内嵌要求「绑定开放平台 + 同/关联主体 + 关联主体列表含视频号主体」，
//     个人视频号进不了企业关联主体列表 ⇒ 组件那条路在视频号侧就断了；
//   · `wx.openChannelsActivity` 官方口径是「无主体要求」，所以只剩这一条路。
//
// ⚠ 因此**页面里没有任何播放、观看能力**，只是外链目录。别为了「体验更好」把 <Video>
//   或 <channel-video> 加回来 —— 那会让小程序被要求补「文娱-其他视频」类目（已踩过一次）。
//
// ── 四个分类的文案与图标为什么写在这里 ────────────────────────────────────
// 服务端的白名单（server/src/lib/tutorial-categories.ts）只负责**校验码值合法**，
// 文案与图标是客户端资产：小程序「我的」页那个分组列表在请求失败时也必须渲染出来，
// 否则整张卡片会空掉。所以这里持有本地副本，服务端返回的同名字段只当兜底。
// ⚠ 三个文件的 code 必须**逐字一致**：
//   · server/src/lib/tutorial-categories.ts
//   · apps/mini/src/services/tutorial.ts（本文件）
//   · apps/admin/src/pages/Tutorials.tsx
import { http } from './request'

export interface TutorialCategory {
  code: string
  /** 分组列表里的短标签 */
  label: string
  /** 分类页的导航标题 */
  pageTitle: string
  /** tdesign 图标名（已在 icon.wxss 里逐个核对存在，写错会静默不显示） */
  icon: string
}

/**
 * ★★ 文案刻意**不用「教程 / 课程 / 技巧 / 知识 / 手册」**：
 *   这几个词会把页面指向「教育服务 / 在线视频课程」，那需要另一套资质（比视频类目更难）。
 *   用「怎么拍 / 怎么剪 …」这种口语，页面读起来是「同行经验目录」，不是课程表。
 *
 * ★★ 2026-10-22 起这套 label **只是离线兜底**：运营可以在后台改分类名
 *   （存在系统设置 `tutorial.category_titles`，由 `/api/v1/tutorials` 下发）。
 *   渲染时优先用接口返回的 title —— 这样改个名字不需要重新发版、也不需要重新提审。
 *   ⚠ 别把这里的常量当成唯一来源：后台改了名而这里没改，是**预期**的。
 */
export const TUTORIAL_CATEGORIES: TutorialCategory[] = [
  { code: 'SHOOTING', label: '怎么拍', pageTitle: '怎么拍', icon: 'camera' },
  { code: 'EDITING', label: '怎么剪', pageTitle: '怎么剪', icon: 'film' },
  { code: 'OPERATION', label: '怎么发', pageTitle: '怎么发', icon: 'root-list' },
  { code: 'MANUAL', label: '怎么用', pageTitle: '怎么用', icon: 'book' },
]

export function tutorialCategoryOf(code: string): TutorialCategory | undefined {
  return TUTORIAL_CATEGORIES.find((c) => c.code === code)
}

export interface TutorialItem {
  id: string
  category: string
  title: string
  durationMs: number | null
  /** 服务端现签的播放地址。**端上已不再播放**，留着只为兼容旧接口字段 */
  videoUrl: string | null
  /** 封面（可选）。没有封面时列表用纯文字卡片，不影响可点性 */
  coverUrl: string | null
  /** 视频号视频标识 —— 点「观看」时传给 Taro.openChannelsActivity */
  feedId: string
  /** 视频号 ID（`sph` 开头）。为 null ⇒ 不给「观看」入口，避免点不动的按钮 */
  finderUserName: string | null
}

export interface TutorialCategoryStat {
  code: string
  /** 当前分类名：后台自定义值，没改过就是代码兜底。**渲染优先用它** */
  title: string
  count: number
}

/** 分类概览（含每个分类的内容数）。失败时调用方应当静默降级，不要挡住分组列表渲染 */
export function listTutorialStats() {
  return http.get<{ categories: TutorialCategoryStat[] }>('/tutorials')
}

/**
 * 某个分类下的内容清单。
 * `title` 是运营在后台配的分类名 —— 分类页的导航标题与页内大标题都用它，
 * 本地常量只在请求没回来/失败时兜底。
 */
export function listTutorials(category: string) {
  return http.get<{ category: string; title?: string; items: TutorialItem[] }>(`/tutorials/${category}`)
}
