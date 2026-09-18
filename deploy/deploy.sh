#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 大帅餐饮 · 服务器端部署脚本（体验版测试期）
#
#   在服务器上执行（代码已放到 /opt/dashuai）：
#     cd /opt/dashuai && bash deploy/deploy.sh
#
# 做的事：检查依赖 → 起 MySQL/Redis → 装依赖 → 建表 → 种子 → 编译 → PM2 起服务
# 幂等：可以反复执行，用于更新上线
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="/opt/dashuai"
SERVER_DIR="$APP_DIR/server"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[error] %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$SERVER_DIR" ] || die "找不到 ${SERVER_DIR}，先把代码放到 $APP_DIR"
cd "$APP_DIR"

# ───────── 1. 依赖检查 ─────────
log "[1/7] 检查运行环境"

command -v node >/dev/null || die "未安装 Node.js，需 v20+"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 版本过低（当前 $(node -v)），需要 v20+"

command -v docker >/dev/null || die "未安装 Docker"
command -v pm2    >/dev/null || die "未安装 PM2（npm i -g pm2）"
command -v ffmpeg >/dev/null || warn "未找到 ffmpeg，真实合成会失败：apt install -y ffmpeg"
command -v ffprobe >/dev/null || warn "未找到 ffprobe，素材探测会失败：apt install -y ffmpeg"

if command -v ffmpeg >/dev/null; then
  echo "    node  : $(node -v)"
  echo "    ffmpeg: $(ffmpeg -version | head -1)"

  # 字幕烧录需要两个前置条件，缺一不可（见 src/render/synthesis.ts:applyAiSynthesis）：
  #   ① ffmpeg 编译了 libass（有 subtitles 滤镜）  ② 系统里有中文字体
  #
  # ⚠ 这里**不能**写 `ffmpeg -filters | grep -q ' subtitles '`：
  #   grep -q 一匹配到就立即退出并关闭管道，ffmpeg 随即收到 SIGPIPE 而异常终止（exit 141），
  #   在脚本开头的 `set -o pipefail` 下整条管道被判为失败 —— 结果**明明有滤镜也报「不可用」**。
  #   （2026-09-15 实测踩过：Ubuntu 26.04 的 ffmpeg 8.0.1 编译了 --enable-libass，
  #     `grep -c` 返回 2，却被这个写法误报成缺 libass。）
  #   改成先把输出收进变量、再用 case 匹配，绕开管道与 SIGPIPE。
  FILTERS="$(ffmpeg -hide_banner -filters 2>/dev/null || true)"
  case "$FILTERS" in
    *" subtitles "*) echo "    libass: 可用（支持字幕烧录）" ;;
    *) warn "ffmpeg 不含 subtitles 滤镜（缺 libass），字幕烧录会降级为『仅配音无字幕』" ;;
  esac

  # 第二个前置条件：字体目录清单必须与 src/render/synthesis.ts:detectCjkFont() 保持一致
  CJK_FONT_DIR=""
  for d in /usr/share/fonts/opentype/noto /usr/share/fonts/truetype/wqy /usr/share/fonts/truetype/droid; do
    if [ -d "$d" ]; then CJK_FONT_DIR="$d"; break; fi
  done
  if [ -n "$CJK_FONT_DIR" ]; then
    echo "    CJK字体: 可用（${CJK_FONT_DIR}）"
  else
    warn "未找到中文字体，字幕烧录会降级为『仅配音无字幕』：apt install -y fonts-noto-cjk"
  fi
fi

# ───────── 2. 环境变量 ─────────
log "[2/7] 检查 server/.env"
if [ ! -f "$SERVER_DIR/.env" ]; then
  die "缺少 $SERVER_DIR/.env —— 请先复制 deploy/env.server.template 并替换所有 REPLACE_*"
