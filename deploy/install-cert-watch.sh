#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 安装「Let's Encrypt 证书续期守望」定时任务（幂等）。
#
#   sudo bash deploy/install-cert-watch.sh              # 安装（需 root：要读 /etc/letsencrypt）
#   sudo bash deploy/install-cert-watch.sh --check      # 只看当前状态，不改动
#   sudo bash deploy/install-cert-watch.sh --uninstall  # 移除任务（保留日志）
#
# ── 为什么必须有 ────────────────────────────────────────────────
# HTTPS 于 2026-09-21 上线，证书续期由 `certbot.timer` 全自动完成（每天 08:54 / 20:54 两次，
# 到期前 30 天才真正签发 ⇒ 天然有 ~30 天重试窗口）。**但本服务器没有任何邮件/短信告警
# 通道**（SMS_PROVIDER 为空、无邮件通道）：certbot 续期失败只写 journal + 一个 `failed`
# 的 systemd 单元，没有人会去看 —— 一路静默到证书过期、小程序全线请求失败。
# 本安装器补的就是「失败你看得见」这唯一缺口。
#
# ── 它装什么（三件事，全部只读）─────────────────────────────────
# · 每天 09:17 把「证书剩余天数 + 到期时间 + SAN + timer 状态」追加到
#   /var/log/dashuai/cert-watch.log
# · 剩余天数 < 21 天、或 certbot.timer 不再 active/enabled、或出现 certbot.* 的 failed
#   单元 ⇒ 该行打 [WARN] / [FAIL] 并附「!! 需要人工介入」
# · 每周日 10:07 做一次 `certbot renew --dry-run`（走 ACME staging，**不动真实证书**）
#   —— 这是唯一能自证「续期链路当前仍可用」的办法：webroot 目录被删、80 被封、
#   DNS 被改，只有干跑才会暴露。结果进 /var/log/dashuai/cert-renewal-drill.log
#
# ── 判活（一行）─────────────────────────────────────────────────
#   tail -3 /var/log/dashuai/cert-watch.log
#   出现 `| OK |` 即正常；出现 WARN/FAIL 的行自带处置提示。
#
# ── 安全设计 ────────────────────────────────────────────────────
# · **守望脚本绝不自己调 `certbot renew`（真续期）** —— 续期只由 certbot.timer 承担，
#   重复触发会争 /var/log/letsencrypt/.certbot.lock。守望必须只读。
# · crontab 按**标记行**做幂等替换（`# dashuai-cert`），其他任务（storage-gc、
#   腾讯云 stargate）原样保留；**绝不用 `crontab -` 直接覆盖**。
# · cron 里避开 `%`（crontab 会把它当换行符），时间戳统一用 `date --iso-8601=seconds`。
# · 日志自动瘦身到最近 400 行，不会无限增长。
# · 守望脚本本体**内嵌在本安装器里**（不另外维护一份仓库文件）—— 只有一处要改，
#   不会出现「仓库版和服务器版漂移」。改了本文件重跑一次即刷新 /usr/local/bin 里的副本。
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

CERT_DIR="${DASHUAI_CERT_DIR:-/etc/letsencrypt/live/api.dspcz.top}"
LOG_DIR="${DASHUAI_LOG_DIR:-/var/log/dashuai}"
WATCH_BIN="/usr/local/bin/dashuai-cert-watch.sh"
MARK="# dashuai-cert"
WATCH_CRON="${DASHUAI_CERT_WATCH_CRON:-17 9 * * *}"
DRILL_CRON="${DASHUAI_CERT_DRILL_CRON:-7 10 * * 0}"

