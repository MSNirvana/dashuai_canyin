# 大帅餐饮小程序：QA 验证报告

> 验证角色：Edward / QA 工程师
>
> 验证时间：2026-09-08
>
> 范围：`server`、`apps/mini`、`apps/admin`；本报告仅做独立审计和受控验证，未修改业务源码，未迁移/清理数据库，未访问真实商家、支付、COS、Redis、AI 或生产服务。
>
> 证据等级：**S=静态源码确认**；**C=受控真实函数/Express 入口复现（数据库边界为内存桩，不能证明 MySQL 事务语义）**；**E=外部或真实环境待验收**。

## 1. Summary

- 受控验证：**13 项 / 13 通过 / 0 失败**（第二轮回归）。这些是 characterization tests，用于证明当前实现的行为，不代表产品验收通过。
- 类型检查：`server` **通过**；`apps/mini` **通过**；`apps/admin` **未通过**，原因是本地依赖缺失：`sh: tsc: command not found`。
- package 基线：根、`server`、`apps/mini`、`apps/admin` 均未声明 `test` 脚本；未发现可通过 package `test` 入口执行的现成业务单元/集成套件。依赖包自带测试不计为本项目覆盖。
- 覆盖率：**未采集代码行/分支覆盖率，不提供虚构百分比**。本轮覆盖13组高优先级行为及对照；不是全量 public API 测试。
- 测试轮次：第一轮 13 项中 12 项通过；唯一失败是 QA `auth` 响应桩缺少 `res.locals`，不是业务源码失败。修正测试桩后按硬上限执行第二轮，13/13 通过；未执行第三轮。
- **Routing Decision：Engineer**。源码缺陷已被静态证据和受控复现确认，应交由工程师修复；本轮不发起修改。
- 发布建议：在 ARC-P0-01/03/04/05/07/08/10/11 等问题修复并完成真实隔离库、支付、视频和真机验收前，**不开放真实付费生产流量**。

## 2. Commands and Results

运行时使用托管 Node：

```bash
export PATH="/Users/gaoyunhong/.workbuddy/binaries/node/versions/22.22.2-2/bin:$PATH"
node --version
# v22.22.2
```

只读类型检查：

```bash
npm --prefix server run typecheck       # PASS
npm --prefix apps/mini run typecheck    # PASS
npm --prefix apps/admin run typecheck   # FAIL: sh: tsc: command not found
```

受控验证：

```bash
npm --prefix server exec tsx -- docs/audit-tests/critical-path-reproduction.ts
# SUMMARY total=13 passed=13 failed=0
```

脚本位置：[`critical-path-reproduction.ts`](./audit-tests/critical-path-reproduction.ts)。脚本动态导入业务模块，使用不可连接的占位 `DATABASE_URL`/`REDIS_URL`，并安装 Prisma 查询阻断器；HTTP 仅监听 `127.0.0.1` 临时端口。内存 DB mock 仅用于调用真实导出函数，不用于声称证明锁、提交或回滚。

现有 smoke 脚本安全审查：

- `server/scripts/render-smoke.ts` 会本地启动 `ffmpeg` 生成临时测试视频、执行 FFmpeg/ffprobe，写入并删除临时目录；未连接应用数据库或外部支付，但属于较重的本地媒体验证。本轮未执行，因其不能验证租户、支付和账务问题。
- `server/scripts/e2e-smoke.mjs` 会访问运行中的应用（默认 `http://localhost:3000`），开发登录、创建门店/菜品/创作并调用 AI/合成/账务接口；可能写入数据库，且依赖真实运行服务。本轮跳过，避免清库、真实服务调用和商家数据变更。

## 3. P0 Verification Matrix

