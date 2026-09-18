#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 一次性运维动作：把「结构已经用 `prisma db push` 建好、但没有迁移记录」的库
# 登记成迁移基线（baseline）。
#
#   预演（只体检、只打印，不写任何记录）：
#     bash deploy/db-baseline.sh --until <迁移名>
#   真正写入：
#     bash deploy/db-baseline.sh --until <迁移名> --yes
#   改完之后断言「库结构 == schema」：
#     bash deploy/db-baseline.sh --verify
#
# ★★ 为什么必须显式给截止点（本脚本的安全核心）：
#   `prisma migrate resolve --applied <m>` **不校验该迁移的 DDL 是否真的已在库里** ——
#   它只往 _prisma_migrations 写一行。所以一旦把「库里还没有的迁移」也标成 applied，
#   这些迁移就**永远不会被执行**，库结构从此与 schema 静默脱节；Prisma 不会报错，
#   直到某条代码路径去查那个不存在的列才炸 `Unknown column`。
#   最容易踩的写法是：`git pull` **带来新迁移之后**再无脑跑 `db-baseline.sh --yes`，
#   于是连新迁移一起标掉。⇒ 截止点必须由人明确声明，脚本不替你猜。
#
#   本项目 2026-09-18 首次接入迁移历史时的真实调用：
#     # 线上库当时只有 1 个迁移有记录（20260909120000_add_dish_video_key），
#     # 其余 11 个老迁移的 DDL 早已被 db push 建好但没有记录。
#     bash deploy/db-baseline.sh --until 20260914210000_add_ai_call_log_absorbed_beans        # 预演
#     bash deploy/db-baseline.sh --until 20260914210000_add_ai_call_log_absorbed_beans --yes  # 写入
#     bash deploy/deploy.sh                                     # 应用剩下的 4 个新迁移
#     bash deploy/db-baseline.sh --verify                       # 断言结构一致
#
# ⚠ 前提：执行前必须确认「库结构 == 截止点那个迁移时的 schema」。步骤 ② 会打印
#   `库 → schema` 差异供人工过眼。**这条判据很硬**：把代码切回截止点那个提交，
#   在 `server/` 下跑
#     npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
#                             --to-schema-datamodel prisma/schema.prisma --exit-code
#   应当返回 **0（无差异）**。返回 2 说明库不是从这些迁移演进过来的，
#   **不要** baseline，改用 `migrate diff` 生成一份真正的补差迁移。
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${DASHUAI_APP_DIR:-/opt/dashuai}"
SERVER_DIR="$APP_DIR/server"
APPLY=0
UNTIL=""
ALL=0
VERIFY=0

usage() {
  cat <<'EOT'
用法：
  bash deploy/db-baseline.sh --until <迁移名>              # 预演（不写记录）
  bash deploy/db-baseline.sh --until <迁移名> --yes        # 真正写入
  bash deploy/db-baseline.sh --all --yes                   # ★ 危险：标记全部迁移
  bash deploy/db-baseline.sh --verify                      # 断言「库结构 == schema」

--until <迁移名>   基线划到该迁移（**含**）。迁移目录名带时间戳前缀，字典序即时间序。
--all              把 prisma/migrations 下**全部**迁移标为已应用。仅在你确知库里已有全部结构时用。
--verify           只做断言，不改任何东西；库结构与 schema 不一致则非 0 退出。
EOT
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --yes)     APPLY=1 ;;
    --all)     ALL=1 ;;
    --verify)  VERIFY=1 ;;
    --until)   UNTIL="${2:-}"; [ -n "$UNTIL" ] || { echo "--until 后面要跟迁移目录名" >&2; exit 1; }; shift ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

log()  { printf '\n\033[1;36m[db-baseline] %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[db-baseline][warn] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[db-baseline][error] %s\033[0m\n' "$*" >&2; exit 1; }

diff_to_schema() {   # 库 → schema；--script 打印 SQL（无差异时输出 "-- This is an empty migration."）
  npx prisma migrate diff \
    --from-schema-datasource prisma/schema.prisma \
    --to-schema-datamodel prisma/schema.prisma "$@"
}

[ -d "$SERVER_DIR/prisma/migrations" ] || die "找不到 $SERVER_DIR/prisma/migrations"
cd "$SERVER_DIR"

