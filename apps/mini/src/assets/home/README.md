# 这个目录里的图**不进代码包**

`home/` 下的 7 张图（6 张 `.jpg` + `slogan-banner-v3.png`）都是**上传源**，
页面里引用的是 CDN 直链，不是这些文件。

- 页面代码引用的是 `src/constants/static-assets.ts` 里的常量（由 `npm run assets:upload` 生成）。
- 改了这里的图，**必须**跑 `npm run assets:upload` 重新上传，否则线上还是旧图。
- 想确认某一轮构建有没有把这些图打进包：看构建后 `dist/weapp/assets/` 下是否还有 `home/` 目录 —— 正常应该**没有**。

留在包里的是：

- `../logo.png` —— 展示最大 64rpx(32pt)，96px 已是 3x 屏上限，14KB；
- `../tabbar/*.png` —— `app.json` 的 `tabBar.iconPath` **只接受本地路径**，无法上 CDN。

两者合计约 32KB，远低于微信「图片和音频资源超过 200K」的建议线，而换来的是品牌标与 tabBar 零延迟渲染。

## `slogan-banner-v3.png`：首页口号海报（红/白/黑三色）

**这张图是代码生成的，不要手工改 PNG。** 设计源是 `apps/mini/scripts/slogan-banner.html`：

```bash
npm run assets:slogan     # 渲染 HTML → 量化 → 写回 src/assets/home/slogan-banner-v3.png
```

- **为什么用代码合成而不是模型出图**：整张图上唯一的信息就是「让餐饮门店 轻松拍视频」十个汉字
  ＋「AI」两个字。图像模型画中文会糊字/串字，而这是产品文案 —— 出错就得重出图，还没法评审、没法 diff。
  在无头 Chrome 里用系统字体（Hiragino Sans GB）渲染，字是确定的，改文案只是改一行 HTML。
- **只用三色**：红 `#e1251b`（= `--td-brand-color`）／黑 `#17181a`／白 `#ffffff`。
  白既是**整幅底色（纯白）**，也用在胶片齿孔、播放三角、「AI」字上。
- **底色是纯白，且烤在图里**：HTML 里那层实心 `.bg` 铺满画布，**不依赖容器的底色**，
  也不依赖截图参数（脚本里 `omitBackground` 开着也照样是白底）。
  对应地 `pages/home/index.scss` 的 `&__slogan-banner` 也用 `#fff`，
  免得 aspectFit 那不到 1rpx 的留白与圆角处露出暖色底。
- **字重**：取字体自身的 W6（Hiragino Sans GB 的最粗档），**不加任何仿粗体**。
  要更粗时用 `text-shadow` 多向偏移；**别用 `-webkit-text-stroke`** ——
  描边在「餐」这种笔画交叠的字上会留一条极细的亮色接缝（实测确有，放大到像素级才明显）。
- **规格**：1125×411（≈375pt 的 3x 上限），宽高比 2.737，**不透明**，调色板 PNG **19KB**
  （全彩 RGBA 是 134KB；量化用 `dither=NONE`，抖动会在纯色块里撒噪点）。
  量化后脚本会把调色板里的**设计色吸回精确值** —— 聚类中心会把纯白 `#fff` 挪成 `(254,254,254)`，
  肉眼分不出但没达到「纯白」这条判据。
- **⚠ 换图必须换文件名**（所以叫 `-v3`）：上传带 `Cache-Control: max-age=604800`，
  对象 Key 固定 ⇒ 沿用同名会继续吐旧图，清缓存都不一定管用。
  流程：改 `slogan-banner.html` → 改文件名 → `assets:slogan` → 改 `scripts/upload-static-assets.mjs` 的
  `FILES` → `assets:upload`（自动重生成 `src/constants/static-assets.ts`）→ 改页面里的常量引用。
- **⚠ 换图后要同步改** `pages/home/index.scss` 里 `&__slogan-image` 的 `height`
  （1125/411 ⇒ 678rpx ÷ 2.737 ≈ 248rpx；那里写了注释说明算法）。
  **不能写 `height: auto`** —— 图在 CDN 上，加载完成前高度是 0，一到位整个首屏会往下跳一截。

历史上这个位置放过两版：第一版是代码画的 750×260 内联 SVG（1.2KB）；
第二版是一张模型出的成品海报（橙色系、带半透明菜品照），需要「白底扣透明 + 反预乘 + 量化」一整套处理
（老流程与踩坑记在 skill `poster-cutout-to-cdn`）。
换成代码合成之后，那条扣图管线**在这个资源上不再需要**了。

留在**包里**的仍然只有 `../logo.png` 与 `../tabbar/*.png`。
