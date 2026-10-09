// 微信小程序的「转发给朋友 / 分享到朋友圈」是**页面级**能力，不是全局开关：
//   · 页面没有定义 `onShareAppMessage` ⇒ 长按菜单里的「转发给朋友」直接置灰
//     （提示"无法转发此页面"）
//   · 页面没有定义 `onShareTimeline` ⇒ 「分享此页面」（朋友圈）同样置灰
//
// ★★ 本项目此前**全仓一个 share 钩子都没有**，症状就是「审核通过、正式版已发布，
//    但任何页面都分享不出去」。这与发布状态、深度合成类目资质**无关**——纯粹是代码里没写。
//
// 收成一个 hook 是为了**一处改口径**：19 个页面各抄一遍样板，将来改文案/落地页必漏几个。
// 每页只要 `useAppShare()` 或 `useAppShare({ ... })` 一行。
//
// ★★★ 但**光有这个 hook 还不够** —— 每个页面的 `*.config.ts` 里必须同时写：
//       enableShareAppMessage: true / enableShareTimeline: true
//
//   原因（Taro 4.2.1 实测）：Taro 本可自动帮你开这两个开关，但它靠**编译期 AST 匹配**
//   源码里的**函数名**实现（见 @tarojs/plugin-framework-react 的 addConfig：只认
//   字面出现的 useShareAppMessage / useShareTimeline）。本文件把它封装成 useAppShare
//   之后，页面源码里不再出现那两个名字 ⇒ 自动开启失效。
//   而 Taro 运行时的挂载条件是 component[onShare*] || pageConfig.enableShare*
//   （@tarojs/runtime 的 createPageConfig）—— 不满足就**不挂 config.onShareAppMessage**，
//   微信于是仍认为页面不支持分享、右上角继续置灰，而且**不报任何错**。
//
//   ⇒ 删掉 config.ts 里那两行 = 分享静默失效。**新增页面时两处都要加。**
import { useShareAppMessage, useShareTimeline } from '@tarojs/taro'

/** 分享卡片默认标题（首页轮播的那句口号） */
export const SHARE_DEFAULT_TITLE = '每天5分钟，让餐饮门店轻松拍视频'

/** 默认落地页：功能页（我的/充值/订单/门店/菜品/创作…）分享出去只能落这里 */
export const SHARE_HOME_PATH = '/pages/home/index'

export interface AppShareOptions {
  /** 卡片标题；缺省用 {@link SHARE_DEFAULT_TITLE} */
  title?: string
  /**
   * 卡片落地路径（以 `/` 开头，可带查询串）；缺省落首页。
   * ★ 只有**免登录可读**的页面才允许指向自己（作品详情、教学页、协议页）——
   *   否则接收方一进去就吃 401、被 switchTab 到「我的」弹登录框，看着像分享坏了。
   *   需要登录、且数据属于分享者本人的页面（成片记录、创作列表…）必须落首页。
   */
  path?: string
  /** 卡片配图（微信按 5:4 裁切）；缺省用页面截图 */
  imageUrl?: string
}

/**
 * 给当前页面挂上转发能力。**必须在页面组件里无条件下调用**（Hooks 规则），
 * 且要放在任何 early return 之前，否则部分分支下声明不上去、转发依旧置灰。
 */
export function useAppShare(options: AppShareOptions = {}): void {
  const { title, path, imageUrl } = options
  const cardTitle = title || SHARE_DEFAULT_TITLE

  useShareAppMessage(() => ({
    title: cardTitle,
    path: path || SHARE_HOME_PATH,
    ...(imageUrl ? { imageUrl } : {}),
  }))
  // 朋友圈卡片只吃 title / imageUrl / query，没有 path
  useShareTimeline(() => ({
    title: cardTitle,
    ...(imageUrl ? { imageUrl } : {}),
  }))
}
