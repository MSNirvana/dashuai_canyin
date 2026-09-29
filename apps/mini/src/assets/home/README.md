# 这个目录里的图**不进代码包**

`home/` 下的 6 张 `.jpg` 都是**上传源**，
页面里引用的是 CDN 直链，不是这些文件。

- 页面代码引用的是 `src/constants/static-assets.ts` 里的常量（由 `npm run assets:upload` 生成）。
- 改了这里的图，**必须**跑 `npm run assets:upload` 重新上传，否则线上还是旧图。
- 想确认某一轮构建有没有把这些图打进包：看构建后 `dist/weapp/assets/` 下是否还有 `home/` 目录 —— 正常应该**没有**。

留在包里的是：

- `../logo.png` —— 展示最大 64rpx(32pt)，96px 已是 3x 屏上限，14KB；
- `../tabbar/*.png` —— `app.json` 的 `tabBar.iconPath` **只接受本地路径**，无法上 CDN。

两者合计约 32KB，远低于微信「图片和音频资源超过 200K」的建议线，而换来的是品牌标与 tabBar 零延迟渲染。

## 2026-09-29：口号图素材已删除

这里原来还有一张 `slogan-banner-v3.png`（首页口号海报，代码合成、红白黑三色、1125×411）。
**口号图功能整条下线**：消费端 2026-09-24 就从首页摘掉了，2026-09-29 连带后台页、上传接口、
seed 配置行、常量与生成脚本（`scripts/render-slogan-banner.mjs` + `slogan-banner.html`）一并清理。

设计源、三色规范与「换图必须换文件名」那套踩坑记录，需要时从 git 历史里翻这份文件与
skill `poster-cutout-to-cdn`；代码里已无任何引用点。

留在**包里**的仍然只有 `../logo.png` 与 `../tabbar/*.png`。
