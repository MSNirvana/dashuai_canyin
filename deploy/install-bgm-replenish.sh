#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 安装「配乐池补货」的定时任务（幂等）。
#
#   bash deploy/install-bgm-replenish.sh                    # 安装（每日 04:40，单次每风格补 1 首、不轮换）
#   bash deploy/install-bgm-replenish.sh --max=2            # 单次每风格最多补 2 首（更费钱）
#   bash deploy/install-bgm-replenish.sh --rotate=5         # 每天每风格轮换 5 首（见下方「轮换」）
#   bash deploy/install-bgm-replenish.sh --rotate=5 --rotate-cooldown=12   # 冷却期改成 12 小时
#   bash deploy/install-bgm-replenish.sh --cron='20 5 * * 0'  # 改周期（例：每周日 05:20）
#   bash deploy/install-bgm-replenish.sh --check            # 只看现状，不改动
#   bash deploy/install-bgm-replenish.sh --uninstall        # 移除任务（保留日志与池子）
#
# ── 为什么必须有调度 ────────────────────────────────────────────
# 渲染时的配乐是**毫秒级读本地文件**：`worker.ts` → `resolveBgmTrack(风格)` →
# `assets/bgm/<风格>/` 里随机抽一首。这带来一个**结构性**后果：
#   **池子里有几首，出片就有几种配乐。**
# 补货脚本（`server/scripts/bgm-replenish.ts`）本身早就写好了 —— 但它只是个**手工命令**。
# 没有调度 ⇒ 池子永远停在「首次手工生成的那几首」⇒ 用户诉求
# 「不是三首固定曲子，而是…随机获取」只兑现了前半句。**这个安装器补的就是这一步。**
#
# ── 它装什么 ────────────────────────────────────────────────────
# 一条 **ubuntu 用户**的 crontab 任务（按 `# dashuai-bgm-replenish` 标记行幂等替换）：
#
#   cd /opt/dashuai/server && flock -n -E 75 <锁> npx tsx scripts/bgm-replenish.ts \
#       --yes --max=<N> --rotate=<R> --rotate-cooldown=<H> >> /var/log/dashuai/bgm-replenish.log 2>&1
#
# 与 `deploy/install-cron.sh`（存储 GC）同一套骨架：flock 互斥、日志落
# `/var/log/dashuai`、按标记行替换而**绝不用 `crontab -` 覆盖**其他任务。
#
# ── 它是「花钱」的任务，代价上界是明确的 ────────────────────────
# 火山按秒计费：约 0.002 元/秒 ⇒ 120s 一首 ≈ **0.24 元**。
#   · 只在「池内 < 目标」时才生成，目标 = `BGM_POOL_TARGET`（`src/render/bgm-library.ts`，
#     2026-09-28 起为 **100** —— 依据是「同一门店连续出片的重样概率」这条生日问题曲线，
#     见该常量上方的注释）；**补满之后每轮零花费**（脚本会走「正好 ⇒ 不动」分支，只打一行日志）
#   · 单轮每风格最多 `--max` 首 ⇒ 单轮上界 = 3 风格 × N × 0.24 元（默认 N=1 ⇒ **≈0.72 元**）
#     ★ 开了轮换之后上界是 `3 × (max + rotate) × 0.24 元`（删掉的那几首也要重新生成）。
#   · ★★ 首次把池子填到 100 首/风格（≈300 首、≈72 元、约 2.3 小时）**不要靠这个定时任务慢慢补**
#     —— 每轮 3 首要好几个月。用一次性批量补，且**逐风格分开跑**：
#       cd /opt/dashuai/server && npx tsx scripts/bgm-replenish.ts --yes --target=100 --max=70 --style=LIGHT
#     ★ 为什么要 `--style` 逐个来、不用 `ALL`：脚本把「账号侧不可用」（额度用尽/未开通）
#       判成 `aborted` 后是 `break` 跳出**整个风格循环** ⇒ 用 `ALL` 时第一个风格崩了，
#       另外两个风格会**一首都不生成**，而日志看起来只是"这一轮提前结束"。
#     定时任务的职责是「池子掉了就补回来」，不是首次填充。
#   · ★★ 它**没有「换血」档位**，也**没有「每天加 N 首」档位**：补满后池子是**冻结**的。
#     想让池子持续进新曲子，只有一条路 —— 调大 `BGM_POOL_TARGET`（并先加词，见下条）。
#   · 池内**超额**时它会**淘汰最旧的**（保留最新 N 首）。★ 若哪天把 `BGM_POOL_TARGET`
#     调小，下一次调度就会按新目标删掉多出来的曲子 —— 这是**静默删除**，改常量前先想清楚。
#   ⇒ 稳态成本 0；最坏情况（提示词打偏、每轮都失败）才是 0.72 元/天。
#
# ── ★★ 轮换（`--rotate=N`，默认 0 = 不轮换）────────────────────────
# 「池子满了」不等于「用户不会再听到重复」：池子 100 首对**一家门店**是 100 个候选，
# 但它听过的那几首会被一直避开（`bgm-history.ts` 的「用过的全避」）⇒ 这家店还能听到的
# **新鲜曲目只会越来越少**。轮换补的就是这一块：**每天淘汰几首「已经有人听过的」、
# 用新曲子顶上来**（判据与顺序见 `server/src/render/bgm-library.ts::planBgmRotation`）。
#
#   · **只淘汰「被派发过」的曲子**（来源是 `render_task.bgm_track`）。淘汰一首谁都没用过的
#     曲子是**纯亏**：没有任何门店因此多听到一首新的。淘汰「听过的」，每一家听过的门店才**净增一首**。
#   · **都没有用过 ⇒ 本轮不动**。新池子刚建好时正是这个状态，这时轮换只会平白烧钱。
#   · **`--max` 必须 ≥ `--rotate`**：轮换是「先删 N 首、再由补货补回 N 首」，`--max` 小于 N
#     就补不满 ⇒ 池子一天掉一点。本安装器默认让两者取同一个值。
#   · **池内没满时不轮换**（先删后补，补失败就是净减 ⇒ 不许在没有余量时动手）。
#   · 成本：`--rotate=5` × 3 风格 × 0.24 元 ≈ **3.6 元/天 ≈ 108 元/月**；**磁盘不涨**（删 5 补 5）。
#     默认 0 ⇒ 不显式要求就**不轮换、不多花一分钱**。
#
# ── 判活（一行）─────────────────────────────────────────────────
#   tail -3 /var/log/dashuai/bgm-replenish.log
#     `rc=0` → 正常（含「补满后什么都没做」）
#     `rc=75` → 上一轮还没跑完，本轮**跳过**（flock 冲突码，**不是故障**）
#     其他 rc → 真失败，看同一文件里本轮输出
#
# ── 磁盘 ────────────────────────────────────────────────────────
# 火山 GenBGM 返回的是 **16bit/44.1kHz 立体声 WAV ≈ 21 MB/首（120s）**。
# 本机实测：曲库根目录 177G 里用了 6% ⇒ **300 MB 量级不值得为它换 mp3**
# （换格式要重写 ingest 的落盘与元数据、并重生成已有曲子，收益是省 0.2% 磁盘）。
# 所以维持 WAV，**不做转码**。
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${DASHUAI_APP_DIR:-/opt/dashuai}"
SERVER_DIR="$APP_DIR/server"
MARK="# dashuai-bgm-replenish"
LOG_DIR="${DASHUAI_LOG_DIR:-/var/log/dashuai}"
LOG_FILE="$LOG_DIR/bgm-replenish.log"
CRON_LOG="$LOG_DIR/bgm-replenish.cron.log"
LOCK_FILE="/tmp/dashuai-bgm-replenish.lock"
CRON_TIME="${DASHUAI_BGM_CRON:-40 4 * * *}"
MAX_PER_RUN="${DASHUAI_BGM_MAX:-1}"
ROTATE_PER_RUN="${DASHUAI_BGM_ROTATE:-0}"
ROTATE_COOLDOWN="${DASHUAI_BGM_ROTATE_COOLDOWN:-6}"
CONFLICT_RC=75

