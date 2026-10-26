import { type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { UserRound, LogOut, ArrowRight } from 'lucide-react'
import { useAuth } from './auth'
import { ICP_LICENSE, SUPPORT_HOURS, SUPPORT_PHONE } from './site-info'

/**
 * 品牌标：红「碗 + 筷子 + 播放键」。
 *
 * ★ 为什么是手写 SVG 而不是贴 apps/mini/src/assets/logo.png：
 *   那张图只有 96×96，放到页头上就是放大糊；而且它是位图、不能跟着文字色变。
 *   这里用同一个图形的矢量版（同款构成：环形碗口 + 交叉筷子 + 居中播放键），
 *   任意尺寸都锐利，颜色跟随 currentColor（= --brand）。
 *   ⚠ 改图形前先对照 apps/mini/src/assets/logo.png，别画出第二个「看着像但不是」的标。
 */
export function Logo({ size = 34, label = '大帅餐饮助手' }: { size?: number; label?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 48 48" fill="none"
      role="img" aria-label={label} style={{ flex: '0 0 auto' }}
    >
      <circle cx="24" cy="28.6" r="12.4" stroke="currentColor" strokeWidth="3" />
      <path d="M9.9 17.9 L38.1 7.3" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M9.9 22.5 L38.1 11.9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".62" />
      <path d="M21.5 23.9 L31 28.8 L21.5 33.7 Z" fill="currentColor" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
    </svg>
  )
}

/*
 * ★ 2026-10-14（用户要求）：这里原有 `AiBadge`（一个叠在图片左下角的「AI 生成」标签，
 *   配套样式 `.media-badge`），连同首页那句「画面为 AI 生成的场景示意，不是客户实拍」
 *   一起删除了。**组件与样式都已删除，不是隐藏**。
 *
 * ⚠ 如实记录：这个标签原本是**我们自己主动加的合规判断**（见旧注释「删掉它属于合规倒退」），
 *   并不是设计元素。删除是用户的明确要求，理由也成立 —— 运营会陆续把 AI 示意图换成
 *   真实门店照片，写死的「AI 生成」到那时反而是**错标**。
 *
 * ★ 所以若之后要恢复标识，**正确做法是给每张图加一个「这张是 AI 生成的」开关**
 *   （跟着图走、落进 `site-images.ts` 那份配置、后台可配），由内容决定要不要标；
 *   **不要**把标签重新写死进组件。写死的标签在下一次换图时又会变成一句假话。
 */

/**
 * 全站骨架。
 *
 * ★ 手机优先（面向 30-50 岁门店经营者）：
 *   1. **手机端不放汉堡菜单**——两级导航对中年用户是不必要的负担，而且汉堡图标本身
 *      不够自解释。本站只有「首页 / 套餐」两个页面，手机端靠 **logo 回首页 + 查看套餐按钮**
 *      就够了，顶栏只留一个动作（登录或账户）。`.nav-links` 在 <768px 直接隐藏。
 *   2. 顶栏高度、按钮高度都在 CSS 里按「手指点击」定：按钮 ≥52px、可点区域 ≥44px。
 *   3. 页脚只留「品牌 + 三个链接（规则/隐私/备案号）」，不重复放宣传语。
 */
export function Layout({ children }: { children: ReactNode }) {
  const { session, logout } = useAuth()
  const navigate = useNavigate()
  // ★ logout() 只清 session、不跳转。若停在受保护页（/account、/orders），清完会被
  //   Protected 原地甩到登录页——用户会以为「点了退出却跑到登录页」。所以必须显式回首页。
  const signOut = () => {
    logout()
    navigate('/')
  }

  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="container nav-wrap">
          <Link className="brand" to="/" aria-label="大帅餐饮助手首页">
            <span className="brand-mark"><Logo /></span>
            {/* ★ 顶栏**只写品牌名**，不再重复「餐饮门店 · 轻松拍」——
                那句话已经由首页首屏的红色字标承担，同一句在两个位置相隔 200px
                出现两次是冗余。改这里前先看 Home.tsx 的 .brand-mark-script。 */}
            <span className="brand-word"><b>大帅餐饮助手</b></span>
          </Link>
          {/* 桌面端导航；手机端由 CSS 隐藏（见 styles.css 的 .nav-links） */}
          <nav className="nav-links" aria-label="主导航">
            <NavLink to="/">首页</NavLink>
            {/* ★ 不加 `end`：在 /app/store 这类子页里「工作台」保持高亮，一眼能看出自己在哪个区域 */}
            {session && <NavLink to="/app">工作台</NavLink>}
            <NavLink to="/pricing">套餐与积分</NavLink>
            {session && <NavLink to="/account">账户中心</NavLink>}
            {session && <NavLink to="/orders">订单</NavLink>}
          </nav>
          <div className="nav-actions">
            {session ? (
              <>
                <Link className="user-chip" to="/account">
                  <UserRound size={17} />
                  <span className="chip-label">{maskPhone(session.merchant.phone)}</span>
                </Link>
                <button className="icon-text-button" onClick={signOut}>
                  <LogOut size={17} />退出
                </button>
              </>
            ) : (
              // ★ 顶栏这颗**故意不用红色实心**：规范要求「一屏最多一个红色实心主按钮」，
              //   首屏的主行动属于 hero 的「查看套餐」。顶栏只是导航，降为浅红 Secondary，
              //   否则首屏会同时出现两个红实心按钮，主次就分不出来了。
              <Link className="button small secondary" to="/login">登录 <ArrowRight size={16} /></Link>
            )}
          </div>
        </div>
      </header>
      <main>{children}</main>
      <footer className="site-footer">
        <div className="container footer-grid">
          <div className="brand">
            <span className="brand-mark"><Logo size={26} /></span>
            <span className="brand-word"><b>大帅餐饮助手</b></span>
          </div>
          <div className="footer-links">
            <Link to="/rules">基础服务规则</Link>
            <Link to="/privacy">隐私协议</Link>
            {/* ★ 备案号必须逐字保持并链接工信部首页：管局要求「网站首页底部悬挂」，
                换成 SPA 后极易被漏掉（旧静态页的存在意义就是这个）。改这里前先读
                deploy/site/index.html 顶部注释。
                ★ 2026-10-23：值改为从 `site-info.ts` 取（与规则页、后台「联系我们」同一份），
                  免得改主体时只改了页脚、页内还是旧号。 */}
            <a className="beian" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">{ICP_LICENSE}</a>
            {/* ★ 客服电话放页脚：微信支付 H5 审核要求「有对应的售后服务、客诉解决的说明」，
                页脚是审核员一定会滚到的地方。tel: 链接让手机上能直接拨。 */}
            <a className="beian" href={`tel:${SUPPORT_PHONE}`}>客服 {SUPPORT_PHONE}（{SUPPORT_HOURS}）</a>
          </div>
        </div>
      </footer>
    </div>
  )
}

export function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return <div className="page-header"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{description && <p>{description}</p>}</div>
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{text}</p>{action}</div>
}

export function LoadingBlock({ text = '正在加载' }: { text?: string }) {
  return <div className="loading-block"><span className="spinner" />{text}</div>
}

export function ErrorBlock({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error-block"><strong>暂时无法完成</strong><span>{message}</span>{retry && <button className="text-button" onClick={retry}>重新尝试</button>}</div>
}

export function formatMoney(fen: number): string {
  return `¥${(fen / 100).toFixed(2)}`
}

export function formatDate(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

export function formatNumber(value: string | number): string {
  const n = Number(value)
  return Number.isFinite(n) ? new Intl.NumberFormat('zh-CN').format(n) : String(value)
}

export function maskPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
}
