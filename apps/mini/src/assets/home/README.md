# 这个目录里的图**不进代码包**

`home/*.jpg`（6 张）是**上传源**，页面里引用的是 CDN 直链，不是这些文件。

- 页面代码引用的是 `src/constants/static-assets.ts` 里的常量（由 `npm run assets:upload` 生成）。
- 改了这里的图，**必须**跑 `npm run assets:upload` 重新上传，否则线上还是旧图。
- 想确认某一轮构建有没有把这些图打进包：看构建后 `dist/weapp/assets/` 下是否还有 `home/` 目录 —— 正常应该**没有**。

留在包里的是：

- `../logo.png` —— 展示最大 64rpx(32pt)，96px 已是 3x 屏上限，14KB；
- `../tabbar/*.png` —— `app.json` 的 `tabBar.iconPath` **只接受本地路径**，无法上 CDN。

两者合计约 32KB，远低于微信「图片和音频资源超过 200K」的建议线，而换来的是品牌标与 tabBar 零延迟渲染。

`slogan-banner.svg` 也留在本地：它会被 webpack 内联成 base64（1.2KB → 约 1.6KB），
比多一次网络请求更划算。
