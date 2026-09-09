#!/bin/zsh
# 一次性 dev 模式构建 weapp（NODE_ENV=development → BASE_URL=localhost:3000）
cd /Users/gaoyunhong/WorkBuddy/2026-09-07-17-56-03/apps/mini || exit 1
export PATH=/Users/gaoyunhong/.workbuddy/binaries/node/versions/22.22.2-2/bin:$PATH
export NODE_ENV=development
export NODE_OPTIONS=--max-old-space-size=4096
./node_modules/.bin/taro build --type weapp
