# 小程序端（Taro 4 + React 18 + TypeScript + TDesign）

一套代码编译微信小程序（`weapp`）与抖音小程序（`tt`）。

## 快速开始

```bash
npm install
npm run dev:weapp     # 微信开发者工具打开 dist/weapp
npm run dev:tt        # 抖音开发者工具打开 dist/tt
```

## 目录

```
src/
├── app.tsx              # 入口：恢复登录态、刷新积分余额
├── app.config.ts        # 页面路由 / 分包 / TDesign 全局注册
├── app.scss             # 全局基础样式
├── styles/theme.scss    # 品牌主题（简洁 + 红色）与 CSS 变量
├── config.ts            # 环境、后端地址、平台判定
├── services/            # 请求封装 + 接口
├── store/               # zustand 全局状态
├── components/          # 业务组件
└── pages/
    ├── login/           # 微信一键 + 手机号验证码（兜底）
    └── home/            # 首页（门店切换 / 积分余额 / 新建创作）
```

## TDesign 组件与 npm 拷贝（动这里之前先读）

TDesign 是**原生小程序组件**，不经过 webpack，而是由 `config/tdesign-copy.ts` 按
「`src/app.config.ts` 注册的 `t-*` 组件 → 真实引用传递闭包」**按需拷贝**到 `dist/weapp/npm/`。
注册新组件不用改配置，拷贝范围会跟着自动走（闭包是机械算出来的，不是手工维护的目录清单）。

两个**已经踩过**的坑，现在都做了构建期拦截：

1. **tdesign ≥ 1.9.0 的隐式 tslib 依赖**
   产物里有 `import{__decorate}from"tslib"`，但 tdesign 的 `package.json` 未声明该依赖
   （官方 issue `Tencent/tdesign-miniprogram#3697`）。微信对 `npm/` 下的裸模块名会退回
   「相对当前文件」解析，所以**每个引用 tslib 的组件目录**里都必须有 `tslib.js`，否则运行时报
   `module 'npm/tdesign-miniprogram/button/tslib.js' is not defined`，页面直接白屏。
   → 由 `config/tdesign-tslib-shim.js` + `tdesign-copy.ts` 自动逐目录补齐
   （11 个目录 × 约 2KB；整份 `tslib.js` 每目录拷一份要 251KB，会顶爆主包配额）。
   若 tdesign 升级后用到新 helper，**构建会直接失败**并告诉你怎么补。

2. **改了 `.env` 却不生效**
   构建脚本里曾写死 `TARO_APP_API_BASE_URL`，而命令行优先级高于 `.env`
   → 已移除。现在产物里的后端地址**只**来自 `.env`。
   想临时连本地后端用 `npm run dev:weapp:local`。

构建后建议跑一次产物自检：

```bash
npm run verify:dist
```

核对项：组件引用是否都能解析 / tslib 是否补齐 / 主包体积 / 产物里有没有残留联调地址。

## 登录

- **默认入口**：微信一键登录。必须用原生 `<Button openType="getPhoneNumber">`（TDesign 的 `t-button` 对 `openType` 支持不稳定）
  - 前置：小程序后台申请「手机号快速验证」（企业主体，¥0.04/次）
  - 页面同时拿 `wx.login()` 的 code，两个 code 一起提交后端
- **小字入口**：手机号 + 短信验证码，用于拒接授权 / 抖音端 / 微信未登录场景
- 抖音端无 `getPhoneNumber` 能力，自动降级为手机号验证码（`SUPPORT_WX_QUICK_LOGIN`）

## 主题

`src/styles/theme.scss` 定义品牌色与 TDesign 变量：

| 变量 | 值 | 用途 |
|---|---|---|
| `--td-brand-color` | `#d93a2b` | 品牌红（按钮、强调） |
| `--ds-bean` | `#ffb400` | 积分（金黄） |
| `--ds-member` | `#8b5cf6` | 会员标识（紫） |
| `--ds-success` | `#00a870` | 成功态 |

## 分包规划（页面补齐后启用）

主包只保留 login / home / mine，目标 **< 1.2MB**：

| 分包 | 页面 |
|---|---|
| `pages-creation` | creation、script、shoot |
| `pages-render` | render |
| `pages-bean` | bean |
| `pages-member` | member |
| `pages-profile` | store-list、store-edit、dish、persona |

配置已在 `app.config.ts` 注释中写好，取消注释即可启用。首页预加载 `pages-creation`。

## 待接入

- 门店切换器（首页顶部）
- 创作流程页（creation / script / shoot）
- 合成进度与成片页（render）
- 积分与会员页（bean / member）
- 多门店管理（profile）
- COS 直传（分片 + 断点续传）
- 订阅消息授权引导
