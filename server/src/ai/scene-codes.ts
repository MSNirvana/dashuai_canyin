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
  // 发布素材（文本 + 图像两个场景，链路见 publish-material.service.ts）。
  // ★ publish_cover 是本项目**第一个图像场景**：它的候选模型必须是
  //   `ai_model.capability='IMAGE'`，且 `ai_scene.kind='IMAGE'`（网关据此选图像适配器）。
  //   把文本模型配进它的候选链，网关会在调用前就跳过并给出明确原因，不会「拿一段文字当图片」。
  publish_material: 'publish_material',
  publish_cover: 'publish_cover',

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
  SCENE.publish_material,
  SCENE.publish_cover,
]

/**
 * 图像场景（`ai_scene.kind='IMAGE'`）的候选**必须**是 `capability='IMAGE'` 的模型。
 *
 * ★ 单独导出成集合而不是就地写 `scene.kind === 'IMAGE'` 判断：后台「AI 场景」页的模型下拉
 *   目前不按能力过滤（运营能看到全部模型），所以下面这条约束是**唯一**的防线：
 *   配错了就在调用前跳过并报明确原因，而不是调错协议、扣了钱、拿回一段没法用的文本。
 */
export const IMAGE_SCENE_CODES: readonly SceneCode[] = [SCENE.publish_cover]
