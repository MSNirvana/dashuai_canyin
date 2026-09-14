/**
 * 场景码注册表 —— 全系统 sceneCode 的唯一权威来源。
 *
 * 业务代码**必须**从这里引用常量，不要再写字面量：
 *   runBilledScene(prisma, gw, { sceneCode: SCENE.copy_generate, ... })
 *
 * 后台「AI 场景」页的「已接入 / 待接入」标记来自 `LIVE_SCENE_CODES`：
 *   - 在 LIVE_SCENE_CODES 里 → 已接入（代码里有调用方）
 *   - 不在 → 待接入（提示词已配好，等业务方接入）
 *
 * 新增场景时两步走：
 *   1) 在本文件加常量 → seed 配提示词 → 后台可见
 *   2) 业务代码引用常量后，把常量名加到 LIVE_SCENE_CODES 里
 *
 * 这样「已接入」标记永远和代码一致，不需要去改前端硬编码。
 */

export const SCENE = {
  // ── 已接入：代码里已有调用方 ──
  copy_generate: 'copy_generate',
  copy_traffic: 'copy_traffic',
  copy_intro: 'copy_intro',
  copy_quality: 'copy_quality',
  copy_recommend: 'copy_recommend',
  storyboard_generate: 'storyboard_generate',

  // ── 待接入：提示词已配好，业务方尚未引用 ──
  script_polish: 'script_polish',
  review_guard: 'review_guard',
  title_overlay: 'title_overlay',
  bgm_select: 'bgm_select',
  rhythm_detect: 'rhythm_detect',
} as const

export type SceneCode = (typeof SCENE)[keyof typeof SCENE]

/** 已有业务调用方的场景（已接入）—— 后台据此打「已接入」标签 */
export const LIVE_SCENE_CODES: readonly SceneCode[] = [
  SCENE.copy_generate,
  SCENE.copy_traffic,
  SCENE.copy_intro,
  SCENE.copy_quality,
  SCENE.copy_recommend,
  SCENE.storyboard_generate,
]
