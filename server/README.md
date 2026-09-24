# 后端服务

大帅餐饮短视频创作工具 · Node.js 20 + TypeScript + Prisma + MySQL 8 + Redis

## 已实现模块

| 模块 | 文件 | 说明 |
|---|---|---|
| AI 协议适配器 | `src/ai/adapters.ts` | OpenAI 兼容（DeepSeek / 通义 / 豆包 / 混元）+ Anthropic 原生（Claude） |
| 熔断器 | `src/ai/circuit-breaker.ts` | Redis 滑动窗口，通道挂掉时直接跳过，不等超时 |
| AI 网关 | `src/ai/gateway.ts` | 场景化调用、故障转移、成本计算、后台通道测试 |
| 自动剪辑引擎 | `src/render/auto-edit.ts` + `src/render/worker.ts` | 素材评分、类型识别、EDL 规划、本地 FFmpeg 渲染与成片质检 |
| 计费编排 | `src/ai/ai.service.ts` | 先冻后扣 / 失败全额退 / 幂等 / 标价硬上限 |
| 积分账务 | `src/bean/bean.service.ts` | FREEZE → CONSUME / UNFREEZE 两阶段，赠积分优先 |
| 密钥加解密 | `src/lib/secret.ts` | AES-256-GCM，主密钥走环境变量 |
| 系统配置 | `src/lib/settings.ts` | 带缓存的配置读取 |

## 环境准备

```bash
cp .env.example .env      # 填写 DATABASE_URL / REDIS_URL / APP_MASTER_KEY
npm install
npx prisma migrate dev    # 建表（详见 docs/01-数据库设计.md）
npm run dev
```

**`.env` 必填项**

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | `mysql://user:pass@host:3306/dashuai` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `APP_MASTER_KEY` | **64 位十六进制**，AI 通道密钥的加密主密钥。生成：`openssl rand -hex 32`。**泄露等于所有 API Key 泄露，不要进代码库** |

## ChatCut MCP 配置

AI 成片默认使用本地自动剪辑引擎：素材探测、镜头规划、FFmpeg 渲染和输出质检都在服务器完成，不依赖 ChatCut。通过 `RENDER_ENGINE=CHATCUT` 才会显式启用外部通道；未完成授权时会自动回退本地引擎，不会让用户的 AI 档不可用。

本地引擎的核心实现位于 `src/render/auto-edit.ts` 与 `src/render/worker.ts`，会自动识别菜品、口播、门店环境和混合内容，并把选择结果写入任务快照，便于后台排查。AI 档支持多音色 TTS、自定义配音、独立字幕来源、xfade 转场、节奏控制、静音清理和响度均衡。

原声字幕默认支持腾讯云语音识别。配置 `ASR_PROVIDER=tencent` 和 `TENCENT_ASR_ENABLED=true` 后，可复用已有的 `TENCENT_SMS_SECRET_ID/KEY`（该身份需拥有 ASR 权限），也可通过 `TENCENT_ASR_SECRET_ID/KEY` 使用独立子账号。60 秒内且不超过 3MB 的 WAV 走一句话识别；其余音频临时上传现有 COS 后走录音文件识别，完成后立即删除临时对象。`TENCENT_ASR_ENGINE_MODEL` 默认 `16k_zh_en_2.0`，识别结果自带句级时间轴供单行字幕使用。

腾讯云控制台只开通产品还不够，当前 SecretId 对应的 CAM 用户/角色还需授予语音识别权限（至少覆盖 `asr:SentenceRecognition`、`asr:CreateRecTask`、`asr:DescribeTaskStatus`；可在 CAM 策略中使用腾讯云 ASR 的完整访问策略）。

未启用腾讯云时仍兼容 OpenAI-compatible Whisper：配置 `ASR_API_URL`、`ASR_API_KEY`、`ASR_MODEL` 和 `ASR_LANGUAGE` 即可。两种通道均未配置时会回退到分镜文案，不阻断出片。腾讯云连通性可用 `npm run asr:probe -- /绝对路径/测试音频.wav` 验证，输出不包含任何密钥。

默认 AI 自动剪辑会使用无歌词低音量 BGM，并与原声混音；如需替换为已获授权的曲库文件，在服务端设置 `DEFAULT_BGM_PATH=/绝对路径/track.m4a`。未设置时使用本地确定性和弦床，不依赖 ChatCut 配乐额度。

ChatCut MCP 仍可用于对照实验或特殊风格。启用时服务端读取 `CHATCUT_MCP_URL`、`CHATCUT_MCP_SUBMIT_TOOL` 和 `CHATCUT_MCP_STATUS_TOOL`。工具名必须以授权后的 `tools/list` 实际返回为准，不能根据公开资料猜测。

生产环境建议同时配置 `CHATCUT_OAUTH_TOKEN_URL` 与 `CHATCUT_OAUTH_REFRESH_TOKEN`。服务端会在 access token 进入刷新窗口时自动续期，支持 refresh token 轮换，并使用 Redis 分布式锁 + 进程内 single-flight 防止并发刷新。access token 和 refresh token 只放服务端环境或密钥管理系统，不要写入小程序、日志或 Git。

首次 OAuth 授权和 ChatCut 商业/额度确认仍需在 ChatCut 侧完成；显式启用外部通道时，未配置有效 token 会按失败流程释放冻结积分。未配置 OAuth 刷新端点时仍兼容固定 `CHATCUT_MCP_ACCESS_TOKEN`，可用 `CHATCUT_MCP_ACCESS_TOKEN_EXPIRES_AT` 标记过期时间。

## 账务两阶段模型

```
FREEZE(X)   frozen += X                      可用额不变，仅做预留
CONSUME(X)  可用额 -= X（赠积分优先），frozen -= X，totalConsume += X
UNFREEZE(X) frozen -= X                      可用额不变（失败退款）
```

- 幂等：`(request_id, type)` 复合唯一索引，同一 requestId 下 FREEZE / CONSUME / UNFREEZE 各只允许一条
- 原子：`SELECT ... FOR UPDATE` 行锁 + 事务，绝不先读后写
- 顺序：赠积分优先消耗，不足部分用充值积分；赠积分随会员到期清零

## 计费规则

见 `docs/05-计费规则.md`。要点：

- 文案 5 积分 / 分镜 10 积分 / 合成 30 积分 / 仅改调色重合成 10 积分 / 首帧拼图 0 积分
- 标价是硬上限，AI 实际成本超出部分平台承担
- 失败、超时一律全额退积分

## 待实现（后续迭代）

- 认证与短信、门店 / 菜品 / 人设 CRUD
- COS 直传预签名与回执（ffprobe）
- FFmpeg 合成任务队列（BullMQ）+ 中间产物缓存
- 微信支付下单与回调（幂等）、会员履约
- 运营后台接口（`docs/02-接口设计.md` 第 9 节）
- 订阅消息额度管理