log() { printf '\033[1;36m[install-cert-watch] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[install-cert-watch][error] %s\033[0m\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  crontab -l 2>/dev/null | grep -v "$MARK" | crontab - || true
  log "已移除证书守望定时任务（保留 $LOG_DIR/cert-watch.log 与 cert-renewal-drill.log）"
  exit 0
fi

if [ "$(id -u)" != "0" ]; then
  die "需要 root（要读 $CERT_DIR 与 root crontab）⇒ sudo bash $0"
fi

if [ "${1:-}" = "--check" ]; then
  log "证书目录：$CERT_DIR"
  openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -enddate -subject 2>/dev/null || echo "  (读不到证书)"
  log "certbot.timer：$(systemctl is-active certbot.timer) / $(systemctl is-enabled certbot.timer 2>/dev/null || echo unknown)"
  log "crontab 相关行："
  crontab -l 2>/dev/null | grep "$MARK" || echo "  (未安装)"
  log "守望日志末尾："
  tail -3 "$LOG_DIR/cert-watch.log" 2>/dev/null || echo "  (暂无)"
  exit 0
fi

[ -d "$CERT_DIR" ] || die "找不到证书目录 $CERT_DIR（先确认 HTTPS 已上线）"
command -v crontab >/dev/null || die "系统没有 crontab"
command -v openssl >/dev/null || die "找不到 openssl"

mkdir -p "$LOG_DIR"

# ── 1) 落守望脚本本体 ──────────────────────────────────────────
cat > "$WATCH_BIN" <<'WATCH_EOF'
#!/usr/bin/env bash
# dashuai-cert-watch —— Let's Encrypt 证书续期守望（**只读**，绝不触发真续期）
#
# 本文件由 deploy/install-cert-watch.sh 生成；要改内容请改那个安装器再重跑，
# 直接改这里会在下次重跑时被覆盖。
#
# 判活：tail -3 /var/log/dashuai/cert-watch.log   （`| OK |` = 正常）
# 退出码：0 = OK，1 = WARN/FAIL（cron 里因此能看到失败，systemd/mail 也可据此告警）
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

CERT_DIR="${CERT_DIR:-/etc/letsencrypt/live/api.dspcz.top}"
LOG="${CERT_WATCH_LOG:-/var/log/dashuai/cert-watch.log}"
WARN_DAYS="${CERT_WATCH_WARN_DAYS:-21}"

# `date --iso-8601=seconds` 是 GNU 专有；兜底写法保证时间戳永不为空（cron 里空时间戳
# 会让日志无法定位是哪一轮出的问题）。注意：**crontab 行里不能用 `%`**，所以走 --iso-8601。
ts="$(date --iso-8601=seconds 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S%z')"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

days=-1
detail=""

# ── 证书剩余天数 ────────────────────────────────────────────────
if [ -r "$CERT_DIR/fullchain.pem" ]; then
  end="$(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -n "${end:-}" ]; then
    if end_epoch="$(date -d "$end" +%s 2>/dev/null)"; then
      days=$(( (end_epoch - $(date +%s)) / 86400 ))
      san="$(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -ext subjectAltName 2>/dev/null | tail -n1 | tr -d ' ')"
      detail="剩余 ${days} 天 | 到期 $end | SAN ${san:-未知}"
    else
      detail="[FAIL] 无法解析到期时间：$end"
    fi
  else
    detail="[FAIL] openssl 读不出 enddate"
  fi
else
  detail="[FAIL] 证书文件不可读或不存在：$CERT_DIR/fullchain.pem"
fi

# ── certbot.timer 是否还在、有没有 failed 单元 ──────────────────
if ! systemctl is-active --quiet certbot.timer 2>/dev/null; then
  detail="$detail | [FAIL] certbot.timer 未运行（自动续期已停）"
  days=-1
elif ! systemctl is-enabled --quiet certbot.timer 2>/dev/null; then
  detail="$detail | [WARN] certbot.timer 已启用状态丢失（重启后不会自动跑）"
fi

failed_units="$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -E '^certbot\.' | tr '\n' ' ')"
if [ -n "${failed_units// /}" ]; then
  detail="$detail | [FAIL] systemd 失败单元：$failed_units"
fi

# ── 判定等级 ────────────────────────────────────────────────────
if [ "$days" -lt 0 ]; then
  level=FAIL
elif printf '%s' "$detail" | grep -q '\[FAIL\]'; then
  level=FAIL
elif [ "$days" -lt "$WARN_DAYS" ]; then
  level=WARN
elif printf '%s' "$detail" | grep -q '\[WARN\]'; then
  level=WARN
else
  level=OK
fi

printf '[cert-watch] %s | %s | %s\n' "$ts" "$level" "$detail" >> "$LOG"
if [ "$level" != "OK" ]; then
  printf '[cert-watch] !! 需要人工介入（%s）：journalctl -u certbot.service -n 50，再手工 certbot renew\n' "$level" >> "$LOG"
fi

# 日志瘦身：只留最近 400 行
if [ -f "$LOG" ]; then
  if tail -n 400 "$LOG" > "$LOG.tmp" 2>/dev/null; then
    mv "$LOG.tmp" "$LOG" 2>/dev/null || rm -f "$LOG.tmp"
  else
    rm -f "$LOG.tmp"
  fi
fi

if [ "$level" = "OK" ]; then
  printf '[cert-watch] OK: %s\n' "$detail"
  exit 0
fi
printf '[cert-watch] %s: %s\n' "$level" "$detail" >&2
exit 1
WATCH_EOF

chmod 755 "$WATCH_BIN"
log "已落守望脚本：$WATCH_BIN"

# ── 2) 幂等安装 crontab（按标记行替换，保留其他任务）───────────
WATCH_LINE="$WATCH_CRON $WATCH_BIN >> $LOG_DIR/cert-watch.cron.log 2>&1 $MARK-watch"
DRILL_LINE="$DRILL_CRON /usr/bin/flock -n /tmp/dashuai-certbot-dryrun.lock /usr/bin/certbot renew --dry-run --quiet >> $LOG_DIR/cert-renewal-drill.log 2>&1; echo \"[cert-renewal-drill] rc=\$? \$(date --iso-8601=seconds)\" >> $LOG_DIR/cert-renewal-drill.log $MARK-renewal-drill"

TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -v "$MARK" > "$TMP" || true
printf '%s\n' "$WATCH_LINE" >> "$TMP"
printf '%s\n' "$DRILL_LINE" >> "$TMP"
crontab "$TMP"
rm -f "$TMP"

log "已安装 crontab："
echo "    $WATCH_LINE"
echo "    $DRILL_LINE"

# ── 3) 立即试跑一次（自证）─────────────────────────────────────
log "立即试跑守望脚本（应输出 OK 并 exit 0）..."
if "$WATCH_BIN"; then
  log "试跑通过"
else
  log "⚠ 试跑返回非 0 —— 请看下面的日志末尾"
fi

log "守望日志末尾："
tail -3 "$LOG_DIR/cert-watch.log" 2>/dev/null || true
log "查看完整状态：sudo bash $0 --check"
log "判活一行：tail -3 $LOG_DIR/cert-watch.log"