log() { printf '\033[1;36m[install-bgm-replenish] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[install-bgm-replenish][error] %s\033[0m\n' "$*" >&2; exit 1; }

MODE="install"
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) crontab -l 2>/dev/null | grep -v "$MARK" | crontab - || true
                 log "已移除配乐补货定时任务（保留 $LOG_FILE 与曲库）"; exit 0 ;;
    --check)     MODE="check" ;;
    --cron=*)    CRON_TIME="${1#*=}" ;;
    --max=*)     MAX_PER_RUN="${1#*=}" ;;
    --rotate=*)  ROTATE_PER_RUN="${1#*=}" ;;
    --rotate-cooldown=*) ROTATE_COOLDOWN="${1#*=}" ;;
    *)           die "未知参数：$1（支持 --cron='分 时 日 月 周' / --max=N / --rotate=N / --rotate-cooldown=小时 / --check / --uninstall）" ;;
  esac
  shift
done

[ -d "$SERVER_DIR" ] || die "找不到 $SERVER_DIR"
command -v crontab >/dev/null || die "系统没有 crontab（装 cron 或改用 systemd timer）"
NPX_BIN="$(command -v npx || true)"
[ -n "$NPX_BIN" ] || die "找不到 npx（Node 未安装或不在 PATH）"
FLOCK_BIN="$(command -v flock || true)"
[ -n "$FLOCK_BIN" ] || die "找不到 flock（util-linux），无法保证互斥，已中止"