| ID | 结论 | 证据和结果 | Routing |
|---|---|---|---|
| ARC-P0-01 refresh 可作 access | **S+C 确认** | `auth` 只验签并读取 `mid`，无 `typ` 检查。真实 `signRefresh(42n)` 经实际 `auth` 进入 handler；`signAccess` 也接受；`signAdmin` 因无 `mid` 被拒绝。 | Engineer |
| ARC-P0-02 默认密钥/开发登录生产闸 | **S；E 待部署验证** | `jwt.ts` 缺密钥使用公开默认值；开发登录主要看 `DEV_LOGIN`，未做完整 `NODE_ENV=production` 硬闸。未尝试账号接管或生产启动。 | Engineer |
| ARC-P0-03 跨租户 dish/asset | **S+C 确认** | `createCreation` 真实调用只查询 `(storeId, merchantId)`，不查询 dish 归属；`updateShotAsset` 保留 creation/shot 条件，但直接写新 `assetId`；真实 `submitRender` 查询资产不带 `merchantId`，将租户B `cosKey` 放入租户A clips。 | Engineer |
| ARC-P0-04 全局 requestId 重放 | **S+C 确认** | `bean.findLedger` 仅 `(requestId,type)`；`runBilledScene` 的 `aiCallLog.findFirst` 仅 `requestId`。受控调用以 merchant B 重用 merchant A 键，返回 A 的 `TENANT_A_PRIVATE_TEXT` 且不调用 gateway；无日志时正确抛 `ScenePendingError`，因此不是所有重复分支都伪成功。 | Engineer |
| ARC-P0-05 双桶消费负余额 | **S+C 确认** | 真实 `freeze`/`consume` 调用，初始充值40、赠送60，冻结/消费80后账户为 `balance=-40, grantBalance=60, frozen=0`。这是源码选择整桶的结果；正确期望应为充值20、赠送0。 | Engineer |
| ARC-P0-06 freeze 唯一键/业务预留 | **S+C 部分；真实 MySQL 待验** | 静态确认查重发生在账户锁前，账户更新后才写流水，P2002 被捕获；`consume`/`unfreeze` 只看账户总 frozen。内存桩不能判断 Prisma/MySQL 事务是否回滚。 | Engineer（并发部分 E） |
| ARC-P0-07 缺支付配置自动发权益 | **S+C 确认** | `NODE_ENV=production` 且 `wxpayEnabled=false` 时，真实 `createBeanOrder` 受控调用自动使用 `DEV...` 交易号、标记 `PAID`，并写充值流水。未触碰真实订单。 | Engineer |
| ARC-P0-08 JSON/raw + snake_case | **S+C 确认** | API v3 AES-GCM 标准 `out_trade_no/transaction_id/trade_state` 解密后仍保留 snake_case；`handleNotify` 读取 camelCase，返回 `SUCCESS` 但不结算。真实 pay router HTTP 对照：`express.json()` 先于 `express.raw()` 时返回500；raw 优先时验证签名并返回200。 | Engineer |
| ARC-P0-09 支付业务验真/终态幂等 | **S；C/E 待验** | 静态确认通知 DTO 不校验 appid/mchid/金额，订单状态更新缺完整 CAS，权益参数按回调时配置读取；已有 `wxTransactionId`/流水唯一约束是局部保护，不能据此断言重复必然入账。并发通知、错金额、续期锁和回调重试需隔离库/支付材料。 | Engineer（并发 E） |
| ARC-P0-10 任务资金终态非原子 | **S+C 部分** | 真实 `submitRender` 受控注入第二事务异常：第一事务已创建 `QUEUED` 任务，第二事务失败，任务未标 `FAILED`，证明建任务与 freeze 分事务。`completeRender` 无终态 CAS；精品交付与 sweeper 的竞争仍需并发实测。 | Engineer |
| ARC-P0-11 AI/TTS/成片承诺 | **S+C 确认** | 真实 `submitRender` clips 遗漏 `Shot.line`，传播外租户素材，并在模拟模式标 SUCCESS、`resultKey` 指向首素材；配置真实 TTS provider 调用真实 `synthesizeNarration` 抛 `not implemented yet`。FFmpeg/COS 实物未执行。 | Engineer |

## 4. P1/P2 Verification Matrix

以下项目已按源码和上游审计复核；没有把整改设计中的建议模型当作已实现保护。

