import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, Copy, LoaderCircle, Sparkles } from 'lucide-react'
import { api, ApiError } from './api'
import { useSiteImages } from './site-images'

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
 * ★★★ 四张展示图**现在是后台可替换的**（2026-10-14）：
 *   内置默认值在 `site-images.ts::DEFAULT_SITE_IMAGES`，运营在后台「官网图片」页
 *   （`apps/admin/src/pages/WebSite.tsx`）上传替换，走 `GET /api/v1/web/site` 免登录下发。
 *   ⇒ 本文件**不再写死任何图片路径**；默认图清单、比例要求、alt 文案都在 `site-images.ts`。
 *   ⇒ 后台留空 = 用内置默认图，所以「删掉自己传的图」与「一次都没配过」是同一件事。
 *   ⇒ ★ 默认值刻意放在官网这一侧（而不是服务端一起返回）：默认图是官网包里的文件，
 *     只有官网知道路径。服务端也知道的话，换默认图就得前后端同时发版，一次只发一半 ⇒ 图 404。
 *   ⇒ ★ 接口不可用时**必须照常显示内置图** —— 这一页是花钱投放的落地页，不能因为一次
 *     配置读取失败就变成四张裂图。
 *
 * ★ 内置四张默认图**全部是餐饮门店拍摄场景**，不要再混入其他品类：
 *      hero.jpg         门店里用手机拍刚出锅的菜
 *      case-kitchen.jpg 后厨出锅：厨师一手端着刚出锅的菜、一手持厨具（**这张没有手机**）
 *      case-table.jpg   餐桌摆盘：店主用三脚架上的手机拍摆好的菜
 *      case-prep.jpg    备菜备料：厨师双手持手机、低头看着屏幕取景拍案台食材
 *
 * ★★ 三张案例图的**动作是刻意分开的**，换图必须保持：出锅装盘 / 三脚架固定机位 / 手持取景。
 *   上一版三张都是「低头摆弄手机或三脚架」，并排看像同一张放了三遍；那版另有两处
 *   **裁不掉**的硬伤：`case-kitchen` 人脸被一道横梁横切（看着像没头）、
 *   `case-prep` 人被左边框裁掉一半。所以这三张是重出的，不是裁出来的。
 *   出图时统一写「主体居中、面部完整不被任何前景遮挡、人物占上部三分之二、
 *   下方三分之一是台面与菜品」—— 这句话是**三张并排像一套**的关键。
 *   ★ 反面教训：写「手机背面朝向镜头、屏幕对着食材」是**自相矛盾**的（背面朝我们
 *     ⇒ 镜头就朝着我们，不在拍食材）。要「在拍」就写「低头看着手机屏幕取景」，
 *     这是最不会误读的姿态。
 *
 * ★ 2026-10-14（用户要求）：**去掉了图上的「AI 生成」标识，也去掉了
 *   「画面为 AI 生成的场景示意，不是客户实拍」那句说明**。
 *   原来的标识是我们自己叠的 `AiBadge`（`components.tsx`），已连同它的样式一起删除。
 *   ⚠ 这几张图确实是 AI 生成的，公开呈现时标注更稳妥。**若之后要恢复**，
 *     正确做法是给每张图加一个「这张是 AI 生成的」开关（跟着图走、后台可配），
 *     而不是把标识重新写死 —— 因为运营换上**真实门店照片**后，写死的「AI 生成」反而是错的。
 */
