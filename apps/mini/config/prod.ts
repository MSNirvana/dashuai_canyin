import type { UserConfigExport } from '@tarojs/cli'

/**
 * 关掉 TerserPlugin 的「注释抽取」，让产物里不再出现 *.LICENSE.txt。
 *
 * 背景：TerserPlugin 默认 `extractComments: true`，会把压缩后 JS 里残留的
 * `@license` 注释**抽成独立文件**放在代码包根目录 —— 这个项目就会出现
 * `app.js.LICENSE.txt` / `vendors.js.LICENSE.txt`（React、scheduler、react-reconciler 的声明）。
 * 这两个文件在代码包里**没有任何引用**，微信开发者工具「代码质量」会判
 * 「存在无依赖文件」【必须项】，并给出「建议去除」。
 *
 * 关掉抽取后注释随 JS 一起被压掉，产物里不会再出现这两个文件，也就不会再被误判。
 *
 * ★ 为什么只能写在 webpackChain 里：
 *   Taro 的 `terser.config` 是合并进 **terserOptions**（terser 编译器自己的选项）的，
 *   而 `extractComments` 是 **TerserPlugin 插件自己的选项**（Taro 只透传 parallel + terserOptions），
 *   所以从 Taro 配置项进不去，只能拿到 chain 之后改插件参数。
 *   参考：@tarojs/webpack5-runner/dist/webpack/BaseConfig.js::setMinimizer
 *        @tarojs/webpack5-runner/dist/webpack/WebpackPlugin.js::getTerserPlugin
 *
 * 只需要写在 prod：`setMinimizer()` 在 `config.mode !== 'production'` 时直接 return，
 * 开发模式下压根没有 minimizer，也就不会产生 .LICENSE.txt。
 */
type TerserMinimizerChain = {
  optimization: {
    minimizers: {
      has(name: string): boolean
    }
    minimizer(name: string): {
      tap(fn: (args: unknown[]) => unknown[]): unknown
    }
  }
}

function disableTerserCommentExtraction(chain: unknown) {
  const c = chain as TerserMinimizerChain
  try {
    if (!c?.optimization?.minimizers?.has('terserPlugin')) return
    c.optimization.minimizer('terserPlugin').tap((args) => {
      const options = (args[0] ?? {}) as { extractComments?: boolean }
      args[0] = options
      options.extractComments = false
      // ★ 只动这一个开关，不要再碰 terserOptions.format：
      //   Taro 的 defaultTerserOptions 里已经有 `output: { comments: false }`（terser 的老字段），
      //   而 terser 规定 `output` 与 `format` **不能同时出现**，同时给会直接报
      //   「Please only specify either output or format option, preferrably format.」构建失败。
      //   关掉抽取后 TerserPlugin 不再改写 format.comments，`output.comments: false` 照常生效 ⇒ 注释照样被丢掉。
      return args
    })
  } catch (err) {
    // Taro 内部结构调整时不要阻断构建：最坏结果只是多两个几 KB 的 .LICENSE.txt
    console.warn('[config] 关闭 terser 注释抽取失败（不影响构建）：', err)
  }
}

export default {
  logger: {
    quiet: false,
    stats: true,
  },
  mini: {
    webpackChain(chain) {
      disableTerserCommentExtraction(chain)
    },
  },
  h5: {},
} satisfies UserConfigExport
