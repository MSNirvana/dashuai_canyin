import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from './components'
import { Home } from './Home'
import { Login } from './Login'
import { Pricing } from './Pricing'
import { Account } from './Account'
import { Orders } from './Orders'
import { Pay } from './Pay'
import { Privacy, Rules } from './Legal'
import { Workspace } from './Workspace'
import { StorePage } from './StorePage'
import { DishesPage } from './DishesPage'
import { PersonaPage } from './PersonaPage'
import { CreationsPage } from './CreationsPage'
import { CreationNewPage } from './CreationNewPage'
import { CreationDetailPage } from './CreationDetailPage'
import { RenderPage } from './RenderPage'
import { useAuth } from './auth'

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/account" element={<Protected><Account /></Protected>} />
        <Route path="/orders" element={<Protected><Orders /></Protected>} />
        {/* 工作台：官网与小程序共用同一套账号与业务接口，这里只是把门店/菜品/人设搬上网页 */}
        <Route path="/app" element={<Protected><Workspace /></Protected>} />
        <Route path="/app/store" element={<Protected><StorePage /></Protected>} />
        <Route path="/app/dishes" element={<Protected><DishesPage /></Protected>} />
        <Route path="/app/persona" element={<Protected><PersonaPage /></Protected>} />
        {/* 创作链路：列表 → 新建 → 详情（文案 + 分镜）。
            ⚠ 顺序不影响匹配（v6 按 rank 选），但把 `new` 写在 `:id` 前面更好读。 */}
        <Route path="/app/creations" element={<Protected><CreationsPage /></Protected>} />
        <Route path="/app/creations/new" element={<Protected><CreationNewPage /></Protected>} />
        <Route path="/app/creations/:id" element={<Protected><CreationDetailPage /></Protected>} />
        <Route path="/app/creations/:id/render" element={<Protected><RenderPage /></Protected>} />
        <Route path="/pay/return" element={<PayReturn />} />
        <Route path="/pay/:orderNo" element={<Protected><Pay /></Protected>} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}

/**
 * 工作台入口：登录了就直接进；**没登录先取一枚只读的演示会话**，让人不登录也能看。
 *
 * ★ 为什么要这样：微信支付 H5 审核两次驳回「网站中体验不到服务内容」——
 *   原来 `/app/*` 全在登录墙后面，审核方点进去只能看到登录框。
 * ★ 只有演示数据不可用（演示号没配 / 白名单为空 / 被限流）时才回落到登录页。
 * ★ 演示态是只读的（服务端 `scope='demo'`，写操作 1007），页面上另有一条横幅说明。
 */
function Protected({ children }: { children: React.ReactNode }) {
  const { session, startDemo } = useAuth()
  const location = useLocation()
  const [demoFailed, setDemoFailed] = useState(false)

  useEffect(() => {
    if (session || demoFailed) return
    let alive = true
    void startDemo().catch(() => {
      if (alive) setDemoFailed(true)
    })
    return () => {
      alive = false
    }
  }, [session, demoFailed, startDemo])

  if (session) return <>{children}</>
  if (demoFailed) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <p className="loading-block">正在打开演示工作台…</p>
}

function PayReturn() {
  const { session } = useAuth()
  if (!session) return <Navigate to="/login" replace state={{ from: '/orders' }} />
  return <Navigate to="/orders" replace />
}
