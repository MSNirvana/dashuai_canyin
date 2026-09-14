# 部署与体验版发布

> 目标：把小程序推到云服务器 + 已备案域名，发一版**体验版**给他人测试，本版要求**能真实合成视频**。
> 适用对象：`apps/mini`（微信小程序）、`server`（Node API + 合成 Worker）、`apps/admin`（运营后台）

---

## 0. 现状体检（部署前必读）

我把代码从入口到渲染链路读完了，有 **1 个硬阻断** 和 **3 个必须在部署时处理的前提**。

### 0.1 硬阻断：`NODE_ENV=production` 会直接拒绝启动

`server/src/lib/config.ts:11-13` 在 `NODE_ENV=production` 时强制校验微信支付七项：

```
WX_PAY_MCH_ID / WX_PAY_API_KEY_V3(必须 32 位) / WX_PAY_SERIAL_NO
WX_PAY_PRIVATE_KEY / WX_APPID / WX_PAY_NOTIFY_URL / WX_PAY_PLATFORM_CERT
```

缺任意一项直接抛 `throw`，进程不启动。而微信支付商户号目前还在申请中。

**处理方式：测试期用 `NODE_ENV=staging`。** 非 `production` 会跳过该校验，其余风险项已单独关掉：

| 风险项 | 取法 | 依据 |
|---|---|---|
| 开发登录旁路 | `DEV_LOGIN=false` | `auth.service.ts:116` 显式判断，非 production 也照样禁用 |
| 演示支付 | `PAYMENT_MODE=test` | `order.service.ts:137/189`，仅非 production 允许演示下单，不碰真实资金 |
| 本地文件存储 | `STORAGE_MODE=cos` | 真机播放地址必须是公网 HTTPS，本地模式签出来的是 `127.0.0.1` |

> ⚠ 这是**测试配置，不是生产配置**。商户号下来后必须改回 `NODE_ENV=production` 并补齐支付七项，否则等于带着可绕过校验的配置对外提供服务。

### 0.2 登录方式：必须走「微信一键登录」

代码里 `POST /auth/sms/send` 的短信通道**没有接入**——`src/auth/sms.ts:87-93` 在没有 `SMS_PROVIDER` 时只把验证码打到服务器日志；一旦配了 `SMS_PROVIDER` 反而直接抛 `SmsProviderNotConfiguredError`。

所以测试者登录只能走这条路：

```
小程序端 openType='getPhoneNumber' + Taro.login()
  → POST /api/v1/auth/wechat-login { phoneCode, wxLoginCode }
  → server/src/auth/wechat.ts: verifyPhoneNumber() 用 wxa/secsvcs/verifysession 换真实手机号
```

**前提：小程序后台已开通「手机号快速验证」能力**（企业主体，按次付费）。没开通的话测试者根本进不去。部署前先去 `mp.weixin.qq.com → 功能 → 手机号快速验证` 确认状态。

备选（不推荐）：临时开 `DEV_LOGIN=true`，登录页会出现「开发登录」按钮，任意手机号直接建号。体验版只有你加的体验成员能扫码打开，风险可控，但等于没有身份校验——**能不用就不用**。

### 0.3 存储必须切 COS，且 COS 域名也要加白名单

真机上 `<video>` / `<image>` 播放的是**私有桶签名 URL**，域名形如
`<bucket>-<appid>.cos.<region>.myqcloud.com`。这个域名不在后台白名单里，体验版一样播不出来。
上传走 `cos-wx-sdk-v5` 直传（`apps/mini/src/services/upload.ts`），同样要加白。

### 0.4 合成 Worker 只起一个进程

`src/index.ts:99-107` 在 `FFMPEG_WORKER=true` 时会**在 API 进程内直接拉起 render worker**。生产校验又强制 `FFMPEG_WORKER=true`，所以再单独起一个 worker 进程属于重复。

单机测试版正确做法就是只跑 API 进程。多开也不会重复处理任务（`src/render/worker.ts:94` 用 `updateMany` 条件更新抢锁），但没必要。

---

## 1. 前置条件核对

| # | 事项 | 状态 |
|---|---|---|
| 1 | 小程序 AppID `wx3004f53da3e30a36`，企业主体已认证 | ✅ 已确认 |
| 2 | 已备案域名 + 云服务器 | ✅ 已确认 |
| 3 | 小程序后台已开通「手机号快速验证」 | ❓ **部署前必须确认** |
| 4 | COS Bucket + 密钥（区region 与 bucket 名） | ❓ 本地 `.env` 已配，需确认可在服务器复用 |
| 5 | 微信支付商户号 | ❌ 申请中，本版不依赖 |
| 6 | 小程序后台「服务器域名」修改权限 | ❓ 需管理员或有「开发设置」权限的成员 |

