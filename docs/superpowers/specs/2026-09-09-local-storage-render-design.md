# 本地素材与合成存储设计

## 目标

在腾讯云 COS 尚未开通前，让小程序可以把图片/视频上传到本机，并让真实 FFmpeg Worker 从本机素材合成视频、把成片保存到本机。明天配置 COS 后只切换配置，不改变数据库表和业务接口。

## 方案

- 增加 `STORAGE_MODE=local|cos` 开关，开发环境默认 `local`，生产环境仍要求 COS。
- 本地文件根目录由 `LOCAL_STORAGE_DIR` 指定，默认项目外的 `server/storage`。
- 原始素材使用 `uploads/{merchantId}/...` 键，成片使用 `renders/{merchantId}/{taskId}.mp4` 键，与 COS 键保持一致。
- 小程序在本地模式调用鉴权的 multipart 上传接口；COS 模式继续使用现有 STS 直传链路。
- 播放接口在本地模式将同一键映射到本地文件并通过 Express 流式响应；COS 模式保留签名 URL。
- Worker 抽象下载/上传操作：本地模式直接复制文件，COS 模式使用现有 SDK。Worker 临时工作目录仍在系统临时目录，任务结束后删除。

## 配置

```env
STORAGE_MODE=local
LOCAL_STORAGE_DIR=/Users/gaoyunhong/Documents/ChatGPT/Evvvv/server/storage
FFMPEG_WORKER=true
```

`COS_*` 为空时不得进入 COS 模式。切换到 COS 时设置 `STORAGE_MODE=cos` 并填写现有四项 COS 变量；不需要迁移数据库中的键格式。

## 验收

1. 本地上传接口在 `uploads/{merchantId}` 生成文件并写入 `media_asset`。
2. 素材播放接口返回本地视频流；不存在或越权时返回现有业务错误。
3. 本地 Worker 能消费 `QUEUED` 任务，在 `renders/{merchantId}` 生成成片并把 `result_key` 写入 `render_task`。
4. `npm run typecheck`、服务端构建和小程序构建通过。
5. 关闭 Worker 或切回 COS 时，不删除用户已有本地文件，也不改变原有 COS 路径规则。