fi
chmod 600 "$SERVER_DIR/.env"
ADMIN_API_DOMAIN="$(grep -E '^WX_PAY_NOTIFY_URL=' "$SERVER_DIR/.env" | sed -E 's#.*https://([^/]+)/.*#\1#' || true)"
echo "    调用域名（来自 WX_PAY_NOTIFY_URL）: ${ADMIN_API_DOMAIN:-未配置}"

# 环境一致性体检：NODE_ENV 与 PAYMENTS_ENABLED 的组合直接决定哪批守卫生效，配错代价很大
ENV_NODE="$(grep -E '^NODE_ENV=' "$SERVER_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ' || true)"
ENV_PAY="$(grep -E '^PAYMENTS_ENABLED=' "$SERVER_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ' || true)"
echo "    NODE_ENV=$ENV_NODE  PAYMENTS_ENABLED=${ENV_PAY:-未设置（=开启）}"
if [ "$ENV_NODE" != "production" ]; then
  warn "NODE_ENV=${ENV_NODE}（非 production）：JWT_SECRET / APP_MASTER_KEY / CORS_ORIGIN / DEV_LOGIN /"
  warn "  MOCK_AI / FFMPEG_WORKER / STORAGE_MODE / COS_* 这八个守卫全部【不会】生效。"
  warn "  对外提供服务时这很危险，请改用 NODE_ENV=production + PAYMENTS_ENABLED=false。"
elif [ "$ENV_PAY" != "false" ]; then
  warn "NODE_ENV=production 且未显式关闭支付：会强制校验微信支付七项配置，"
  warn "  商户号未下来前会启动失败。若本意是灰度关闭支付，请在 .env 加 PAYMENTS_ENABLED=false。"
else
  log "    支付校验已显式关闭，其余八个生产守卫正常生效"
fi

# 开发登录后门体检（体验版测试期专用）——
# SMS_TEST_CODE / SMS_TEST_CODE_PHONES / SMS_TEST_CODE_ALLOW_PROD 这三个变量的
# 「生效/失效」组合很难靠肉眼判断，且失效时用户只看到一句
# 「测试期仅名单内的测试号码可登录」，看不出是自己漏了 ALLOW_PROD，故在这里点明。
ENV_SMS_CODE="$(grep -E '^SMS_TEST_CODE=' "$SERVER_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ' || true)"
ENV_SMS_PHONES="$(grep -E '^SMS_TEST_CODE_PHONES=' "$SERVER_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ' || true)"
ENV_SMS_ALLOW="$(grep -E '^SMS_TEST_CODE_ALLOW_PROD=' "$SERVER_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ' || true)"
if [ -z "$ENV_SMS_CODE" ] || [ -z "$ENV_SMS_PHONES" ]; then
  echo "    短信测试码: 未启用（SMS_TEST_CODE 与 SMS_TEST_CODE_PHONES 必须同时非空才可能生效）"
elif [ "$ENV_NODE" = "production" ] && [ "$ENV_SMS_ALLOW" != "true" ]; then
  warn "配了 SMS_TEST_CODE 但缺 SMS_TEST_CODE_ALLOW_PROD=true ⇒ 生产环境下【整块失效】，"
  warn "  测试者点「获取验证码」只会看到『测试期仅名单内的测试号码可登录』（真因看不出来）。"
  warn "  这多半是故意的（防本地 .env 整份复制上线）；确实要给测试者开就补上那行。"
elif [ "$ENV_NODE" = "production" ]; then
  warn "⚠⚠ 生产环境的登录后门【已启用】：白名单手机号可用固定码登录。"
  warn "  测试期结束 / 备案通过后，必须把 SMS_TEST_CODE / SMS_TEST_CODE_PHONES /"
  warn "  SMS_TEST_CODE_ALLOW_PROD 这三个变量【一起】删掉 —— 只删一两个 = 后门还开着。"
else
  echo "    短信测试码: 已配置（env=${ENV_NODE}，非生产环境本就允许）"
fi

# ───────── 3. 起依赖服务 ─────────
log "[3/7] 启动 MySQL + Redis（docker compose）"
if ! docker compose version >/dev/null 2>&1; then
  die "缺少 docker compose 插件（docker-compose-plugin）"
