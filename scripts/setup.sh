#!/usr/bin/env bash
# 大帅餐饮短视频工具 · 一键本地起栈
# 前置：Docker 已安装并启动（MySQL + Redis 走 docker-compose）
#
#   bash scripts/setup.sh
#
# 流程：复制 .env → 安装依赖 → 生成 Prisma Client → 建表 → 种子数据 → 启动开发服务
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT_DIR/server"
cd "$SERVER_DIR"

echo "==> [1/6] 准备 .env"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    已根据 .env.example 生成 .env（本地联调默认值：DEV_LOGIN=true / FFMPEG_WORKER=false / MOCK AI）"
else
  echo "    .env 已存在，跳过"
fi

echo "==> [2/6] 安装依赖"
npm install

echo "==> [3/6] 生成 Prisma Client"
npx prisma generate

echo "==> [4/6] 同步数据库表结构（prisma db push）"
if npx prisma db push --skip-generate; then
  echo "    建表成功"
else
  echo "    [警告] 建表失败：请确认 docker compose up -d 已启动且 MySQL 可连接（localhost:3306）"
  echo "           修复后重新运行本脚本即可。"
  exit 1
fi

echo "==> [5/6] 写入种子数据（AI 通道/场景 + 充值档位 + 会员套餐 + 演示商家 13800000000）"
npm run db:seed

echo "==> [6/6] 启动开发服务（Ctrl+C 退出）"
npm run dev