| ID | QA 状态 | 静态结论/待验范围 | Routing |
|---|---|---|---|
| ARC-P1-01 上传元数据/配额 | S；E 待验 | 上传确认接受客户端元数据，配额预占和真实 COS 对象一致性需隔离 COS/DB 验证。 | Engineer |
| ARC-P1-02 worker/AI 租约与崩溃 | S；E 待验 | worker 有 QUEUED 条件抢占，但无完整租约、总超时和崩溃补偿；未启动 worker。 | Engineer |
| ARC-P1-03 赠豆到期/权益快照 | S；E 待验 | 代码有到期清零函数，但未在本轮验证调度、续期并发和购买权益快照。 | Engineer |
| ARC-P1-04 AI 日志与业务完成 | S；C 待验 | AI 日志更新和业务持久化不形成独立完成状态；需注入持久化失败检查扣费、日志和重试。 | Engineer |
| ARC-P1-05 分镜重生成/版本 | S | 非数组/无 `.shots` 时可能清空旧分镜；未验证真实历史素材绑定恢复。 | Engineer |
| ARC-P1-06 小程序余额混用 | S | `setLogin`/`refreshBean` 写充值余额，`refreshMe` 写 `balance.available`；compose 用 `Number(balance)` 做拦截。 | Engineer |
| ARC-P1-07 历史 SUCCESS/精品结果恢复 | S | compose 首次只加载 creation/renders，不为历史成功任务恢复播放 URL；精品提交后不轮询。支付到账确认同样需真实联调。 | Engineer |
| ARC-P1-08 错误契约/裸 async | S+C 确认局部问题 | 全局 `SubscriptionRequiredError` 映射为 403/2005，但 creations 本地 `handleAiErr` 未处理该异常。真实 copy/storyboard HTTP 均返回 500/code 500；实际日志包含该异常。部分 GET 是裸 async handler。 | Engineer |
| ARC-P1-09 配置边界/版本 | S；E 待验 | `getNumber` 只校验 finite，不校验正数、上限、整数；后台配置和多实例缓存一致性需部署验证。 | Engineer |
| ARC-P1-10 后台/精品审计 | S；E 待验 | 精品接单虽有 `MANUAL_PENDING` 条件更新，但交付状态检查在事务外，接单人/对象审计需真实后台验收。 | Engineer |
| ARC-P1-11 注册/门店/短信 | S；E 待验 | 注册赠送和默认门店原子性、短信真实发送与限流未执行。 | Engineer |
| ARC-P1-12 AI 预算闭环 | S；E 待验 | 预算是调用前软检查，月度重置、成本和业务请求闭环未验证。 | Engineer |
| ARC-P2-01 列表/队列索引 | S | 列表读取和队列索引需性能数据验证；本轮不做负载测试。 | Engineer |
| ARC-P2-02 可观测性/健康检查 | S | traceId 未贯穿异步链路，健康检查依赖反映不足；需部署监控验收。 | Engineer |
| ARC-P2-03 契约/迁移治理 | S | 文档、命名和账务语义存在漂移；整改设计仅为建议，尚无迁移验收。 | Engineer |

## 5. Existing Protections

避免误报，以下保护已在源码中确认存在：

- creation 查询和列表按 `merchantId`；store 创建校验 `(storeId, merchantId, deletedAt)`。
- `getCreation` 校验创作租户；`updateShotAsset` 校验 creation 属于商家，并以 `{id: shotId, creationId}` 更新分镜。
- `submitRender` 初始 `requestId` 查重带 `merchantId`；`getRender`/`listRenders` 带商家条件。
- bean 账户有 `INSERT IGNORE`、`SELECT ... FOR UPDATE`；worker 抢占使用 `status='QUEUED'` 条件更新。
- `adjust` 入口有分桶非负校验；不是所有账务入口都无保护。
- 全局错误映射确实处理 `SubscriptionRequiredError → HTTP 403/code 2005`，缺陷是 creations 路由的局部 catch 覆盖该映射。
- admin token 通常因无 `mid` 在商家 `auth` 的 `BigInt(undefined)` 路径被拒绝；问题不是“所有 token 都互相可用”。
- `wxTransactionId` 和部分流水存在数据库唯一约束；不能据先读后写代码直接断言重复支付一定双重入账。

