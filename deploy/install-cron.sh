#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 安装「存储孤儿对象回收」的每日定时任务（幂等）。
#
#   bash deploy/install-cron.sh              # 安装为「报告 + 删除」（生产推荐）
#   bash deploy/install-cron.sh --dry-run    # 安装为「只报告」，不删任何对象
#   bash deploy/install-cron.sh --uninstall  # 移除任务
#
# 为什么必须有调度：上传成功后取消交付、返工重传、删除作品、分片中断都会留下无主对象，
#   COS 里这些对象**持续计费**。GC 脚本本身早就写好了（含 24h 保留期、安全前缀、
#   单轮删除上限），但它只是个手工命令 —— 没有调度就等于永远不会跑。
#
# 安全设计（自动删除是不可逆操作，这里逐条兜住）：
#   · 只删「数据库未引用」且「超过保留期」的对象，保留期默认 24h（见脚本 --retention-hours）
#   · 只动 uploads/ renders/ tutorials/ works/ 四个前缀，缓存区需额外开关
#   · 单轮删除上限（默认 100 个），不会一次性清空
#   · flock -n 互斥：上一轮没跑完时本轮直接跳过，不会两个进程同时删
#   · 全部输出追加到日志文件（审计留痕）
#   · 只删对象、不碰 HTTP 分片以外的任何数据库行
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${DASHUAI_APP_DIR:-/opt/dashuai}"
SERVER_DIR="$APP_DIR/server"
MARK="# dashuai-storage-gc"
LOG_DIR="${DASHUAI_LOG_DIR:-/var/log/dashuai}"
LOG_FILE="$LOG_DIR/storage-gc.log"
LOCK_FILE="/tmp/dashuai-storage-gc.lock"
CRON_TIME="${DASHUAI_GC_CRON:-30 4 * * *}"

log() { printf '\033[1;36m[install-cron] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[install-cron][error] %s\033[0m\n' "$*" >&2; exit 1; }

MODE="--delete"
case "${1:-}" in
  --uninstall)
    crontab -l 2>/dev/null | grep -v "$MARK" | crontab - || true
    log "已移除存储 GC 定时任务"
    exit 0
    ;;
  --dry-run) MODE="--dry-run" ;;
  "") ;;
  *) die "未知参数：$1（支持 --dry-run / --uninstall）" ;;
esac

[ -d "$SERVER_DIR" ] || die "找不到 $SERVER_DIR"
command -v crontab >/dev/null || die "系统没有 crontab（装 cron 或改用 systemd timer）"

NPX_BIN="$(command -v npx || true)"
[ -n "$NPX_BIN" ] || die "找不到 npx（Node 未安装或不在 PATH）"
FLOCK_BIN="$(command -v flock || true)"
[ -n "$FLOCK_BIN" ] || die "找不到 flock（util-linux），无法保证互斥，已中止"

mkdir -p "$LOG_DIR" 2>/dev/null || sudo mkdir -p "$LOG_DIR"
touch "$LOG_FILE" 2>/dev/null || true

# --dry-run 模式不给 --delete：脚本本身是「预演/执行」二态，靠参数决定
if [ "$MODE" = "--dry-run" ]; then
  GC_ARGS=""
  log "模式：只报告（不删除）"
else
  GC_ARGS="--delete"
  log "模式：报告 + 删除（保留期 24h、单轮上限 100、仅限允许前缀）"
fi

CMD="cd $SERVER_DIR && $FLOCK_BIN -n $LOCK_FILE $NPX_BIN tsx scripts/gc-orphan-objects.ts --abort-fragments $GC_ARGS >> $LOG_FILE 2>&1"
LINE="$CRON_TIME $CMD $MARK"

# 幂等：先按标记清掉旧行，再追加新行
TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -v "$MARK" > "$TMP" || true
printf '%s\n' "$LINE" >> "$TMP"
crontab "$TMP"
rm -f "$TMP"

log "已安装："
echo "    $LINE"
echo "    日志：$LOG_FILE"
log "查看：crontab -l"
log "立即试跑一次（先看报告）：bash $APP_DIR/deploy/install-cron.sh --dry-run && $NPX_BIN tsx $SERVER_DIR/scripts/gc-orphan-objects.ts"
