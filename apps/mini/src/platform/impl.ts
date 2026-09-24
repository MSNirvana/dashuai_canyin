// 平台适配层 · 兜底文件（★ 正常构建永远不会执行到这里）
//
// 为什么需要它：`./index.ts` 里写的是 `import { impl } from './impl'`（不带平台后缀），
// Taro 构建时由 webpack 的 MultiPlatformPlugin（@tarojs/runner-utils）按
// `process.env.TARO_ENV` 解析成 `impl.weapp.ts` / `impl.tt.ts`；
// 但 **tsc 与 IDE 不认识这个机制**，所以磁盘上必须存在一个 `impl.ts` 才能解析。
//
// 设计取舍：这里**故意抛错**，而不是转发到某一个端的实现。
//   若某个端缺少 `impl.<该端>.ts`，构建会静默落到这里 —— 此时必须响亮失败，
//   而不是让它退化成微信语义（那会让新端带着错的假设一路做到上架）。
//
// 源码级红线由 scripts/check-platform-boundary.mjs 保证；产物级由
// scripts/verify-weapp-dist.mjs 断言（微信产物里不得出现这里的标记串）。

import type { PlatformAdapter } from './types'

throw new Error(
  `platform-impl-missing: 没有当前端的适配实现，请新增 src/platform/impl.${process.env.TARO_ENV ?? 'unknown'}.ts`,
)

export const impl = undefined as unknown as PlatformAdapter
