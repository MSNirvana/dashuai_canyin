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

[ -d "$SERVER_DIR" ] || die "找不到 $SERVER_DIR，先把代码放到 $APP_DIR"
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
  # 字幕烧录依赖 libass，缺了只能降级为「仅配音无字幕」
  if ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' subtitles '; then
    echo "    libass: 可用（支持字幕烧录）"
  else
    warn "ffmpeg 不含 subtitles 滤镜（缺 libass），字幕烧录会降级"
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
grep -qE '^NODE_ENV=production' "$SERVER_DIR/.env" \
  && warn "当前 NODE_ENV=production：会强制校验微信支付七项配置，商户号未下来前会启动失败"

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
mkdir -p /var/log/dashuai
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
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
     看到 "[server] listening on :3000 (env=staging)" 即正常
     看到 "Local storage forbidden" / "Missing production payment config" 说明 env 有问题

  2) 外网直连验证（把域名换成你的）：
     curl -sS https://api.<域名>/healthz

  3) 到 mp.weixin.qq.com 配置服务器域名（见 deploy/README.md 第 4 节）

  4) 本地执行出包：
     bash scripts/build-weapp-prod.sh https://api.<域名>/api/v1
─────────────────────────────────────────────
EOF
