// 本页原先没有页面配置文件：这里**只补分享开关**，不设 navigationBarTitleText
// —— 保持沿用全局标题（大帅餐饮助手），避免顺带改了导航栏观感。
export default definePageConfig({
  // 分享开关（默认 false）；详见 utils/app-share.ts 顶部说明
  enableShareAppMessage: true,
  enableShareTimeline: true,
})
