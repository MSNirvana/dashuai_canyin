import { Routes, Route, Navigate } from 'react-router-dom'
import { RequireAuth } from './context/AuthContext'
import AppLayout from './layouts/AppLayout'
import LoginPage from './pages/Login'
import DashboardPage from './pages/Dashboard'
import MerchantsPage from './pages/Merchants'
import MerchantDetailPage from './pages/MerchantDetail'
import BeanPackagesPage from './pages/BeanPackages'
import MemberPackagesPage from './pages/MemberPackages'
import BeanLedgerPage from './pages/BeanLedger'
import RenderTasksPage from './pages/RenderTasks'
import AiProvidersPage from './pages/AiProviders'
import AiModelsPage from './pages/AiModels'
import AiScenesPage from './pages/AiScenes'
import AiCallLogsPage from './pages/AiCallLogs'
import ShotLibraryPage from './pages/ShotLibrary'
import SettingsPage from './pages/Settings'
import TtsProvidersPage from './pages/TtsProviders'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
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
        <Route path="/ai/providers" element={<AiProvidersPage />} />
        <Route path="/ai/models" element={<AiModelsPage />} />
        <Route path="/ai/scenes" element={<AiScenesPage />} />
        <Route path="/ai/call-logs" element={<AiCallLogsPage />} />
        <Route path="/shot-library" element={<ShotLibraryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/tts-providers" element={<TtsProvidersPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
