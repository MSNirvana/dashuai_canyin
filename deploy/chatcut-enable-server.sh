#!/usr/bin/env bash
# 把**本地已授权好**的 ChatCut 三行凭证推到线上，让 AI 档立即放开。
#
# ★ **在本机跑**（不是服务器上）—— 因为凭证只存在于本地 server/.env 里。
#
# 跑法：
#   SSH_PASS='<服务器密码>' bash deploy/chatcut-enable-server.sh
#   不给 SSH_PASS 就走 ssh 默认认证（已配置的密钥 / agent）。
#   DRY_RUN=1 只打印「将执行哪些步骤」，不碰服务器。
#
# 为什么需要它：AI 档的开关**不是代码，而是服务端环境变量**：
#   有凭证 ⇒ chatCutConfigured() = true ⇒ 能力表 AI.available=true ⇒ 小程序不再置灰。
#   而这些凭证只能从「已经完成过浏览器授权的那台机器」搬过去 —— OAuth 的「点同意」只有人能点。
#
# ★★ 推完之后**不要再在本机跑 chatcut:probe / chatcut:authorize**：
#   refresh_token 是**轮换**的，谁刷新谁作废旧值。再在本机跑一次，线上那张就立刻失效、
#   AI 档会静默挂掉（能力表回到 available=false，且没有任何告警）。
#   线上多实例靠共享 Redis（代码已实现「Redis 里的值优先于 .env」）。
#
# ★★ 反方向同样要小心（2026-09-21 推送时确认）：**服务器一旦自行刷新，本地这张就过时了**。
#   chatcut.ts 会把轮换后的新值写进 Redis（`persistRotatedRefreshToken`），且读取时
#   **Redis 优先于 .env** —— 所以线上跑一阵子之后，本地 `server/.env` 里那张就是废票。
#   将来若要重新推（换机器 / 换服务器 / .env 丢了），**别直接拿本地值往上推**，
#   否则推上去的是废值，症状是「能力表 available=true，但一提交就失败」，比没配更难查。
#   先取线上的权威值（Redis 可能跑在容器里）：
#     redis-cli --raw GET dashuai:chatcut:oauth:refresh-token
#     docker exec <redis容器> redis-cli --raw GET dashuai:chatcut:oauth:refresh-token
#
# 三道自保（沿用 deploy/enable-sms-live.sh 的思路）：
#   ① 服务器 `.env` 先备份 —— 它是线上唯一的环境变量来源，改坏了服务起不来。
#   ② 三行缺任意一行就**中止且不落盘** —— 半套配置比不配置更难查。
#   ③ 只精确动这三个键 —— 绝不动同前缀的 CHATCUT_ADAPTER_ENABLED / CHATCUT_MCP_URL 等。
#   ④ 不回显任何密钥值，只报「已取到 + 长度」。
set -euo pipefail

HOST="${SSH_HOST:-49.232.243.241}"
SSH_USER="${SSH_USER:-ubuntu}"
ENV_FILE="${ENV_FILE:-/opt/dashuai/server/.env}"
PM2_APP="${PM2_APP:-dashuai-api}"
CAPABILITIES_URL="${CAPABILITIES_URL:-http://127.0.0.1:3000/api/v1/render/capabilities}"

# 只搬这三个。OAuth 的 client_secret 对 public client 是空的，不需要。
KEYS=(CHATCUT_OAUTH_TOKEN_URL CHATCUT_OAUTH_CLIENT_ID CHATCUT_OAUTH_REFRESH_TOKEN)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_ENV="$REPO_ROOT/server/.env"

echo "▌ChatCut 凭证同步（本地 → 线上）"
echo "  本地来源 = $LOCAL_ENV"
echo "  目标     = ${SSH_USER}@${HOST}:${ENV_FILE}"
echo ""

[ -f "$LOCAL_ENV" ] || { echo "✗ 找不到 $LOCAL_ENV（凭证在本地，不能从别处取）"; exit 1; }

CRED_LINES=()
for key in "${KEYS[@]}"; do
  line="$(grep -m1 -E "^${key}=" "$LOCAL_ENV" || true)"
  if [ -z "$line" ]; then
    echo "✗ 本地缺 ${key} —— 先完成一次授权：cd server && npm run chatcut:authorize"
    exit 1
  fi
  CRED_LINES+=("$line")
  # 只报长度，值不回显（即使是在终端里）
  echo "  ✓ ${key}（已取到，长度 ${#line}）"
