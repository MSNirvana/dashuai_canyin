import { Layout, Menu, Button } from 'tdesign-react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  DashboardIcon,
  UserCircleIcon,
  ServerIcon,
  ChartIcon,
  MoneyIcon,
  VideoIcon,
  ServiceIcon,
  SettingIcon,
  ControlPlatformIcon,
  TimeIcon,
  ImageIcon,
} from 'tdesign-icons-react'
import { useAuth } from '../context/AuthContext'

const MENU = [
  { label: '仪表盘', icon: <DashboardIcon />, path: '/dashboard' },
  { label: '商家管理', icon: <UserCircleIcon />, path: '/merchants' },
  { label: '加油包', icon: <MoneyIcon />, path: '/bean-packages' },
  { label: '会员套餐', icon: <MoneyIcon />, path: '/member-packages' },
  { label: '积分流水', icon: <ChartIcon />, path: '/bean-ledger' },
  { label: '合成任务', icon: <VideoIcon />, path: '/render-tasks' },
  { label: 'AI 通道', icon: <ServiceIcon />, path: '/ai/providers' },
  { label: 'AI 模型', icon: <ControlPlatformIcon />, path: '/ai/models' },
  { label: 'AI 场景', icon: <ServerIcon />, path: '/ai/scenes' },
  { label: 'AI 调用日志', icon: <TimeIcon />, path: '/ai/call-logs' },
  { label: '镜头库', icon: <ImageIcon />, path: '/shot-library' },
  { label: '系统设置', icon: <SettingIcon />, path: '/settings' },
  { label: 'TTS 供应商', icon: <ServiceIcon />, path: '/tts-providers' },
]

export default function AppLayout() {
  const loc = useLocation()
  const nav = useNavigate()
  const { admin, logout } = useAuth()
  const active = (path: string) =>
    loc.pathname === path || (path !== '/' && loc.pathname.startsWith(path))

  return (
    <Layout className="app-layout">
      <Layout.Aside className="app-layout__sider">
        <div className="logo">大帅餐饮 · 后台</div>
        <Menu
          theme="dark"
          value={loc.pathname}
          onChange={(v) => nav(v as string)}
        >
          {MENU.map((m) => (
            <Menu.MenuItem key={m.path} value={m.path} icon={m.icon}>
              <Link to={m.path}>{m.label}</Link>
            </Menu.MenuItem>
          ))}
        </Menu>
      </Layout.Aside>
      <Layout.Content>
        <div className="app-layout__header">
          <div style={{ fontSize: 14, color: '#666' }}>
            {MENU.find((m) => active(m.path))?.label ?? '欢迎'}
          </div>
          <div>
            <span style={{ marginRight: 12, color: '#666' }}>
              {admin ? `管理员：${admin.username}` : ''}
            </span>
            <Button
              size="small"
              theme="default"
              variant="outline"
              onClick={() => {
                logout()
                nav('/login', { replace: true })
              }}
            >
              退出登录
            </Button>
          </div>
        </div>
        <div className="app-layout__content">
          <Outlet />
        </div>
      </Layout.Content>
    </Layout>
  )
}
