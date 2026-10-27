import { Suspense, useEffect, useState } from 'react'
import { Layout, Menu, Button, Badge, Dialog, Drawer, Input, message } from 'tdesign-react'
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
  LogoWechatIcon,
  ViewListIcon,
} from 'tdesign-icons-react'
import { useAuth } from '../context/AuthContext'
import RouteFallback from '../components/RouteFallback'
import PageGuide from '../components/PageGuide'
import Field, { FieldGroup } from '../components/Field'
import { request } from '../lib/http'
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
      // 官网图片与首页轮播图是**同一类东西**（运营图，且都免登录下发），但消费端不同：
      // 轮播图喂小程序、官网图片喂 dspcz.top。相邻放，运营一眼能看出「改哪儿影响哪一端」。
      { label: '官网图片', icon: <ImageIcon />, path: '/web-site' },
      // 与「首页轮播图」同属「小程序上长什么样」这一类，所以同组相邻放
      { label: '联系我们', icon: <LogoWechatIcon />, path: '/contact' },
      { label: '参考视频', icon: <VideoIcon />, path: '/tutorials' },
      // 演示账号是「限时发放的账号」，与系统设置同属配置类，放在这一组末尾
      { label: '演示账号', icon: <TimeIcon />, path: '/demo-account' },
      { label: '系统设置', icon: <SettingIcon />, path: '/settings' },
    ],
  },
]

const MENU = MENU_GROUPS.flatMap((group) => group.items)

/**
 * ≤820px 视为「抽屉形态」。★ 不能只靠 CSS：TDesign 的 Layout.Aside 渲染时会写
 * inline style（width/max-width/min-width/flex 全 232px），inline 优先级高于
 * 任何 class 规则（含 !important），media query 改不动它 ⇒ 从这里开始整个不渲染
 * 侧栏，换成顶栏汉堡按钮 + 抽屉菜单。
 * ★ 断点取 820 而不是 640：styles.css 在 820 有个「图标模式」（--ds-sidebar:72px
 *   ＋隐藏菜单文字），它同样被 inline 宽度压掉 ⇒ 641~820px 会出现「232px 宽、
 *   只有图标没有文字」的空壳侧栏。抽屉从 820 起接管，那个模式就没有登场机会。
 */
const MOBILE_MQ = '(max-width: 820px)'
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_MQ).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isMobile
}

/** 修改密码弹窗的初始表单 */
const emptyPw = () => ({ oldPassword: '', newPassword: '', confirmPassword: '' })

