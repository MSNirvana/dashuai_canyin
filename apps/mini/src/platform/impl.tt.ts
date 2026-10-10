// 平台适配层 · 抖音（字节小程序）实现 —— ★ 骨架，尚未接入完成
//
// 现状诚实说明（别把它当已可用）：
//   · login：Taro 在 tt 端会把 login 映射到 tt.login，故这里直接转发；**待真机验证**。
//     注意「拿手机号」不是这个口 —— 抖音手机号走 open-type='getPhoneNumber' 返回
//     encryptedData+iv，由**服务端**用 session_key 做 AES-128-CBC 解密（见 docs/11 §3.1）。
//   · requestPayment：抖音是担保交易（服务端下单拿 orderId+orderToken → tt.pay），
//     需先完成进件。当前**未接入**，故意抛错而不是让请求悄悄走微信语义。
//   · chooseChatFile：抖音无「从聊天选文件」，返回 null；页面应先看 capabilities.chatFile。
//   · 素材上传（预签名 URL）尚未纳入契约，见 ./types.ts 末尾说明。
//
// ★ 本文件只在 `TARO_ENV=tt` 时被解析进产物。里面的 TT_IMPL_CANARY 同时被
//   scripts/verify-weapp-dist.mjs 当作「跨端隔离」断言用的金丝雀：
//   微信产物里一旦出现它，就说明抖音端代码漏进了微信包。

import Taro from '@tarojs/taro'
import type {
  ChooseChatFileOptions,
  LoginCredential,
  PickedFile,
  PlatformAdapter,
  PlatformFeature,
  RequestPaymentParams,
} from './types'

/**
 * 跨端隔离金丝雀。
 * ★ 它被插值进下面每个错误消息里 —— 这不是装饰：插值进**运行时可达的字符串**才能保证
 *   它不会被压缩器当死代码删掉，从而让「微信产物不含抖音端代码」这条断言真的有效。
 *   改这个值必须同步改 scripts/verify-weapp-dist.mjs。
 */
export const TT_IMPL_CANARY = 'platform-impl-canary:tt'

const CAPABILITIES: Record<PlatformFeature, boolean> = {
  // 抖音没有微信式「一键取手机号」，手机号要用户点授权后由服务端解密
  quickLogin: false,
  // 抖音没有「从聊天会话选文件」
  chatFile: false,
  record: true,
  subscribeMessage: true,
}

/**
 * ★ 抖音端**不认识**微信侧的虚拟支付四件套 ⇒ `virtualPay: false`。
 *
 * 上报这个值的效果：服务端下单口据此**不会**给抖音端下发 `{signData,…}`，
 * 而是落到「普通微信支付」那一支（本项目仅微信两端实现了它）。
 * ⇒ 抖音端在完成担保交易接入前，下单仍是**不可用**的 —— 这是既定事实，
 *   但至少不再是「收到一组看不懂的微信参数」这种误导性的失败。
 * 接入时（`orderId`/`orderToken`）应在这里如实改成 `true` 所对应的新能力位。
 */
const PAY_CAPABILITIES = { virtualPay: false } as const

export const impl: PlatformAdapter = {
  kind: 'tt',
  capabilities: CAPABILITIES,
  payCapabilities: PAY_CAPABILITIES,

  async login(): Promise<LoginCredential> {
    const res = await Taro.login()
    return { code: res.code }
  },

  requestPayment(params: RequestPaymentParams): void {
    // ★ 虚拟支付是**微信侧能力**（`wx.requestVirtualPayment`），抖音端不适用。
    //   本端已上报 `payCapabilities.virtualPay=false`，所以正常情况下服务端**不会**
    //   下发四件套 ⇒ 走到这里说明**服务端与本端的能力声明脱节了**（例如服务端用了
    //   按环境切的旧判据 / 漏传了 `vpCapable`）。单独判一次就是为了让这种情况
    //   立刻显形，而不是让人一头雾水地去找担保交易进件进度。
    //   （抖音端整体尚未接入，见 docs/11。）
    if (params.signData) {
      throw new Error(
        `${TT_IMPL_CANARY} 收到的是微信「小程序虚拟支付」参数（signData），抖音端不适用。` +
          `本端已声明 payCapabilities.virtualPay=false ⇒ 说明服务端下单口没按客户端能力选通道` +
          `（或漏取了 vpCapable），见 docs/12-多端架构约定.md §3.2。`,
      )
    }
    if (!params.orderId || !params.orderToken) {
      throw new Error(
        `${TT_IMPL_CANARY} 抖音支付需要服务端下发 orderId / orderToken（担保交易），当前未拿到。` +
          `服务端下单分支与 Provider 抽象见 docs/12-多端架构约定.md §3.2。`,
      )
    }
    throw new Error(
      `${TT_IMPL_CANARY} 抖音担保支付（tt.pay，service:5）尚未接入：` +
        `需先完成进件，见 docs/11-抖音小程序上线动作清单.md §3.3。`,
    )
  },

  async chooseChatFile(_options: ChooseChatFileOptions): Promise<PickedFile | null> {
    // 该端无此能力；调用方应先按 capabilities.chatFile 隐藏入口，走到这里直接返回空。
    return null
  },
}
