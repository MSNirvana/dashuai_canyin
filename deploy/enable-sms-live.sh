#!/usr/bin/env bash
# 把线上短信从「未启用」切到「真实发送」。**在服务器上跑**，不在本机跑。
#
# 跑法：ssh ubuntu@49.232.243.241 'bash -s' < deploy/enable-sms-live.sh
#       （或把文件传上去后 bash enable-sms-live.sh）
#
# 为什么需要它：短信链路的失败点全是**静默**的 ——
#   腾讯云 `SendSms` 失败也返回 HTTP 200、配置写错不抛异常、`SMS_PROVIDER` 写错大小写
#   会被当成「未配置」而已。所以本脚本的做法是：**要么全绿，要么一行都不改**。
#
# 三道自保（都是踩过的坑）：
#   ① `.env` 先备份 —— 这是线上唯一的环境变量来源，改坏了服务起不来。
#   ② 5 项里缺任意一项就**中止且不落盘** —— 半套配置比不配置更难查
#      （表现为「接口 200、没有短信」，而不是明确的 1004）。
#   ③ 只在值真的变化时才改文件 —— 幂等，重复跑不会把 `.env` 弄乱。
#
# ⚠ 不在本脚本里写任何密钥，也不回显密钥片段（只报「已设置 / 长度 N」）。
#   踩过的坑：用 `sed 's/=(.{0,8}).*/…/'` 做掩码会把 CJK 按**字节**切断 ⇒ 输出非法 UTF-8 变乱码；
#   而签名名恰好是中文。所以这里改成「非密钥原样打印、密钥只打印长度」。
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/dashuai/server/.env}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/dashuai-deploy-backups}"
PM2_APP="${PM2_APP:-dashuai-api}"

# 非密钥项（可安全回显）
PLAIN_KEYS=(SMS_PROVIDER TENCENT_SMS_SDK_APP_ID TENCENT_SMS_SIGN_NAME TENCENT_SMS_TEMPLATE_ID TENCENT_SMS_REGION)
# 凭据项（只报是否已设置 + 长度）
SECRET_KEYS=(TENCENT_SMS_SECRET_ID TENCENT_SMS_SECRET_KEY)
# 五项必备（缺一即视为「通道未配置」）
REQUIRED_KEYS=(
  TENCENT_SMS_SECRET_ID
  TENCENT_SMS_SECRET_KEY
  TENCENT_SMS_SDK_APP_ID
  TENCENT_SMS_SIGN_NAME
  TENCENT_SMS_TEMPLATE_ID
)

# 签名名必须与腾讯云侧**已过审**的那条逐字一致。第一次提交的「大帅餐饮管理」已被驳回，
# 后来改名为「廊坊大帅餐饮管理」才过审（同一个 SignId 721922）。
# 写错不会报「签名不对」，只会静默发不出去 —— 所以这里硬拦一次。
EXPECTED_SIGN_NAME="${EXPECTED_SIGN_NAME:-廊坊大帅餐饮管理}"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# 取某个键的当前值：去掉引号与首尾空白。同名键取最后一条（后写覆盖先写）。
envval() {
  local k="$1"
  grep -E "^${k}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- \
    | tr -d '"' | tr -d "'" | tr -d '[:space:]' || true
}

[ -f "$ENV_FILE" ] || die "找不到 $ENV_FILE（这个脚本要在服务器上跑）"

say '=== 一、改前现状 ==='
for k in "${PLAIN_KEYS[@]}"; do
  v="$(envval "$k")"
  printf '  %-26s = %s\n' "$k" "${v:-<空>}"
done
for k in "${SECRET_KEYS[@]}"; do
  v="$(envval "$k")"
  if [ -n "$v" ]; then
    printf '  %-26s = <已设置，长度 %s>\n' "$k" "${#v}"
  else
    printf '  %-26s = <空>\n' "$k"
  fi
done
if [ -n "$(envval SMS_TEST_CODE)" ]; then
  say '  测试码后门           = ⚠ 仍启用（白名单号收不到真实短信，验证必须用名单外的号）'
else
  say '  测试码后门           = 未启用'
fi
say ''

