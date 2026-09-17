# 部署与体验版发布

> 目标：把小程序推到云服务器 + 已备案域名，发一版**体验版**给他人测试，本版要求**能真实合成视频**。
> 适用对象：`apps/mini`（微信小程序）、`server`（Node API + 合成 Worker）、`apps/admin`（运营后台）

---

## 0. 现状体检（部署前必读）

我把代码从入口到渲染链路读完了，有 **1 个硬阻断** 和 **3 个必须在部署时处理的前提**。

### 0.1 原硬阻断已解除：现在可以直接用 `NODE_ENV=production`

**（2026-09-14 更新）** 原先 `server/src/lib/config.ts` 在 `NODE_ENV=production` 时强制校验微信支付七项，缺一项直接拒绝启动，而商户号还在申请中 —— 当时只能退而用 `NODE_ENV=staging` 绕过。

但 `NODE_ENV` 是**全部** fail-closed 校验的唯一开关。用 `staging` 等于把这些守卫一起关掉：

| 守卫 | `NODE_ENV=production` | 用 `staging` 时 |
|---|---|---|
| JWT_SECRET 强度/占位符 | 强制 | **跳过** |
| APP_MASTER_KEY 64 hex | 强制 | **跳过** |
| CORS_ORIGIN 不得为 `*` | 强制 | **跳过** |
| DEV_LOGIN 必须 false | 强制 | **跳过** |
| MOCK_AI 必须 false | 强制 | **跳过** |
| FFMPEG_WORKER 必须 true | 强制 | **跳过** |
| STORAGE_MODE 不得为 local | 强制 | **跳过** |
| COS_* 四件套 | 强制 | **跳过** |
| 微信支付七项 | 强制 | 跳过（当时想要的效果） |

**现在已把「支付」这一件事单独解耦出来**，新增显式开关 `PAYMENTS_ENABLED`：

```bash
NODE_ENV=production
PAYMENTS_ENABLED=false     # 商户号申请期间：跳过支付七项校验，服务器正常启动，真实下单被拒（业务码 3008）
```

于是可以放心用 `production`，**其余八个守卫全部正常生效**，只有支付这一项被显式关闭。

| 风险项 | 取法 | 依据 |
|---|---|---|
| 开发登录旁路 | `DEV_LOGIN=false` | `auth.service.ts:116`，production 下强制禁用 |
| 真实支付 | `PAYMENTS_ENABLED=false` | `lib/config.ts` + `order.service.ts:resolvePayMode()`，production 下下单一律拒绝 |
| 演示支付（自动置 PAID） | 生产下**不可达** | `resolvePayMode()` 硬性要求 `NODE_ENV !== 'production'`，这是刻意的 |
| 本地文件存储 | `STORAGE_MODE=cos` | 真机播放地址必须是公网 HTTPS，本地模式签出来的是 `127.0.0.1` |

> ⚠ 两种取值都不要忘：`PAYMENTS_ENABLED` **不设置等于开启**（fail-closed，生产忘配支付凭据会拒绝启动）。
> 商户号下来后，把 `PAYMENTS_ENABLED` 改成 `true`（或删掉该行）并补齐支付七项即可，不需要再动 `NODE_ENV`。

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

**顺带配一条「碎片过期自动删除」生命周期规则**（COS 控制台 → 生命周期）。
上传中途失败会留下**未完成的分片上传**，这些分片**不是对象**，对象列表看不到，但照样占存储计费。
配规则让它自动过期最省事；手动通道：`npx tsx scripts/gc-orphan-objects.ts --abort-fragments`。

### 0.4 合成 Worker 只起一个进程

`src/index.ts:99-107` 在 `FFMPEG_WORKER=true` 时会**在 API 进程内直接拉起 render worker**。生产校验又强制 `FFMPEG_WORKER=true`，所以再单独起一个 worker 进程属于重复。

单机测试版正确做法就是只跑 API 进程。多开也不会重复处理任务（`src/render/worker.ts:94` 用 `updateMany` 条件更新抢锁），但没必要。

---

## 1. 前置条件核对

