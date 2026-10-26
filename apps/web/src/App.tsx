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
        <Route path="/pay/return" element={<PayReturn />} />
        <Route path="/pay/:orderNo" element={<Protected><Pay /></Protected>} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}

function Protected({ children }: { children: React.ReactNode }) {
  const { session } = useAuth()
  const location = useLocation()
  return session ? children : <Navigate to="/login" replace state={{ from: location.pathname }} />
}

function PayReturn() {
  const { session } = useAuth()
  if (!session) return <Navigate to="/login" replace state={{ from: '/orders' }} />
  return <Navigate to="/orders" replace />
}
