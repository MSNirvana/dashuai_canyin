# 大帅餐饮 GitHub 同步概览

## 已完成
- 当前工作区已初始化为 Git 仓库并推送至 GitHub：`https://github.com/MSNirvana/dashuai_canyin.git`。
- 分支：`main`。
- 提交：`3c7482ac2ff9ec2b62786287a0824cf2fb9f2699`。
- 本地 HEAD 与 `origin/main` 已确认一致。
- 已包含 `apps/mini`、`apps/admin`、`server`、`docs`、`scripts`、数据库 schema 与迁移文件。
- 已排除 node_modules、构建产物、本地私有配置、`.workbuddy`、缓存和 vite 临时时间戳文件。

## 当前代码包含的主要改动
- 登录兼容与旧 refresh token 处理。
- 订单状态查询与充值确认流程。
- 门店城市/区县下拉选择。
- 菜品图片、视频上传与 `video_key` 迁移。
- JWT、支付配置和账务部分加固。
- 审计文档与整改验收脚本。

## 注意
仓库不是发布就绪状态。真实付费联调、MySQL 并发、COS/FFmpeg/TTS、真机验收仍继续。
