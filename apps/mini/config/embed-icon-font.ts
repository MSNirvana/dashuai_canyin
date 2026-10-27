import { execFileSync } from 'node:child_process'

/**
 * 每次 webpack 编译结束后，把 TDesign 图标字体内嵌进产物（`scripts/embed-t-icon-font.mjs`）。
 *
 * ── 为什么必须挂在构建里，而不能靠人记得手动跑 ────────────────────────
 * TDesign 的 `icon.wxss` 里 `@font-face` 只有 `https://tdesign.gtimg.com/...` 四个远程地址，
 * **小程序端加载不到远程字体** ⇒ 真机上 `t-icon` 全是空白（元素在、占位在、字形空、**不报错**）。
 * 唯一稳的修法就是把子集字体以 base64 写进那个 wxss（原因见 embed 脚本头部）。
 * 但 `icon.wxss` 是 **copy 插件从 node_modules 拷进 dist 的** —— 每次构建/重启 watch
 * 都会被覆盖回「远程地址」那一版。
 * ⇒ 2026-10-27 的真实事故：`scripts/build-weapp-prod.sh`（正式出包）里本来有这一步，
 *   但**本地 watch / 预览包没有**，所以「工具里好好的、真机上图标全空」又复发了一次。
 *   用户的疑点是「是不是我网络问题」—— 不是，是包里压根没字库。
 *
 * ── 为什么挂在 webpack 的 done 钩子，而不是 Taro 的 onBuildFinish ──────
 * `done` 是 webpack 生命周期里**最后一个**钩子：copy 插件写文件发生在 emit 阶段，
 * 一定在 `done` 之前 ⇒ 我们改的是「已经落盘的那份」。watch 每次重编译都会再触发一遍，
 * 幂等（脚本自身先读后写，且会断言写完不含远程域名）。
 *
 * ── 为什么放在 dev.ts / prod.ts 各自调用，而不是 base 配置 ─────────────
 * `mini.webpackChain` 在 dev.ts 与 prod.ts 里**都声明了**，而 Taro 用 webpack-merge 合并配置 ——
 * 两个函数同名时是**后者覆盖前者**（不是依次调用）。写在 base 里会被 prod.ts 那份顶掉，
 * 而且不会报错。所以由两个环境各自显式调用同一个 helper。
 */
export function attachIconFontEmbedder(chain: any): void {
  chain.plugin('dashuai-embed-t-icon-font').use(
    class EmbedTIconFontPlugin {
      apply(compiler: any): void {
        compiler.hooks.done.tap('dashuai-embed-t-icon-font', (stats: any) => {
          // 编译本来就失败了：这时候去打补丁只会把真正的报错刷掉
          if (stats?.hasErrors?.()) return
          /**
           * ★ 不吞异常：子集里缺字形时脚本会 **非 0 退出**（它会扫 `src/**` 里用到的图标名）。
           *   那一刻必须让构建红掉 —— 否则就是一个「构建成功、真机空白」的静默故障，
           *   而这正是当初踩了三次的那个坑。
           */
          execFileSync(process.execPath, ['scripts/embed-t-icon-font.mjs'], {
            cwd: process.cwd(),
            stdio: 'inherit',
          })
        })
      }
    },
  )
}
