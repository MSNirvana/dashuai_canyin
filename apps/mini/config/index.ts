import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type UserConfigExport } from '@tarojs/cli'
import devConfig from './dev'
import prodConfig from './prod'
import { buildTdesignCopyPatterns } from './tdesign-copy'

/**
 * 极简 .env 解析：读 apps/mini/.env.local / .env（都不进 git，见根 .gitignore）。
 * 目的：让「clone 下来直接构建」也能连到本地后端，不至于编译出 REPLACE_ME 占位域名。
 * 命令行环境变量优先级更高，方便 CI / 多端覆盖。
 */
function readEnvFile(): Record<string, string> {
  for (const file of ['.env.local', '.env']) {
    const p = join(process.cwd(), file)
    if (!existsSync(p)) continue
    const out: Record<string, string> = {}
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m) continue
      out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
    return out
  }
  return {}
}

// Taro 4 配置：一套代码编译微信 / 抖音两端
export default defineConfig(async (merge, { mode }) => {
  const isDevelopment = process.env.NODE_ENV === 'development' || mode === 'development'
  const fileEnv = readEnvFile()
  const apiBaseUrl = (
    process.env.TARO_APP_API_BASE_URL?.trim() ||
    fileEnv.TARO_APP_API_BASE_URL?.trim() ||
    (isDevelopment ? 'http://127.0.0.1:3000/api/v1' : 'https://REPLACE_ME.example.com/api/v1')
  )
  if (/REPLACE_ME/.test(apiBaseUrl)) {
    console.warn(
      '\n[config] ⚠️  未配置接口域名，产物里写的是占位地址 https://REPLACE_ME.example.com/api/v1，' +
        '小程序启动会报 ERR_CONNECTION_CLOSED。\n' +
        '[config]    本地联调：在 apps/mini/.env 写 TARO_APP_API_BASE_URL=http://127.0.0.1:3000/api/v1（或直接 npm run build:weapp:dev）\n' +
        '[config]    真机调试：写成局域网 IP，如 http://192.168.x.x:3000/api/v1，并在开发者工具勾选「不校验合法域名」\n' +
        '[config]    正式环境：写成已备案的 https 域名，并在小程序后台加入 request 合法域名\n',
    )
  }
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
        // usingComponents 的 '/npm/tdesign-miniprogram/...' 引用路径对应。
        //
        // ★ 按需拷贝（P0-3）：原先整拷 miniprogram_dist 共 104 个组件目录、1.43MB，
        //   而项目只注册了 7 个 t-* 组件。现在按 app.config.ts 的注册项算传递闭包，
        //   只拷真正需要的目录（含 common/mixins/loading/overlay/popup 等隐藏依赖）。
        //   注册新组件无需改这里，拷贝范围会自动跟着走。
        ...buildTdesignCopyPatterns(process.cwd(), process.env.TARO_ENV),
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
