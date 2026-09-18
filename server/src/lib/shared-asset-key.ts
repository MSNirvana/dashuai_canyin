// 「平台共享对象」的前缀白名单 —— 这类对象不属于任何商户，可以跨商户签名。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// `media.service.ts::getSharedPlayUrlByKey` 刻意**不校验商家前缀**（它服务的是
// 平台级共享资源）。那把「什么键算平台共享」这件事写在调用方，各调用方就得各自记得判。
// 本项目已经因此踩过两次：作品封面/视频（work.service.ts::isSignableWorkKey）、
// 教学素材（tutorial.service.ts::signTutorialUrl）各写了一遍自己的守卫，
// 而**镜头库示范视频漏了** —— 那条路由直接把库里的 `demoVideoKey` 签出去。
// 那一列在后台是**自由文本框**，谁把它填成 `uploads/2/xxx.mp4`，
// 任何登录商户请求 `/shot-library/:id/demo-play-url` 都能拿到商户 2 私有文件的签名地址：
// 越权读，而且日志里完全看不出异常（签出去的是合法签名）。
//
// 所以这里把「平台共享前缀」收敛成一个**唯一权威清单**，供各调用方共用；
// 各调用方仍可在此基础上**收窄**（例如作品只放行 works/ + renders/），但不得放宽。
//
// ── 判据为什么是「白名单」而不是「黑名单 uploads/」────────────────────────────
// 黑名单只挡住今天已知的商户前缀。以后新增一个商户级前缀（例如按门店分目录），
// 黑名单不会跟着长，而白名单会天然把它挡在外面 —— 白名单的失效方向是「签名被拒」，
// 黑名单的失效方向是「签名被放行」。前者是可见的业务故障，后者是静默的越权。
import { isSafeObjectKey } from './object-key.js'

/**
 * 平台共享前缀清单。
 *
 * · `tutorials/` 教学素材（后台运营上传，全商户可看）
 * · `works/` 优秀作品（运营从成片里挑出来公开给所有商户看，是刻意的产品语义）
 * · `static/` 运营公开展示图（首页轮播 / 口号图），本来就是匿名可读的
 *
 * ⚠ **不含** `uploads/` 与 `renders/`：这两个是**商户级**目录，
 *   即使某个键确实属于运营自己想引用的那个商户，也不该借这条通道签名 ——
 *   读接口拿不到「当前请求者是谁」的对照，一旦放行就等于对所有登录商户放行。
 */
export const SHARED_STORAGE_PREFIXES = ['tutorials/', 'works/', 'static/'] as const

export type SharedStoragePrefix = (typeof SHARED_STORAGE_PREFIXES)[number]

/**
 * 这个键是否允许作为「平台共享资源」被签名。
 *
 * ★ 必须**两件事一起做**：先判路径安全，再判前缀。
 *   只做前缀匹配的话，`tutorials/../../uploads/2/x.mp4` 会通过 `startsWith('tutorials/')`，
 *   而各存储后端解析后落到商户 2 的目录 —— 这正是 `object-key.ts` 文件头记的那次事故，
 *   守卫写在前缀那一层是拦不住的。
 *
 * @param allow 可选的**收窄**清单；不传则用全量共享前缀
 */
export function isSharedAssetKey(
  key: string | null | undefined,
  allow: readonly string[] = SHARED_STORAGE_PREFIXES,
): key is string {
  if (!key) return false
  if (!isSafeObjectKey(key)) return false
  return allow.some((prefix) => key.startsWith(prefix))
}

/** 面向运维的可读说明：配置里该填什么样的键 */
export function describeSharedPrefixes(allow: readonly string[] = SHARED_STORAGE_PREFIXES): string {
  return allow.join(' / ')
}