（2026-09-15 更新：服务器与域名信息已到手，下表按**实测**结果填写）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 小程序 AppID `wx3004f53da3e30a36`，企业主体已认证 | ✅ 已确认 |
| 2 | 已备案域名 `dspcz.top` + 云服务器 `49.232.243.241` | ✅ 已确认 |
| 3 | 服务器系统环境（node/pm2/nginx/docker/ffmpeg/中文字体） | ✅ **已初始化完成**，见 2.1 |
| 4 | 域名解析：`dspcz.top` / `www` / `admin` 子域 | ✅ 已解析到 49.232.243.241 |
| 5 | 域名解析：`api.dspcz.top` | ❌ **无 A 记录，上线前必须补** |
| 6 | 腾讯云安全组放行 80 / 443 | ❌ **未放行**（实测外部探测 filtered） |
| 7 | 小程序后台已开通「手机号快速验证」 | ❓ **需你登录后台确认** |
| 8 | COS Bucket `dashuai-1485028436` / `ap-beijing` + 密钥 | ✅ 两套候选密钥**实测均可访问**该桶 |
| 9 | 小程序 AppSecret（`WX_SECRET`） | ❌ **缺失**，微信一键登录必需 |
| 10 | 微信支付商户号 | ❌ 申请中，本版不依赖（`PAYMENTS_ENABLED=false`） |
| 11 | 小程序后台「服务器域名」修改权限 | ❓ 需管理员或有「开发设置」权限的成员 |
| 12 | 代码已提交并推送 | ❌ **硬阻断**，见第 7 节 |

**域名规划**（一个主域名切两个子域，都要 HTTPS）：

```
api.dspcz.top      → 小程序接口（request / uploadFile）
admin.dspcz.top    → 运营后台静态站 + /admin/api/v1
```

> 后台「服务器域名」**每月可修改次数有限**，一次配全，别反复改。

---

## 2. 服务器初始化（一次性）

> **本机已完成。** 2026-09-15 在 `ubuntu@49.232.243.241`（Ubuntu 26.04 LTS，内核 7.0，4 核 / 15G / 177G）
> 上跑完了一次初始化，结果见下方「2.1 实测记录」。若换新机器，按本节的命令重跑即可。
> 一键脚本（幂等，可反复执行）：`bash deploy/deploy.sh` 只覆盖部署，**不覆盖系统层安装** ——
> 系统层用本节命令。

### 2.1 实测记录（Ubuntu 26.04 / 腾讯云，2026-09-15）

官方文档给的步骤（NodeSource + get.docker.com）在**国内腾讯云 + Ubuntu 26.04** 这套组合上有四处对不上，
下面全部是实测结论，照抄官方命令会在不同环节卡住：

| # | 官方写法 | 实测结果 | 正确做法 |
|---|---|---|---|
| 1 | `curl -fsSL https://deb.nodesource.com/setup_20.x \| bash -` | Ubuntu 26.04 代号 `resolute`，NodeSource 未必有对应源；而**apt 自带 nodejs 22.22.1**，已满足 `deploy.sh` 的 `>=20` 要求 | 直接 `apt install -y nodejs npm`，**不需要 NodeSource** |
| 2 | `apt install -y ffmpeg` | ✅ 装得上（8.0.1），且**编译了 `--enable-libass`**，`subtitles`/`ass` 滤镜都在 | 保持，但**必须另装中文字体**（见第 3 行） |
| 3 | （文档未提字体） | ❌ 系统 **0 个 CJK 字体**。`synthesis.ts:detectCjkFont()` 找不到字体就**静默降级为仅配音、不烧字幕** | `apt install -y fonts-noto-cjk` + `fc-cache -f` |
| 4 | `curl -fsSL https://get.docker.com \| sh` + `docker-compose-plugin` | `get.docker.com` 走的 registry 直连超时；且 Ubuntu 26.04 的 compose 插件包名是 **`docker-compose-v2`**，没有 `docker-compose-plugin` | `apt install -y docker.io docker-compose-v2` |

**国内网络的两个硬坑**（都会让部署中途失败，且报错不直观）：

