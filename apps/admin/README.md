# 大帅餐饮 · 管理后台 (apps/admin)

React 18 + Vite + TDesign-React 的 PC 后台，对接 `server` 的 `/admin/api/v1` 端点。

## 启动

```bash
npm install
npm run dev      # http://localhost:5173，Vite 代理 /admin/api/v1 -> http://localhost:3000
npm run typecheck
npm run build
```

## 默认登录

后端种子写入 `admin / admin123456`（生产请改）。

## 现有页面

| 路径 | 用途 |
|---|---|
| `/login` | 管理员登录 |
| `/dashboard` | 仪表盘（商家/创作/财务/AI） |
| `/merchants` | 商家列表 |
| `/merchants/:id` | 商家详情（门店/账户/流水/订单）+ 启停 |
| `/bean-packages` | 加油包 CRUD |
| `/member-packages` | 会员套餐 CRUD |
| `/bean-ledger` | 跨商家积分流水 + 手动调账 |
| `/render-tasks` | 合成任务列表（状态/进度/缓存命中） |
| `/ai/providers` | AI 通道 CRUD + 一键测试/单测 + 启停 |
| `/ai/models` | 模型 + 价格（分/MTok） |
| `/ai/scenes` | 场景：提示词模板 + 默认/备用模型 + 兜底模板 + 超时 |
| `/ai/call-logs` | 全平台 AI 调用日志（含 TEST） |
| `/shot-library` | 六类镜头手法 CRUD |
| `/settings` | `system_setting` 配置 CRUD（写入即失效缓存） |
| `/tts-providers` | 腾讯云/火山 TTS 供应商 |

## 与 weapp 共用 admin API

任何 `/admin/api/v1/...` 请求都会自动在 header 加 `Authorization: Bearer ${token}`；
401 自动清理 session 并跳 `/login`。
