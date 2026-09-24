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

export const impl: PlatformAdapter = {
  kind: 'weapp',
  capabilities: CAPABILITIES,

  async login(): Promise<LoginCredential> {
    const res = await Taro.login()
    return { code: res.code }
  },

  requestPayment(params: RequestPaymentParams): void {
    // ★ 只剥掉「另一个端」的字段，其余整体透传：
    //   这样服务端以后新增的**通用**字段不需要改这里，也不会被静默漏掉。
    // ★ 刻意**不**在这里校验 5 个必填字段：原来缺字段时走的是 wx 的 fail 回调
    //   （充值页据此弹「支付失败」）；若改成这里抛错，异常会被充值页的 catch 静默吞掉，
    //   属于错误路径的行为变化 —— 抽骨架这一步不做，留到两端错误口径一起定。
    const rest = { ...params }
    delete rest.orderId
    delete rest.orderToken
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
