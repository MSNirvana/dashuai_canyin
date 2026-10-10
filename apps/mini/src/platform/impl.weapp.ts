// 平台适配层 · 微信（小程序）实现
//
// ★ 本文件只在 `TARO_ENV=weapp` 时被 Taro 解析进产物（见 ./index.ts 的说明）。
//   里面的所有调用都是**原样转发**到现有实现 —— 抽骨架这一步不允许顺手改行为，
//   否则「微信端零行为变化」这个验收前提就不成立了。

import Taro from '@tarojs/taro'
import type {
  ChooseChatFileOptions,
  LoginCredential,
  PickedFile,
  PlatformAdapter,
  PlatformFeature,
  RequestPaymentParams,
} from './types'

const CAPABILITIES: Record<PlatformFeature, boolean> = {
  quickLogin: true,
  chatFile: true,
  record: true,
  subscribeMessage: true,
}

/**
 * ★ 微信端两种支付参数都认识（JSAPI 五件套 + 虚拟支付四件套），所以这里恒为 `true`。
 *   这个值会随下单请求上报，服务端据此决定下发哪一组 —— 为什么必须显式上报而不是
 *   让服务端看环境配置决定，见 `types.ts` 的 `PayCapabilities`。
 */
const PAY_CAPABILITIES = { virtualPay: true } as const

/**
 * 微信基础库全局。
 *
 * ★ 为什么在这里**本地声明**而不是全局声明：`@tarojs/taro` 的类型里**没有**
 *   `requestVirtualPayment`（`grep requestVirtualPayment node_modules/@tarojs/` 零命中），
 *   项目也没有引入 `miniprogram-api-typings`（tsconfig 的 `types` 只有 `@tarojs/taro`）。
 *   全局声明会污染所有文件、且与红线「平台差异只留在 src/platform/**」冲突，
 *   所以只在本文件按需最小声明（字段与官方 `RequestVirtualPaymentOption` 对齐）。
 */
declare const wx: {
  requestVirtualPayment?: (option: {
    /** ★ 必须是**已序列化好的字符串**，且与签名用的那串逐字节一致 */
    signData: string
    paySig: string
    signature: string
    mode: string
    success?: (res: unknown) => void
    fail?: (err: { errMsg?: string; errCode?: number }) => void
  }) => void
}

/**
 * 小程序虚拟支付（`wx.requestVirtualPayment`）。
 *
 * ── 为什么必须有它 ─────────────────────────────────────────────
 * 微信《虚拟支付业务运营指南》要求：小程序内的**虚拟商品**（订阅内容、虚拟代币、
 * 付费功能……）购买与支付**均须接入小程序虚拟支付**，且平台会**关闭**这类小程序在
 * 安卓及其余非 iOS 系统的普通微信支付能力。本项目的「会员订阅」与「积分加油包」
 * 两件商品都命中 ⇒ 原来那条 `Taro.requestPayment` 对它们已经**不通**。
 *
 * ── 参数从哪来 ─────────────────────────────────────────────────
 * 四件套全部由服务端签发（`server/src/lib/xpay.ts`）。端侧**一个字节都不改**地透传：
 * `paySig` 是对 `signData` 的 HMAC、`signature` 是对 `signData` 的 session_key 签名，
 * 任何重排 key / 重新序列化都会导致 `-15005` / `-15006`，而这两种错误在现场几乎无法自查。
 */
function requestVirtualPayment(params: RequestPaymentParams): void {
  const fn = wx.requestVirtualPayment
  if (typeof fn !== 'function') {
    // 基础库 < 2.19.2。★ 这里**主动**调 fail 而不是静默 return：
    //   静默返回会让充值页永远停在「点了没反应」，而 fail 至少给出一次明确的提示。
    //   （概率极低 —— 2.19.2 发布于 2021 年；且走这条路说明服务端已开了虚拟支付通道。）
    params.fail?.({ errMsg: '当前微信版本过低，不支持虚拟商品支付，请升级微信后重试' })
    return
  }
  fn({
    signData: params.signData as string,
    paySig: params.paySig as string,
    signature: params.signature as string,
    mode: params.mode as string,
    success: params.success,
    fail: params.fail,
  })
}

export const impl: PlatformAdapter = {
  kind: 'weapp',
  capabilities: CAPABILITIES,
  payCapabilities: PAY_CAPABILITIES,

  async login(): Promise<LoginCredential> {
    const res = await Taro.login()
    return { code: res.code }
  },

  requestPayment(params: RequestPaymentParams): void {
    // ── 通道分派：有 `signData` ⇒ 虚拟支付；否则走原来的 JSAPI ──
    // ★ 判据只认 `signData`（而不是 `mode`/`paySig`）：它是四件套里唯一一定会被
    //   微信消费、且不可能出现在 JSAPI 参数里的字段，用它分流最不容易误判。
    // ★ 这一步**不是**平台判断（红线管的是 weapp/tt 之分），而是同一个平台内两条
    //   支付通道的分派，因此留在适配层内部是恰当的：页面无需知道虚拟商品走哪条路。
    if (params.signData) {
      requestVirtualPayment(params)
      return
    }

    // ★ 只剥掉「另一个端」与「另一条通道」的字段，其余整体透传：
    //   这样服务端以后新增的**通用**字段不需要改这里，也不会被静默漏掉。
    // ★ 刻意**不**在这里校验 5 个必填字段：原来缺字段时走的是 wx 的 fail 回调
    //   （充值页据此弹「支付失败」）；若改成这里抛错，异常会被充值页的 catch 静默吞掉，
    //   属于错误路径的行为变化 —— 抽骨架这一步不做，留到两端错误口径一起定。
    const rest = { ...params }
    delete rest.orderId
    delete rest.orderToken
    delete rest.signData
    delete rest.paySig
    delete rest.signature
    delete rest.mode
    // 断言理由：rest 的字段是 Option 的超集（Option 的必填项在这里都是可选），
    // 交给平台 SDK 按原语义处理。
    void Taro.requestPayment(rest as Taro.requestPayment.Option)
  },

  async chooseChatFile(options: ChooseChatFileOptions): Promise<PickedFile | null> {
    const res = await Taro.chooseMessageFile({ count: 1, type: 'file', extension: options.extensions })
    const file = res.tempFiles?.[0]
    if (!file) return null
    return { path: file.path, size: file.size, name: file.name }
  },
}