```bash
# 坑 1：Docker Hub 直连不通（实测 registry-1.docker.io 10s 超时，HTTP 000）
#       不配镜像加速，docker compose up 拉 mysql:8.0 会一直卡住
#       实测 mirror.ccs.tencentyun.com 可用：HTTP 200 / 0.03s
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "registry-mirrors": ["https://mirror.ccs.tencentyun.com"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" }
}
JSON
sudo systemctl restart docker

# 坑 2：腾讯云镜像预置的 ~/.npmrc 指向 mirrors.tencentyun.com/npm，实测该地址根路径 404，
#       npm install 会整体失败。改成可用的源。
npm config set registry https://registry.npmmirror.com     # 实测 200 / 0.13s
```

**权限**：`/opt` 属 `root`，`ubuntu` 用户不能直接写，`git clone` 到 `/opt/dashuai` 会 permission denied：

```bash
sudo mkdir -p /opt/dashuai /var/log/dashuai /var/www/certbot
sudo chown -R ubuntu:ubuntu /opt/dashuai /var/log/dashuai
# docker 组也在这一步加，注意要重新登录 SSH 才生效
sudo usermod -aG docker ubuntu
```

**完整初始化命令（Ubuntu 26.04 / 国内云，可直接复制）**：

```bash
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq

# Node 22（apt 自带，满足 >=20）+ ffmpeg + nginx + 构建工具 + compose 插件
sudo apt-get install -y nodejs npm ffmpeg build-essential git nginx docker.io docker-compose-v2

# ★ 中文字体：不装则字幕静默降级（这是最容易漏的一步）
sudo apt-get install -y fonts-noto-cjk && sudo fc-cache -f

sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu
sudo mkdir -p /opt/dashuai /var/log/dashuai /var/www/certbot
sudo chown -R ubuntu:ubuntu /opt/dashuai /var/log/dashuai

# Docker 镜像加速 + npm 源（见上面两个坑）
# ... daemon.json 与 npm config set registry ...

# PM2
sudo npm i -g pm2

# 验证
node -v && npm -v && pm2 -v
docker --version && docker compose version
ffmpeg -version | head -1
ffmpeg -hide_banner -filters | grep subtitles        # 期望看到 subtitles 与 ass 两行
fc-list | grep -ci CJK                                # 期望 > 0（fonts-noto-cjk 装了是 30）
```

> ⚠ **别用 `ffmpeg -filters | grep -q ...` 做判定**。`grep -q` 一匹配就关闭管道，
> `ffmpeg` 收到 SIGPIPE 异常终止（exit 141），在 `set -o pipefail` 下会被判为失败 ——
> **明明有滤镜也报「不可用」**。`deploy/deploy.sh` 早先就有这个写法，2026-09-15 已修成
> 先收变量再 `case` 匹配。要手测请用 `grep -c`（本机返回 2）。

### 2.2 代码落地

```bash
mkdir -p /opt/dashuai && cd /opt/dashuai
git clone https://github.com/MSNirvana/dashuai_canyin.git .

cp deploy/env.server.template server/.env
vi server/.env          # 替换所有 REPLACE_*，然后 chmod 600 server/.env
```

> 实测 `git ls-remote` 在腾讯云上 45s 内可完成 —— git 协议**能通，只是慢**，
> 别因为 `curl https://github.com` 超时就判定拉不动代码。

**生成两个密钥**：

```bash
openssl rand -hex 32    # → JWT_SECRET
openssl rand -hex 32    # → APP_MASTER_KEY（必须 64 位十六进制）
```

> ⚠ `APP_MASTER_KEY` 换了必须重新 `npm run db:seed`（AI 通道 Key 用它加密），且**不要跟本地开发用同一个**。

**调整 `docker-compose.yml` 的 MySQL 密码**：仓库里写的是 `CHANGE_ME`，服务器上要改强密码，并同步改 `server/.env` 的 `DATABASE_URL`。

