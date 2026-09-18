import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  /**
   * 是否是「路由 chunk 下载失败」。这两种失败要分开说话：
   * 前者是**发版导致旧 hash 失效**（用户开着旧页面，新一轮 `vite build` 之后
   * `index.html` 引用的 `Xxx-<hash>.js` 已经不存在了），用户唯一该做的就是刷新；
   * 后者才是真的代码 bug，需要把技术细节留给排查的人。
   */
  chunkLoadFailed: boolean
}

/**
 * 判断异常是否为「动态 import 的 chunk 取不到」。
 *
 * 三家浏览器/打包器的报错文案都不一样，而且**都不是稳定 API**，所以并存多条：
 *   Chrome/Edge: Failed to fetch dynamically imported module: <url>
 *   Firefox:     error loading dynamically imported module
 *   webpack:     Loading chunk <n> failed / ChunkLoadError
 * 匹配不上也不会更差 —— 退回「未知错误」分支，仍然能渲染出失败页。
 */
function isChunkLoadFailure(error: Error): boolean {
  const msg = `${error.name} ${error.message}`
  return (
    /dynamically imported module/i.test(msg) ||
    /Loading chunk .* failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg) ||
    /Importing a module script failed/i.test(msg)
  )
}

/**
 * 兜住单个页面的渲染异常，别让整个后台外壳一起倒下。
 *
 * ★ 文案分层（与小程序端同一条约定）：**首屏可见的句子必须是人话**。
 *   加路由懒加载之前这里几乎没有触发场景；加了之后，「页面资源已更新」会是**最常见**
 *   的一种失败（每次发版都会让所有开着的旧标签页命中）。原来那句直接把
 *   `Failed to fetch dynamically imported module: /assets/Settings-CaoK6VzO.js` 摆在最显眼处，
 *   运营看到只会以为后台坏了。现在改成一句可执行的提示，技术细节降级到下面小字里 ——
 *   不删（内网工具里排查的人需要它），只是不再是第一眼看到的东西。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, chunkLoadFailed: false }

  static getDerivedStateFromError(error: Error): State {
    return { error, chunkLoadFailed: isChunkLoadFailure(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[admin] page render failed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    const { chunkLoadFailed, error } = this.state
    return (
      <div style={{ padding: 32 }}>
        <h2>{chunkLoadFailed ? '页面资源已更新' : '页面加载失败'}</h2>
        <p style={{ color: '#666' }}>
          {chunkLoadFailed
            ? '后台刚发过新版本，当前页面引用的是上一版的文件。刷新一下就能继续使用。'
            : '这个页面出错了。可以刷新重试；如果反复出现，请把下面的技术细节发给开发。'}
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          重新加载
        </button>
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', color: '#999', fontSize: 12 }}>技术细节</summary>
          <pre style={{ color: '#999', fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {error.message || '发生未知错误'}
          </pre>
        </details>
      </div>
    )
  }
}
