import { Suspense } from 'react'
import { Layout, Menu, Button, Badge } from 'tdesign-react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
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
  AssignmentUserIcon,
  ErrorCircleFilledIcon,
} from 'tdesign-icons-react'
import { useAuth } from '../context/AuthContext'
import RouteFallback from '../components/RouteFallback'
import PageGuide from '../components/PageGuide'
import { useOpsAlertSummary } from '../lib/ops-alert'

/** 告警页路径。顶栏横幅与菜单角标都指它，抽出来免得两处写岔 */
const ALERTS_PATH = '/ops-alerts'

const MENU_GROUPS = [
  {
    label: '运营',
    items: [
      { label: '仪表盘', icon: <DashboardIcon />, path: '/dashboard' },
      { label: '运维告警', icon: <ErrorCircleFilledIcon />, path: ALERTS_PATH },
      { label: '商家管理', icon: <UserCircleIcon />, path: '/merchants' },
    ],
  },
  {
    label: '交易与任务',
    items: [
      { label: '加油包', icon: <MoneyIcon />, path: '/bean-packages' },
      { label: '会员套餐', icon: <MoneyIcon />, path: '/member-packages' },
      { label: '积分流水', icon: <ChartIcon />, path: '/bean-ledger' },
      { label: '合成任务', icon: <VideoIcon />, path: '/render-tasks' },
      { label: '精品接单', icon: <AssignmentUserIcon />, path: '/premium-orders' },
    ],
  },
  {
    label: '内容与 AI',
    items: [
      { label: 'AI 通道', icon: <ServiceIcon />, path: '/ai/providers' },
      { label: 'AI 模型', icon: <ControlPlatformIcon />, path: '/ai/models' },
      { label: 'AI 场景', icon: <ServerIcon />, path: '/ai/scenes' },
      { label: 'AI 调用日志', icon: <TimeIcon />, path: '/ai/call-logs' },
      { label: '镜头库', icon: <ImageIcon />, path: '/shot-library' },
      { label: '优秀作品', icon: <VideoIcon />, path: '/works' },
    ],
  },
  {
    label: '页面与系统',
    items: [
      { label: '首页轮播图', icon: <ImageIcon />, path: '/home-carousel' },
      { label: '首页口号图', icon: <ImageIcon />, path: '/home-slogan-banner' },
      { label: '教学中心', icon: <VideoIcon />, path: '/tutorials' },
      { label: '系统设置', icon: <SettingIcon />, path: '/settings' },
      { label: 'TTS 供应商', icon: <ServiceIcon />, path: '/tts-providers' },
    ],
  },
]

const MENU = MENU_GROUPS.flatMap((group) => group.items)

export default function AppLayout() {
  const loc = useLocation()
  const nav = useNavigate()
  const { admin, logout } = useAuth()
  const active = (path: string) =>
    loc.pathname === path || (path !== '/' && loc.pathname.startsWith(path))
  /**
   * 未处理告警数：每 60s 拉一次，失败静默（见 lib/ops-alert.ts 的取舍说明）。
   * ★ 两个出口都要有 —— 只在菜单上加角标，人停在别的页面时看不见；
   *   只在顶栏加横幅，菜单里那项又看不出有几条。
   */
  const { open: openAlerts, critical: criticalAlerts } = useOpsAlertSummary()
  const showAlertBanner = openAlerts > 0 && !active(ALERTS_PATH)

  return (
    <Layout className="app-layout">
      <Layout.Aside className="app-layout__sider">
        <div className="logo">
          <img className="logo__image" src="/logo-transparent.png" alt="大帅餐饮" />
          <span className="logo__text"><strong>大帅餐饮</strong><small>运营管理后台</small></span>
        </div>
        <nav className="app-layout__nav" aria-label="后台导航">
          {MENU_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group__label">{group.label}</div>
              <Menu
                theme="light"
                value={loc.pathname}
                onChange={(v) => nav(v as string)}
              >
                {group.items.map((m) => (
                  <Menu.MenuItem key={m.path} value={m.path} icon={m.icon}>
                    {m.path === ALERTS_PATH && openAlerts > 0 ? (
                      <span className="menu-label-with-badge">
                        {m.label}
                        <Badge count={openAlerts} maxCount={99} size="small" />
                      </span>
                    ) : (
                      m.label
                    )}
                  </Menu.MenuItem>
                ))}
              </Menu>
            </div>
          ))}
        </nav>
        <div className="sider-footer">
          <div className="sider-footer__avatar">{(admin?.username ?? '管').slice(0, 1).toUpperCase()}</div>
          <div className="sider-footer__meta">
            <strong>{admin?.username ?? '管理员'}</strong>
            <span>当前已登录</span>
          </div>
        </div>
      </Layout.Aside>
      <Layout.Content>
        <div className="app-layout__header">
          <div className="app-layout__header-title">
            <span className="header-kicker">大帅餐饮</span>
            <span className="header-divider">/</span>
            <strong>{MENU.find((m) => active(m.path))?.label ?? '欢迎'}</strong>
            {showAlertBanner && (
              <button
                type="button"
                className={
                  'ops-alert-pill' + (criticalAlerts > 0 ? ' ops-alert-pill--critical' : '')
                }
                onClick={() => nav(ALERTS_PATH)}
                title="点击查看运维告警"
              >
                <ErrorCircleFilledIcon />
                {criticalAlerts > 0 && <span>{criticalAlerts} 条严重 · </span>}
                <span>未处理告警 {openAlerts} 条</span>
              </button>
            )}
          </div>
          <div className="app-layout__header-actions">
            <span className="header-admin">管理员：{admin?.username ?? '未登录'}</span>
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
          <PageGuide />
          {/*
            Suspense 包在 Outlet 这一层（而不是整个 App）：页面已按路由懒加载，
            切换菜单时页面 chunk 需要先下载。包在这里，菜单与顶栏在下载期间保持可见且可点，
            只有内容区显示占位 —— 包在整个 App 外层会让侧栏一起闪白，看起来像整站重载。
            chunk 下载失败（如发版后旧 hash 失效）由外层 ErrorBoundary 兜住，不会一直转圈。
          */}
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </div>
      </Layout.Content>
    </Layout>
  )
}
