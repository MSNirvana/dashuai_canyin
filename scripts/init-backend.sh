#!/bin/zsh
# 后端初始化：等 MySQL 健康 → .env → prisma db push → seed
cd /Users/gaoyunhong/WorkBuddy/2026-09-07-17-56-03/server || exit 1
export PATH=/Users/gaoyunhong/.workbuddy/binaries/node/versions/22.22.2-2/bin:$PATH

echo "==> [1/4] 等待 MySQL 健康（最多 90s）"
ok=0
for i in $(seq 1 18); do
  st=$(docker inspect --format '{{.State.Health.Status}}' dashuai-mysql 2>/dev/null)
  echo "    [$i] mysql health: $st"
  if [ "$st" = "healthy" ]; then ok=1; break; fi
  sleep 5
done
[ "$ok" = "1" ] || { echo "MySQL 未就绪，退出"; exit 1; }

echo "==> [2/4] 准备 .env"
[ -f .env ] || cp .env.example .env

echo "==> [3/4] prisma generate + db push"
./node_modules/.bin/prisma generate || exit 1
./node_modules/.bin/prisma db push --skip-generate || exit 1

echo "==> [4/4] 写入种子数据"
npm run db:seed || exit 1

echo "全部完成 ✅"
