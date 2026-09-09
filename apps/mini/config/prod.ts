import type { UserConfigExport } from '@tarojs/cli'

export default {
  logger: {
    quiet: false,
    stats: true,
  },
  mini: {
    webpackChain() {},
  },
  h5: {},
} satisfies UserConfigExport