> 注意 `ValidateProductionConfig` 会拒绝含 `changeme` / `123456` / `please-change` / `dev-insecure` 的
> 值（`lib/config.ts`，大小写不敏感）。`CHANGE_ME` **不含** `changeme` 这个连续子串（有下划线），
> 所以严格说能过校验 —— 但既然公网可达，别赌这个，直接换强密码。
>
> **2026-09-15 起 `docker-compose.yml` 已默认只绑回环**（`"127.0.0.1:3306:3306"` / `"127.0.0.1:6379:6379"`）。
> 用这两个端口的都是**同机进程**（后端 API、本机 mysql/redis CLI），所以这个默认值
> 对**本地开发和服务器都成立** —— 也正因如此，这个基础文件才能两边共用。
>
> 背景：以前它绑的是 `0.0.0.0`。实测腾讯云安全组默认**未放行**这两个端口（外部探测 filtered），
> 所以不构成实际暴露 —— 但别依赖这个，绑回环是零成本的。

**⚠ 覆盖端口必须用 `!override` 标签**（2026-09-15 实测踩到，部署因此中断）

不要在 `docker-compose.override.yml` 里直接写这样：

```yaml
services:
  redis:
    ports:
      - "127.0.0.1:6379:6379"      # ❌ 错误
```

compose 对 `ports` 是**列表追加**语义，不是覆盖 —— 上面会跟主文件的映射
**叠加成两条**，启动时报：

```
Error response from daemon: failed to set up container networking:
failed to bind host port 127.0.0.1:6379/tcp: address already in use
```

而 `docker compose config` 会把两条都列出来（可用来诊断）。正确写法是用 `!override` 整段替换：

```yaml
services:
  mysql:
    environment:
      MYSQL_PASSWORD: <强口令>        # environment 是 map 语义，同名 key 直接覆盖，无需 !override
    ports: !override
      - "127.0.0.1:3306:3306"
  redis:
    ports: !override
      - "127.0.0.1:6379:6379"
```

（主文件现在**已默认绑回环**，所以服务器那份 override 里的端口块其实可以省掉了；
但 `!override` 这个用法要记住 —— 哪天需要把端口改回 `0.0.0.0`（比如别的机器要连），
直接写就会踩上面那个 `address already in use`。）

（仓库根目录没有这个 override 文件，服务器上单独放一份即可 —— 它不在 git 里，
所以生产口令不会被提交。注意 `deploy/deploy.sh` 是在 `/opt/dashuai` 下执行
`docker compose up`，compose 会自动读取同目录的 `docker-compose.override.yml`。
**根目录的 `.gitignore` 已显式忽略 `docker-compose.override.yml`** —— 本地那份override
里钉的是本机卷名，一旦被提交并部署到服务器，服务器会去找一个不存在的卷而直接失败。）

---

## 2.1 ⚠ 本地开发：项目名 = 目录名 ⇒ 换目录执行会挂到「空卷」

（2026-09-15 实测踩到，排查了很久）

`docker compose` 默认用**执行时所在目录名**当项目名，卷名则是 `<项目名>_<卷键>`。
这套 MySQL/Redis 最早是在 `/Users/gaoyunhong/WorkBuddy/2026-09-07-17-56-03/` 里
第一次 `up -d` 的，所以本机实际的卷名是：

| 项目名 | 卷名 |
|---|---|
| `2026-09-07-17-56-03` | `2026-09-07-17-56-03_dashuai_mysql` / `..._dashuai_redis` |

仓库后来搬到了别的目录。**此时在仓库根直接 `docker compose up -d`，compose 会把它当成
一个全新项目，挂两个全新的空卷** —— 现象就是「本地数据全丢了」
（旧数据其实还在上面那两个卷里，只是没被挂上）。**这件事真实发生过。**

已实现的结论：

- **`docker-compose.yml`（提交进 git）保持可移植** —— 它同时给本地和服务器 `/opt/dashuai` 用，
  所以只放两边都成立的东西。**任何"只对某台机器成立"的配置都不要写进它。**
- **本地专属的「项目名 + 卷名」钉子放在 `docker-compose.override.yml`**，
  这个文件**已被 `.gitignore` 忽略**（见根目录 `.gitignore`），不会提交、也不会被部署到服务器。
  内容很短：

  - 顶层 `name: 2026-09-07-17-56-03`（钉死项目名，消除"随目录名漂移"）
  - 两个卷声明 `external: true` + `name: 2026-09-07-17-56-03_dashuai_{mysql,redis}`

  用 `external` 的额外好处：`down -v` **删不掉**它（误删本地数据的路被堵死），
  而且卷若真丢了，`up -d` 会**直接报错**，而不是悄悄给你建一个空库。