/**
 * ★★★ 四张源图**已经裁掉了底部 80px**（`hero.jpg` 1536×944，三张 case 1024×1456）。
 *   原因：出图工具在**右下角烧进了自己的水印**（白字两行，距底 11–61px），
 *   那是**像素里的杂质**，不是我们叠的标识 —— 所以在图上叠任何 badge **都盖不住它**
 *   （badge 在左下、水印在右下，会并存成两个「AI 生成」），而且源图比例与展示框比例
 *   相同时 `object-fit: cover` **根本不会裁掉边角**。
 *   ⇒ 已裁底，见 `public/images/`。**不要**把底边加回来；换新图后先看**源图右下角**再用。
 *   ★ 定位水印**别用固定阈值、别用边缘检测、也别用行均亮度**：`case-kitchen` 底部本就
 *     是暗色灶台、`case-prep` 是明亮大理石台面，「亮于本行中位」在这几张上**满屏误报**，
 *     根本读不出水印在哪。唯一可靠的是**把右下角切下来放大 3 倍用眼睛看**。
 *   ★ 两批（8 张）实测水印几何一致：y 1475–1525、距底 11–61px。但**下一批不要照抄**，
 *     每次都要重新量 —— 这次我在 3x 拼图上目测出「位置更高了」，量完发现是看错了缩放比。
 *   ★ 出图给的是 PNG ⇒ 本轮的裁切是 PIL 裁 + 直接编码 JPEG(q85)，**没有** jpegtran 那一步，
 *     所以不受 `-crop 宽高须为 16 的倍数` 约束（那个约束只在无损裁已有 JPEG 时才要管）。
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

/**
 * 首屏那两句话。做成**带序号的列表**：它们是一件流程的两步，序号本身就是信息
 * （先做 1 再做 2），比两个并列的句子更好读；而且把它降级成列表后，上面那行 h1
 * 的视觉权重才立得住（原来两行正文和一句话正文一样大，首屏没有主次）。
 *
 * ★ 文案刻意保持 17 字以内：320px 窄屏下 `.hero-lead li` 的可读宽度约 252px、
 *   字号 clamp 下限 15px ⇒ 每行约 16.8 字。超了会在窄屏折行（已用
 *   `text-wrap: balance` 均分，不会掉孤字），但也别随手加长。
 */
const heroPoints = [
  '输入菜名和卖点，自动生成文案分镜。',
  '拍完自动加字幕配音，导出竖版视频。',
]

