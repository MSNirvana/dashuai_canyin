import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { RequireAuth } from './context/AuthContext'
import ErrorBoundary from './components/ErrorBoundary'
import RouteFallback from './components/RouteFallback'
import AppLayout from './layouts/AppLayout'

/**
 * ★ 页面按路由懒加载（原来全是静态 import）。
 *
 * 为什么：原来所有页面被静态引入 ⇒ Rollup 必须把它们全部打进入口 chunk，
 * 结果是一个 841KB（gzip 261KB）的 index-*.js —— 未登录访客打开 /login 也要先把
 * 「积分流水 / AI 场景 / 教学中心」等全部后台代码下载并解析完，首屏才可交互。
 * `manualChunks` 只拆出了第三方依赖，业务页面代码仍在同一个包里，解决不了这一点。
 *
 * 现在：每个页面各自成 chunk，只在**真正访问**时下载。改一个页面的代码也只让它自己
 * 那个 chunk 的 hash 变，其余 chunk 继续命中浏览器缓存。
 *
 * 注意：`AppLayout`（外壳，含菜单与顶栏）**故意保持静态引入** —— 它是每个已登录页面
 * 的公共框架，懒加载它等于每次首屏多一个往返，反而更慢。
 * 页面 chunk 的加载兜底由 `<Suspense>` 提供：登录页在 App.tsx 里就地包一层，
 * 已登录页面由 AppLayout 包住 `<Outlet />`（这样切页时菜单/顶栏不会闪掉）。
 */
const LoginPage = lazy(() => import('./pages/Login'))
const DashboardPage = lazy(() => import('./pages/Dashboard'))
const MerchantsPage = lazy(() => import('./pages/Merchants'))
const MerchantDetailPage = lazy(() => import('./pages/MerchantDetail'))
const BeanPackagesPage = lazy(() => import('./pages/BeanPackages'))
const MemberPackagesPage = lazy(() => import('./pages/MemberPackages'))
const BeanLedgerPage = lazy(() => import('./pages/BeanLedger'))
const RenderTasksPage = lazy(() => import('./pages/RenderTasks'))
const PremiumOrdersPage = lazy(() => import('./pages/PremiumOrders'))
const AiProvidersPage = lazy(() => import('./pages/AiProviders'))
const AiModelsPage = lazy(() => import('./pages/AiModels'))
const AiScenesPage = lazy(() => import('./pages/AiScenes'))
const AiCallLogsPage = lazy(() => import('./pages/AiCallLogs'))
const ShotLibraryPage = lazy(() => import('./pages/ShotLibrary'))
const WorksPage = lazy(() => import('./pages/Works'))
const HomeCarouselPage = lazy(() => import('./pages/HomeCarousel'))
const HomeSloganBannerPage = lazy(() => import('./pages/HomeSloganBanner'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const TtsProvidersPage = lazy(() => import('./pages/TtsProviders'))
const TutorialsPage = lazy(() => import('./pages/Tutorials'))

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route
          path="/login"
          element={
            // 登录页不在 AppLayout 里（没有菜单栏），所以要自己包 Suspense
            <Suspense fallback={<RouteFallback />}>
              <LoginPage />
            </Suspense>
          }
        />
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/merchants" element={<MerchantsPage />} />
          <Route path="/merchants/:id" element={<MerchantDetailPage />} />
          <Route path="/bean-packages" element={<BeanPackagesPage />} />
          <Route path="/member-packages" element={<MemberPackagesPage />} />
          <Route path="/bean-ledger" element={<BeanLedgerPage />} />
          <Route path="/render-tasks" element={<RenderTasksPage />} />
          <Route path="/premium-orders" element={<PremiumOrdersPage />} />
          <Route path="/ai/providers" element={<AiProvidersPage />} />
          <Route path="/ai/models" element={<AiModelsPage />} />
          <Route path="/ai/scenes" element={<AiScenesPage />} />
          <Route path="/ai/call-logs" element={<AiCallLogsPage />} />
          <Route path="/shot-library" element={<ShotLibraryPage />} />
          <Route path="/works" element={<WorksPage />} />
          <Route path="/home-carousel" element={<HomeCarouselPage />} />
          <Route path="/home-slogan-banner" element={<HomeSloganBannerPage />} />
          <Route path="/tutorials" element={<TutorialsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/tts-providers" element={<TtsProvidersPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  )
}