say '=== 二、前置校验（缺一即中止，不落盘）==='
missing=()
for k in "${REQUIRED_KEYS[@]}"; do
  [ -z "$(envval "$k")" ] && missing+=("$k")
done
if [ "${#missing[@]}" -gt 0 ]; then
  printf '  ✗ 缺失/为空：%s\n' "${missing[*]}"
  say ''
  say '  → 从你本机 server/.env 里把这几个键的整行复制过来、追加到服务器上的 .env 即可。'
  say '    本机这几项已是核对过的正确值（SDK_APP_ID 1401194004 /'
  say '    SIGN_NAME 廊坊大帅餐饮管理 / TEMPLATE_ID 2731941）。'
  die '配置不齐，未做任何修改'
fi
say '  ✓ 五项必备配置都在'

sign_now="$(envval TENCENT_SMS_SIGN_NAME)"
if [ "$sign_now" != "$EXPECTED_SIGN_NAME" ]; then
  printf '  ✗ TENCENT_SMS_SIGN_NAME = 「%s」\n' "$sign_now"
  printf '    期望「%s」—— 必须与腾讯云侧已过审的签名逐字一致（含地域前缀）。\n' "$EXPECTED_SIGN_NAME"
  say '    第一次提交的「大帅餐饮管理」已被驳回，写成它只会静默发不出去。'
  die '签名名疑似过期，未做任何修改'
fi
printf '  ✓ 签名名与已过审的一致（%s）\n' "$sign_now"
say ''

say '=== 三、备份 ==='
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/env.server.$(date +%Y%m%d-%H%M%S).bak"
cp -p "$ENV_FILE" "$BACKUP"
printf '  ✓ 已备份到 %s\n' "$BACKUP"
say ''

say '=== 四、切换 SMS_PROVIDER → tencent ==='
if [ "$(envval SMS_PROVIDER)" = 'tencent' ]; then
  say '  · 已是 tencent，无需改动'
elif grep -qE '^SMS_PROVIDER=' "$ENV_FILE"; then
  # 只替换**未被注释**的那一行；不动注释里的示例行
  awk '{ if ($0 ~ /^SMS_PROVIDER=/) print "SMS_PROVIDER=tencent"; else print }' "$ENV_FILE" > "$ENV_FILE.tmp"
  cat "$ENV_FILE.tmp" > "$ENV_FILE"
  rm -f "$ENV_FILE.tmp"
  say '  ✓ 已把原有的 SMS_PROVIDER 行改成 tencent'
else
  printf '\nSMS_PROVIDER=tencent\n' >> "$ENV_FILE"
  say '  ✓ 原文件没有该键，已追加 SMS_PROVIDER=tencent'
fi
say ''

say '=== 五、重启（--update-env 不能省，否则 PM2 仍用旧环境变量）==='
pm2 restart "$PM2_APP" --update-env
sleep 2
pm2 describe "$PM2_APP" | grep -E 'status|restarts|uptime' || true
say ''

say '=== 六、下一步（人工，脚本不代做）==='
say '  1) 核对「配置里写的」 vs 「腾讯云侧真实的」：'
say '       cd /opt/dashuai/server && npx tsx scripts/sms-status.ts'
say '     要看到签名与模板双绿（StatusCode 0）。'
say '  2) 真机验证**必须用不在白名单里的号** —— 白名单号走的是固定码分支，'
say '     收不到真实短信；拿它验证会看到「接口 200、没有短信」而误判成通道坏了。'
say '  3) 看服务端日志有没有 [SMS] 发送失败（失败原因只进日志，不回客户端）：'
printf '       pm2 logs %s --lines 80 | grep -i "\\[SMS\\]" || true\n' "$PM2_APP"
say '  4) 测试期结束、要关掉固定测试码后门时，删掉 .env 里这四行再重启：'
say '       SMS_TEST_CODE / SMS_TEST_CODE_PHONES / SMS_TEST_CODE_ALLOW_PROD / DEV_LOGIN'
say ''
printf '回滚：cp %s %s && pm2 restart %s --update-env\n' "$BACKUP" "$ENV_FILE" "$PM2_APP"
