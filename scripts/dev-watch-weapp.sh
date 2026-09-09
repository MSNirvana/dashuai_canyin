#!/bin/zsh
# dev watch 构建（NODE_ENV=development → BASE_URL=http://localhost:3000）
# 等价于 cd apps/mini && npm run dev:weapp，进程常驻、改动自动重编译
cd /Users/gaoyunhong/WorkBuddy/2026-09-07-17-56-03/apps/mini || exit 1
export PATH=/Users/gaoyunhong/.workbuddy/binaries/node/versions/22.22.2-2/bin:$PATH
export NODE_OPTIONS=--max-old-space-size=4096
exec ./node_modules/.bin/taro build --type weapp --watch
