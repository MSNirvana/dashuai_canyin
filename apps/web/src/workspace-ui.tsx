import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { listStores, type Store } from './workspace-data'

/** 工作台的页面外壳：标题 + 一句说明 + 二级标签 */
export function WsPage({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <div className="container ws-page">
      <header className="ws-head">
        {/* ★ 这里**不放 eyebrow**：本来写的是 `.eyebrow`「工作台」，可概览页 h1 也是
            「工作台」，一屏出现两次同一个词；桌面端顶栏的「工作台」还高亮着，第三次更吵。
            层级由「h1 + 下面那排标签」表达就够了（标签里当前项是红字+下划线）。 */}
        <h1>{title}</h1>
        {lead && <p className="ws-lead">{lead}</p>}
        <WsTabs />
      </header>
      {children}
    </div>
  )
}

/**
 * 二级标签。
 * ★ 不做侧边栏：官网 Layout 已经是顶部导航，再套一层侧栏会出现两套并行的垂直导航，
 *   手机上更是挤成一团。四个入口用横向标签足够，也符合「手机优先」。
 */
function WsTabs() {
  return (
    <nav className="ws-tabs" aria-label="工作台导航">
      <NavLink to="/app" end>概览</NavLink>
      <NavLink to="/app/store">门店</NavLink>
      <NavLink to="/app/dishes">菜品</NavLink>
      <NavLink to="/app/persona">人设</NavLink>
      <NavLink to="/app/creations">创作</NavLink>
    </nav>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="ws-field">
      <span className="ws-label">{label}</span>
      {children}
      {hint && <span className="ws-hint">{hint}</span>}
    </label>
  )
}

/**
 * 读当前账号的门店。
 *
 * ★ 单店模型：一个账号只有一家门店，所以取数组第一项即可（服务端 `createStore` 也限 1）。
 * ★ `reload` 在创建门店后必须调用 —— 否则页面还停在「没有门店」的空态。
 */
export function useMyStore() {
  const [store, setStore] = useState<Store | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listStores()
      setStore(list[0] ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '门店信息加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { store, loading, error, reload }
}