done
echo ""

REMOTE_SCRIPT="$(mktemp -t chatcut-enable.XXXXXX)"
chmod 600 "$REMOTE_SCRIPT"
trap 'rm -f "$REMOTE_SCRIPT"' EXIT

{
  echo 'set -euo pipefail'
  printf 'ENV_FILE=%q\n' "$ENV_FILE"
  printf 'PM2_APP=%q\n' "$PM2_APP"
  printf 'CAPABILITIES_URL=%q\n' "$CAPABILITIES_URL"
  cat <<'REMOTE_HEAD'
[ -f "$ENV_FILE" ] || { echo "✗ 服务器上找不到 $ENV_FILE"; exit 1; }

BAK="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BAK"
echo "  ✓ 已备份 → $BAK"

TMP="$(mktemp)"
# 幂等：先删掉这三个键的旧行（保留同前缀的其他变量），再统一追加
grep -vE '^CHATCUT_(OAUTH_TOKEN_URL|OAUTH_CLIENT_ID|OAUTH_REFRESH_TOKEN)=' "$ENV_FILE" > "$TMP" || true

cat >> "$TMP" <<'CREDS_MARKER'
REMOTE_HEAD
  for line in "${CRED_LINES[@]}"; do printf '%s\n' "$line"; done
  cat <<'REMOTE_TAIL'
CREDS_MARKER

# 用 `cat >` 而非 mv：保留原文件的 owner/权限，不做无谓变更（已备份，写坏可回滚）
cat "$TMP" > "$ENV_FILE"
rm -f "$TMP"

echo "  ✓ 三行已写入（同前缀的其他 CHATCUT_* 变量未动）"
printf '    现在 CHATCUT_* 共 %s 行\n' "$(grep -c '^CHATCUT_' "$ENV_FILE" || true)"

# ★ 生产跑的是 dist/（PM2），不是 tsx watch —— 所以不需要 touch src/index.ts，
#   重启进程就会用 dotenv 重新读 .env。--update-env 顺带刷新 PM2 自己缓存的环境。
cd "$(dirname "$ENV_FILE")"
pm2 restart "$PM2_APP" --update-env > /dev/null
echo "  ✓ pm2 已重启 $PM2_APP"

echo ""
echo "  ── 验收：本机能力表（期望 AI.available = true）──"
for i in 1 2 3 4 5; do
  sleep 3
  body="$(curl -s --max-time 15 "$CAPABILITIES_URL" || true)"
  if [ -n "$body" ]; then
    echo "  $body"
    case "$body" in
      *'"key":"AI","available":true'*) echo "  ✓ AI 档已放开"; exit 0 ;;
      *'"key":"AI","available":false'*) echo "  ✗ AI 档仍不可用 —— 上面 ⑧/② 段的判据项再核一遍" ;;
    esac
    [ "$i" = "5" ] && exit 1
  else
    echo "  …第 ${i} 次没拿到响应，服务可能还在起"
    [ "$i" = "5" ] && { echo "  ✗ 5 次都没拿到能力表，去 pm2 logs $PM2_APP 看一眼"; exit 1; }
  fi
done
REMOTE_TAIL
} > "$REMOTE_SCRIPT"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "[DRY RUN] 将执行的步骤（密钥已隐去，不打印凭据行）："
  grep -vE '^CHATCUT_' "$REMOTE_SCRIPT" | sed 's/^/    /'
  echo "    CHATCUT_*=<三行已在内存中，共 ${#CRED_LINES[@]} 行>"
  exit 0
fi

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
if [ -n "${SSH_PASS:-}" ]; then
  # ★ 必须显式禁用 publickey：否则 agent 里若有密钥会先挨个试，
  #   撞上 MaxAuthTries 直接被拒，报出来的却是 `Permission denied (publickey,password)`，
  #   看着像密码错了 —— 这正是 deploy skill 里记过的坑。
  SSH_OPTS+=(-o PreferredAuthentications=password -o PubkeyAuthentication=no)
  sshpass -p "$SSH_PASS" ssh "${SSH_OPTS[@]}" "${SSH_USER}@${HOST}" 'bash -s' < "$REMOTE_SCRIPT"
else
  ssh -o BatchMode=yes "${SSH_OPTS[@]}" "${SSH_USER}@${HOST}" 'bash -s' < "$REMOTE_SCRIPT"
fi
