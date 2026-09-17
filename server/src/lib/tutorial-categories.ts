// 教学中心 · 四个固定分类的白名单（服务端权威定义）。
//
// ── 为什么是代码常量而不是一张分类表 ──────────────────────────────────────
// 这四个入口的**文案与图标本来就要写死在客户端**：小程序「我的」页那个四宫格在
// 网络请求失败时也必须渲染出来（否则整张卡片会空掉）。既然客户端已经有一份，
// 再建一张分类表就有了两个真相，运营改一次名字要让两边同时改 —— 这是纯粹的漂移风险。
// 所以：服务端只负责**校验码值合法**，展示文案由各端自己拥有。
//
// 与客户端的对应关系（改这里时一起改）：
//   · 小程序 apps/mini/src/services/tutorial.ts 的 TUTORIAL_CATEGORIES（label + icon + pageTitle）
//   · 后台   apps/admin/src/pages/Tutorials.tsx 的 CATEGORIES（下拉选项）
// 三处的 **code 必须逐字一致**；文案可以不一致（后台可以写得更长）。
export const TUTORIAL_CATEGORY_CODES = ['SHOOTING', 'EDITING', 'OPERATION', 'MANUAL'] as const

export type TutorialCategoryCode = (typeof TUTORIAL_CATEGORY_CODES)[number]

/** zod 用的字面量联合，`z.enum` 需要非空元组 */
export const tutorialCategoryEnum = TUTORIAL_CATEGORY_CODES as unknown as [
  TutorialCategoryCode,
  ...TutorialCategoryCode[],
]

export function isTutorialCategory(v: string): v is TutorialCategoryCode {
  return (TUTORIAL_CATEGORY_CODES as readonly string[]).includes(v)
}
