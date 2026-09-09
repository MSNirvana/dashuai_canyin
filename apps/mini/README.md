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
├── app.tsx              # 入口：恢复登录态、刷新豆余额
├── app.config.ts        # 页面路由 / 分包 / TDesign 全局注册
├── app.scss             # 全局基础样式
├── styles/theme.scss    # 品牌主题（简洁 + 红色）与 CSS 变量
├── config.ts            # 环境、后端地址、平台判定
├── services/            # 请求封装 + 接口
├── store/               # zustand 全局状态
├── components/          # 业务组件
└── pages/
    ├── login/           # 微信一键 + 手机号验证码（兜底）
    └── home/            # 首页（门店切换 / 豆余额 / 新建创作）
```

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
| `--ds-bean` | `#ffb400` | AI豆（金黄） |
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
- AI豆与会员页（bean / member）
- 多门店管理（profile）
- COS 直传（分片 + 断点续传）
- 订阅消息授权引导
