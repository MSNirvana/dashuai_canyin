// 参考视频 · 四个固定分类的白名单（服务端权威定义）。
//
// ── 为什么是代码常量而不是一张分类表 ──────────────────────────────────────
// **码值**（SHOOTING/EDITING/OPERATION/MANUAL）是写死的：它出现在数据库列、接口参数、
// 页面 query 里，改一次要动全链路 —— 没有运营需要改它。
//
// ── 文案（2026-10-22 起可自定义）──────────────────────────────────────────
// 分类**名称**由运营在后台改，存在系统设置 `tutorial.category_titles`（一条 JSON）。
// 优先级：系统设置里的自定义值 > 兜底文案。兜底只有一份，在
// services/tutorial.service.ts 的 FALLBACK_TITLES —— 别再往别处复制第二份。
//
// ⚠ 改名的**边界**：只换 label，不动码值（见记忆里的「对外称号只换 label、不动标识符」）。
// ⚠ 名称里不许出现 TUTORIAL_TITLE_BANNED_WORDS 里的词 —— 那几个词会把页面指向
//   「教育服务·在线视频课程」，那套资质的门槛比「文娱-其他视频」更高。
//   后台保存时由本文件的 findBannedTitleWord 强制挡住（不是靠前端提示）。
//
// 与客户端的对应关系（改 code 时一起改）：
//   · 小程序 apps/mini/src/services/tutorial.ts 的 TUTORIAL_CATEGORIES（本地兜底 label + icon）
//   · 后台   apps/admin/src/pages/Tutorials.tsx 的 CATEGORIES（下拉选项兜底）
// 三处的 **code 必须逐字一致**；文案以系统设置为准，那两处只是兜底。
export const TUTORIAL_CATEGORY_CODES = ['SHOOTING', 'EDITING', 'OPERATION', 'MANUAL'] as const

export type TutorialCategoryCode = (typeof TUTORIAL_CATEGORY_CODES)[number]

/** 分类名的长度上限（后台输入框的 maxLength 与这里同步） */
export const MAX_CATEGORY_TITLE_LEN = 8

/**
 * 分类名里的**禁词**。
 *
 * ★★ 为什么由服务端强制、而不是在后台界面上写句提示：
 *   这几个词（课程/教程/教学/学习/技巧/知识/手册）正是把页面指向
 *   「教育服务·在线视频课程」的引信 —— 2026-10-22 就因为它们被要求补过视频类目。
 *   运营手一抖把「怎么拍」改成「拍摄技巧」，风险就悄悄回来了，而页面上看不出异常。
 */
export const TUTORIAL_TITLE_BANNED_WORDS = ['课程', '教程', '教学', '学习', '技巧', '知识', '手册'] as const

/** 命中禁词返回那个词，否则 null */
export function findBannedTitleWord(title: string): string | null {
  return TUTORIAL_TITLE_BANNED_WORDS.find((w) => title.includes(w)) ?? null
}


/** zod 用的字面量联合，`z.enum` 需要非空元组 */
export const tutorialCategoryEnum = TUTORIAL_CATEGORY_CODES as unknown as [
  TutorialCategoryCode,
  ...TutorialCategoryCode[],
]

export function isTutorialCategory(v: string): v is TutorialCategoryCode {
  return (TUTORIAL_CATEGORY_CODES as readonly string[]).includes(v)
}
