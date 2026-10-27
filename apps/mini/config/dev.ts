import type { UserConfigExport } from '@tarojs/cli'
import { attachIconFontEmbedder } from './embed-icon-font'

export default {
  logger: {
    quiet: false,
    stats: true,
  },
  mini: {
    // 微信基础库不提供 React 的 jsxDEV runtime；开发包也使用生产 JSX 变换。
    debugReact: false,
    /**
     * ★ 本地 watch / 预览包也必须有这一步：`icon.wxss` 每次编译都会被 copy 插件
     *   从 node_modules 覆盖回「远程字体」那一版，真机上是图标全空、且不报错。
     *   细节与踩坑记录见 config/embed-icon-font.ts。
     */
    webpackChain(chain) {
      attachIconFontEmbedder(chain)
    },
  },
  h5: {},
} satisfies UserConfigExport