**域名规划**（一个主域名切两个子域，都要 HTTPS）：

```
api.<你的域名>      → 小程序接口（request / uploadFile）
admin.<你的域名>    → 运营后台静态站 + /admin/api/v1
```

> 后台「服务器域名」**每月可修改次数有限**，一次配全，别反复改。

---

## 2. 服务器初始化（一次性）

以 Ubuntu 22.04 / Debian 12 为例，`root` 或有 sudo 的账号执行：

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# ffmpeg（含 libass，字幕烧录需要）+ 构建工具
apt install -y ffmpeg build-essential git nginx

# Docker + compose 插件
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose-plugin

# PM2
npm i -g pm2

# 验证
node -v && ffmpeg -version | head -1
ffmpeg -hide_banner -filters | grep subtitles   # 有输出才支持字幕烧录
docker compose version
```

**代码落地**：

```bash
mkdir -p /opt/dashuai && cd /opt/dashuai
git clone https://github.com/MSNirvana/dashuai_canyin.git .

cp deploy/env.server.template server/.env
vi server/.env          # 替换所有 REPLACE_*，然后 chmod 600 server/.env
```

**生成两个密钥**：

```bash
openssl rand -hex 32    # → JWT_SECRET
openssl rand -hex 32    # → APP_MASTER_KEY（必须 64 位十六进制）
```

> ⚠ `APP_MASTER_KEY` 换了必须重新 `npm run db:seed`（AI 通道 Key 用它加密），且**不要跟本地开发用同一个**。

**调整 `docker-compose.yml` 的 MySQL 密码**：仓库里写的是 `CHANGE_ME`，服务器上要改强密码，并同步改 `server/.env` 的 `DATABASE_URL`。

---

## 3. 部署后端

```bash
cd /opt/dashuai
bash deploy/deploy.sh
```

脚本会依次：检查依赖 → 起 MySQL/Redis → 装依赖编译 → 建表 → seed → PM2 启动 → 健康检查。

失败时看日志：

```bash
pm2 logs dashuai-api --lines 80
```

正常应看到：

```
[server] listening on :3000 (env=staging)
```

出现下面这些说明 env 没配对：

| 日志 | 原因 |
|---|---|
| `Local storage forbidden in production` | `NODE_ENV=production` 但 `STORAGE_MODE=local` |
| `Missing production payment config: WX_PAY_*` | `NODE_ENV=production` 但支付配置缺失 |
| `Missing production storage config: COS_*` | COS 四项没配齐 |
| `Unsafe production config: DATABASE_URL` | 密码里含 `changeme` / `123456` 等弱口令字样 |

### Nginx + HTTPS

```bash
# 证书（先把域名的 A 记录指到服务器公网 IP，等生效）
apt install -y certbot python3-certbot-nginx
mkdir -p /var/www/certbot

cp deploy/nginx/dashuai-api.conf   /etc/nginx/conf.d/
cp deploy/nginx/dashuai-admin.conf /etc/nginx/conf.d/
sed -i 's/api.REPLACE_DOMAIN/api.<你的域名>/g; s/admin.REPLACE_DOMAIN/admin.<你的域名>/g' \
  /etc/nginx/conf.d/dashuai-*.conf

nginx -t && systemctl reload nginx

certbot --nginx -d api.<你的域名> -d admin.<你的域名>
```

验证：

```bash
curl -sS https://api.<你的域名>/healthz     # 期望 {"code":0,...,"data":{"ok":true,...}}
```

> 微信要求 TLS 1.2+，证书链必须完整。certbot 的 fullchain.pem 已包含中间证书，配置里已指向它，不要改成 cert.pem。

### 运营后台（可选，测试期可跳过）

```bash
cd /opt/dashuai/apps/admin
npm install && npm run build     # 产物 dist/
```

> 已知问题：交接文档记着「`apps/admin` 完整 build」尚未通过。测试期如果只是给他人测小程序，后台可以先不部署，用本地 `npm run dev` 连服务器接口。

---

## 4. 小程序后台配置（关键一步）

登录 `mp.weixin.qq.com` → **开发管理 → 开发设置 → 服务器域名**，按下表填。

填的时候**只填域名，不带 `https://`，不能带端口**。

| 类型 | 填什么 | 为什么 |
|---|---|---|
| request 合法域名 | `api.<你的域名>` | 所有 `/api/v1/*` 接口 |
| uploadFile 合法域名 | `api.<你的域名>`<br>`<bucket>-<appid>.cos.<region>.myqcloud.com` | 前者是兜底上传通道，后者是 `cos-wx-sdk-v5` 直传 COS |
| downloadFile 合法域名 | `<bucket>-<appid>.cos.<region>.myqcloud.com` | 私有桶签名 URL 播放素材/成片 |
| socket 合法域名 | 不填 | 项目没用 WebSocket |

