// definePageConfig 是 Taro 4 的全局声明，无需 import
export default definePageConfig({
  navigationBarTitleText: '个人主页',
  navigationBarBackgroundColor: '#FFFFFF',
  // 分享开关（默认 false）；详见 utils/app-share.ts 顶部说明
  enableShareAppMessage: true,
  enableShareTimeline: true,
})
