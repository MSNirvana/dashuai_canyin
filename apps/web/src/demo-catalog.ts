import type { Catalog } from './types'

/**
 * ★★★ 审核期演示数据（2026-10-23 起）—— **全部写死，不读任何接口**。
 *
 * 为什么这么做（用户决定）：
 *   官网只为了让微信 H5 支付审核看到「卖什么、多少钱、有售后」，审核期这几个数字
 *   用不着是真的。而一旦读后台，就有三处连带：
 *     ① 改 `member_package.price_fen` 会撞上小程序虚拟支付的道具价契约
 *        （`server/src/lib/xpay.ts::VP_PRODUCT_CONTRACT`，真值在微信 MP 后台，
 *        本地改价 ⇒ 小程序下单 `-15013`）；
 *     ② 改回来还要再走一遍 MP 后台，来回两次都有人工步骤；
 *     ③ 套餐周期/赠积分是「唯一源」，动它等于动已售出会员的口径。
 *   ⇒ 审核期用演示数据，审核通过后一次性回滚成读后台。
 *
 * ── 回滚步骤（就三处，改完删掉本文件即可）───────────────────────
 *   1. `Pricing.tsx`：把 `DEMO_MODE ? Promise.resolve(DEMO_CATALOG) : api<Catalog>(...)`
 *      改回原来的 `api<Catalog>('/web/catalog', { auth: false })`；
 *   2. `Pricing.tsx`：删掉 `buy()` 开头那段 `if (DEMO_MODE) { ... }` 的提示分支；
 *   3. 删掉本文件，以及 `Pricing.tsx` 顶部对它的两行 import。
 *   ⚠ 别只改一半：只删数据、留 `DEMO_MODE` 常量会编译报错；只改 `buy()`、
 *     留着演示数据会「页面显示 ¥198、真下单扣 ¥980」—— 这是最难被发现的那种错。
 *
 * ★ 演示数据本身的要求：像一家**正常在卖东西的店**，不是像一张广告。
 *   · 两档套餐（年付 / 三年付），三年付折合每年更便宜 —— 让「有对比」这件事成立；
 *   · 加油包沿用线上真实的三档（它们本来就对得上，审核员看到的是真实商品结构）；
 *   · 金额一律整数元，不出现 ¥198.50 这种没人定过的价。
 */
export const DEMO_MODE = true

export const DEMO_CATALOG: Catalog = {
  plans: [
    { id: 'demo-plan-1y', name: '订阅 · 1 年', priceFen: 19800, durationDays: 365, grantBeans: '8000' },
    { id: 'demo-plan-3y', name: '订阅 · 3 年', priceFen: 49800, durationDays: 1095, grantBeans: '30000' },
  ],
  packages: [
    { id: 'demo-bean-100', name: '100元 · 10000积分', priceFen: 10000, beans: '10000', bonusBeans: '0' },
    { id: 'demo-bean-300', name: '300元 · 32000积分', priceFen: 30000, beans: '30000', bonusBeans: '2000' },
    { id: 'demo-bean-500', name: '500元 · 50000积分', priceFen: 50000, beans: '50000', bonusBeans: '5000' },
  ],
  /**
   * 两条收银通道都写 false：这是**事实**，不是演示开关 ——
   * `WEB_PAY_NATIVE_ENABLED` / `WEB_PAY_H5_ENABLED` 现在都没开（H5 权限还没批）。
   * 写 true 会让页面点「立即开通」去真的建单，然后卡在一个付不了的收银台上。
   */
  capabilities: { native: false, h5: false },
}
