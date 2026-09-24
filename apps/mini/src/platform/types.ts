// 平台适配层 · 契约
//
// ★ 这是「多端」的唯一分叉点。页面/组件/hooks/services 一律不认平台，
//   需要端能力时只调 `platform.*`（见 ./index.ts）。
//   约定全文见 docs/12-多端架构约定.md；红线 1：
//   `IS_DOUYIN` / `IS_WEAPP` / `process.env.TARO_ENV` 只许出现在本目录与 src/config.ts。
//
// 为什么用「接口 + 两份实现」而不是在业务代码里写 if：
//   ① 新增一个端能力时，接口加方法 ⇒ TypeScript 会**编译期**要求两端都实现，
//      漏一端不会等到线上才炸；
//   ② 两端实现分文件（impl.weapp.ts / impl.tt.ts），由 Taro 的 MultiPlatformPlugin
//      按 process.env.TARO_ENV 解析 ⇒ **另一端的代码根本不进本端产物**
//      （既省体积，也避免一端包里出现另一端的痕迹而影响平台审核）。

/** 当前编译的端。取值与 Taro 的 `process.env.TARO_ENV` 对齐。 */
export type PlatformKind = 'weapp' | 'tt'

/**
 * 端能力开关。页面据此决定「显示 / 隐藏某个入口」，
 * 这就是取代散落 `if (IS_DOUYIN)` 的机制。
 */
export type PlatformFeature =
  /** 一键取手机号（微信 `getPhoneNumber`）。抖音端手机号走 encryptedData+iv 由服务端解密，无此一键授权。 */
  | 'quickLogin'
  /** 从聊天会话选文件（微信 `chooseMessageFile`）。抖音端无此能力。 */
  | 'chatFile'
  /** 录音。 */
  | 'record'
  /** 订阅消息。 */
  | 'subscribeMessage'

export interface LoginCredential {
  /** 一次性登录凭证，交回服务端换 session。 */
  code: string
}

/**
 * 支付参数：由**服务端按端下发**，端侧只取自己需要的那组字段。
 *
 * - 微信（v3 JSAPI）：timeStamp / nonceStr / package / signType / paySign
 * - 抖音（担保交易）：orderId / orderToken
 *
 * ★ 两组字段都声明成可选，是为了让**同一个服务端返回对象**能两端通用。
 *   每个实现负责校验自己那组是否齐备，缺了就响亮报错 —— 不做静默降级。
 */
export interface RequestPaymentParams {
  timeStamp?: string
  nonceStr?: string
  package?: string
  signType?: string
  paySign?: string
  orderId?: string
  orderToken?: string
  /** 与调用方原样透传，适配层不二次包装回调语义。 */
  success?: (res: unknown) => void
  fail?: (err: { errMsg?: string }) => void
}

/** 选中的文件（跨端统一形态）。 */
export interface PickedFile {
  path: string
  size: number
  name: string
}

export interface ChooseChatFileOptions {
  extensions: string[]
}

export interface PlatformAdapter {
  readonly kind: PlatformKind
  readonly capabilities: Readonly<Record<PlatformFeature, boolean>>
  /** 登录：拿一次性 code 交回服务端换 session。 */
  login(): Promise<LoginCredential>
  /**
   * 发起支付。**只做透传**：不把回调包成 Promise、不吞异常 ——
   * 否则调用方（充值页）的 toast 分支与「已取消 / 支付失败」语义会跟着变。
   */
  requestPayment(params: RequestPaymentParams): void
  /** 从聊天会话选文件。该端不支持时返回 null（页面应先用 capabilities.chatFile 隐藏入口）。 */
  chooseChatFile(options: ChooseChatFileOptions): Promise<PickedFile | null>
}

// 尚未纳入契约的端能力（故意留到对应端实现一起做，避免现在猜签名）：
//   · 素材上传：微信是 cos-wx-sdk-v5 分片直传，抖音要用预签名 URL + Taro.uploadFile，
//     两者共用的入参形态要等抖音端方案定了再冻结（现由 services/upload.ts 直接提供）。
