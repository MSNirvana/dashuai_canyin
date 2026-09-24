// 平台适配层 · 唯一入口
//
// 用法（页面/组件/hooks）：
//   import { platform } from '../../platform'
//   const { code } = await platform.login()
//   platform.requestPayment({ ...payParams, success, fail })
//   if (platform.capabilities.chatFile) { /* 只在这一端渲染该入口 */ }
//
// ★★ 红线：本目录之外**禁止**出现 `IS_WEAPP` / `IS_DOUYIN` / `process.env.TARO_ENV`
//    之类的平台判断（src/config.ts 除外，它只导出 PLATFORM 供 X-Platform 头使用）。
//    这条红线由 scripts/check-platform-boundary.mjs 机械校验。
//
// 为什么 `./impl` 不带平台后缀：
//   Taro 的 MultiPlatformPlugin 会按 process.env.TARO_ENV 把 `./impl`
//   解析成 `impl.weapp.ts` / `impl.tt.ts` ⇒ **另一端那份根本不会进入本端产物**。
//   这既是为了包体积，也是为了避免「微信包里出现抖音的代码/字样」这类平台审核风险。
//   代价：tsc 不认识该机制，所以磁盘上需要一个永不执行的 `impl.ts` 兜底（见该文件）。

import { impl } from './impl'
import type { PlatformAdapter } from './types'

export const platform: PlatformAdapter = impl

export type {
  ChooseChatFileOptions,
  LoginCredential,
  PickedFile,
  PlatformAdapter,
  PlatformFeature,
  PlatformKind,
  RequestPaymentParams,
} from './types'
