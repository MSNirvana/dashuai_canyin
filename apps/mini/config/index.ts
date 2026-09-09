import { defineConfig, type UserConfigExport } from '@tarojs/cli'
import devConfig from './dev'
import prodConfig from './prod'

// Taro 4 配置：一套代码编译微信 / 抖音两端
export default defineConfig(async (merge, { mode }) => {
  const apiBaseUrl = process.env.TARO_APP_API_BASE_URL?.trim() || (mode === 'development'
    ? 'http://localhost:3000/api/v1'
    : 'https://REPLACE_ME.example.com/api/v1')
  const baseConfig: UserConfigExport = {
    projectName: 'dashuai-mini',
    date: '2026-9-7',
    designWidth: 375,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2,
    },
    sourceRoot: 'src',
    outputRoot: `dist/${process.env.TARO_ENV}`,
    plugins: [],
    defineConstants: {
      __API_BASE_URL__: JSON.stringify(apiBaseUrl),
    },
    copy: {
      patterns: [
        // 原生小程序 npm 组件（tdesign-miniprogram）不会被打包进 webpack，
        // 必须整目录拷贝到 dist/<env>/npm/ 下，与 app.config.ts 里
        // usingComponents 的 '/npm/tdesign-miniprogram/...' 引用路径对应
        {
          from: 'node_modules/tdesign-miniprogram/miniprogram_dist/',
          to: `dist/${process.env.TARO_ENV}/npm/tdesign-miniprogram/`,
          ignore: ['*.md', '*.d.ts'],
        },
      ],
      options: {},
    },
    framework: 'react',
    compiler: {
      type: 'webpack5',
      prebundle: {
        enable: false,
      },
    },
    cache: {
      enable: false,
    },
    alias: {
      '@': `${process.cwd()}/src`,
    },
    mini: {
      postcss: {
        pxtransform: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: false,
        },
      },
      // 分包大小优化：公共组件抽到主包
      optimizeMainPackage: {
        enable: true,
      },
    },
    h5: {
      publicPath: '/',
      staticDirectory: 'static',
      postcss: {
        autoprefixer: {
          enable: true,
        },
        cssModules: {
          enable: false,
        },
      },
    },
  }

  if (mode === 'development') {
    return merge({}, baseConfig, devConfig)
  }
  return merge({}, baseConfig, prodConfig)
})
