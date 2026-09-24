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
// 见该文件头注释），「未登录的人点到需要登录的按钮」就从一个边缘情况变成了**主路径** ——
// 首页现在的角色就是给未登录用户的引流入口，看完作品点「生成同款」是必然的一步。
// 所以这层解释要在**点击处**直接给出来，不能等服务端回 401。
//
// 注意它不是「鉴权闸门」：真正的闸门永远在服务端（requireSubscription / auth 中间件）。
// 这里只是把「接下来要发生的事」提前说清楚，绕过它也不会获得任何权限。
import Taro from '@tarojs/taro'

interface LoginGuideOptions {
  /** 一句话说清**为什么**需要登录，例如「套用同款配方需要先登录」。不要写「请先登录」这种空话 */
  reason: string
  /** 确认按钮文案，默认「去登录」 */
  confirmText?: string
  /** 取消按钮文案，默认「再逛逛」—— 用户是从作品页过来的，别把他往外赶 */
  cancelText?: string
}

/** 弹一次登录引导；用户点了确认才跳「我的」（那里会弹微信一键登录） */
export function guideLogin(options: LoginGuideOptions): void {
  void Taro.showModal({
    title: '登录后可用',
    content: options.reason,
    confirmText: options.confirmText ?? '去登录',
    cancelText: options.cancelText ?? '再逛逛',
    confirmColor: '#e1251b',
  }).then((r) => {
    if (r.confirm) Taro.switchTab({ url: '/pages/mine/index' })
  })
}
