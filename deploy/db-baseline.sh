#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 一次性运维动作：把「结构已经用 `prisma db push` 建好、但没有迁移记录」的库
# 登记成迁移基线（baseline）。
#
#   在服务器上执行：bash deploy/db-baseline.sh            # 只体检 + 打印将要标记的迁移
#                   bash deploy/db-baseline.sh --yes      # 真正写入迁移记录
#
# 为什么需要它：本项目的库历史上一直用 `db push` 对齐结构，`prisma/migrations/` 里的
# 迁移**从未被登记**过。直接跑 `migrate deploy` 会尝试重放全部历史迁移 ⇒ 表已存在 ⇒ 报错。
# 正确做法是先把这些「事实上已经生效」的迁移标记为 applied，之后 deploy.sh 只需要
# 应用**新增**迁移即可。（deploy.sh 已不再自动回退 db push —— 见那里的说明。）
#
# ⚠ 前提：执行前必须确认「库结构 == 这些历史迁移的结果」。脚本会先打印
#   `库 → schema` 的差异，差异里只应剩下**尚未应用的新迁移**要改的东西。
#   如果差异里出现了历史迁移本该建好的列/表，说明这个库不是从这些迁移演进过来的，
#   **不要** baseline，改用 `migrate diff` 生成一份真正的补差迁移。
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${DASHUAI_APP_DIR:-/opt/dashuai}"
SERVER_DIR="$APP_DIR/server"
APPLY=0
[ "${1:-}" = "--yes" ] && APPLY=1

log()  { printf '\n\033[1;36m[db-baseline] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[db-baseline][error] %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$SERVER_DIR/prisma/migrations" ] || die "找不到 $SERVER_DIR/prisma/migrations"
cd "$SERVER_DIR"

log "① 当前迁移状态"
npx prisma migrate status || true

log "② 库 → schema 差异（体检，务必人工过一眼）"
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script || die "migrate diff 失败：数据库不可达或 .env 有问题"

MIGRATIONS=()
for d in prisma/migrations/*/; do
  [ -d "$d" ] || continue
  MIGRATIONS+=("$(basename "$d")")
done
[ "${#MIGRATIONS[@]}" -gt 0 ] || die "prisma/migrations 下没有迁移目录"

log "③ 将要标记为「已应用」的迁移（${#MIGRATIONS[@]} 个）"
for m in "${MIGRATIONS[@]}"; do echo "    $m"; done

if [ "$APPLY" != "1" ]; then
  log "预演结束，未写入任何记录。确认上面差异只含【新增迁移】后，加 --yes 重跑。"
  exit 0
fi

log "④ 写入迁移记录"
for m in "${MIGRATIONS[@]}"; do
  if npx prisma migrate resolve --applied "$m" >/dev/null 2>&1; then
    echo "    已标记 $m"
  else
    echo "    跳过 $m（可能已标记过）"
  fi
done

log "⑤ 复核"
npx prisma migrate status || true
log "完成。此后 deploy.sh 只会应用新增迁移。"
