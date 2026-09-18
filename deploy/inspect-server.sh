#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 大帅餐饮 · 服务器现状体检（**只读**，不改任何东西）
#
#   用法（在服务器上）：
#     cd /opt/dashuai && bash deploy/inspect-server.sh
#   或从本机一次跑完：
#     ssh ubuntu@49.232.243.241 'cd /opt/dashuai && bash -s' < deploy/inspect-server.sh
#
# 目的：部署前先把「服务器跑的是哪版代码 / .env 到底怎么配的 / 进程什么状态」
#   变成可核对的事实，而不是靠记忆猜。
#
# 安全约定：
#   · 全程只读：只有 git log/status、grep、ls、curl、pm2 list、docker ps、df、Prisma 查询
#   · 不读任何密钥：.env 只按**白名单键名**打印；JWT_SECRET / COS_* / DB 口令一律不碰
#     （数据库计数**刻意**不用 mysql 客户端 —— 那样得把口令写进命令行，会暴露在 `ps` 上；
#       改走项目的 Prisma 客户端，它自己从 .env 读 DATABASE_URL）
#   · 不重启、不写文件、不改数据
#
# 刻意【不】写 set -e / set -o pipefail：体检要的是「尽量多查到」，某一项失败
#   不该让整份报告半途而废（这与部署脚本的诉求正好相反）。
# ═══════════════════════════════════════════════════════════════

# 可覆盖（便于在本地对着仓库试跑）：APP_DIR=. bash deploy/inspect-server.sh
APP_DIR="${APP_DIR:-/opt/dashuai}"
SERVER_DIR="$APP_DIR/server"

sec() { printf '\n\033[1;36m===== %s =====\033[0m\n' "$*"; }
kv()  { printf '  %-22s %s\n' "$1" "$2"; }

sec "0. 基本信息"
kv "hostname" "$(hostname 2>/dev/null)"
kv "date" "$(date '+%F %T %Z')"
kv "node" "$(node -v 2>/dev/null || echo '未安装')"
kv "pm2" "$(pm2 -v 2>/dev/null || echo '未安装')"
kv "ffmpeg" "$(ffmpeg -version 2>/dev/null | head -1 || echo '未安装')"
kv "磁盘 /" "$(df -h / 2>/dev/null | awk 'NR==2{print $4" 可用 / "$2" 总 ("$5" 已用)"}')"

sec "1. 代码落到哪一版了（这是最要紧的一项）"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" || exit 1
  kv "HEAD" "$(git rev-parse --short HEAD 2>/dev/null)"
  kv "分支" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  kv "最近提交时间" "$(git log -1 --format='%ci' 2>/dev/null)"
  echo "  ── 最近 5 个提交 ──"
  git log --oneline -5 2>/dev/null | sed 's/^/     /'
  echo "  ── 工作区是否被改过（会被后续 merge --ff-only 挡住）──"
  ST="$(git status --short 2>/dev/null)"
  if [ -z "$ST" ]; then
    echo "     干净（无未提交改动）"
  else
    echo "$ST" | head -20 | sed 's/^/     /'
    N="$(echo "$ST" | wc -l | tr -d ' ')"
    [ "$N" -gt 20 ] && echo "     …（共 $N 项，只列前 20）"
  fi
else
  echo "  $APP_DIR 不是 git 仓库 —— 代码不是用 git bundle 落地的"
fi

sec "2. 已部署的产物比源码新吗（判断 dist 有没有跟上）"
kv "dist/index.js" "$(ls -la "$SERVER_DIR/dist/index.js" 2>/dev/null | awk '{print $6,$7,$8}' || echo '不存在')"
kv "src/index.ts" "$(ls -la "$SERVER_DIR/src/index.ts" 2>/dev/null | awk '{print $6,$7,$8}' || echo '不存在')"
kv "node_modules" "$([ -d "$SERVER_DIR/node_modules" ] && echo '已安装' || echo '缺失')"

sec "3. 那版代码里有没有「生产破例开关」"
# 判据：源码里出现 SMS_TEST_CODE_ALLOW_PROD ⇒ 是四闸门版本；否则是三闸门旧版
HITS="$(grep -c 'SMS_TEST_CODE_ALLOW_PROD' "$SERVER_DIR/src/auth/sms.ts" 2>/dev/null || echo 0)"
if [ "${HITS:-0}" -gt 0 ] 2>/dev/null; then
  kv "sms.ts 闸门版本" "四闸门（含 ALLOW_PROD）—— 已是目标版本"
else
  kv "sms.ts 闸门版本" "旧版（无 ALLOW_PROD）⇒ 不部署代码就无法在线上开固定码"
fi
kv "含 smsTestCodeConfig" "$(grep -c 'smsTestCodeConfig' "$SERVER_DIR/src/auth/sms.ts" 2>/dev/null || echo 0)"

