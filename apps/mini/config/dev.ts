import type { UserConfigExport } from '@tarojs/cli'

export default {
  logger: {
    quiet: false,
    stats: true,
  },
  mini: {
    // 微信基础库不提供 React 的 jsxDEV runtime；开发包也使用生产 JSX 变换。
    debugReact: false,
    webpackChain() {},
  },
  h5: {},
} satisfies UserConfigExport
