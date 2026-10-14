import { useEffect, useState } from 'react'
import { api } from './api'

/**
 * 官网首页的展示图（主视觉 1 张 + 案例 3 张）。
 *
 * ── 两份来源，合并成一份 ────────────────────────────────────────────────────
 *   · **内置默认**：随包发布的静态资源（`/images/*.jpg`），写死在下面；
 *   · **后台配置**：运营在后台「官网图片」页上传的图，由 `GET /api/v1/web/site`
 *     免登录下发（见 `server/src/routes/web.ts`）。
 * 合并规则是**逐格、逐字段**取远端的非空值，空则回退内置。
 *
 * ── 为什么默认值必须在官网这一侧，而不是服务端一起返回 ────────────────────────
 * 默认图是**官网包里的文件**（`public/images/`），只有官网知道它们的路径。
 * 服务端要是也知道这份清单，换默认图就得前后端同时改、还得同时发版 —— 一次只能改一半
 * 的部署必然出现「图 404」，而那时页面只是白块、没有任何报错可循。
 *
 * ── ★★★ 接口不可用时，页面必须照常能用 ───────────────────────────────────────
 * 这一页是花钱投放的落地页，不能因为一次 `/web/site` 超时（或后端发版、或网络抖动）
 * 就变成四张裂图。所以：
 *   1. **先用内置默认图渲染**，请求成功后再替换 —— 不是「等接口回来再渲染」。
 *      后者会让首屏空白若干百毫秒，而且接口一旦不可用就是永久空白。
 *   2. 请求失败**静默**（不弹错、不重试、不留任何红字）—— 用户没有做错任何事，
 *      告诉他「配置读取失败」只会让人以为站点坏了。
 *   3. 不做重试与轮询：一次失败就这一跳用默认图，下次刷新自然重来。
 */

export interface SiteImageSlot {
  image: string
  alt: string
}

export interface SiteCaseSlot extends SiteImageSlot {
  title: string
}

export interface SiteImages {
  hero: SiteImageSlot
  cases: SiteCaseSlot[]
}

/**
 * 内置默认图。
 *
 * ★★ 三张案例图的**动作是刻意分开的**（出锅装盘 / 三脚架固定机位 / 手持取景），
 *   并排看才像一套，不是同一张放了三遍。换默认图时保持这一点。
 * ★ 源图已经裁掉底部 80px（出图工具在右下角烧了水印）——换图前先看新图右下角，
 *   详见 `Home.tsx` 文件头。
 */
export const DEFAULT_SITE_IMAGES: SiteImages = {
  hero: { image: '/images/hero.jpg', alt: '门店经营者用手机拍摄刚出锅的菜品' },
  cases: [
    { image: '/images/case-kitchen.jpg', title: '后厨出锅', alt: '厨师端着刚出锅的菜品装盘' },
    { image: '/images/case-table.jpg', title: '餐桌摆盘', alt: '店主用手机三脚架拍摄摆好盘的菜品' },
    { image: '/images/case-prep.jpg', title: '备菜备料', alt: '厨师低头看着手机屏幕拍摄案台上的食材' },
  ],
}

/**
 * 把远端的半成品配置合并到内置默认值上。
 *
 * ★ 逐字段而不是整格替换：运营只换了图、没改 alt 时，**alt 必须继续用内置那句**。
 *   整格替换会让 alt 变成空字符串（`<img alt="">` 在无障碍语义上是「这是装饰图，
 *   跳过」）—— 一张承载信息的商品图被声明成装饰，是比缺图更难发现的问题。
 */
export function mergeSiteImages(remote: Partial<SiteImages> | null | undefined): SiteImages {
  if (!remote) return DEFAULT_SITE_IMAGES
  const pick = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
  return {
    hero: {
      image: pick(remote.hero?.image, DEFAULT_SITE_IMAGES.hero.image),
      alt: pick(remote.hero?.alt, DEFAULT_SITE_IMAGES.hero.alt),
    },
    // 遍历**内置**的刻度：远端多出来的格子直接丢掉（官网只有 3 张卡的位置），
    // 少了的用内置补齐。这样「后台配了几格」永远不会改变官网的版式。
    cases: DEFAULT_SITE_IMAGES.cases.map((d, i) => {
      const r = remote.cases?.[i]
      return {
        image: pick(r?.image, d.image),
        title: pick(r?.title, d.title),
        alt: pick(r?.alt, d.alt),
      }
    }),
  }
}

/** 拉取后台配置并合并；失败时保持内置默认图（理由见文件头）。 */
export function useSiteImages(): SiteImages {
  const [images, setImages] = useState<SiteImages>(DEFAULT_SITE_IMAGES)
  useEffect(() => {
    let alive = true
    // auth: false —— 这是免登录接口；不带 token 也就不会在 401 时触发刷新跳登录，
    // 未登录访客打开首页不会因为这一跳被弹到登录页。
    api<Partial<SiteImages>>('/web/site', { auth: false })
      .then((remote) => { if (alive) setImages(mergeSiteImages(remote)) })
      .catch(() => { /* 用内置默认图，静默（见文件头第 2 条） */ })
    return () => { alive = false }
  }, [])
  return images
}