> 如果 COS 绑了 CDN 加速域名，CDN 域名也要一并加入 uploadFile / downloadFile。
> 具体 COS 域名从 `server/.env` 的 `COS_BUCKET` / `COS_REGION` 拼出来，或到 COS 控制台看「访问域名」。

**同时确认**：`开发管理 → 开发设置 → 小程序代码上传密钥` 是按需的（用 CLI 上传才需要）；用 IDE 手动上传只要有开发者权限即可。

---

## 5. 出包 → 上传 → 设体验版

### 本地出包

```bash
bash scripts/build-weapp-prod.sh https://api.<你的域名>/api/v1
```

脚本会校验必须是 HTTPS、且不带端口（这两条错了真机直接 `request:fail`）。
**不要**直接改 `apps/mini/.env`——那是本地联调地址，改了会污染日常开发。

### 上传

1. 微信开发者工具打开 `apps/mini` 目录（`miniprogramRoot` 已经是 `dist/weapp/`）
2. 右上角「上传」→ 填版本号（如 `0.1.0`）和备注
3. 上传后到 `mp.weixin.qq.com → 版本管理 → 开发版本`，找到刚上传的版本 → 点「选为体验版本」

### 加体验成员 + 发码

`管理 → 成员管理 → 体验成员` 添加测试者的微信号（需对方已关注/绑定微信）。
然后 `版本管理 → 体验版本 → 二维码` 生成体验二维码发出去。

> 体验成员有数量上限（后台会显示当前名额），先核对够不够你要测的人数。
> 体验版**不需要审核**、搜不到，只有体验成员能扫码打开——适合当前阶段。

---

## 6. 真机验收清单

对方扫码打开后，按顺序走一遍。**这份清单对应"能真实合成视频"的目标**：

- [ ] 打开小程序，登录页出现「微信一键登录」按钮（如果只看到手机号+验证码，说明「手机号快速验证」没开通）
- [ ] 一键登录成功，进入首页
- [ ] 新建/编辑门店，城市区县下拉能选
- [ ] 新建菜品，**上传图片和视频成功**（这一步验证 COS 直传 + uploadFile 白名单）
- [ ] 首页/门店页能看到刚上传的图片和视频（这一步验证 downloadFile 白名单 + 签名 URL）
- [ ] 进入创作，AI 生成口播文案（**验证 AI 通道 + 扣豆**）
- [ ] AI 生成分镜脚本（同上）
- [ ] 按槽位上传素材
- [ ] 提交合成 → 进度推进 → **产出可播放的成片**
- [ ] 成片导出/保存到相册
- [ ] 充值页能看到档位（演示支付能走通，但不产生真实资金）
- [ ] 会员页能看到套餐

**排查真机报错的方法**：体验者在小程序内点右上角 `⋯ → 打开调试`，然后回微信开发者工具看 Console，能看到真机日志。

---

## 7. 已知阻断与未验证项

来自 `docs/本地交接说明.md`，部署解决不了，属于代码本身待补：

**阻断当前场景的**

- 微信支付商户号申请中 → 无法真实充值/开会员，也无法切 `NODE_ENV=production`
- 短信通道未接入 → 只能用微信一键登录

**不阻断本次测试，但会影响体验**

- `Bean Reservation`（账务预留）与 freeze/consume/unfreeze 并发原子性未验证 → 高并发下可能重复扣豆/漏退
- `RenderTask` 状态机与 Worker 崩溃恢复：已有 stuck sweeper 兜底（默认 30 分钟超时退款），但租约机制未做
- `Shot.line` → TTS → 字幕 → 成片的完整链路、TTS 供应商真实联调未验收
- `apps/admin` 完整 build 未通过

**结论**：这一版可以给他人测**界面 + 流程 + 单条真实合成**，但**不要**对外当成品宣传，也**不要**放进真实付费流量。

---

## 8. 文件说明

| 文件 | 用途 |
|---|---|
| `deploy/env.server.template` | 服务器 `server/.env` 模板，含每项的取法说明 |
| `deploy/deploy.sh` | 服务器端一键部署（幂等，可反复跑） |
| `deploy/ecosystem.config.cjs` | PM2 进程配置（含「为什么只起一个进程」的说明） |
| `deploy/nginx/dashuai-api.conf` | API 域名站点（HTTPS + 支付回调 body 直通） |
| `deploy/nginx/dashuai-admin.conf` | 后台域名站点（静态站 + `/admin/api/v1` 反代） |
| `scripts/build-weapp-prod.sh` | 用正式域名给小程序出包（带 HTTPS/端口校验） |