# ─────────────── --verify：断言「库结构 == schema」 ───────────────
if [ "$VERIFY" = "1" ]; then
  log "断言：库结构 == prisma/schema.prisma"
  if diff_to_schema --exit-code >/dev/null 2>&1; then
    log "✅ 无差异：库结构与 schema 完全一致（迁移历史可信）"
    exit 0
  fi
  warn "差异内容："
  diff_to_schema --script || true
  die "❌ 库结构与 schema 仍有差异 —— 通常意味着有迁移被标记成 applied 但实际没执行。
   排查：npx prisma migrate status
   修法：为缺失的那部分**新增一个迁移文件**（npx prisma migrate dev --create-only），
        不要手改库、也不要再加 migrate resolve。"
fi

log "① 当前迁移状态"
npx prisma migrate status || true

log "② 库 → schema 差异（体检，务必人工过一眼）"
diff_to_schema --script || die "migrate diff 失败：数据库不可达或 .env 有问题"

# 迁移目录名带时间戳前缀 ⇒ 字典序 == 时间序
MIGRATIONS=()
while IFS= read -r d; do MIGRATIONS+=("$d"); done < <(
  find prisma/migrations -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
)
[ "${#MIGRATIONS[@]}" -gt 0 ] || die "prisma/migrations 下没有迁移目录"

if [ "$ALL" = "1" ]; then
  warn "--all：把**全部 ${#MIGRATIONS[@]} 个**迁移标为已应用（危险）"
  TARGET=("${MIGRATIONS[@]}")
elif [ -n "$UNTIL" ]; then
  TARGET=()
  hit=0
  for m in "${MIGRATIONS[@]}"; do
    TARGET+=("$m")
    if [ "$m" = "$UNTIL" ]; then hit=1; break; fi
  done
  if [ "$hit" != "1" ]; then
    printf '找不到迁移：%s\n   可用的迁移目录：\n' "$UNTIL" >&2
    for m in "${MIGRATIONS[@]}"; do printf '     %s\n' "$m" >&2; done
    exit 1
  fi
else
  log "③ 未给截止点 —— 只打印，不写任何记录"
  echo "    可用迁移（按时间序，共 ${#MIGRATIONS[@]} 个）："
  for m in "${MIGRATIONS[@]}"; do echo "      $m"; done
  echo
  echo "★★ 脚本不会替你决定基线划在哪（给错 = 把新迁移永久标掉，见文件头）。"
  echo "   确认 ② 的差异只含「尚未应用的新迁移」后，明确声明截止点："
  echo
  echo "     bash deploy/db-baseline.sh --until <最后一个「库里已存在」的迁移> --yes"
  echo
  exit 0
fi

# 基线之后仍待应用的迁移 = TARGET 末尾之后的那些
target_last="${TARGET[${#TARGET[@]}-1]}"
PENDING=()
seen_last=0
for m in "${MIGRATIONS[@]}"; do
  if [ "$seen_last" = "1" ]; then PENDING+=("$m"); continue; fi
  if [ "$m" = "$target_last" ]; then seen_last=1; fi
done

log "③ 将标记为「已应用」的迁移（${#TARGET[@]} 个）"
for m in "${TARGET[@]}"; do echo "    $m"; done

log "④ 基线之后仍会【待应用】的迁移（${#PENDING[@]} 个）"
if [ "${#PENDING[@]}" -eq 0 ]; then
  warn "一个都不剩 —— 基线覆盖了全部迁移。"
  warn "若你刚 git pull 带来新迁移，说明截止点给大了，那些新迁移会被永久跳过！"
else
  for m in "${PENDING[@]}"; do echo "    $m"; done
  echo "    ⇒ 这些由 deploy.sh 的 migrate deploy 真正执行。"
fi

if [ "$APPLY" != "1" ]; then
  log "预演结束，未写入任何记录。确认无误后加 --yes 重跑。"
  exit 0
fi

log "⑤ 写入迁移记录"
for m in "${TARGET[@]}"; do
  if npx prisma migrate resolve --applied "$m" >/dev/null 2>&1; then
    echo "    已标记 $m"
  else
    echo "    跳过 $m（可能已标记过）"
  fi
done

log "⑥ 复核"
npx prisma migrate status || true

warn "基线只负责「把事实上已生效的迁移登记上」，**不保证库结构真的对得上**。"
warn "跑完 deploy.sh（它内部会 migrate deploy）之后，必须再执行："
warn "    bash deploy/db-baseline.sh --verify"
log "完成。"
