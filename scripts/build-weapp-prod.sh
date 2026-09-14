#!/usr/bin/env bash
# 小程序「正式域名」出包 —— 用于上传体验版 / 正式版
#
#   bash scripts/build-weapp-prod.sh https://api.example.com/api/v1
#
# 为什么不用 apps/mini/.env：
#   那个文件里写的是本地联调地址，且 .env.local 优先级高于 .env，
#   直接改会污染本地开发。这里用命令行环境变量覆盖（config/index.ts 里
#   process.env.TARO_APP_API_BASE_URL 优先级最高），互不影响。
set -euo pipefail

API_BASE="${1:-}"
if [ -z "$API_BASE" ]; then
  echo "用法: bash scripts/build-weapp-prod.sh https://api.<你的域名>/api/v1" >&2
  exit 1
fi

case "$API_BASE" in
  https://*) ;;
  *)
    echo "错误: 小程序真机只接受 HTTPS。当前值：$API_BASE" >&2
    exit 1
    ;;
esac

if printf '%s' "$API_BASE" | grep -q ':\([0-9]\+\)/'; then
  echo "错误: 合法域名不能带端口号。当前值：$API_BASE" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/apps/mini"

echo "==> 构建微信小程序（体验版/正式域名）"
echo "    TARO_APP_API_BASE_URL=$API_BASE"

export NODE_ENV=production
export TARO_APP_API_BASE_URL="$API_BASE"
export NODE_OPTIONS=--max-old-space-size=4096

if [ ! -d node_modules ]; then
  echo "==> 安装依赖"
  npm install
fi

npx taro build --type weapp

echo ""
echo "==> 构建完成：apps/mini/dist/weapp"
echo "    下一步：用微信开发者工具打开 apps/mini（miniprogramRoot=dist/weapp），"
echo "            确认「详情 → 本地设置」里 已勾选 不校验合法域名（仅本地预览用），"
echo "            然后点「上传」→ 填版本号 → 到 mp.weixin.qq.com 设为体验版。"