# ★ -E（冲突退出码）不是所有 flock 都有；没有就退回默认（冲突时也返回 1），
#   此时「跳过」和「失败」在日志里无法区分 —— 所以宁可在这里先探明。
FLOCK_ARGS="-n"
if "$FLOCK_BIN" --help 2>&1 | grep -q -- '--conflict-exit-code\|-E'; then
  FLOCK_ARGS="-n -E $CONFLICT_RC"
else
  log "⚠ 本机 flock 不支持 -E（冲突退出码）：锁冲突将与真失败同为 rc=1，日志里分不开"
fi

# ── --check：只读体检 ──────────────────────────────────────────
if [ "$MODE" = "check" ]; then
  log "服务器目录：$SERVER_DIR"
  log "crontab 相关行："
  crontab -l 2>/dev/null | grep "$MARK" || echo "  (未安装)"
  log "曲库现状："
  if [ -d "$SERVER_DIR/assets/bgm" ]; then
    du -sh "$SERVER_DIR/assets/bgm" 2>/dev/null || true
    for style in LIGHT UPBEAT PREMIUM; do
      printf '  %-8s 池内 %s 首  单文件 %s\n' "$style" \
        "$(ls -1 "$SERVER_DIR/assets/bgm/$style" 2>/dev/null | grep -cE '\.(mp3|m4a|aac|wav|flac|ogg|opus)$' || true)" \
        "$(ls -1 "$SERVER_DIR/assets/bgm/$style".* 2>/dev/null | grep -v '\.json$' | head -1 || true)"
    done
  else
    echo "  (没有曲库目录)"
  fi
  log "日志末尾："
  tail -3 "$LOG_FILE" 2>/dev/null || echo "  (暂无)"
  exit 0
fi

mkdir -p "$LOG_DIR" 2>/dev/null || die "无法创建 $LOG_DIR（需要写权限）"
touch "$LOG_FILE" "$CRON_LOG" 2>/dev/null || true

# ★★ `--max` 与 `--rotate` 的**数值关系**在这里兜住：轮换是「先删 N 首、再由补货补回 N 首」，
#   若 `--max < --rotate`，删掉的那几首补不满 ⇒ 每天净减。宁可在这里自动抬高 `--max`，
#   也不要留下一个「看着配了、实际每天掉几首」的定时任务（掉到 0 就是全员没配乐）。
EFFECTIVE_MAX="$MAX_PER_RUN"
if [ "$ROTATE_PER_RUN" -gt "$EFFECTIVE_MAX" ] 2>/dev/null; then
  EFFECTIVE_MAX="$ROTATE_PER_RUN"
  log "⚠ --rotate=$ROTATE_PER_RUN > --max=$MAX_PER_RUN ⇒ 自动把 --max 抬到 $ROTATE_PER_RUN（否则每轮补不满、池子会一天掉一点）"
