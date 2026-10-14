import { Link } from 'react-router-dom'
import { ArrowRight, Check } from 'lucide-react'
import { AiBadge } from './components'

/**
 * 首页。
 *
 * ★ 面向 **30-50 岁的餐饮门店经营者，主要用手机看**。取舍准则：
 *   1. **一屏一件事，能删就删**。改版前有 5 段（首屏 / 流程 / 适用门店 / 经营者视角 / 收尾），
 *      其中「经营者视角」整段是抽象话 + 引用卡 + 标签堆砌，对老板没有信息量 ⇒ 已删。
 *      现在只剩 4 段，且每段只说一句话。
 *   2. **说人话**。不写「内容生产闭环」「赋能」，写「输入菜名和卖点」「照着拍完」。
 *   3. **首屏只放一个按钮**：改版前是「查看套餐」+「看看怎么用」两颗，
 *      次要那颗对老板是干扰项（他不需要先「了解功能」，他要的是「开始用」）⇒ 合成「开始使用」。
 *   4. 字号、行高、按钮高度都按「中年人看得清、点得准」定，不按「设计师觉得精致」定。
 *
 * ★ 底色衔接的约定：整页只在 `.site-shell` 上刷**一条**连续的冷灰过渡，本文件里所有
 *   section 都**不设 background**。所以模块之间不存在接缝 —— 需要分块的区域用
 *   `.case-band` / `.cta-card` 这种大圆角卡片承载，边界是「一张卡片」，而不是「整幅换色」。
 *   **不要**再给某个 section 单独加底色。
 *
 * ★ 海报**全部是餐饮门店拍摄场景**（`public/images`），四张一套，不要再混入其他品类：
 *      hero.jpg         门店里用手机拍刚出锅的菜
 *      case-kitchen.jpg 后厨拍出锅
 *      case-table.jpg   餐桌拍摆盘
 *      case-prep.jpg    备菜拍过程
 *   因此：
 *   1. 每张图上都有 `AiBadge` 显式标识，别摘；
 *   2. 文案只能写成「场景示意」，**不得**说成客户实拍或真实案例。
 *
 * ★★★ 四张源图**已经裁掉了底部 80px**（`hero.jpg` 1536×944，三张 case 1024×1456）。
 *   原因：出图工具在**右下角烧进了自己的水印**（白字两行，距底 11–61px），
 *   那是**像素里的杂质**，不是我们叠的标识 —— 叠 `AiBadge` **盖不掉它**
 *   （badge 在左下、水印在右下，会并存成两个「AI 生成」），而且源图比例与展示框比例
 *   相同时 `object-fit: cover` **根本不会裁掉边角**。
 *   ⇒ 已用 `jpegtran -crop`（**无损，不重新压缩**）裁底，见 `public/images/`。
 *   **不要**把底边加回来；换新图后先看**源图右下角**再用。
 */
/**
 * ★★ 这三句的长度是**算过字宽**的，不要随手加字：
 *   390 档卡片正文列宽 260px ÷ 16px ≈ 每行 16 字 ⇒ 每句控在 **16 字以内**才能一行放下。
 *   改版前是 20 / 19 / 21 字，第二行只剩「话。」「然。」——「然」还是从成语
 *   「一目了然」里劈出来的，中文排版里这叫**孤字**，桌面端更明显（三张卡片行数 2/1/2 不齐）。
 *   现在 16 / 15 / 15 字，桌面与 390 档都是一行；320 档放不下时会折两行，
 *   由 `.step-card p { text-wrap: balance }` 均分，不再出现孤字。
 */
const steps = [
  { title: '写文案', text: '填菜名和卖点，生成能照着念的话。' },
  { title: '照着拍', text: '文案拆成镜头，拍什么一目了然。' },
  { title: '出成片', text: '自动加字幕配音，导出竖版视频。' },
]

const scenes = [
  { img: '/images/case-kitchen.jpg', title: '后厨出锅', alt: '厨师用手机拍摄刚出锅的菜品' },
  { img: '/images/case-table.jpg', title: '餐桌摆盘', alt: '店主用手机三脚架拍摄摆好盘的菜品' },
  { img: '/images/case-prep.jpg', title: '备菜备料', alt: '店员用手机拍摄备菜过程' },
]

export function Home() {
  return (
    <>
      <section className="hero">
        <div className="container hero-grid">
          <div className="hero-copy">
            {/* 品牌字标：与小程序首页一致（楷体红字 + 一条手绘下划线）。
                ★ 它只出现在这里——顶栏不再重复同一句话（见 components.tsx）。 */}
            <span className="brand-mark-script">
              <em>餐饮门店·轻松拍</em>
              <svg className="underline" viewBox="0 0 300 10" preserveAspectRatio="none" aria-hidden="true">
                <path d="M4 6 C 70 1.6, 170 1.8, 296 5" style={{ stroke: 'var(--brand)' }} strokeWidth="2.4" fill="none" strokeLinecap="round" />
              </svg>
            </span>
            <h1>好菜拍下来，<br />帮你做成短视频</h1>
            {/* ★ 这里**故意不写 <br/> 以外的换行**：两行各 17 个字，在 320px 窄屏 + 16px
                字号下也放得下（272px < 280px），所以硬换行是安全的、断句也干净。
                改文案前先按这个算式核一遍，否则会掉出孤字。 */}
            <p className="hero-lead">输入菜名和卖点，自动生成文案分镜。<br />拍完自动加字幕配音，导出竖版视频。</p>
            <div className="hero-actions">
              <Link className="button" to="/pricing">开始使用 <ArrowRight size={18} /></Link>
            </div>
            <p className="hero-note"><Check size={17} />和小程序是同一个账号</p>
          </div>
          <div className="hero-media">
            <div className="media-frame">
              <img src="/images/hero.jpg" alt="门店经营者用手机拍摄刚出锅的菜品" width={1536} height={1024} />
              <AiBadge text="AI 生成 · 场景示意" />
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="container">
          <h2 className="section-title">三步，拍完就能发</h2>
          <div className="steps-grid">
            {steps.map((step, i) => (
              <article className="step-card" key={step.title}>
                <span className="step-num">{i + 1}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="case-band">
            <h2 className="section-title">店里能拍的场景</h2>
            <div className="case-grid">
              {scenes.map(({ img, title, alt }) => (
                <article className="case-card" key={title}>
                  <div className="media-frame">
                    <img src={img} alt={alt} width={1024} height={1536} loading="lazy" />
                    <AiBadge text="AI 生成" />
                  </div>
                  <h3>{title}</h3>
                </article>
              ))}
            </div>
            <p className="case-note">画面为 AI 生成的场景示意，不是客户实拍。</p>
          </div>
        </div>
      </section>

      <section className="cta-section">
        <div className="container cta-card">
          <div>
            <h2>手机上就能开始</h2>
            <p>用手机号登录，和小程序是同一个账号。</p>
          </div>
          <Link className="button" to="/pricing">查看套餐 <ArrowRight size={18} /></Link>
        </div>
      </section>
    </>
  )
}
