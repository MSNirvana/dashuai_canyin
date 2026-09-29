/**
 * 视频盒子「按视频自身宽高比自适应」——门店详情页与门店编辑页预览两个展示点共用。
 *
 * ★ 为什么是「百分比 padding-top」而不是算像素高度：
 *   百分比 padding 的基准是**包容块的宽度** ⇒ 高度 = 宽度 ÷ 比例，
 *   只要给一个百分比就够了。于是**完全不需要**知道容器是 614rpx、是 307px，
 *   也就一次性绕开了 windowWidth、rpx↔px 换算、以及 H5 侧 designWidth 把尺度
 *   整体放大 2 倍这一整类坑（见 skill `h5-headless-frontend-acceptance` §5）。
 *
 * ★ 比例从哪来：`chooseMedia` 返回的 width/height 只覆盖**新拍的**视频，而线上存量
 *   门店视频在 `media_asset.width/height` 里全是 NULL ⇒ 读库方案对存量无效。
 *   唯一对「存量 + 新增」都成立的数据源是**播放器元数据事件**：
 *   小程序 `bindloadedmetadata` / H5 `loadedmetadata`，两端载荷都是
 *   `{ width, height, duration }`（Taro 属性名 `onLoadedMetaData`）。
 */

/**
 * 竖版封顶：最高按 9:16 撑，即盒子最矮的比例是 0.5625。
 * 比 9:16 更细长的视频（1:2、1:3…）只会在盒子里左右留黑边，
 * 不会让「门店视频」这一块把整页拉得没有边。
 * ★ 想放宽/收紧「竖版最多能多高」，改这一个数就够了。
 */
export const PORTRAIT_FLOOR = 9 / 16

/** 元数据未到（或加载失败）时的兜底比例 16:9 —— 避免盒子高度先塌成 0、再突然撑开 */
export const FALLBACK_RATIO = 16 / 9

/**
 * 「宽/高」→ 可直接塞进内联样式的 padding-top 百分比。
 * 传入非法值（NaN / 0 / 负数）时回退到 16:9。
 */
export function ratioToPaddingTop(ratio: number | null | undefined): string {
  const safe = typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? ratio : FALLBACK_RATIO
  const eff = Math.max(safe, PORTRAIT_FLOOR)
  return `${(100 / eff).toFixed(4)}%`
}

/**
 * 从播放器元数据事件里取宽高比。取不到（没有 detail / 宽高缺失 / 宽高为 0）返回 null，
 * 调用方据此保留兜底比例 —— 宁可显示成 16:9，也不要拿 NaN 去撑盒子。
 */
export function readRatioFromMeta(e: unknown): number | null {
  const detail = (e as { detail?: { width?: unknown; height?: unknown } } | null | undefined)?.detail
  const w = Number(detail?.width)
  const h = Number(detail?.height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return w / h
}
