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
 * - 微信（小程序虚拟支付）：signData / paySig / signature / mode
 * - 抖音（担保交易）：orderId / orderToken
 *
 * ★ 三组字段都声明成可选，是为了让**同一个服务端返回对象**能两端通用。
 *   每个实现负责校验自己那组是否齐备，缺了就响亮报错 —— 不做静默降级。
 *
 * ★ 微信的两组是**互斥**的：同一笔订单只会下发其中一组（由服务端 `resolvePayChannel()`
 *   决定），实现按「有没有 `signData`」分流。这不算平台判断，属于同一个平台内部的通道分派。
 */
export interface RequestPaymentParams {
  timeStamp?: string
  nonceStr?: string
  package?: string
  signType?: string
  paySign?: string
  orderId?: string
  orderToken?: string
  /**
   * 小程序虚拟支付（`wx.requestVirtualPayment`）—— 服务端签好的四件套，端侧**原样透传**。
   *
   * ★ 为什么这 4 个字段是「平铺」而不是包成 `virtualPay: {...}`：服务端的 `payParams`
   *   本身就在这一层（JSAPI 是上面 5 个、虚拟支付是这 4 个），保持扁平才能让
   *   「同一个返回对象两端通用」继续成立，页面也才能继续 `{...payParams}` 直传。
   * ★ `signData` 是**已序列化好的字符串**，端侧**不许**再 `JSON.stringify` / `JSON.parse`
   *   或改动任何字符 —— `paySig` 与 `signature` 都是对它**逐字节**签名，重排 key 顺序或
   *   改一次转义就全部失效（现场只会看到 `-15005` / `-15006`，极难排查）。
   */
  signData?: string
  paySig?: string
  signature?: string
  /** 虚拟支付的支付类型。本项目只用 `short_series_goods`（道具直购），不用代币。 */
  mode?: string
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

/**
 * 本端**能解析哪几组支付参数** —— 随下单请求上报给服务端，由它决定下发哪一组。
 *
 * ★★ 为什么必须显式声明，而不能让服务端「看本环境配没配 `WX_VP_*`」就决定：
 *   线上随时有大量**已安装、尚未升级**的客户端。服务端若按环境切成虚拟支付，
 *   旧版本会把 `signData` 四件套当成 JSAPI 参数交给 `Taro.requestPayment`，
 *   表现是「点了付款没反应 / 支付失败」⇒ **全体用户付不了款**。
 *   微信侧的版本发布不由我们控制（用户下次冷启动才拉到新版），
 *   所以「切通道」只能按请求走，判据只能来自**正在发请求的那个客户端**。
 *
 * ★ 这是「客户端告诉服务端我认识什么」，**不是**端侧自己挑通道 ——
 *   挑通道（签哪组参数）始终在服务端，端侧只负责如实申报自己的能力。
 */
export interface PayCapabilities {
  /** 能否接「小程序虚拟支付」四件套（`signData/paySig/signature/mode`）。微信端 true。 */
  readonly virtualPay: boolean
}

export interface ChooseChatFileOptions {
  extensions: string[]
}

export interface PlatformAdapter {
  readonly kind: PlatformKind
  readonly capabilities: Readonly<Record<PlatformFeature, boolean>>
  /** 支付参数解析能力。见 `PayCapabilities` —— 下单时上报，服务端据此选通道。 */
  readonly payCapabilities: PayCapabilities
  /** 登录：拿一次性 code 交回服务端换 session。 */
  login(): Promise<LoginCredential>
  /**
   * 发起支付。**只做透传**：不把回调包成 Promise、不吞异常 ——
   * 否则调用方（充值页）的 toast 分支与「已取消 / 支付失败」语义会跟着变。
   *
   * ★ 微信端内部还要按「参数里有没有 `signData`」在两套支付能力之间分派
   *   （虚拟支付 / JSAPI）。这一步**刻意留在适配层内部**：页面照旧只调一次
   *   `requestPayment`，不需要知道虚拟商品必须走哪条通道。
   */
  requestPayment(params: RequestPaymentParams): void
  /** 从聊天会话选文件。该端不支持时返回 null（页面应先用 capabilities.chatFile 隐藏入口）。 */
  chooseChatFile(options: ChooseChatFileOptions): Promise<PickedFile | null>
}

// 尚未纳入契约的端能力（故意留到对应端实现一起做，避免现在猜签名）：
//   · 素材上传：微信是 cos-wx-sdk-v5 分片直传，抖音要用预签名 URL + Taro.uploadFile，
//     两者共用的入参形态要等抖音端方案定了再冻结（现由 services/upload.ts 直接提供）。