sec "4. server/.env 实配（只按白名单键名，不碰任何密钥）"
ENVF="$SERVER_DIR/.env"
if [ -f "$ENVF" ]; then
  kv "文件权限" "$(stat -c '%a %U:%G' "$ENVF" 2>/dev/null || echo '取不到')"
  for k in NODE_ENV PAYMENTS_ENABLED DEV_LOGIN SMS_PROVIDER SMS_TEST_CODE \
           SMS_TEST_CODE_PHONES SMS_TEST_CODE_ALLOW_PROD \
           TENCENT_SMS_SDK_APP_ID TENCENT_SMS_SIGN_NAME TENCENT_SMS_TEMPLATE_ID \
           STORAGE_MODE MOCK_AI FFMPEG_WORKER COS_BUCKET; do
    if grep -qE "^${k}=" "$ENVF" 2>/dev/null; then
      v="$(grep -E "^${k}=" "$ENVF" | head -1 | cut -d= -f2-)"
      kv "$k" "${v:-（空值）}"
    else
      kv "$k" "（未设置）"
    fi
  done
  echo "  ── 判读 ──"
  NV="$(grep -E '^NODE_ENV=' "$ENVF" | head -1 | cut -d= -f2-)"
  SP="$(grep -E '^SMS_PROVIDER=' "$ENVF" | head -1 | cut -d= -f2-)"
  SC="$(grep -E '^SMS_TEST_CODE=' "$ENVF" | head -1 | cut -d= -f2-)"
  SA="$(grep -E '^SMS_TEST_CODE_ALLOW_PROD=' "$ENVF" | head -1 | cut -d= -f2-)"
  [ "$NV" = "production" ] && echo "     · NODE_ENV=production ⇒ 固定码默认关闭"
  if [ -z "$SP" ]; then
    echo "     · SMS_PROVIDER 为空 ⇒ 短信走「通道未选」那条（1004「短信服务未配置」）"
  else
    echo "     · SMS_PROVIDER=$SP ⇒ 若密钥不全，走「选了但配置不齐」那条（同样 1004，文案不同）"
  fi
  if [ -n "$SC" ] && [ "$SA" = "true" ]; then
    echo "     · ⚠⚠ 固定测试码【已启用】：名单内号码可用它登录（测试期结束后必须删）"
  elif [ -n "$SC" ]; then
    echo "     · 配了 SMS_TEST_CODE 但 ALLOW_PROD≠true ⇒ 线上整块失效"
  else
    echo "     · 未配固定测试码"
  fi
else
  echo "  缺少 $ENVF"
fi

sec "5. 进程状态"
pm2 list 2>/dev/null | sed 's/^/  /'
echo "  ── dashuai-api 详情 ──"
pm2 describe dashuai-api 2>/dev/null | grep -E 'status|uptime|restarts|script path|exec cwd|out log|error log' | sed 's/^/     /'

sec "6. 本机自测（不经 nginx）"
kv "curl /healthz" "$(curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz 2>&1)"
kv "auth/dev-mode" "$(curl -sS -m 5 http://127.0.0.1:3000/api/v1/auth/dev-mode 2>&1 | head -c 200)"
kv "works(未带token)" "$(curl -sS -m 5 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3000/api/v1/works?page=1' 2>&1)"
kv "tutorials" "$(curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/v1/tutorials 2>&1)"

sec "7. 依赖服务"
kv "docker compose" "$(docker compose version 2>/dev/null | head -1 || echo '未安装 compose 插件')"
docker ps --format '     {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | head -10

sec "8. nginx（备案绕行配置还在不在）"
ls -la /etc/nginx/conf.d/ 2>/dev/null | sed 's/^/  /'
grep -rl 'default_server' /etc/nginx/conf.d/ 2>/dev/null | sed 's/^/     default_server 在: /'

sec "9. 候选测试号的归属 / 积分 / 会员（决定登录后进哪个账号、能不能真跑 AI）"
# 走项目自己的 Prisma 客户端：它从 .env 读 DATABASE_URL，口令不经过命令行。
# 只读 findMany；★ 必须显式 disconnect + exit，否则脚本跑完不退出。
cd "$SERVER_DIR" || exit 1
node -e '
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const PHONES = ["13800000000", "13800000001", "13000000000"];
(async () => {
  try {
    const rows = await p.merchant.findMany({
      where: { phone: { in: PHONES } },
      select: {
        id: true, phone: true, nickname: true, status: true, wechatOpenid: true,
        _count: { select: { stores: true } },
        beanAccount: { select: { balance: true, grantBalance: true, grantRegisterBalance: true, frozen: true } },
        memberships: { select: { endAt: true, status: true }, orderBy: { endAt: "desc" }, take: 1 },
      },
      orderBy: { id: "asc" },
    });
    const byPhone = new Map(rows.map((r) => [r.phone, r]));
    for (const ph of PHONES) {
      const r = byPhone.get(ph);
      if (!r) { console.log(`  ${ph}  （不存在 ⇒ 首次登录会自动建号）`); continue; }
      const wx = r.wechatOpenid ? "已绑微信" : "未绑微信";
      const b = r.beanAccount;
      const avail = b ? Number(b.balance + b.grantBalance + b.grantRegisterBalance - b.frozen) : 0;
      const beans = b
        ? `积分可用${avail}（充值${b.balance}+会员赠${b.grantBalance}+注册赠${b.grantRegisterBalance}，冻结${b.frozen}）`
        : "无积分账户（0 积分）";
      const m = r.memberships[0];
      const mem = m && m.status === "ACTIVE" && new Date(m.endAt) > new Date()
        ? `会员有效至${m.endAt.toISOString().slice(0, 10)}`
        : "无有效会员";
      console.log(`  ${ph}  id=${r.id}  ${r.nickname ?? "(无昵称)"}  ${r.status}  门店${r._count.stores}家  ${wx}`);
      console.log(`        ${beans} ／ ${mem}`);
      console.log(`        ⇒ ${avail > 0 && mem.startsWith("会员有效") ? "可跑 AI" : "只能看界面，跑不了 AI（需后台手动开通会员/加积分）"}`);
    }
  } catch (e) {
    console.log("  查询失败：" + e.message);
  } finally {
    await p.$disconnect();
    process.exit(0);
  }
})();
'

printf '\n\033[1;32m体检结束（全程只读）\033[0m\n'