export function Home() {
  // 先用内置默认图渲染，接口返回后台配置后再替换（接口不可用就一直是内置图）。
  // 不是「等接口回来再渲染」—— 那会让首屏空白几百毫秒，接口挂了还会永久空白。
  const images = useSiteImages()
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
            {/* ★ 做成**带序号的列表**：这两句是一件流程的两步，序号本身就是信息（先 1 后 2），
                比两个并列的句子更好读；降级成辅助信息后，上面那行 h1 的视觉权重才立得住。
                ★ `aria-hidden` 是必须的：读屏软件会把「1」念成正文的一部分，
                  而 <ol> 已经会念「第 1 项」，两处一起念就是「1、第 1 项、输入菜名…」。 */}
            <ul className="hero-lead">
              {heroPoints.map((text, i) => (
                <li key={text}>
                  <span className="hero-lead__num" aria-hidden="true">{i + 1}</span>
                  {text}
                </li>
              ))}
            </ul>
            <div className="hero-actions">
              {/* ★ 2026-10-23：首屏主行动由「开始使用（→套餐）」改成「免费试一条」。
                  原因是微信支付 H5 审核驳回：「网站中体验不到服务内容」。
                  让人**当场用一次**，比让他先看价格更能证明「网站里有服务」。
                  套餐仍在顶栏与页尾，没有丢入口。 */}
              <a className="button" href="#try">免费试一条 <ArrowRight size={18} /></a>
            </div>
            <p className="hero-note"><Check size={17} />不用登录，30 秒出一条</p>
          </div>
          <div className="hero-media">
            <div className="media-frame">
              {/* ★ 不再写 width/height 属性：图现在由后台替换，真实尺寸不再可知，
                  写死一个数字就是一句假话（而且当初 `<img width height>` 那个坑
                  正是从「属性与真实尺寸不一致」开始的）。
                  展示比例由 CSS 的 `.hero-media img { aspect-ratio }` 决定 ⇒ 没有布局抖动。 */}
              <img src={images.hero.image} alt={images.hero.alt} />
            </div>
          </div>
        </div>
      </section>

      {/* 试用区紧贴首屏：审核员/新访客往下滑一格就能用到，这是「网站里有服务」的实证 */}
      <TrySection />

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
            {/* ★ 图与标题都来自 `images.cases`（后台可替换，留空用内置默认图）。
                ★ 遍历的是**内置的格数**（`mergeSiteImages` 里按 `DEFAULT_SITE_IMAGES.cases`
                  的刻度合并），后台多配一格或少配一格都不会改变这里的版式。
                ★ 不再写 width/height：图由运营替换，真实尺寸不可知。展示比例由
                  `.case-card img { aspect-ratio: 2 / 3 }` 决定，所以不会布局抖动。
                ★ `loading="lazy"` 保留：这三张在首屏之下，晚点加载能省首屏带宽。
                  ⚠ 取证截图时别忘了先滚全页 —— lazy 图不进视口就一直是空白。 */}
            <div className="case-grid">
              {images.cases.map(({ image, title, alt }, i) => (
                <article className="case-card" key={i}>
                  <div className="media-frame">
                    <img src={image} alt={alt} loading="lazy" />
                  </div>
                  <h3>{title}</h3>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="cta-section">
        <div className="container cta-card">
          <div>
            {/* ★ 2026-10-23 改写：原来的标题是「微信小程序【大帅餐饮助手】」+「微信里搜索就能找到」，
                等于当面告诉审核员「服务在微信里，不在这个网站」——
                而 H5 支付审核驳回理由正是「网站中体验不到服务内容」（官方反例第 2 类：
                「APP/小程序推广页，附带少量商品或服务」）。
                现在改成讲**这个网站能干什么**：试用、下单、查订单，账号与小程序通用。 */}
            <h2>网页上先试，觉得行再开通</h2>
            <p>开通后用同一手机号登录，网页与小程序权益通用，订单和积分在账户中心随时可查。</p>
          </div>
          <Link className="button" to="/pricing">查看套餐 <ArrowRight size={18} /></Link>
        </div>
      </section>
    </>
  )
}

/**
 * 「免费试一条」—— 官网里唯一一个**不登录就能用**的服务入口。
 *
 * ★ 为什么必须有（2026-10-23）：微信支付 H5 支付权限被驳回，理由是
 *   「网站中体验不到服务内容」。官方《商户申请H5支付权限注意事项》第 1 条要求
 *   「能清晰的看到网站售卖的商品以及**网站内体验到服务的具体内容**」，
 *   反例第 4 类就是「网页只有介绍，要线下/别处才能体验」—— 我们原来正是这一类。
 *
 * ★ 服务端：`POST /api/v1/web/demo/copy`（免登录、单 IP 每日 3 条、全站每日 200 条）。
 *   场景 `copy_demo` 的 `beanPrice` 是 0 ⇒ 试用不扣任何人的积分，但**AI 是花钱的**，
 *   所以限流是功能的一部分，不是防刷装饰。
 *
 * ★ 失败时**不假装成功**：AI 挂了就如实说「暂时忙不过来」。页面上不允许出现
 *   「假样例」—— 审核员一旦发现是写死的文案，比没有更糟。
 */
function TrySection() {
  const [dish, setDish] = useState('')
  const [point, setPoint] = useState('')
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const run = async () => {
    const name = dish.trim()
    if (name.length < 2) {
      setError('先填一个菜名，两个字以上')
      return
    }
    setBusy(true)
    setError('')
    setCopied(false)
    try {
      const r = await api<{ text: string }>('/web/demo/copy', {
        method: 'POST',
        auth: false,
        body: { dish: name, sellingPoint: point.trim() ? point.trim() : undefined },
      })
      setText(r.text)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '网络不通，稍后再试')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // 剪贴板在非 https / 旧浏览器上会拒绝，这里不提示「复制失败」——
      // 文案就在页面上，用户可以自己长按选。静默即可。
      setCopied(false)
    }
  }

  return (
    <section className="section" id="try">
      <div className="container">
        <div className="try-card">
          <h2 className="section-title">先试一条，不用登录</h2>
          <p className="try-lead">填一个菜名，看看我们能写出什么样的口播。真的现场生成，不是写好的样例。</p>
          <div className="try-form">
            <label className="input-wrap">
              <input
                value={dish}
                onChange={(e) => setDish(e.target.value)}
                maxLength={20}
                placeholder="菜名，例：干锅鸭头"
                aria-label="菜名"
              />
            </label>
            <label className="input-wrap">
              <input
                value={point}
                onChange={(e) => setPoint(e.target.value)}
                maxLength={60}
                placeholder="卖点（可不填），例：每天现卤，辣度可调"
                aria-label="卖点"
              />
            </label>
            <button className="button" onClick={() => void run()} disabled={busy}>
              {busy ? <><LoaderCircle className="spin" size={18} />正在生成</> : <><Sparkles size={18} />生成一条</>}
            </button>
          </div>
          {error && <div className="form-notice error" role="alert">{error}</div>}
          {text && (
            <div className="try-result">
              <p>{text}</p>
              <button className="text-button" onClick={() => void copy()}>
                {copied ? <><Check size={16} />已复制</> : <><Copy size={16} />复制这段</>}
              </button>
            </div>
          )}
          <p className="try-note">
            每位每天可试 3 条。要用完整流程（分镜、拍摄提词、字幕配音、成片导出）需要开通会员。
          </p>
        </div>
      </div>
    </section>
  )
}
