#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 迁移前数据库备份（deploy.sh 在 migrate deploy 之前调用）
#
#   在服务器上执行：bash deploy/backup-db.sh
#
# 为什么必须有这一步：迁移是不可逆的结构变更，出问题时唯一能回去的路就是这份 dump。
# 备份落在 ~/dashuai-deploy-backups/<时间戳>/，与代码回滚材料放在一起。
#
# ★ 密码不落盘、不上命令行：从**容器内**的 MYSQL_ROOT_PASSWORD 读取，
#   宿主机的 ps / shell 历史里都不会出现口令（docker-compose.override.yml 是本机专属的，
#   密码只存在于容器环境变量中）。
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

CONTAINER="${DASHUAI_MYSQL_CONTAINER:-dashuai-mysql}"
DB="${DASHUAI_DB_NAME:-dashuai}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${DASHUAI_BACKUP_DIR:-$HOME/dashuai-deploy-backups/$STAMP}"

log() { printf '\033[1;36m[backup-db] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[backup-db][error] %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "未安装 Docker"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "容器 $CONTAINER 不存在或未运行"

mkdir -p "$OUT_DIR"
SQL_FILE="$OUT_DIR/${DB}.sql"

log "导出 ${DB} → ${SQL_FILE}"
# --single-transaction：InnoDB 下不加表锁、拿到一致性快照（部署期间业务写入不会被长时间阻塞）
# --routines --triggers：这两类对象不在表数据里，漏了就恢复不出完整库
if ! docker exec "$CONTAINER" sh -c \
  'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers --databases "$0"' \
  "$DB" > "$SQL_FILE"; then
  rm -f "$SQL_FILE"
  die "mysqldump 执行失败（检查容器 $CONTAINER 是否 healthy）"
fi

[ -s "$SQL_FILE" ] || die "备份文件为空：$SQL_FILE"

# 完整性自查：一个正常的 dump 必然包含建表语句与库声明
if ! grep -q "CREATE TABLE" "$SQL_FILE"; then
  rm -f "$SQL_FILE"
  die "备份内容异常（没有 CREATE TABLE），已删除产物"
fi
if ! grep -q "CREATE DATABASE" "$SQL_FILE"; then
  log "提示：dump 里没有 CREATE DATABASE（用 --databases 时应存在），恢复时请手工建库"
fi

gzip -f "$SQL_FILE"
SIZE="$(du -h "$SQL_FILE.gz" | cut -f1)"
log "完成：$SQL_FILE.gz（$SIZE）"
log "恢复方式：gunzip -c $SQL_FILE.gz | docker exec -i $CONTAINER sh -c 'exec mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\"'"