- 换目录/改配置后，先用 `docker compose config` 确认「当下解析到哪个项目名、哪个卷名」。
- 确实要清空本地数据，只能手动：
  `docker volume rm 2026-09-07-17-56-03_dashuai_mysql 2026-09-07-17-56-03_dashuai_redis`
- 旧副本目录 `/Users/gaoyunhong/WorkBuddy/2026-09-07-17-56-03/` 里的两份 compose 文件
  已同步成一致，所以从哪个目录执行都会落到同一个项目 + 同一批卷。

> 顺带一提：`docker-compose.yml` 里 MySQL 的 healthcheck 用的是 `-pdashuai`，
> 而 `MYSQL_PASSWORD` 是 `CHANGE_ME` —— 也就是这个 healthcheck 其实一直在"假通过"
> （`mysqladmin ping` 认证失败也返回存活）。不影响使用，但别把它当真实健康判据。




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
[server] listening on :3000 (env=production)
[config] PAYMENTS_ENABLED=false —— 跳过微信支付凭据校验；所有真实支付下单将被拒绝。仅用于商户号申请期间的灰度关闭。
```

（第二行是预期输出，不是错误；商户号下来后把 `PAYMENTS_ENABLED` 改为 `true` 即不再打印。）

出现下面这些说明 env 没配对：

| 日志 | 原因 |
|---|---|
| `Local storage forbidden in production` | `NODE_ENV=production` 但 `STORAGE_MODE=local` |
| `Missing production payment config: WX_PAY_*` | `NODE_ENV=production` 但支付配置缺失 |
| `Missing production storage config: COS_*` | COS 四项没配齐 |
| `Unsafe production config: DATABASE_URL` | 密码里含 `changeme` / `123456` 等弱口令字样 |

### Nginx + HTTPS

> ⚠ **先放行安全组**。实测腾讯云默认只开了 22，**80 / 443 都处于 closed/filtered**。
> 不放行的话 nginx 起得来但外网访问不到，`certbot --nginx` 的 http-01 校验也必然失败。
> 到「控制台 → 轻量应用服务器/CVM → 防火墙（安全组）」放行 TCP 80、443。

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

**本项目实际域名**（`dspcz.top`，2026-09-15 实测解析状态）：

| 域名 | A 记录 | 用途 |
|---|---|---|
| `dspcz.top` | ✅ → 49.232.243.241 | 主域名 |
| `www.dspcz.top` | ✅ → 49.232.243.241 | 未使用 |
| `admin.dspcz.top` | ✅ → 49.232.243.241 | 运营后台 + `/admin/api/v1` |
| `api.dspcz.top` | ❌ **无记录** | 小程序 request / uploadFile —— **上线前必须补** |

> `api` 子域是硬依赖：`deploy/nginx/dashuai-api.conf` 的 `server_name`、`env.server.template` 里
> `CORS_ORIGIN` 与 `WX_PAY_NOTIFY_URL`、以及小程序出包的 `TARO_APP_API_BASE_URL` 都指向它，
> certbot 也要能解析到该域名才能签证书。

验证：

```bash
curl -sS https://api.<你的域名>/healthz     # 期望 {"code":0,...,"data":{"ok":true,...}}
```

> 微信要求 TLS 1.2+，证书链必须完整。certbot 的 fullchain.pem 已包含中间证书，配置里已指向它，不要改成 cert.pem。

### 运营后台

```bash
cd /opt/dashuai/apps/admin
npm install && npm run build     # 产物 dist/
```

> ⚠ **`deploy/deploy.sh` 不会构建后台前端** —— 它只装 `server` 的依赖并编译后端。
> 而 `nginx/dashuai-admin.conf` 的 `root` 指向 `/opt/dashuai/apps/admin/dist`，
> 不手动跑上面两条命令的话，后台域名会 403/404。测试期若只给他人测小程序，
> 后台可以先不部署，本地 `npm run dev` 连服务器接口即可。

> 2026-09-14 实测：`vite build` **可以通过**（2263 模块，8.21s，产物 `dist/`，gzip 后 249KB）。
> 交接文档里「`apps/admin` 完整 build 未通过」的记录已过时。
> 构建时有「单个 chunk > 500KB」的告警（`index-*.js` 约 810KB），属性能提示不属错误，内部后台可接受。
> 测试期如果只是给他人测小程序，后台仍可先不部署，用本地 `npm run dev` 连服务器接口。

### ★ 增量更新：改了服务端代码之后必须做什么

**PM2 跑的是 `dist/index.js`，不是 `src/`**（`deploy/ecosystem.config.cjs:22`）。
所以「改代码 → `pm2 restart`」**不够** —— 重启只是重新加载**旧的**编译产物，
表现为「代码明明改了、服务器行为没变」，极难排查（本项目 2026-09-15 差点踩到）。

正确顺序：

```bash
# ① 本地：重新编译（tsc → dist）
cd server && npm run build

