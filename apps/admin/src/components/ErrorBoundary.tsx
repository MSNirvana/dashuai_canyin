import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Keep one broken page from taking down the whole admin shell. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[admin] page render failed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 32 }}>
        <h2>页面加载失败</h2>
        <p style={{ color: '#666' }}>{this.state.error.message || '发生未知错误'}</p>
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </div>
    )
  }
}
