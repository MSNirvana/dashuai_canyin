# 整改后独立验收契约

> 状态：准备阶段。服务端和前端仍在修改；本文件只定义验收断言和受控测试边界，不代表当前源码已通过。
>
> 限制：测试只能调用真实导出函数或真实 Express 路由，外部边界使用隔离内存桩/假 HTTP；不连接真实 MySQL、Redis、微信支付、COS、TTS、FFmpeg 或商家数据。不修改业务源码、原 `critical-path-reproduction.ts`、package/schema 文件。

## 运行入口

待工程提交稳定后新增可执行脚本：

```text
docs/audit-tests/post-fix-acceptance.ts
```

推荐命令：

```bash
export PATH="/Users/gaoyunhong/.workbuddy/binaries/node/versions/22.22.2-2/bin:$PATH"
npm --prefix server exec tsx -- docs/audit-tests/post-fix-acceptance.ts
```

脚本应在模块加载前设置隔离环境变量，并阻断任何真实数据库/Redis连接；HTTP 只监听 `127.0.0.1` 临时端口。每项使用 Arrange-Act-Assert，输出总数、通过数、失败数和明确的 Known Issues。

## 验收断言矩阵

### A. 身份和生产配置

1. `signRefresh(42n)` 经业务 `auth` 必须返回 401/拒绝，不得调用 `next`；合法 access token 可以继续调用，admin token 不能进入商家路由。
2. access、refresh、admin 必须具备不可互换的 `typ`/用途校验；伪造缺失类型、错误类型、错误 issuer/audience 的 token 均拒绝。
3. `NODE_ENV=production` 缺失支付凭据时，启动配置校验或下单必须失败；不得创建 `PAID` 订单，不得写 `DEV...` 交易号，不得发充值/会员权益。
4. 生产环境不得因为 `DEV_LOGIN=true` 或默认 JWT secret 开放开发登录；测试只验证拒绝，不尝试真实账号接管。

### B. 租户和资源关系

1. 商家 A 创建属于 A 门店的创作并提交属于 B 的 `dishId`，必须返回明确的 403/404 业务错误，且不写入 creation。
2. A 更新自己的 shot 绑定 B 的 `assetId`，必须拒绝，且 `shot.assetId` 不变。
3. 即使绕过写入校验构造异常历史关系，`submitRender` 仍须二次验证资产的 merchant/store 归属，不能把 B 的 `cosKey` 放入 A 的 `paramsJson.clips`。
4. 允许的跨门店复用必须有显式授权契约；没有授权不能仅凭可猜 ID 读取或合成。

### C. 幂等和重放隔离

1. 同一商家、同一操作、同一业务资源、同一 `requestId` 且 payload 相同：返回首次结果，不能重复冻结/扣费。
2. 同一商家同一 `requestId` 但 scene、bizId、creation 或 payload hash 不同：返回参数冲突（建议 409），不能返回旧快照，也不能执行第二次业务操作。
3. 不同商家即使使用同一 `requestId`：必须独立处理；B 不能读到 A 的 AI 文本、流水或任务结果。
4. `FREEZE`、`CONSUME`、`UNFREEZE`、AI 日志和业务请求的幂等作用域必须彼此明确；重复成功/失败回调不能产生双扣或重复退款。
5. 无完成日志的重复 AI 请求必须返回 pending/conflict，不得返回空文本伪成功；失败后按设计允许的新 requestId 重试。

### D. 双桶账务、不变量和跨期冻结

1. 初始充值 40、赠送 60；冻结 80 后消费 80，正确结果必须为：充值余额 20、赠送余额 0、冻结 0、可用 20。
2. 覆盖边界：仅充值、仅赠送、赠送恰好足额、赠送不足、amount=0、负 amount、总可用不足；任何成功路径不得使充值或赠送余额为负。
3. 消费流水必须记录双桶实际分摊（或可审计的等价明细），不能以单一 bucket 掩盖“赠送60+充值20”的结算。
4. 赠送到期与冻结交叉：赠送余额被任务冻结后到期清零不得抹掉仍有效的预留；消费/释放必须只影响对应 reservation，不得挪用其他任务冻结。
5. 重复成功、失败重试和超时退款各执行多次，最终只能有一份 consume 或 unfreeze；账务快照、流水和任务状态一致。
6. 所有断言同时检查 `available = recharge + grant - frozen`，以及充值/赠送/冻结非负不变量。

### E. 支付回调协议

