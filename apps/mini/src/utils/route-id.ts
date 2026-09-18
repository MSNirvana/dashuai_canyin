// 页面编号（路径参数 id）的取值与校验。
//
// ★ 为什么值得单独一个文件：`?id=${id}` 在 id 为 undefined 时会**静默**拼成字符串
//   `'undefined'` —— URL 看着完全正常，小程序和 IDE 都不报任何错，页面也照常渲染。
//   但服务端 `idParam()` 对非纯数字串一律抛 InvalidIdParamError，返回
//   `{"code":4000,"message":"参数不合法"}`（实测复现：`GET /creations/undefined`）。
//   用户看到的就是这么一句**指向不了任何操作**的报错：不知道该点哪里、也不知道是
//   哪一步出的问题，只能当成「应用坏了」。
//
//   ⇒ 页面拿不到编号时应当**当场**说清「编号丢了，请从创作列表重新进入」，
//     而不是带着一个假编号去请求、再把服务端的参数校验错误当结果展示出来。
//
// 合法形态与服务端共用同一口径（`server/src/lib/params.ts` 的 idStrSchema）：
// 1~19 位纯数字，显式排除空串、前导 0、负号、小数、科学计数法 —— 两边判据必须一致，
// 否则前端放过去的编号会被服务端按 400 打回来，又变成同一种「参数不合法」。

/** 合法的创作 / 分镜 / 素材编号 */
export function isNumericId(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,19}$/.test(v)
}

/**
 * 从页面参数里取编号。
 * 返回 null 表示「这个页面根本没拿到有效编号」——调用方必须给出**可操作**的提示，
 * 绝不要退化成空串或 `'undefined'` 再拼进下一个 URL（那正是这个文件存在的理由）。
 */
export function readRouteId(params: Record<string, unknown> | undefined, key = 'id'): string | null {
  const v = params?.[key]
  return isNumericId(v) ? v : null
}

/**
 * 「路由里**带了**编号，但这个编号不合法」—— 最典型的就是字符串 `'undefined'`。
 *
 * ★ 为什么必须与「根本没带编号」分开判断：
 *   两个页面的分支语义完全不同。
 *   · 编辑类页面（门店/菜品/创作编辑）**不带编号就是正常场景** —— 那是「新建」。
 *     如果只判断「不合法」，新建也会被当成坏跳转拦下来，等于把功能删了；反过来，
 *     如果不判断，`?id=undefined` 会以「新建」的身份悄悄打开，用户以为在改一条数据、
 *     实际上提交会**新建出第二条**，而原来那条还在。
 *   · 只读类页面（门店详情 / 作品详情）不带编号没意义，这时说什么都比空白强。
 *
 * 判据与 `readRouteId` 共用 `isNumericId`（也就与服务端 `idStrSchema` 同口径），
 * 免得两边对「什么算合法编号」的看法不一致，又变成同一种「参数不合法」。
 */
export function isBrokenRouteId(params: Record<string, unknown> | undefined, key = 'id'): boolean {
  const v = params?.[key]
  // 没带 / 空串 ⇒ 不是坏跳转，而是「没带编号」（调用方按自己的语义处理）
  if (v === undefined || v === null || v === '') return false
  return !isNumericId(v)
}
