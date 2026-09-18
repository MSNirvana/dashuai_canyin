// 会话代次计数器（session generation）。
//
// ── 解决什么 ──────────────────────────────────────────────────────────
// `services/request.ts` 的 refresh 单飞只解决了「同一时刻并发刷新重复发请求」，
// 完全没有解决「回包属于哪个会话」。真实事故链路：
//   ① 账号 A 的 token 过期 → 触发 refresh（网络慢，还在飞）；
//   ② 用户此刻退出登录 / 换成账号 B 登录 → storage 里的 token 已经是 B 的；
//   ③ A 的 refresh 回包姗姗来迟 → **无条件**把 A 的 token 写回 storage；
//   ④ 结果：storage 里是 A 的 token、页面 store 里是 B 的商户信息，
//      接下来每个请求都带着 A 的身份去取 B 页面上的数据。
// 只有把「会话」变成可比对的数字，回包才有资格被拒绝。
//
// ── 为什么单独一个文件、不放在 services/auth.ts ────────────────────────
// auth.ts 依赖 request.ts（要 http），而 request.ts 需要读会话代次。
// 把计数器放 auth.ts 就会形成 request ⇄ auth 的循环依赖 —— 在小程序的分包/CommonJS
// 产物里，循环依赖的求值顺序一旦变化就会变成「undefined is not a function」这种
// 极难定位的崩溃。这里刻意做成零依赖的叶子模块，两边都只依赖它。
//
// ── 为什么不持久化 ────────────────────────────────────────────────────
// 小程序冷启动会重置模块级变量，但冷启动之后也**不可能**存在「上一个会话的在途回包」
// （在途请求随进程一起没了）。所以内存计数足够，落 storage 反而是多余状态。
export let sessionGeneration = 0

/** 当前会话代次。发起异步流程前记下，落地前再比对。 */
export function currentSessionGeneration(): number {
  return sessionGeneration
}

/** 使所有在途的旧会话异步流程失效（登录 / 退出时自动调用） */
export function bumpSessionGeneration(): number {
  sessionGeneration += 1
  return sessionGeneration
}