# ② 同步 dist（以及 src / scripts / package.json 保持仓库一致）
rsync -az -e "sshpass -p <密码> ssh -o StrictHostKeyChecking=no \
  -o PreferredAuthentications=password -o PubkeyAuthentication=no" \
  --exclude node_modules --exclude .env \
  server/dist/ ubuntu@<IP>:/opt/dashuai/server/dist/

# ③ 确认同步到位：本地与服务器 sha256 必须一致
shasum -a 256 server/dist/lib/<改动的文件>.js | cut -c1-32
ssh ... 'sha256sum /opt/dashuai/server/dist/lib/<改动的文件>.js | cut -c1-32'

# ④ 重启并验证
pm2 restart dashuai-api && curl -s http://127.0.0.1:3000/healthz
```

> ⚠ 两个坑：
> 1. **不要用 `if rsync ... | tail` 判断成败** —— `if` 拿的是管道最后一个命令（`tail`）的退出码，
>    rsync 失败也会被判成成功。加 `set -o pipefail`，或直接看 `rsync` 自身的输出。
> 2. macOS 自带的是 **openrsync**，**不支持 `--info=stats2`** 等 GNU 选项，会直接打印用法并失败。
>    用 `--stats` 或不带统计选项即可。
>
> `.env` 不会被覆盖：`deploy.sh` 对它是「存在性检查 + `chmod 600`」，不写入内容。

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
- [ ] 进入创作，AI 生成口播文案（**验证 AI 通道 + 扣积分**）
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

- 微信支付商户号申请中 → 无法真实充值/开会员。**已不再阻断 `NODE_ENV=production`**：
  用 `PAYMENTS_ENABLED=false` 显式关闭支付即可上线，其余八个生产守卫正常生效（见 0.1 节）
- 短信通道未接入 → 只能用微信一键登录

**不阻断本次测试，但会影响体验**

- `Bean Reservation`（账务预留）与 freeze/consume/unfreeze 并发原子性未验证 → 高并发下可能重复扣积分/漏退
- `RenderTask` 状态机与 Worker 崩溃恢复：已有 stuck sweeper 兜底（默认 30 分钟超时退款），但租约机制未做
- `Shot.line` → TTS → 字幕 → 成片的完整链路、TTS 供应商真实联调未验收

**已解除**（2026-09-14 实测）

- ~~`apps/admin` 完整 build 未通过~~ → `vite build` 已通过（见第 3 节末尾）
- 服务端生产编译 `npx tsc -p tsconfig.json` 已通过，产出 `dist/index.js`
- 小程序正式出包已通过（主包 1.69MB / 2.00MB，84.3%）

**部署前必须处理**

- ⚠ **代码需先提交并推送**。2026-09-14 核对时工作区有 100 个未提交改动，其中包含
  `PAYMENTS_ENABLED` 支付开关与 `deploy/` 套件本身 —— 直接按本文件 `git clone` 会拉到
  一个**没有支付开关的旧版本**，`NODE_ENV=production` 会因缺微信支付七项而拒绝启动。
  详见 `deploy/部署前置核对-2026-09-14.md`。

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
