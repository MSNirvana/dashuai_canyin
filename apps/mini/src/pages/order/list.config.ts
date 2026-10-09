export default definePageConfig({
  // 标题必须稳定成「订单中心」：微信在后台核对 order-center 的 path 时看的就是这一页，
  // 而标题若跟着状态变（像教学中心那样按分类 setNavigationBarTitle），核对的人会以为走错了页。
  navigationBarTitleText: '订单中心',
  navigationBarBackgroundColor: '#FFFFFF',
  // 订单是「随时可能变」的数据（刚付完款回到这页就该是最新的），下拉刷新比找按钮顺手
  enablePullDownRefresh: true,
  backgroundTextStyle: 'dark',
  // 分享开关（默认 false）；详见 utils/app-share.ts 顶部说明
  enableShareAppMessage: true,
  enableShareTimeline: true,
})
