# 后端服务

大帅餐饮短视频创作工具 · Node.js 20 + TypeScript + Prisma + MySQL 8 + Redis

## 已实现模块

| 模块 | 文件 | 说明 |
|---|---|---|
| AI 协议适配器 | `src/ai/adapters.ts` | OpenAI 兼容（DeepSeek / 通义 / 豆包 / 混元）+ Anthropic 原生（Claude） |
| 熔断器 | `src/ai/circuit-breaker.ts` | Redis 滑动窗口，通道挂掉时直接跳过，不等超时 |
| AI 网关 | `src/ai/gateway.ts` | 场景化调用、故障转移、成本计算、后台通道测试 |
| 计费编排 | `src/ai/ai.service.ts` | 先冻后扣 / 失败全额退 / 幂等 / 标价硬上限 |
| AI豆账务 | `src/bean/bean.service.ts` | FREEZE → CONSUME / UNFREEZE 两阶段，赠豆优先 |
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

## 账务两阶段模型

```
FREEZE(X)   frozen += X                      可用额不变，仅做预留
CONSUME(X)  可用额 -= X（赠豆优先），frozen -= X，totalConsume += X
UNFREEZE(X) frozen -= X                      可用额不变（失败退款）
```

- 幂等：`(request_id, type)` 复合唯一索引，同一 requestId 下 FREEZE / CONSUME / UNFREEZE 各只允许一条
- 原子：`SELECT ... FOR UPDATE` 行锁 + 事务，绝不先读后写
- 顺序：赠豆优先消耗，不足部分用充值豆；赠豆随会员到期清零

## 计费规则

见 `docs/05-计费规则.md`。要点：

- 文案 5 豆 / 分镜 10 豆 / 合成 30 豆 / 仅改调色重合成 10 豆 / 首帧拼图 0 豆
- 标价是硬上限，AI 实际成本超出部分平台承担
- 失败、超时一律全额退豆

## 待实现（后续迭代）

- 认证与短信、门店 / 菜品 / 人设 CRUD
- COS 直传预签名与回执（ffprobe）
- FFmpeg 合成任务队列（BullMQ）+ 中间产物缓存
- 微信支付下单与回调（幂等）、会员履约
- 运营后台接口（`docs/02-接口设计.md` 第 9 节）
- 订阅消息额度管理