fi
docker compose up -d mysql redis

echo "    等待 MySQL 健康..."
MYSQL_OK=0
for i in $(seq 1 30); do
  st="$(docker inspect --format '{{.State.Health.Status}}' dashuai-mysql 2>/dev/null || echo unknown)"
  printf '    [%02d/30] mysql: %s\n' "$i" "$st"
  if [ "$st" = "healthy" ]; then MYSQL_OK=1; break; fi
  sleep 5
done
[ "$MYSQL_OK" = "1" ] || die "MySQL 未在 150s 内就绪，请看 docker logs dashuai-mysql"

# ───────── 4. 安装依赖 + 编译 ─────────
log "[4/7] 安装依赖并编译后端"
cd "$SERVER_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --ignore-scripts || npm install --omit=dev
  npm install --no-save prisma typescript tsx @types/node >/dev/null 2>&1 || true
else
  npm install
fi
npx prisma generate
npx tsc -p tsconfig.json
[ -f dist/index.js ] || die "编译产物 dist/index.js 不存在"

# ───────── 5. 数据库结构 ─────────
log "[5/7] 同步数据库结构"
if npx prisma migrate deploy 2>/dev/null; then
  echo "    migrate deploy 成功"
else
  warn "migrate deploy 失败（迁移历史与 schema 可能不一致，本地开发用的是 db push）"
  warn "回退到 prisma db push（会直接对齐 schema，不做迁移记录）"
  npx prisma db push --skip-generate
fi

# ───────── 6. 种子数据 ─────────
log "[6/7] 写入种子数据"
echo "    包含：AI 通道与场景、充值档位、会员套餐、后台管理员、演示商家"
echo "    若已 seed 过会走 upsert，不会重复插入"
npm run db:seed

# ───────── 7. 起进程 ─────────
log "[7/7] 启动 PM2 进程"
# 日志目录属 root，普通用户建不了 —— 已存在则 mkdir -p 直接成功，否则需要 sudo
mkdir -p /var/log/dashuai 2>/dev/null || sudo mkdir -p /var/log/dashuai
sudo chown -R "$(id -un):$(id -gn)" /var/log/dashuai 2>/dev/null || true

# ⚠ PM2 配置必须用【绝对路径】：
#   上面第 4 步执行过 `cd "$SERVER_DIR"`，之后 cwd 一直停在 server/，
#   这里若写相对的 `deploy/ecosystem.config.cjs`，会被解析成 server/deploy/...
#   → `[PM2][ERROR] File deploy/ecosystem.config.cjs not found`。
#   （2026-09-15 实际踩到，部署卡在第 7 步。）
pm2 startOrReload "$APP_DIR/deploy/ecosystem.config.cjs" --update-env
pm2 save

sleep 3
echo ""
log "健康检查"
if curl -fsS http://127.0.0.1:3000/healthz >/dev/null; then
  echo "    http://127.0.0.1:3000/healthz  OK"
else
  die "健康检查失败，看日志：pm2 logs dashuai-api --lines 80"
fi

cat <<'EOF'

─────────────────────────────────────────────
部署完成。接下来手工确认：

  1) pm2 logs dashuai-api --lines 50
     看到 "[server] listening on :3000 (env=production)" 即正常
     看到 "[config] PAYMENTS_ENABLED=false" 是预期输出（商户号申请期间的灰度关闭）
     看到 "Local storage forbidden" / "Missing production payment config" / "Unsafe production config"
       说明 server/.env 有问题，按报错补齐

  2) 外网直连验证（把域名换成你的）：
     curl -sS https://api.<域名>/healthz

  3) 到 mp.weixin.qq.com 配置服务器域名（见 deploy/README.md 第 4 节）

  4) 本地执行出包：
     bash scripts/build-weapp-prod.sh https://api.<域名>/api/v1
─────────────────────────────────────────────
EOF
