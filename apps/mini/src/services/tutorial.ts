// 教学中心：学习中心四宫格 + 分类课程列表。
//
// ── 四个分类的文案与图标为什么写在这里 ────────────────────────────────────
// 服务端的白名单（server/src/lib/tutorial-categories.ts）只负责**校验码值合法**，
// 文案与图标是客户端资产：小程序「我的」页那个四宫格在请求失败时也必须渲染出来，
// 否则整张卡片会空掉。所以这里持有本地副本，服务端返回的同名字段只当兜底。
// ⚠ 三个文件的 code 必须**逐字一致**：
//   · server/src/lib/tutorial-categories.ts
//   · apps/mini/src/services/tutorial.ts（本文件）
//   · apps/admin/src/pages/Tutorials.tsx
import { http } from './request'

export interface TutorialCategory {
  code: string
  /** 四宫格里的短标签 */
  label: string
  /** 分类页的导航标题（参考样式里写的是完整课程名） */
  pageTitle: string
  /** tdesign 图标名（已在 icon.wxss 里逐个核对存在，写错会静默不显示） */
  icon: string
}

export const TUTORIAL_CATEGORIES: TutorialCategory[] = [
  { code: 'SHOOTING', label: '拍摄技巧', pageTitle: '短视频拍摄技巧', icon: 'camera' },
  { code: 'EDITING', label: '剪辑教程', pageTitle: '短视频剪辑教程', icon: 'film' },
  { code: 'OPERATION', label: '运营知识', pageTitle: '短视频运营知识', icon: 'root-list' },
  { code: 'MANUAL', label: '使用手册', pageTitle: '使用手册', icon: 'book' },
]

export function tutorialCategoryOf(code: string): TutorialCategory | undefined {
  return TUTORIAL_CATEGORIES.find((c) => c.code === code)
}

export interface TutorialItem {
  id: string
  category: string
  title: string
  durationMs: number | null
  /** 服务端现签的播放地址（1 小时有效）；签不出来时为 null */
  videoUrl: string | null
  coverUrl: string | null
}

export interface TutorialCategoryStat {
  code: string
  /** 服务端的兜底文案，正常不使用（用本地的 label） */
  title: string
  count: number
}

/** 分类概览（含每个分类的课程数）。失败时调用方应当静默降级，不要挡住四宫格渲染 */
export function listTutorialStats() {
  return http.get<{ categories: TutorialCategoryStat[] }>('/tutorials')
}

export function listTutorials(category: string) {
  return http.get<{ category: string; items: TutorialItem[] }>(`/tutorials/${category}`)
}