1. Express 挂载顺序必须保留原始 JSON bytes；带空格和换行的受控签名通知经真实 pay router 验签成功。
2. API v3 AES-GCM 解密后必须显式把标准 `out_trade_no`、`transaction_id`、`trade_state` 映射为内部 `outTradeNo`、`transactionId`、`tradeState`；`trade_state=SUCCESS` 才能进入结算。
3. 回调必须校验订单对应的 merchant/appid/mchid、金额、币种和支付交易号；错订单、错金额、错商户和过期签名不得入账。
4. PENDING → PAID 必须是合法状态 CAS；重复 SUCCESS 回调返回支付方要求的成功语义，但只发一份权益。
5. 下单时保存的价格、赠送积分和订阅天数快照优先于回调时可变配置。
6. 一般 API 信封不能未经验证地替代微信支付通知响应协议；需在受控 HTTP 契约测试中核对状态码和响应字段。

### F. 渲染资金状态机

1. 建任务和创建 reservation/freeze 必须在同一原子边界；freeze 失败、事务异常或进程中断不能留下可执行 `QUEUED` 任务、孤立冻结或无流水状态。
2. worker 只能领取带有效 reservation 且状态为 `QUEUED` 的任务；重复领取必须只有一个成功。
3. 成功、失败、超时、人工交付和人工失败都必须使用终态 CAS/版本检查；已 `SUCCESS` 的任务不能被 sweeper 改成 `FAILED`，已退款任务不能再次 consume。
4. 释放失败不得伪装成已退款；应进入可补偿状态并保留待处理证据。
5. 跨任务并发下，任务 A 的 consume/unfreeze 不能改变任务 B 的 reservation 或冻结额。
6. `paramsJson.clips` 必须保留每个 `Shot.line`、顺序、trim 和归属校验后的素材信息；精品素材清单同样保留口播。
7. AI 档配置可用时必须产出真实 TTS/字幕可检查实物；若功能仍未实现，生产必须拒绝该档位或明确降级并执行产品定义的退款/降价规则。
8. 模拟模式不得把首个上传素材伪装为合成结果；生产不得开放模拟支付/模拟成片。

### G. 前端余额和结果恢复

1. `balance` 的唯一语义为 API `balance.available`；登录、刷新账户、刷新个人信息和渲染预估均不得混用充值余额。
2. 展示必须同时明确 available、充值桶、赠送桶、冻结额；渲染拦截使用同一 available 数值。
3. 冷启动加载历史 `SUCCESS` 任务后，必须恢复其播放 URL；精品任务交付后也必须刷新/轮询到结果，不得只显示成功状态。
4. 失败、超时和退款后刷新余额必须反映释放结果；重复刷新不能回退到旧桶值。
5. 未订阅文案/分镜接口必须呈现 HTTP 403、业务码 2005；不能被局部 route catch 改写为 500/500。

## 受控适配契约

脚本实现时可使用以下隔离替身，但每个替身必须只模拟边界，不复制被测算法：

- 账务：提供真实 `freeze/consume/unfreeze` 的 Prisma 方法接口，记录更新、流水和 reservation；不能直接预先计算期望值。
- HTTP：调用真实 router，原始 body 使用固定 bytes；支付签名和 AES-GCM 密文在测试中生成，私钥/API v3 key 仅为一次性测试值。
- AI：调用真实 `runBilledScene`，gateway 为不访问网络的 stub；日志和流水由内存 Prisma 记录。
- Render：调用真实 `submitRender/completeRender`；创建任务、reservation、终态更新均记录调用顺序，以断言异常后的状态清理。
- 前端：若没有可安全导入的页面测试运行器，先用纯函数/API 状态转换契约验证 balance 字段；真机结果仍标 E，不以 mock 代替。

## 不得误报为已验收

以下只能在授权的隔离环境完成后下结论：

- MySQL `SELECT ... FOR UPDATE`、唯一键冲突、真实事务提交/回滚和并发终态竞争。
- 微信支付平台验签材料、通知重试、退款/查单和真实响应协议。
- COS 对象归属、下载权限、FFmpeg 产物、声波/字幕/字体和 TTS vendor 实际服务。
- 小程序冷启动、微信真机播放/下载、网络失败和支付 UI。

## 输出和路由

验收脚本完成后报告必须逐项给出 `PASS`、`FAIL` 或 `ENVIRONMENT_BLOCKED`，附源码函数/路由、期望/实际和证据等级：

- 业务实现偏离上述正确断言：`Engineer`。
- 断言、fixture 或测试适配器错误：`QA` 修正，最多两轮。
- 全部可执行断言通过且无环境阻断：`NoOne`；环境阻断不能伪报 NoOne。