fi

CMD="cd $SERVER_DIR && $FLOCK_BIN $FLOCK_ARGS $LOCK_FILE $NPX_BIN tsx scripts/bgm-replenish.ts --yes --max=$EFFECTIVE_MAX --rotate=$ROTATE_PER_RUN --rotate-cooldown=$ROTATE_COOLDOWN"
# ① 先把本轮输出落到主日志；② 再把退出码单独记一行（**不写 rc 就分不出「补满没做事」和「崩了」**）；
# ③ 日志瘦身到最近 400 行；④ **最后 `exit $rc` 把真实退出码还原给 cron**。
#   ★ ④ 是必须的：③ 的 `mv` 一旦执行成功，整行的退出码就变成 0 ——
#     **cron 永远看不到失败**（实测确认：锁冲突那轮外层 rc 也是 0）。
#     本机没有邮件通道，将来要靠 `systemd` / 告警钩子接住失败时，这个退出码就是唯一接口。
#   ★ 锁冲突（rc=$CONFLICT_RC）也会让退出码非 0。日跑任务里冲突几乎不发生（只有上一轮超过 24h 才可能），
#     所以不值得为它单独抹平 —— 真出现了本来就该有人看一眼。
# ★ crontab 行里**绝不能出现 `%`**（cron 把它当换行符）⇒ 时间戳必须用 `date --iso-8601=seconds`。
STAMP='$(date --iso-8601=seconds)'
LINE="$CRON_TIME $CMD >> $LOG_FILE 2>&1; rc=\$?; echo \"[bgm-replenish] rc=\$rc $STAMP\" >> $LOG_FILE; tail -n 400 $LOG_FILE > $LOG_FILE.tmp 2>/dev/null && mv $LOG_FILE.tmp $LOG_FILE 2>/dev/null; exit \$rc $MARK"

TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -v "$MARK" > "$TMP" || true
printf '%s\n' "$LINE" >> "$TMP"
crontab "$TMP"
rm -f "$TMP"

log "已安装："
echo "    $LINE"
echo "    周期：$CRON_TIME    单轮每风格最多：$EFFECTIVE_MAX 首    轮换：每风格 $ROTATE_PER_RUN 首/轮（冷却 ${ROTATE_COOLDOWN} 小时）"
echo "    单轮上界约 $(awk -v n="$EFFECTIVE_MAX" -v r="$ROTATE_PER_RUN" 'BEGIN{printf "%.2f", (n+r)*3*0.24}') 元（补货 + 轮换各按满额算）"
echo "    日志：$LOG_FILE"

# ── 自证：跑一次**只读**的 --list ──────────────────────────────
# ★★ 这里**绝不能**用 `--yes` —— 安装动作顺手花钱是不可接受的。
#   但也不能什么都不跑：cron 的 PATH/工作目录/prisma 连接这些问题**只有真跑一次才暴露**，
#   否则等于把一个没验过的任务留在机器上（`--list` 会真实导入 db 模块并连库，足以证明链路通）。
log "自证：跑一次只读的 --list（不生成、不花钱）..."
if (cd "$SERVER_DIR" && "$NPX_BIN" tsx scripts/bgm-replenish.ts --list); then
  log "自证通过（池子可读、依赖齐备）"
else
  log "⚠ 自证失败 —— cron 装上了但跑不通，先修上面这个错再等调度"
fi

log "查看：crontab -l | grep '$MARK'"
log "体检：bash $0 --check"
log "判活：tail -3 $LOG_FILE   （rc=0 正常 / rc=$CONFLICT_RC 上一轮未结束跳过 / 其他为失败）"
log "看本轮真实输出：tail -40 $LOG_FILE"