export default function AppLayout() {
  const loc = useLocation()
  const nav = useNavigate()
  const { admin, logout } = useAuth()
  const active = (path: string) =>
    loc.pathname === path || (path !== '/' && loc.pathname.startsWith(path))

  // ── 修改密码 ──────────────────────────────────────────────
  // 改成功后**立即登出**：服务端的 JWT 在改密码后并不会作废（无状态、2h 自然过期），
  // 立刻登出把「旧 token 还能用」的窗口收敛到「操作者自己当场」，
  // 也顺便强制用新密码走一遍登录，确认自己真的记得住。
  const [pwOpen, setPwOpen] = useState(false)
  const [pwSubmitting, setPwSubmitting] = useState(false)
  const [pw, setPw] = useState(emptyPw)
  const pwError =
    !pw.oldPassword
      ? '请输入原密码'
      : pw.newPassword.length < 8
        ? '新密码至少 8 位'
        : pw.newPassword === pw.oldPassword
          ? '新密码不能与原密码相同'
          : pw.newPassword !== pw.confirmPassword
            ? '两次输入的新密码不一致'
            : ''
  const setPwField = (patch: Partial<ReturnType<typeof emptyPw>>) => setPw((s) => ({ ...s, ...patch }))

  const submitPassword = async () => {
    if (pwSubmitting || pwError) return
    setPwSubmitting(true)
    try {
      await request({
        url: '/auth/password',
        method: 'POST',
        data: { oldPassword: pw.oldPassword, newPassword: pw.newPassword },
      })
      message.success('密码已修改，请用新密码重新登录')
      setPwOpen(false)
      setPw(emptyPw())
      logout()
      nav('/login', { replace: true })
    } catch {
      // http 层已统一提示（原密码错误 / 至少 8 位都会带原因回来）
    } finally {
      setPwSubmitting(false)
    }
  }
  /**
   * 未处理告警数：每 60s 拉一次，失败静默（见 lib/ops-alert.ts 的取舍说明）。
   * ★ 两个出口都要有 —— 只在菜单上加角标，人停在别的页面时看不见；
   *   只在顶栏加横幅，菜单里那项又看不出有几条。
   */
  const { open: openAlerts, critical: criticalAlerts } = useOpsAlertSummary()
  const showAlertBanner = openAlerts > 0 && !active(ALERTS_PATH)

  // ── 手机形态（≤640px）：侧栏不渲染，菜单收进抽屉 ─────────────
  const isMobile = useIsMobile()
  const [navOpen, setNavOpen] = useState(false)

  /** 菜单组渲染：桌面侧栏与手机抽屉共用同一份，保证两处菜单永远不会写岔 */
  const renderMenuGroups = () => (
    <>
      {MENU_GROUPS.map((group) => (
        <div className="nav-group" key={group.label}>
          <div className="nav-group__label">{group.label}</div>
          <Menu
            theme="light"
            value={loc.pathname}
            onChange={(v) => {
              nav(v as string)
              setNavOpen(false)
            }}
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
    </>
  )

  /** 抽屉里的底部操作：手机上顶栏按钮被隐藏（放不下），改密码/退出登录挪到这里 */
  const drawerActions = (
    <div className="nav-drawer__actions">
      <Button
        block
        variant="outline"
        onClick={() => {
          setNavOpen(false)
          setPw(emptyPw())
          setPwOpen(true)
        }}
      >
        修改密码
      </Button>
      <Button
        block
        variant="outline"
        onClick={() => {
          logout()
          nav('/login', { replace: true })
        }}
      >
        退出登录
      </Button>
    </div>
  )

  return (
    <Layout className="app-layout">
      {!isMobile && (
        <Layout.Aside className="app-layout__sider">
          <div className="logo">
            <img className="logo__image" src="/logo-transparent.png" alt="大帅餐饮" />
            <span className="logo__text"><strong>大帅餐饮</strong><small>运营管理后台</small></span>
          </div>
          <nav className="app-layout__nav" aria-label="后台导航">
            {renderMenuGroups()}
          </nav>
          <div className="sider-footer">
            <div className="sider-footer__avatar">{(admin?.username ?? '管').slice(0, 1).toUpperCase()}</div>
            <div className="sider-footer__meta">
              <strong>{admin?.username ?? '管理员'}</strong>
              <span>当前已登录</span>
            </div>
          </div>
        </Layout.Aside>
      )}
      <Layout.Content>
        <div className="app-layout__header">
          {isMobile && (
            <Button
              className="header-burger"
              shape="square"
              variant="text"
              size="large"
              aria-label="打开菜单"
              onClick={() => setNavOpen(true)}
            >
              <ViewListIcon />
            </Button>
          )}
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
                setPw(emptyPw())
                setPwOpen(true)
              }}
            >
              修改密码
            </Button>
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

      {/* 手机导航抽屉：内容结构与桌面侧栏一致（logo + 菜单 + 底部操作），
          复用 app-layout__sider 的样式类 ⇒ 菜单项的配色/悬停/选中态不用另写一套 */}
      <Drawer
        visible={navOpen}
        placement="left"
        size="290px"
        header={false}
        footer={false}
        className="nav-drawer"
        onClose={() => setNavOpen(false)}
      >
        <div className="app-layout__sider nav-drawer__inner">
          <div className="logo">
            <img className="logo__image" src="/logo-transparent.png" alt="大帅餐饮" />
            <span className="logo__text"><strong>大帅餐饮</strong><small>运营管理后台</small></span>
          </div>
          <nav className="app-layout__nav" aria-label="后台导航">
            {renderMenuGroups()}
          </nav>
          <div className="nav-drawer__footer">
            <div className="sider-footer">
              <div className="sider-footer__avatar">{(admin?.username ?? '管').slice(0, 1).toUpperCase()}</div>
              <div className="sider-footer__meta">
                <strong>{admin?.username ?? '管理员'}</strong>
                <span>当前已登录</span>
              </div>
            </div>
            {drawerActions}
          </div>
        </div>
      </Drawer>

      <Dialog
        header="修改密码"
        visible={pwOpen}
        onClose={() => setPwOpen(false)}
        onConfirm={submitPassword}
        // ★ content 不能省：confirmBtn 传对象时 TDesign 不注入 children，只写 {loading}
        //   会渲染成一个没有文字的红色按钮（见 BeanLedger / MerchantDetail 的同款注释）
        confirmBtn={{ content: '确认修改', loading: pwSubmitting, disabled: Boolean(pwError) }}
        width={480}
      >
        <FieldGroup labelWidth={90}>
          <Field label="原密码" required>
            <Input
              type="password"
              value={pw.oldPassword}
              onChange={(v) => setPwField({ oldPassword: v as string })}
              placeholder="当前使用的密码"
            />
          </Field>
          <Field label="新密码" required help="至少 8 位。修改成功后会立即退出登录，需要用新密码重新登录。">
            <Input
              type="password"
              value={pw.newPassword}
              onChange={(v) => setPwField({ newPassword: v as string })}
              placeholder="至少 8 位"
            />
          </Field>
          <Field label="确认新密码" required>
            <Input
              type="password"
              value={pw.confirmPassword}
              onChange={(v) => setPwField({ confirmPassword: v as string })}
              placeholder="再输入一遍新密码"
            />
          </Field>
        </FieldGroup>
        {pwError ? (
          <div className="danger-text" style={{ fontSize: 12, marginTop: 4 }}>
            {pwError}
          </div>
        ) : null}
      </Dialog>
    </Layout>
  )
}
