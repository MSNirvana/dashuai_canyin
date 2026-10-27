// 未登录时点「需要登录的功能」的统一引导。
//
// 为什么要有这个工具、而不是各页自己弹一个 modal：
//
// 过去这类点击的做法是「先跳到某个需要鉴权的页面」，由那一页的请求吃一个 401，
// 再由请求层 redirectToLogin() 把用户 switchTab 到「我的」并弹登录框。
// 用户看到的是「点了按钮 → 闪两下 → 落在『我的』」，中间发生了什么完全不可见，
// 很容易以为是按钮坏了。
//
// 而自从首页「优秀作品」和作品详情改成**免登录可看**（服务端 routes/works.ts 故意不鉴权，
// 见该文件头注释），「未登录的人点到需要登录的功能」就从一个边缘情况变成了**主路径** ——
// 首页现在的角色就是给未登录用户的引流入口，看完作品想去创作是必然的一步。
// 所以这层解释要在**点击处**直接给出来，不能等服务端回 401。
// ★ 2026-10-26：作品卡片上的「生成同款」与详情页的「套用配方」都已删除，
//   目前还剩的唯一调用点是首页「去创作」。这段背景仍然成立，只是不再由作品页触发。
//
// 注意它不是「鉴权闸门」：真正的闸门永远在服务端（requireSubscription / auth 中间件）。
// 这里只是把「接下来要发生的事」提前说清楚，绕过它也不会获得任何权限。
import Taro from '@tarojs/taro'
import { openGuideDialog } from '../components/guide-dialog'

interface LoginGuideOptions {
  /** 一句话说清**为什么**需要登录，例如「开始创作需要先登录」。不要写「请先登录」这种空话 */
  reason: string
  /** 确认按钮文案，默认「去登录」 */
  confirmText?: string
  /** 取消按钮文案，默认「再逛逛」—— 用户是从作品页过来的，别把他往外赶 */
  cancelText?: string
  /**
   * ★ 卡片最底部的一行**小字**（可选），例如「联系客服领取试用」。
   *
   *   为什么要单开一档、而不是拼进 `content`：`Taro.showModal` 的 content 是**纯字符串**，
   *   微信没给任何样式入参（无富文本、无字号）⇒ 原生弹窗里那行字只能跟正文**一样大**，
   *   「小字」这个层级根本表达不出来。所以自 2026-10-15 起本函数改走自绘弹窗，
   *   原理与边界见 `components/guide-dialog/index.tsx` 的文件头 ★★。
   */
  note?: string
}

/** 弹一次登录引导；用户点了确认才跳「我的」（那里会弹手机号快捷登录） */
export function guideLogin(options: LoginGuideOptions): void {
  openGuideDialog({
    title: '登录后可用',
    content: options.reason,
    confirmText: options.confirmText ?? '去登录',
    cancelText: options.cancelText ?? '再逛逛',
    confirmColor: '#e1251b',
    note: options.note,
    onConfirm: () => { Taro.switchTab({ url: '/pages/mine/index' }) },
  })
}