## 6. Coverage Gaps

- 没有测试框架或 `test` script；13 项为一次性审计线束，不是持续回归套件。
- 未使用真实 MySQL 验证：并发 freeze 唯一键、P2002 回滚、业务预留隔离、支付通知并发、精品终态竞争、事务提交/回滚。
- 未连接真实微信支付平台，未验证平台证书轮换、时间窗、金额/商户号、通知响应协议和重试行为。
- 未执行 COS 上传/下载、FFmpeg worker、真实 TTS、字体/字幕、生成文件声轨和视频内容检查。
- 未进行小程序真机/微信开发者工具验收，未验证断网、冷启动、历史结果恢复、下载保存和余额显示体验。
- 未执行生产配置、部署清单、secret manager、Redis 认证和监控告警检查。
- `render-smoke.ts` 仅适合本地媒体链路，不覆盖上述业务安全边界；`e2e-smoke.mjs` 会写应用数据，因此按安全范围跳过。

## 7. Minimal Regression Suite

修复后必须将以下场景加入持续测试，并同时断言 HTTP 响应、DB 状态、账务流水和任务快照：

1. JWT：refresh/admin/access 类型隔离；禁用商家旧 access/refresh、刷新和各登录路径均拒绝。
2. 租户：A 不能绑定 B 的 dish/asset；渲染二次校验；DB 无跨租户关系和 COS key 泄漏。
3. 幂等：唯一键至少包含 merchant、operation、request；同键跨租户/跨创作/跨场景返回参数冲突而非他人快照。
4. 双桶：40 充值+60 赠送冻结80消费80，结果必须充值20、赠送0、冻结0；覆盖0赠送、恰好够、全赠送、并发消费、到期。
5. Freeze/Reservation：同键并发最终一份冻结/一条流水；失败事务不留账户变更；消费/释放不得挪用其他业务预留。
6. 支付：缺配置在 production 拒绝下单且无 PAID/权益；标准 snake_case 通知映射并校验 appid/mchid/金额；重复通知全部幂等成功且仅一笔权益。
7. Render：建任务与 reserve 同一原子边界；worker 不读取无 reserve 任务；成功/失败/超时用终态 CAS；释放失败进入补偿态而不是假称退款。
8. AI 视频：clips 保存 line；真实 TTS/字幕有可检查实物；模拟模式不能用首素材冒充合成结果，或明确关闭付费入口。
9. 前端：余额统一为 available；冷启动恢复历史 SUCCESS 的播放 URL；精品提交后轮询/推送交付；下载保存入口可用。
10. 错误契约：未订阅 copy/storyboard/render 统一返回 403/code 2005；所有 async route 进入统一错误处理中间件。

## 8. Launch Gate

在以下条件全部满足前保持真实付费关闭：

- P0 身份、租户、幂等、双桶账务、支付旁路/回调、任务资金状态和 AI 成片承诺已修复并通过隔离 MySQL 验证。
- production 配置启动自检拒绝默认密钥、开发登录、模拟支付和模拟成片；真实支付材料由 secret manager 管理。
- 微信支付 sandbox/受控商户完成标准通知、重复通知、异常金额/商户号、超时重试和到账核对。
- FFmpeg/COS/TTS 真实链路产出可播放成片；按档位验证音频、字幕、口播和首素材不替代问题。
- 小程序真机完成冷启动、历史结果、余额、会员门槛、失败退款、精品交付和下载验收。
- 完成流水/订单/任务/AI 日志对账和告警，保留可审计证据。

## 9. Final Routing

**Engineer：** ARC-P0-01/03/04/05/07/08/10/11，以及 P0-02、P0-06、P0-09 和 P1/P2 静态缺口均需要工程修复或补充生产防护；本报告不直接改业务源码。

**QA：** 第一轮唯一失败是测试响应桩缺 `res.locals`，已在第二轮修正并通过；没有遗留 QA 测试缺陷。

**NoOne：** server、mini 类型检查和第二轮 13 项受控验证均无测试失败；这不等价于业务上线通过。
