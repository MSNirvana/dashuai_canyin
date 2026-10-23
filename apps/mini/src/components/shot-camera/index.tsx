// 自建拍摄层：**全屏**取景 + 提词器 + **点击**拍摄（取代微信原生的「长按录像」）
//
// ★ 为什么必须自建：Taro.chooseMedia 的 sourceType:'camera' 打开的是**微信客户端自己的**
//   拍摄界面，录像是**长按**触发的，小程序侧没有任何参数能改（只有 maxDuration）。
//   系统相机 App 也调不起来 —— 小程序沙箱不开放唤起其它 App（官方原话：
//   「微信未开放原生系统相机界面调用权限」）。要「点一下开始、再点一下停止」，
//   只能用 <Camera> 组件自己画界面。顺带把**提词器**做出来：界面归我们画，
//   分镜的台词（ShotItem.line）就能直接铺在取景画面上。
//
// ★★ 界面必须用 <cover-view>，不能用普通 View —— 这是两次真机翻车换来的结论：
//   1. 取景画面要**占满屏幕**，控件就必然压在 camera 的矩形上；
//   2. camera 是客户端创建的原生组件，官方原文「它的层级是最高的，不能通过 z-index
//      控制层级」，而**同层渲染在真机上会失败**（官方 bindrendererror 注释：
//      Android 缺少同层渲染内核 / iOS 页面节点树不稳定）。一旦失败，叠在它矩形上的
//      普通 View 就收不到点击 —— 表现是整层控件（前后摄、补光、快门）一起点不动；
//   3. cover-view 是官方为「覆盖在原生组件之上」提供的组件（本仓首页那个盖在 <video>
//      上的「收起」按钮就是同一套路）。cover-view 里只能放 cover-view / cover-image，
//      所以这里的文字全用 CoverView，布局一律绝对定位（它不吃 flex）。
//   ⇒ 改这一层之前先读这段：**普通 View 不要往取景画面上放**。只有等 camera 已经卸载的
//     时候（拍完确认 / 相机不可用两块面板）才可以用普通 View。
//
// ★ 自建相机与原生选择器有四处差异，都在下面补齐（少补一处就是静默算错钱或丢素材）：
//   1. stopRecord 只回 { tempVideoPath, tempThumbPath }，**没有 duration**
//      ⇒ 录制时长由本组件自己计时 —— 它同时是「按实际时长计价」的依据，不能省。
//   2. **没有 size** ⇒ 另外问一次文件系统；拿不到就留 undefined（上传侧按 0 处理，
//      服务端 sizeBytes 的校验是 min(0)，不会因此被拒）。
//   3. 「录制结束」有两条入口：用户点击 stopRecord，以及微信自己结束（到达 timeout 上限、
//      页面 onHide、录像异常退出）后回调 timeoutCallback。两条必须收敛到**同一个** finalize，
//      且只能收敛一次 —— 否则会凭空多出一条 take。
//   4. 原生选择器会顺手抽一张封面（thumbTempFilePath），自建相机是靠 tempThumbPath；
//      两者都必须往上传层传，否则素材列表没有缩略图。
//
// ★★ 还有一条平台脾气：startRecord / stopRecord 会「success、fail 一个都不回调」
//   （官方社区多例，其中一例就是用 Taro 调 createCameraContext；安卓另有相机渲染
//   异步导致的 `camera has not been initalized`）。所以**界面状态绝不挂在 success 上**：
//   点击即进入录制态、立即走表；回调只用来纠正 / 重锚；两条调用都配看门狗兜底。
//   这一条是「点了录制没有计时 + 再也点不了停止」的直接原因，改前必读 doStart / doStop。
//
// ★ 布局硬约束（微信官方文档）：同一页面只能有一个 camera；camera **不能**放进
//   scroll-view / swiper / picker-view / movable-view。所以这一层是整页 fixed 浮层，
//   内部不嵌套任何滚动容器（提词器用 CoverView —— 分镜台词本来就只有十几个字）。
//
// ★★ 第五条平台脾气（2026-09-30 加）：**相机没出画时不会有任何回调**。
//   症状就是「提词器、快门、两个圆钮全都渲染正常，只有取景画面是纯黑」（已实测）。
//   `onError` 官方注明是「用户不允许使用摄像头时触发」，但 iOS 上实测**不触发**
//   （社区口径：「无报错、`binderror` 不触发、画面全黑」）。所以三条一起上：
//     ① 失败不打信号 ⇒ 只能盯**成功**信号：`onInitDone` 到点还没来就按「没出画」处理；
//     ② 页面这一侧改不了原生层 ⇒ 唯一的自救是把原生节点**重建**（挪 key），
//        这正是切前后摄已经在用的手段（`device-position` 动态改不生效，也是换 key）；
//     ③ 重建两次还不行 ⇒ 转成面板给出口（去设置 / 回落微信原生的），不能留一块黑屏。
//   另外一条独立的：`onStop`（切后台、被系统抢占、来电）之后预览**不会自己回来**，
//   同样只能靠重建 —— 录制中的那一次刻意不重建，交给「拍完确认 → 重拍」那条路。

import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Image, Camera, CoverView, CoverImage } from '@tarojs/components'
import Taro from '@tarojs/taro'
// ★★ 这两个控件（切换镜头 / 补光）的**图形符号只能用图片**：它们必须待在盖住 camera 的
//   那个 `<cover-view>` 里，而 cover-view **只允许嵌套 cover-view 与 cover-image** ——
//   字体图标（t-icon 之类）在这一层根本渲染不出来。
//   图标由 `scripts/gen-shotcam-icons.py` 生成（白描、透明底），改形状请改脚本重跑。
//   ★ 这三个 PNG 都是 2–3KB，会被 webpack 的图片规则**内联成 base64**，而 <cover-image>
//     的 src 官方只声明支持「临时路径 / 网络地址 / 云文件ID」⇒ 已在 config/index.ts 里
//     关掉内联（`mini.imageUrlLoaderOption.limit = true`），必须是**真文件**。
//     ★★ 值是 `true`，不是 `0` —— 那个配置的语义是**反的**：`true` ⇒ maxSize 0 ⇒ 永不内联；
//        写 `0` 是 falsy，等于「没配」，会静默回落成 2048 字节 ⇒ **只错一部分**
//        （体积刚好大于 2048 的那些仍然正常），是最难查的一类。（本条注释一度写着 0。）
import iconSwitch from '../../assets/shotcam/switch-camera.png'
import iconFlashOn from '../../assets/shotcam/flash-on.png'
import iconFlashOff from '../../assets/shotcam/flash-off.png'
import './index.scss'

/**
 * **自建相机**的录制上限（秒）= 5 分钟，也就是微信 `startRecord.timeout` 的官方上限
 * （原文：「录制时长上限，单位为秒，最长不能超过 5 分钟」，默认 30，最低库 2.22.0）。
 *
 * ★★ 2026-10-19 由 60 改成 300：原来取 60 是为了跟**原生选择器**的 `maxDuration` 对齐，
 *   但产品上我们**只用自建相机**，没必要被原生那条路的上限拖着走。
 * ★ 回落路径（相册 / 相机不可用时）仍受微信限制，它的上限是**另一个**常量
 *   `NATIVE_PICK_MAX_SECONDS = 60`（官方 `chooseMedia.maxDuration` 只接受 3~60 秒）。
 *   ⇒ 两个数**不要合并**：把 300 传给 `chooseMedia` 是越界的，行为未定义。
 * ★ 时长是计价依据（`durationMs`），放宽之后单条素材会变长，计价与转码时长跟着变。
 */
export const SHOOT_MAX_SECONDS = 300

/**
 * 微信**原生选择器**（`wx.chooseMedia`）的拍摄上限（秒）。
 * 官方原文：「拍摄视频最长拍摄时间，单位秒。时间范围为 **3s 至 60s** 之间。不限制相册。」
 * ★ 它跟 `SHOOT_MAX_SECONDS` 是两回事，别拿自建相机的 300 去填它。
 * ★ 相册那条路本来不受 `maxDuration` 限制（官方「不限制相册」），这里写 60 只是给
 *   「相机不可用 → 回落原生相机」那一档兜个底。
 */
export const NATIVE_PICK_MAX_SECONDS = 60

/**
 * 等 stopRecord 把文件交回来的上限（毫秒）。
 * 它要等编码落盘，本来就慢，所以给得宽一点；但**必须有这个上限** ——
 * stopRecord 也可能一个回调都不来（平台已知问题），没有上限用户就永远停在「正在保存…」。
 */
const STOP_ACK_TIMEOUT_MS = 8000

/**
 * `stopRecord` 报 fail 之后，还要再等多久给 `timeoutCallback` 一个机会（毫秒）。
 *
 * ★★ `operateCamera:fail:is not recording` 的字面意思是「调停止时原生层没在录」。
 *   它**不是相机故障**，最常见的原因是**微信已经自己把录像结束了** —— 到录制上限、
 *   页面 onHide、被系统抢占都会这样，而结束后的文件是由 `timeoutCallback` 送回来的。
 *   那条回调比 `stopRecord` 的 fail **晚到是常态**（平台已知的不保证回调）。
 *   ⇒ 判到这个错不能立刻判死：把看门狗缩到这一档，等文件；
 *     文件来了就正常进确认页（这一段救回来了），没来才回待拍并 toast。
 */
const STOP_FAIL_GRACE_MS = 1500

/**
 * 短于这个时长（毫秒）就认为「这一条基本没录上」。
 * 它同时是 A 类故障的现场特征：快门点得太快 —— `startRecord` 是异步的，
 * 而本组件是**乐观进态**（不等 success 就进录制态，见 doStart ★★），
 * 于是 t+0 发出 start、t+200ms 就点了停止 ⇒ 原生还没进录制态 ⇒ `is not recording`。
 */
const MIN_MEANINGFUL_TAKE_MS = 1200

/**
 * 「录制状态对不上」的金丝雀串（纯 ASCII，防压缩器当死代码删掉）。
 * ★ 这个故障在真机上只能靠控制台分辨是 A（按太快）还是 B（微信自己结束了）：
 *   日志里同时打出 `acked`（startRecord 有没有被确认过）与 `elapsed`（点了多久）。
 */
const STOP_STATE_CANARY = 'shotcam-stop-state'

/**
 * 「相机尚未初始化」的重试间隔（毫秒）。
 * 安卓的相机渲染是异步的，startRecord 偶尔会撞上 `camera has not been initalized`。
 * 这是瞬时竞态，隔一拍重试一次就过 —— 别为它弹面板，否则用户以为相机坏了。
 */
const START_RETRY_DELAY_MS = 700

/**
 * 等「相机初始化完成」的上限（毫秒）。
 *
 * ★★ 黑屏是**没有任何回调**的故障：相机因为没授权 / 被别的 App 占着 / 机型不兼容而没出画时，
 *   这一层界面**照常渲染**（提词器、快门、两个圆钮全在），而 `onError` 在 iOS 上实测
 *   **不触发**（官方社区口径：「无报错、binderror 不触发、画面全黑」）。
 *   既然失败不打信号，就只能反过来盯**成功**信号：到点还没等到 `onInitDone`，
 *   就按「没出画」处理（见 recoverCamera）。
 * 给 3 秒是因为相机启动本身要时间（安卓低端机从进页面到有画面要 1~2 秒）。
 */
const CAM_INIT_TIMEOUT_MS = 3000

/**
 * 一次打开浮层里允许**自动重建**相机的次数。
 * 黑屏的首选自救就是把原生节点重建一遍（切前后摄能生效就是同一个原理）。
 * 重建两次还没起来，就不是瞬时问题了 —— 转成面板给出口，别让用户对着黑屏干等。
 */
const CAM_MAX_AUTO_RECOVER = 2

/**
 * 「摘-挂」重建之间要等的毫秒数。
 *
 * ★★ 为什么不能直接换 key：`<Camera>` 是**原生组件**，微信的硬约束是「同一时刻只允许一个」。
 *   换 key 时 React 会在**同一个 commit** 里插入新节点、移除旧节点，而原生层的销毁是**异步**的 ——
 *   新节点插进去时旧节点还在 ⇒ 直接报
 *   `insertCamera:fail can insert only one camera`，相机从此整个不能用（不是黑屏，是彻底不可用）。
 *   ★ 2026-09-30 真机复现：首次进入走授权流程超过 3 秒 ⇒ 看门狗误判黑屏 ⇒ 重建 ⇒ 撞车。
 *   ⇒ 必须**先把相机摘下来**，给微信一点时间销毁原生节点，再挂新一代。
 */
const CAM_REBUILD_GAP_MS = 350

/**
 * 「授权还没定」时看门狗给的时限（毫秒）。
 *
 * ★ 首次进入会弹微信的相机授权框，用户看完再点「允许」要好几秒 —— 这段时间**不可能**有
 *   `onInitDone`。用默认的 3 秒去等，等于**必然**误判成黑屏（进而触发重建、撞出上面那个错）。
 *   所以按授权状态分两档：已明确允许过用 3 秒；还没问过（含首次弹框、getSetting 读失败）给 12 秒。
 */
const CAM_AWAIT_AUTH_TIMEOUT_MS = 12000

/**
 * 控制台/产物里的**金丝雀**串（纯 ASCII，防压缩器当死代码删掉）。
 * `scripts/verify-weapp-dist.mjs` 拿它断言「黑屏自愈这条链路确实进了产物」——
 * 只看源码或只跑 tsc 都验不出「产物里有没有它」。
 */
const BLACK_RECOVER_CANARY = 'shotcam-black-recover'

export interface ShotCameraResult {
  videoPath: string
  thumbPath?: string
  /** 录制时长（毫秒）。★ 自建相机拿不到 duration，由本组件计时 —— 它是计价依据 */
  durationMs: number
  /** 文件字节数；取不到则是 undefined */
  sizeBytes?: number
}

/** 提词器要用到的分镜字段（只取用得到的几个，避免把整个 ShotItem 拖进来） */
export interface ShotCameraShot {
  seq: number
  shotType?: string | null
  line?: string | null
  visualReq?: string | null
  durationSuggest?: number | null
}

interface Props {
  visible: boolean
  shot: ShotCameraShot | null
  /**
   * 「怎么拍」的一句话（来自镜头库）。
   * ★ 2026-09-28 按需求从取景层撤掉：屏幕上只留「口播文案 + 画面文案」，别的都不要。
   *   字段先留着是为了**不动调用方**（pages/creation/shots.tsx 那一行属于另一条未提交的
   *   改动线，不该被这次改动捆进去）。下次清理时连调用方那一行一起删。
   */
  tipText?: string
  onCancel: () => void
  onDone: (r: ShotCameraResult) => void
  /**
   * 自建相机用不了（没有权限 / 没有摄像头 / 启动失败）。
   * ★ 调用方必须接住并回落到微信原生选择器 —— 否则用户在这一页就彻底拍不了。
   */
  onUnavailable: (reason: string) => void
  /**
   * 录制**刚结束**（文件已拿到、但还没进 review 面板）时回调一次。
   * ★ 与 onDone 的差别只在时机：onDone 要等用户点「用这条」，这里**一录完就给**。
   *   调用方用它做「留一份本地副本」这种**不需要用户确认**的附带动作
   *   （本项目：存一份到手机相册）—— 放在这个时机，即使随后上传失败、或用户直接重拍，
   *   这一段也已经落地了；等 onDone 就晚了，而「上传失败导致视频丢了」正是要防的场景。
   * ★ 可选：不传即代表调用方不需要副本。本组件只负责把文件路径交出来，存到哪里是调用方的事。
   */
  onRecorded?: (r: ShotCameraResult) => void
}

/** 录制结束的两种来源（用户点击 / 微信自己结束）回给我们的都是这俩路径 */
interface RecordEndPayload {
  tempVideoPath?: string
  tempThumbPath?: string
}

/** Taro 的 CameraContext.StartRecordOption 类型里漏了 timeout（微信 2.22.0+ 才有），这里补上 */
interface StartRecordOptionWithTimeout {
  timeout?: number
  success?: () => void
  fail?: (e: unknown) => void
  timeoutCallback?: (res: RecordEndPayload) => void
}
interface StopRecordOptionLoose {
  success?: (r: RecordEndPayload) => void
  fail?: (e: unknown) => void
}

/** 00:12 形式的时钟（提词器/计时器用；与分镜卡片上的「分:秒」保持同一种读法） */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * 每一行最多几个字 —— **必须与 index.scss 里对应的 font-size 成对修改**。
 * 依据：prompt 可用宽度约 686rpx，中文按「1 字 ≈ 1 个字号宽」⇒ 686 / font-size。
 *   口播文案 62rpx ⇒ 11 字；画面文案 30rpx ⇒ 22 字
 */
const PROMPT_MAX_CHARS = 11
const VISUAL_MAX_CHARS = 22

/** 不许出现在**行首**的标点（落在这上面就把切点右移一位，让标点收在上一行行尾） */
const LEAD_PUNCT_RE = /[，、。！？；：,.!?;:）》」』】]/

/**
 * 把一条文案切成若干行，**保证每一行都排得下**。
 *
 * ★★ 为什么必须自己切：这两条文案画在 `<cover-view>` 里，而 cover-view 的默认样式是
 *   `white-space: nowrap` —— 超过一行的部分会被**静默裁掉**（不换行、不报错）。
 *   `white-space: normal` 在真机上并不可靠，所以这里按「每行最多几个字」硬切 ——
 *   切完每行都一定排得下。
 *
 * ★ 2026-10-19 用户口径：**不许按长度缩字号**（「文字一长，字体就又变小了，要直接分行」）。
 *   所以原来那三档字号（62 / 42 / 32）已全部取消，字号固定 62rpx，
 *   长了的唯一表现就是**多占一行**。
 *
 * ★★ 切法＝**均分**，不是「按标点切」。按标点切会把
 *   `我们家的牛肉，每天早上现切` 切成 `我们家的牛` / `肉，` —— 两字孤行比硬切更难看。
 *   均分（11 字 ⇒ 4+4+3）不会留孤字，且每行长度差不超过 1 个字。
 * ★ 原文自带换行时**先按换行拆段、每段各自均分** —— 那正是「按句子分行」的行为。
 * ★ 均分之外只做一处微调：切点正好落在标点前时，先试着把标点**收进上一行行尾**；
 *   上一行已经占满就**退一格**让它落进行中。两条都不成立（会造出孤字行或超宽行）
 *   时才允许标点落在行首 —— 平衡与不超宽优先于标点位置。
 * ★ 每段至少 2 个字（`Math.max(2, maxChars)`）：避免 `maxChars < 2` 时死循环。
 * ★ 行数 = ceil(n / lim)，逐行取 `base` 或 `base+1` ⇒ 拼回去与原文逐字相同。
 */
function splitPromptLines(text: string, maxChars: number): string[] {
  const lim = Math.max(2, maxChars)
  const paras = text
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const out: string[] = []
  for (const para of paras) {
    const n = para.length
    if (n <= lim) {
      out.push(para)
      continue
    }
    const lines = Math.ceil(n / lim)
    const base = Math.floor(n / lines)
    const extra = n % lines
    const cuts: number[] = [0]
    let pos = 0
    for (let i = 0; i < lines - 1; i++) {
      pos += base + (i < extra ? 1 : 0)
      cuts.push(pos)
    }
    cuts.push(n)
    for (let i = 1; i < cuts.length - 1; i++) {
      const c = cuts[i]!
      if (!LEAD_PUNCT_RE.test(para[c] ?? '')) continue
      const prev = cuts[i - 1]!
      const next = cuts[i + 1]!
      // ① 首选：把标点收进上一行行尾（上一行放得下、且本行还剩 ≥3 字）
      if (c - prev + 1 <= lim && next - (c + 1) >= 3) {
        cuts[i] = c + 1
        continue
      }
      // ② 次选：退一格，让本行从标点前一个字开始，标点落进行中
      if (c - 1 - prev >= 3 && next - (c - 1) <= lim) cuts[i] = c - 1
    }
    for (let i = 0; i < cuts.length - 1; i++) {
      out.push(para.slice(cuts[i], cuts[i + 1]))
    }
  }
  return out
}

/** 微信的错误对象有时是 {errMsg}、有时是 Error（Taro 包了一层），两种都取 */
function errText(e: unknown): string {
  const o = e as { errMsg?: string; message?: string } | null | undefined
  return o?.errMsg || o?.message || ''
}

/**
 * 取本地文件字节数（自建相机拿不到 size，只能自己问文件系统）。
 * ① 先问 FileSystemManager（接口现成、类型完整）；
 * ② 再兜底顶层 Taro.getFileInfo（官方注释里指明它才是给**临时文件**用的那个）；
 * ③ 都拿不到就返回 undefined —— 上传侧会给 0，服务端 sizeBytes 是 min(0)，不会因此被拒。
 *    宁可 size 记 0，也不能为了拿这个数字把拍好的视频卡在这里。
 */
function readFileSize(filePath: string): Promise<number | undefined> {
  const pick = (r: unknown): number | undefined => {
    const n = (r as { size?: number } | null)?.size
    return typeof n === 'number' && n > 0 ? n : undefined
  }
  return new Promise<number | undefined>((resolve) => {
    try {
      Taro.getFileSystemManager().getFileInfo({
        filePath,
        success: (r) => resolve(pick(r)),
        fail: () => resolve(undefined),
      })
    } catch { resolve(undefined) }
  }).then((n) => {
    if (typeof n === 'number') return n
    return new Promise<number | undefined>((resolve) => {
      try {
        Taro.getFileInfo({
          filePath,
          success: (r) => resolve(pick(r)),
          fail: () => resolve(undefined),
        })
      } catch { resolve(undefined) }
    })
  })
}

/** CameraContext 收窄成我们实际用的两个方法（见 StartRecordOptionWithTimeout 的注释） */
function cameraCtx(): {
  startRecord: (o: StartRecordOptionWithTimeout) => void
  stopRecord: (o?: StopRecordOptionLoose) => void
} {
  return Taro.createCameraContext() as unknown as {
    startRecord: (o: StartRecordOptionWithTimeout) => void
    stopRecord: (o?: StopRecordOptionLoose) => void
  }
}

export default function ShotCamera({ visible, shot, onCancel, onDone, onUnavailable, onRecorded }: Props) {
  /** idle 取景待拍 / recording 录制中 / review 拍完待确认 */
  const [phase, setPhase] = useState<'idle' | 'recording' | 'review'>('idle')
  const [elapsed, setElapsed] = useState(0)
  /**
   * 点了停止、正在等文件落盘的那一小段（stopRecord 要等编码完成才回调。
   * ★ 有它用户才知道「点停有反应了」，也顺手挡住这段时间里的重复点击。
   */
  const [saving, setSaving] = useState(false)
  const [device, setDevice] = useState<'front' | 'back'>('back')
  const [flash, setFlash] = useState<'off' | 'torch'>('off')
  const [take, setTake] = useState<ShotCameraResult | null>(null)
  /**
   * 相机层自己的问题（拒绝授权 / 没有摄像头 / 启停失败）。
   * ★ 一旦有值就**不再渲染 <Camera>**：渲染一个用不了的 camera 只会反复弹授权框，
   *   而用户需要的是一个能走出去的出口（去设置 / 回落原生）。
   */
  const [failMsg, setFailMsg] = useState('')

  /**
   * 相机重建代次。★ 它进 `<Camera>` 的 key：改一下就**强制微信重建原生节点**。
   * 这是本项目已验证过能拿回画面的唯一手段 —— 切前后摄（`device-position` 在部分机型上
   * 动态改不生效）就是靠换 key 重建生效的。
   * 用途：黑屏自愈（见 recoverCamera）、从设置页回来重试。
   */
  const [camGen, setCamGen] = useState(0)

  /**
   * 「暂时把相机摘下来」。
   * ★★ 重建必须走「先摘 → 等一等 → 再挂」，不能只换 key —— 见 CAM_REBUILD_GAP_MS 的 ★★。
   *   它和 camGen 是一对：camHold=true 卸掉旧节点，CAM_REBUILD_GAP_MS 之后 camGen+1 且
   *   camHold=false 挂上新节点。中间那一小段黑屏是有意的，换来的是不撞车。
   */
  const [camHold, setCamHold] = useState(false)
  /** 摘-挂重建的定时器（关浮层 / 卸载时必须清掉，否则会对一个已经关掉的浮层把相机挂回来） */
  const camRebuildRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * `scope.camera` 的探测结果：true 已授权 / false 明确拒绝 / null 还没问过。
   * ★ 它只决定看门狗用哪一档超时（见 CAM_AWAIT_AUTH_TIMEOUT_MS）——首次进入时，
   *   用户还在看授权框，不该按「3 秒没画面就是黑屏」处理。
   */
  const [camAuth, setCamAuth] = useState<boolean | null>(null)

  /** 这一代相机是否已经 `onInitDone`。★ 它是判断「画面到底出没出」的**唯一可靠信号**（黑屏不报错） */
  const camReadyRef = useRef(false)
  /** 初始化看门狗：到点还没 onInitDone 就按「没出画」处理 */
  const camInitWatchRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 本次打开浮层已经自动重建过几次（成功起来一次就还清，见 onInitDone） */
  const camRecoverRef = useRef(0)

  /**
   * `startRecord` 有没有真的被微信确认过（只有它的 `success` 会置真）。
   *
   * ★★ 它**不能**用来判断「到底在不在录」：那个 `success` 在真机上经常一个都不回调
   *   （见 doStart ★★），拿 false 当「没录上」的证据会误伤正常录制。
   *   它只用于两件事：① 真机日志里区分「按太快」与「微信自己结束了」；
   *   ② 日志之外的提示文案分档。生死判断一律交给「文件有没有回来」这个事实。
   */
  const startAckedRef = useRef(false)

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** stopRecord 的看门狗：它不回调时靠它把界面放出来（见 doStop） */
  const stopWatchRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startedAtRef = useRef(0)
  const elapsedRef = useRef(0)
  /** 停表时刻的时长：点击停止与微信自动结束都要先落到这里，finalize 只读不算 */
  const endedElapsedRef = useRef<number | null>(null)
  /** finalize 的幂等闸：两条结束入口 + 兜底自停，只能有一次真正生效 */
  const finalizedRef = useRef(false)
  /**
   * ★★ 录制态用 ref 做**同步**判断，`phase` 只管渲染：连点两下快门时两次 click 读到的
   *   `phase` 都是旧值（setState 是异步的），只靠它挡不住第二次 startRecord。
   */
  const recordingRef = useRef(false)
  /** 点了停止、正等文件落盘：这期间的点击必须被挡住（同上是同步判断） */
  const savingRef = useRef(false)
  /**
   * ★★ 「录制代次」：`resetRun` 每清一次场就 +1，startRecord / stopRecord 的回调在**发出
   *   那一刻**把当时的代次闭包进去，回来时先对一下代次 —— 对不上说明这一轮已经被用户
   *   放弃（重拍 / 交棒 / 关掉浮层）了。
   *   为什么必须有它：这两个回调在真机上会**迟很多拍**才回来（平台已知问题）。没有它，
   *   上一段的 stopRecord 回来时会把**上一段的文件**当成刚拍好的这一段填进 take。
   */
  const epochRef = useRef(0)

  /**
   * ★ 把 onRecorded 转成「永远指向最新」的读取口，而不是在 finalize 里直接用 props 里的它。
   *
   * 为什么必须绕这一下：finalize 是 `useCallback(..., [clearTimer])`，而 clearTimer 恒定
   * ⇒ **finalize 只会创建一次**，它闭包住的是**第一次 render 时**那个 onRecorded。
   * 调用方传的多半是内联箭头函数、里面闭着当轮的 state —— 直接用就会读到**过期**的那一份
   * （典型症状：留副本时用的是旧分镜 / 旧门店）。
   * 而把 onRecorded 塞进 finalize 的依赖数组同样不行：那会让 finalize 每次 render 重建，
   * 连带 doStop 等一串 callback 一起失效 —— 而「回调稳定」正是本组件录制状态机成立的前提
   * （见上面 resetRun / epochRef 那几段注释）。⇒ ref 是唯一两边都不动的办法。
   */
  const onRecordedRef = useRef(onRecorded)
  useEffect(() => { onRecordedRef.current = onRecorded }, [onRecorded])

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  /**
   * 把「这一条录制」的运行时痕迹全部清干净：计时器、看门狗、幂等闸、录制/保存标记。
   * ★ 三处都要用（关闭浮层、重新打开、重拍），漏掉哪一处都会留下一条「卡住的」状态。
   * ★ 注意它会把 finalizedRef 置回 false —— 所以 **finalize 内部不能调它**，
   *   那些字段在 finalize 里逐个显式处理（见 finalize）。
   */
  const resetRun = useCallback(() => {
    clearTimer()
    if (stopWatchRef.current) { clearTimeout(stopWatchRef.current); stopWatchRef.current = null }
    startedAtRef.current = 0
    elapsedRef.current = 0
    endedElapsedRef.current = null
    finalizedRef.current = false
    recordingRef.current = false
    savingRef.current = false
    startAckedRef.current = false
    // ★ 相机自愈的预算也还回去：重拍 / 重新打开时，黑屏又有两次重建机会（而不是一进就失败）
    camRecoverRef.current = 0
    camReadyRef.current = false
    // ★ 在飞的摘-挂重建也要停掉并解开：否则「关掉浮层 → 350ms 后又把相机挂回来」，
    //   用户已经退出去了，相机却在后台被点亮。
    if (camRebuildRef.current) { clearTimeout(camRebuildRef.current); camRebuildRef.current = null }
    setCamHold(false)
    // ★ 代次 +1：在飞的那两个回调（startRecord / stopRecord）从此对不上号，一律丢弃
    epochRef.current += 1
  }, [clearTimer])

  /**
   * ★★ 只在「正在取景」时才挂 <Camera>。拍完确认（review）与相机不可用（failMsg）两块
   * 面板都是**居中**的、用的是普通 View —— 普通 View 盖不住还活着的 camera（native 组件的
   * 层级最高）。所以进这两态之前先把 camera 卸掉，面板上的按钮才点得到；
   * 这也是 43454fa 里「面板同样点不动」的同一条根因（见 index.scss 文件头 ★★）。
   */
  const showCamera = !failMsg && phase !== 'review' && !camHold

  /**
   * 相机没出画时的自救：把原生节点**重建一遍**。
   *
   * ★★ 为什么重建是唯一手段：取景画面是客户端原生层画的，黑屏时页面这边**收不到任何错误**
   *   （`onError` 在 iOS 上实测不触发），我们改不了原生层，只能让微信**重新初始化一次相机**。
   * ★ 预算（CAM_MAX_AUTO_RECOVER 次）用尽就转成面板：到那一步就是环境问题
   *   （系统里把微信的相机权限关了 / 摄像头被别的 App 占着 / 机型不兼容），
   *   必须有出口（去设置、回落微信原生的），不能留用户对着黑屏。
   */
  const rebuildCamera = useCallback((reason: string) => {
    if (camRebuildRef.current) return  // 已经在摘-挂了，别再叠一次
    camReadyRef.current = false
    // ★ 打一行带金丝雀的日志：真机上看不到界面细节时，这是唯一能确认「自愈确实跑过」的痕迹
    console.warn(`[${BLACK_RECOVER_CANARY}] 重建相机（${reason}），自愈计数 ${camRecoverRef.current}/${CAM_MAX_AUTO_RECOVER}`)
    setCamHold(true)
    camRebuildRef.current = setTimeout(() => {
      camRebuildRef.current = null
      setCamGen((g) => g + 1)
      setCamHold(false)
    }, CAM_REBUILD_GAP_MS)
  }, [])

  const recoverCamera = useCallback((why: 'init-timeout' | 'insert-conflict' | 'stopped') => {
    if (camRebuildRef.current) return  // 已经在重建中，这一轮不再追加预算
    if (camRecoverRef.current >= CAM_MAX_AUTO_RECOVER) {
      setFailMsg('相机没能启动，画面一直是黑的')
      return
    }
    camRecoverRef.current += 1
    rebuildCamera(why)
  }, [rebuildCamera])

  // 关掉浮层（visible=false）时一定要停表：否则 interval 会在已卸载的组件上继续 setState。
  // 看门狗同理 —— 它到点也会 setState。
  useEffect(() => {
    if (!visible) return
    return () => { resetRun() }
  }, [visible, resetRun])

  // 每次重新打开都从「待拍」开始；device/flash 保留上次选择（用户多半要连拍同一机位）
  useEffect(() => {
    if (!visible) return
    resetRun()
    setPhase('idle')
    setElapsed(0)
    setSaving(false)
    setTake(null)
    setFailMsg('')
  }, [visible, resetRun])

  // 预检相机授权：已明确拒绝过时直接给面板，别让 <Camera> 空转。
  // ★ 顺便把结果落进 camAuth —— 看门狗要靠它决定用「3 秒」还是「12 秒」（见 CAM_AWAIT_AUTH_TIMEOUT_MS）。
  useEffect(() => {
    if (!visible) return
    let alive = true
    setCamAuth(null)  // 每次打开都重新探测
    Taro.getSetting()
      .then((s) => {
        if (!alive) return
        const auth = (s.authSetting ?? {}) as Record<string, boolean>
        if (auth['scope.camera'] === false) {
          setCamAuth(false)
          setFailMsg('需要相机权限才能在这里拍摄')
          return
        }
        setCamAuth(auth['scope.camera'] === true)
      })
      .catch(() => { /* 读不到就交给 <Camera> 自己的授权弹窗；camAuth 保持 null ⇒ 按「未定」给长超时 */ })
    return () => { alive = false }
  }, [visible])

  /**
   * ★★ 黑屏探针：盯**成功**信号，而不是等错误。
   *
   * 相机没出画时这一层收不到任何回调 —— `onError` 在 iOS 上实测不触发，于是界面一切正常、
   * 画面全黑，用户只能退出去重进（这正是加这条之前的行为）。
   * 所以反过来做：一进取景就起计时器，到点还没等到 `onInitDone` 就按「没出画」处理 ——
   * 先自动重建，重建次数用完才给面板（见 recoverCamera）。
   * 顺带把另一条也闭掉了：首次进入时若在授权弹窗上点了「拒绝」，同样不会有 onInitDone，
   * 于是走同一条路 → 最终落到面板上的「去设置里允许」，而不是一块没有任何提示的黑屏。
   *
   * ★★ 只用 showCamera / camGen 表示「新一代原生节点挂上来了」。device / flash 的普通状态变化
   *   不能重置成功信号；尤其 camAuth 是异步返回的，它可能晚于 onInitDone —— 若此时把 ready 清回 false，
   *   这台已经正常启动的相机会在 3 秒后被误判成黑屏并被我们主动摘掉。
   */
  useEffect(() => {
    if (!showCamera) return
    // ★ 已经收到这一代的 onInitDone 就别再布看门狗。典型顺序是：相机先起来，随后 getSetting
    //   才返回 camAuth=true；后者会让本 effect 重跑，但绝不能抹掉前者已经确认的成功事实。
    if (camReadyRef.current) return
    // ★★ 超时分两档：首次进入时微信可能弹相机授权框，用户看完再点需要好几秒，
    //   这段时间不可能有 onInitDone。已明确允许过才用 3 秒；授权未定给 12 秒。
    const wait = camAuth === true ? CAM_INIT_TIMEOUT_MS : CAM_AWAIT_AUTH_TIMEOUT_MS
    camInitWatchRef.current = setTimeout(() => {
      camInitWatchRef.current = null
      if (!camReadyRef.current) recoverCamera('init-timeout')
    }, wait)
    return () => {
      if (camInitWatchRef.current) { clearTimeout(camInitWatchRef.current); camInitWatchRef.current = null }
    }
  }, [showCamera, camGen, camAuth, recoverCamera])

  /**
   * 录制结束的唯一收敛点：用户点停、到达上限、被系统打断，最后都走这里。
   * ★ 幂等由 finalizedRef 保证；时长只读 endedElapsedRef，不在这里重新算 ——
   *   success 回调回来时已经过了一段编码落盘时间，在这里取 Date.now() 会把时长算长，
   *   而时长是计价依据。
   */
  const finalize = useCallback(async (res: RecordEndPayload) => {
    if (finalizedRef.current) return
    finalizedRef.current = true
    recordingRef.current = false
    savingRef.current = false
    startAckedRef.current = false
    clearTimer()
    if (stopWatchRef.current) { clearTimeout(stopWatchRef.current); stopWatchRef.current = null }
    setSaving(false)
    setPhase('idle')
    const videoPath = res.tempVideoPath
    if (!videoPath) {
      // 录像异常退出且微信没把文件交回来：不能假装成功，也不该把用户刚拍的那段默默丢掉
      setFailMsg('这次没有拿到录像文件，请再拍一次')
      return
    }
    const durationMs = endedElapsedRef.current ?? Math.max(0, elapsedRef.current)
    const sizeBytes = await readFileSize(videoPath)
    const recorded: ShotCameraResult = { videoPath, thumbPath: res.tempThumbPath, durationMs, sizeBytes }
    setTake(recorded)
    setPhase('review')
    // ★ 录制一结束就把这一段交给调用方（它要留一份到相册）。
    //   时机刻意放在「拿到文件」之后、「用户点『用这条』」之前：这样即使随后上传失败、
    //   或用户直接重拍，这一段也已经落地了 —— 这正是要防的场景（上传失败 = 视频白拍）。
    //   ★ 刻意**不 await**：留副本要过相册授权（可能弹框、可能被拒），绝不能因此把用户
    //     卡在「正在保存…」而迟迟进不了 review 面板；保存失败也不影响本次交付的文件。
    onRecordedRef.current?.(recorded)
  }, [clearTimer])

  /**
   * 这一条彻底放弃：回到待拍，**相机继续挂着**。
   *
   * ★★ 为什么不沿用 `setFailMsg(...)`：那个状态会让 `showCamera` 变 false（见 showCamera），
   *   整台相机被拆掉，用户只剩「去设置里允许」—— 可「没在录」跟权限毫无关系，
   *   那是**录制状态**对不上，相机本身是好的。拆掉它 = 让用户白重来一遍取景。
   * ★ 走之前必须把代次 +1：否则在飞的 startRecord / stopRecord 回调还对得上号，
   *   迟到的文件会填进**下一条**正在录的里（表现为「重拍之后跳出来一个旧视频」）。
   */
  const abandonTake = useCallback((toast: string) => {
    finalizedRef.current = true   // ← 迟到的回调一律丢弃，别把这一条又当成成功
    recordingRef.current = false
    savingRef.current = false
    startAckedRef.current = false
    if (stopWatchRef.current) { clearTimeout(stopWatchRef.current); stopWatchRef.current = null }
    clearTimer()
    epochRef.current += 1
    endedElapsedRef.current = null
    elapsedRef.current = 0
    setSaving(false)
    setElapsed(0)
    setPhase('idle')
    Taro.showToast({ title: toast, icon: 'none' })
  }, [clearTimer])

  const doStop = useCallback(() => {
    if (!recordingRef.current || finalizedRef.current) return
    // ★ 记下「这一轮」的代次：下面两个回调迟回来时若对不上，说明用户已经重拍 / 关掉了，
    //   那个文件不能再算作刚拍好的这一段（见 epochRef ★★）。
    const ep = epochRef.current
    /**
     * startRecord 有没有被微信确认过。
     * ★ 只用来给日志与提示分档，**不用它做生死判断** —— 那个 success 在真机上经常不回调，
     *   拿 false 当「没录上」的证据会误伤正常录制。生死只看「文件有没有回来」。
     */
    const acked = startAckedRef.current
    recordingRef.current = false
    endedElapsedRef.current = endedElapsedRef.current ?? Math.max(0, Date.now() - startedAtRef.current)
    const endedMs = endedElapsedRef.current ?? 0
    clearTimer()
    // 立刻离开「录制中」并进入「正在保存」：点停要有即时反馈，也顺手挡住重复点击
    setPhase('idle')
    savingRef.current = true
    setSaving(true)
    /**
     * 收口：放弃这一条。
     * ★ 它**不**弹「相机不可用」面板 —— 那个面板是给权限 / 没有摄像头用的，会拆掉整台相机；
     *   「没在录」只是这一段没成，相机还是好的，用户应当能就地把快门再按一次。
     */
    const armWatch = (ms: number) => {
      if (stopWatchRef.current) { clearTimeout(stopWatchRef.current); stopWatchRef.current = null }
      stopWatchRef.current = setTimeout(() => {
        stopWatchRef.current = null
        if (epochRef.current !== ep || finalizedRef.current || !savingRef.current) return
        abandonTake(endedMs < MIN_MEANINGFUL_TAKE_MS
          ? '这一条没录上，请再拍一次'
          : '这段录像没保存成功，请再拍一次')
      }, ms)
    }
    /* ★★ 看门狗：stopRecord 也会「success、fail 一个都不回调」（平台已知问题）。
       没有它，用户就永远停在「正在保存…」—— 那就是「点不了停止」。 */
    armWatch(STOP_ACK_TIMEOUT_MS)
    /**
     * 停止失败。
     * ★★ `operateCamera:fail:is not recording` 的语义是「调停止时原生层没在录」，
     *   最常见的原因是**微信已经自己结束了录像**（到上限 / 页面 onHide / 被系统抢占），
     *   文件正由 `timeoutCallback` 送回来 —— 它比 stopRecord 的 fail 晚到是常态。
     *   ⇒ 不能立刻判死、更不能弹相机不可用面板：把看门狗缩到 STOP_FAIL_GRACE_MS，
     *     等文件；来了就正常进确认页（这一段救回来），没来才回待拍并 toast。
     * ★ 打一行金丝雀日志：真机上这是唯一能分辨「按太快（A）」与「微信自己结束了（B）」的痕迹。
     */
    const onStopFail = (e: unknown) => {
      if (epochRef.current !== ep || finalizedRef.current || !savingRef.current) return
      const msg = errText(e)
      console.warn(`[${STOP_STATE_CANARY}] stopRecord 失败：${msg || '(空)'}｜acked=${acked}｜elapsed=${endedMs}ms｜等 ${STOP_FAIL_GRACE_MS}ms 看 timeoutCallback 会不会把文件送回来`)
      armWatch(STOP_FAIL_GRACE_MS)
    }
    try {
      cameraCtx().stopRecord({
        success: (r) => { if (epochRef.current !== ep) return; void finalize(r) },
        fail: onStopFail,
      })
    } catch (e) {
      // cameraCtx() 本身也可能抛（上下文拿不到）：同样按「停止失败」处理 ——
      // 不因为一次调用异常就把一台好相机拆掉。
      onStopFail(e)
    }
  }, [abandonTake, clearTimer, finalize])

  const doStart = useCallback(() => {
    if (recordingRef.current || savingRef.current) return
    // ★★ 每开一条新的录制就换一代（见 epochRef ★★）：startRecord / stopRecord 的回调都认它。
    //   resetRun 只在重拍 / 关浮层 / 交棒时 +1，
    //   挡不住「录到一半被 onStop 打断、用户立刻重录」那条路：那种情况下上一条
    //   迟到的 timeoutCallback 代次还对得上，会把旧文件 finalize 掉、把这一条顶成确认页。
    epochRef.current += 1
    const ep = epochRef.current
    recordingRef.current = true
    startAckedRef.current = false
    startedAtRef.current = Date.now()
    elapsedRef.current = 0
    endedElapsedRef.current = null
    finalizedRef.current = false
    setElapsed(0)
    setPhase('recording')
    /* ★★ 不等 success 就进录制态、立刻走表。
       startRecord 在真机上会「success、fail 一个都不回调」（官方社区多例）。把进入录制态
       挂在 success 上的话，用户看到的就是「点了没反应、没有计时」，而且旧实现里那个
       busyRef 会一直被占着 —— 于是「再也点不了停止」。回调现在只用来纠正和重锚。 */
    clearTimer()
    timerRef.current = setInterval(() => {
      if (!startedAtRef.current) return
      const ms = Date.now() - startedAtRef.current
      elapsedRef.current = ms
      setElapsed(ms)
      // 兜底自停：微信到上限会回调 timeoutCallback，但万一没回调，界面会一直停在
      // 「录制中」而用户以为还在录。到点后我们自己收手（finalize 的幂等闸会挡住重复）。
      if (ms >= SHOOT_MAX_SECONDS * 1000 + 1200) {
        endedElapsedRef.current = endedElapsedRef.current ?? SHOOT_MAX_SECONDS * 1000
        doStop()
      }
    }, 200)

    /** 撤销录制态。只有 fail（或 startRecord 直接抛）才走这里 */
    const abort = (e: unknown) => {
      if (epochRef.current !== ep || !recordingRef.current) return
      recordingRef.current = false
      startAckedRef.current = false
      clearTimer()
      setPhase('idle')
      setFailMsg(`无法开始录制：${errText(e) || '请检查相机权限'}`)
    }

    const fire = (retried: boolean) => {
      if (epochRef.current !== ep) return
      try {
        cameraCtx().startRecord({
          timeout: SHOOT_MAX_SECONDS,
          success: () => {
            // ★ 用 success 的时刻**重锚**开始时间：录制是这一刻才真正开始的。
            //   时长是计价依据，不能把 startRecord 的调用/相机初始化延迟算进去。
            //   ★ 只做重锚，**不靠它进录制态** —— 它在真机上根本不回调（见上面 ★★）。
            if (epochRef.current !== ep) return
            // ★ 记下「微信确认过在录」这个事实。★ 它只给日志与提示文案分档用（见 startAckedRef），
            //   绝不用来判断「到底在不在录」—— 这个 success 在真机上经常不回调。
            startAckedRef.current = true
            startedAtRef.current = Date.now()
            elapsedRef.current = 0
          },
          fail: (e) => {
            if (epochRef.current !== ep) return
            // 安卓的相机渲染是异步的，偶发「camera has not been initalized」（官方社区）。
            // 这是瞬时竞态：隔一拍重试一次就过，别直接弹面板把用户挡回去。
            // ★ 任何失败都先隔一拍**重试一次**，不再只认 init 那一类：一次 fail 就 abort
            //   会直接弹「相机不可用」面板把用户挡回去，而这条 API 的失败文案并不稳定
            //   （安卓常见 `camera has not been initalized`，别的机型还有别的写法）。
            //   重试也只给一次 —— 两次都失败才认为真的起不来。
            if (!retried) {
              setTimeout(() => { if (recordingRef.current && epochRef.current === ep) fire(true) }, START_RETRY_DELAY_MS)
              return
            }
            abort(e)
          },
          // ★ 到达上限、页面 onHide、录像异常退出 —— 微信都从这里把文件交回来
          timeoutCallback: (r) => {
            if (epochRef.current !== ep) return
            endedElapsedRef.current = endedElapsedRef.current ?? Math.max(0, Date.now() - startedAtRef.current)
            void finalize(r)
          },
        })
      } catch (e) {
        // cameraCtx() 本身可能抛：这里不收口的话录制态和计时器会一起留在那儿
        abort(e)
      }
    }
    fire(false)
  }, [clearTimer, doStop, finalize])

  const toggleRecord = useCallback(() => {
    // ★ 用 recordingRef 而不是 phase：连点两下时 phase 还是旧值，挡不住第二次 startRecord
    if (recordingRef.current) doStop()
    else doStart()
  }, [doStart, doStop])

  /**
   * 切前端 / 后置。
   * ★ 顺手把补光关掉：`flash='torch'` 是**后置**闪光灯，前置没有闪光灯，带着 'torch' 切过去
   *   在部分机型上会让相机**直接渲染失败**（那时会弹「相机不可用」，看着像相机坏了）。
   * ★ 真正让画面翻转靠的是**重建原生节点**（部分机型 device-position 动态改不生效）。
   *   但**不能靠换 key** —— 那样新旧节点会撞车（can insert only one camera，见 CAM_REBUILD_GAP_MS），
   *   改走统一的「先摘 → 等一等 → 再挂」（rebuildCamera）。
   */
  const switchDevice = () => {
    const next = device === 'back' ? 'front' : 'back'
    if (next === 'front' && flash !== 'off') setFlash('off')
    setDevice(next)
    // ★ 新节点挂载时 device 已经是新值 ⇒ 照样翻转画面
    rebuildCamera('switch-device')
  }

  /**
   * 回到取景重新拍：把上一条的痕迹清干净，否则 finalizedRef 会把下一次录制直接吞掉。
   * ★ 它同时是「相机不可用」面板上那个「再试一次」的落点 —— 所以这里**显式重建一次相机**
   *   （挪 camGen）。面板状态下 camera 本来就已卸载、清掉 failMsg 也会重新挂载，
   *   但显式挪一次能保证拿到的是全新节点，重建预算也在 resetRun 里一并还清。
   */
  const retake = useCallback(() => {
    resetRun()
    setTake(null)
    setFailMsg('')
    setElapsed(0)
    setSaving(false)
    setPhase('idle')
    setCamGen((g) => g + 1)
  }, [resetRun])

  const close = async () => {
    if (recordingRef.current) {
      const r = await Taro.showModal({
        title: '正在录制',
        content: '现在离开会丢掉这一段。',
        confirmText: '离开',
        cancelText: '继续拍',
        confirmColor: '#d54941',
      })
      if (!r.confirm) return
      try { cameraCtx().stopRecord({}) } catch { /* 放弃这一段，停不下来也不影响离开 */ }
    }
    // 走人之前把所有运行时痕迹清干净（含 stopRecord 的看门狗与「正在保存」标记）
    resetRun()
    setSaving(false)
    onCancel()
  }

  const goSetting = async () => {
    try {
      const r = await Taro.openSetting()
      const auth = (r.authSetting ?? {}) as Record<string, boolean>
      if (auth['scope.camera']) { retake(); return }
      Taro.showToast({ title: '还没允许使用相机', icon: 'none' })
    } catch {
      Taro.showToast({ title: '打开设置失败，可从右上角「…」进设置', icon: 'none' })
    }
  }

  /**
   * 交棒给「微信原生的拍/选」：关掉浮层之前先把这一层的运行痕迹全部按住。
   * ★ 必须走 resetRun（而不是只 clearTimer）：它会把看门狗停掉、把代次 +1，
   *   否则这段在飞的 stopRecord 回调会在交棒之后把文件填回来，改一个已经交出去的状态。
   */
  const handoff = () => {
    resetRun()
    setSaving(false)
    onUnavailable(failMsg)
  }

  if (!visible) return null

  const recording = phase === 'recording'
  const line = (shot?.line ?? '').trim()
  const visual = (shot?.visualReq ?? '').trim()
  // ★★ 不再按长度缩字号（用户口径：「有的文字一长，字体就又变小了，要直接分行」）。
  //   现在只有**一个**字号，长了就多占一行 —— 切行交给 splitPromptLines，
  //   它保证每一行都排得下（cover-view 默认 nowrap，溢出的部分会被静默裁掉）。
  const lineRows = splitPromptLines(line, PROMPT_MAX_CHARS)
  const visualRows = splitPromptLines(visual, VISUAL_MAX_CHARS)

  return (
    <View className='shotcam' catchMove>
      {/* ── 取景画面：**整屏铺满**。它必须和下面的 UI 层**平级** —— camera 是客户端创建的
          原生组件，层级最高、z-index 管不了它，只能靠 cover-view 盖上去（见文件头 ★★）。 */}
      {showCamera && (
        <Camera
          /* ★★ key **只**带 camGen：重建一律走「摘-挂」（rebuildCamera），
             不再让 device/flash 的变化隐式换 key。原因是换 key 时 React 会在**同一个 commit**
             里插入新原生节点、移除旧的，而原生层的销毁是**异步**的 ⇒ 撞出
             `insertCamera:fail can insert only one camera`（2026-09-30 真机复现）。
             切镜头现在也走 rebuildCamera，新节点挂载时 props 已是新值、画面照样翻转。
             详见 CAM_REBUILD_GAP_MS。 */
          key={camGen}
          className='shotcam__preview'
          devicePosition={device}
          flash={flash}
          resolution='high'
          /* ★★ onInitDone 是「画面到底出没出」的**唯一可靠信号**（黑屏不报错，
             见 CAM_INIT_TIMEOUT_MS 的 ★★）。收到它就说明这一代相机真的起来了，
             顺手把重建预算还清 —— 之后要是再遇到「切后台回来黑屏」还有得救。 */
          onInitDone={() => { camReadyRef.current = true; camRecoverRef.current = 0 }}
          onError={(e) => {
            const msg = errText(e.detail)
            // ★★ `can insert only one camera` 是**重建撞车**的瞬时错误（旧原生节点还没销毁
            //    就插了新的），不是环境问题。必须走自愈（摘-挂一轮），
            //    绝不能直接判死给面板 —— 那等于把一台本来好用的相机自己弄没了。
            if (/insert only one camera/i.test(msg)) { recoverCamera('insert-conflict'); return }
            setFailMsg(`相机不可用：${msg || '请检查权限'}`)
          }}
          onStop={() => {
            // 摄像头被非正常终止（切后台、被系统抢占、来电）。
            // ★ 判据用 recordingRef 而不是渲染里的 recording：这个回调可能早于 setState 落地。
            if (recordingRef.current) {
              // 正在录：微信会走 timeoutCallback 把文件交回来，这里只负责把界面从「录制中」
              // 摘出来，别让它一直停在录制态骗用户。
              // ★ 这一段**刻意不重建相机**：重建会打断 stopRecord 的回收链路，
              //   而它的画面由后面「拍完确认 → 重拍」那条路自然解决（重拍会重新挂 camera）。
              recordingRef.current = false
              clearTimer()
              setPhase('idle')
              return
            }
            // ★★ 没在录的时候被停掉，预览**不会自己回来** —— 屏幕上留下一个纯黑画面，
            //    而提词器、快门、两个圆钮全都还在，用户只会以为相机坏了。
            //    切后台再回来是最常见的一条：此时唯一的出路就是把原生节点重建一遍。
            recoverCamera('stopped')
          }}
        />
      )}

      {/* ★★ 立体 UI 层：**必须是 CoverView**。普通 View 压在全屏 camera 上要靠同层渲染，
          真机上会失败 —— 一失败就是「前后摄、快门」几条一起点不动（见文件头 ★★）。
          cover-view 不吃 flex、默认 nowrap，所以这一层里**一律绝对定位**（见 scss）。
          ★ 屏幕上只留两条文案：口播文案（大，要念的）+ 画面文案（小，要拍到的）。 */}
      {showCamera && (
        <CoverView className='shotcam__ui'>
          {/* 关闭。✕ 是符号不是文案 */}
          <CoverView className='shotcam__close' onClick={() => void close()}>✕</CoverView>

          {/* 切前后摄只能在开录前：录到一半换摄像头会把这一段废掉。
              ★ 用户这轮说「其他文案不要」，所以这里**不留「前置/后置」四个字**，
                改成环形双箭头的图形符号（前后摄点不动那个需求本身还在）。
              ★ 符号只表示「点它就换一个镜头」，不再表示「当前是哪个」——
                当前是哪一路，取景画面自己会说话。 */}
          {!recording && !saving && (
            <CoverView
              className='shotcam__tool shotcam__tool--device'
              onClick={switchDevice}
            >
              <CoverImage className='shotcam__icon' src={iconSwitch} />
            </CoverView>
          )}

          {/* 补光：**只在后置时给**。前置摄像头没有闪光灯，`flash='torch'` 在它身上必然无效
              —— 上一轮「补光也没有用」就是这么来的，不是坏了。
              状态靠图形本身表达：**实心闪电 = 开 / 空心闪电 = 关**（外加一圈暖色底），
              不再有「补光 开 / 关」这几个字。 */}
          {!recording && !saving && device === 'back' && (
            <CoverView
              className={`shotcam__tool shotcam__tool--flash ${flash === 'torch' ? 'shotcam__tool--flash-on' : ''}`}
              onClick={() => setFlash((f) => (f === 'off' ? 'torch' : 'off'))}
            >
              <CoverImage
                className={`shotcam__icon ${flash === 'torch' ? '' : 'shotcam__icon--dim'}`}
                src={flash === 'torch' ? iconFlashOn : iconFlashOff}
              />
            </CoverView>
          )}

          {/* ★ 这两条文案直接**浮在取景画面上**：「分镜 N · 类型」「建议 N 秒」
              「点一下开始 / 点一下停止」「补光 开 / 关」全部撤掉。 */}
          <CoverView className='shotcam__prompt'>
            {lineRows.map((row, i) => (
              <CoverView key={`l${i}`} className='shotcam__promptline'>{row}</CoverView>
            ))}
            {visualRows.length > 0 && (
              <CoverView className='shotcam__promptvisual'>
                {visualRows.map((row, i) => (
                  <CoverView key={`v${i}`} className='shotcam__promptvisual-row'>{row}</CoverView>
                ))}
              </CoverView>
            )}
          </CoverView>

          {/* 录制计时：**居中大字**。读的是 startedAtRef 的真时间差（由 200ms 的 interval 推），
              不是旧实现里那个「永远 00:00」的假值 —— 旧值只在 startRecord 的 success 里才更新，
              而那个 success 在真机上根本不回调（见 doStart ★★）。 */}
          {/* 录制指示：一个红点（符号不是文案）。有了它，「正在录」这件事一眼可见，
              计时器随它一起出现 —— 整屏只有这两样东西在录的时候发生变化。 */}
          {recording && <CoverView className='shotcam__recdot'>●</CoverView>}
          {recording && (
            <CoverView className='shotcam__bigtime ds-num'>{fmtClock(elapsed)}</CoverView>
          )}

          {/* 快门：待拍 = 实心圆；录制中 = 收成圆角方块（就是「点一下停止」的那个停止符）。
              ★ 点一下即切态，不等 startRecord 的回调（见 doStart ★★）。 */}
          {!saving && (
            <CoverView className='shotcam__shutterwrap' onClick={toggleRecord}>
              <CoverView className={`shotcam__shutter ${recording ? 'shotcam__shutter--on' : ''}`} />
            </CoverView>
          )}

          {/* 点停之后的等待段：stopRecord 要等编码落盘才能把文件交回来。
              ★★ **故意不给它 onClick**：这一段里文件已经在写盘，后到的回调还会回填 take，
                 让用户在这里「放弃」只会把状态机搅乱（放弃之后回调再来一次，界面会莫名
                 其妙跳回确认页）。它最多停 STOP_ACK_TIMEOUT_MS，到点由看门狗收口（见 doStop）。 */}
          {saving && (
            <CoverView className='shotcam__wait'>
              <CoverView className='shotcam__waittitle'>正在保存这一条…</CoverView>
              <CoverView className='shotcam__waitsub ds-num'>
                {fmtClock(endedElapsedRef.current ?? elapsed)}
              </CoverView>
            </CoverView>
          )}
        </CoverView>
      )}

      {/* ── 拍完确认：把封面和时长摆出来，让用户决定用不用 ──
          ★ 这一块用**普通 View**：走到这里 camera 已经卸载（showCamera=false），
            没有原生组件要盖，普通 View 反而好写（能吃 flex、能换行）。 */}
      {/* ★ `!failMsg` 是防御性的：两块面板都是 `.shotcam__panel`（同一个定位层），
          同时为真就会叠在一起。正常情况下走不到 —— 但「录制失败」与「文件迟到」
          曾经能凑出这个组合，加一条前置比赌它不发生便宜。 */}
      {!failMsg && phase === 'review' && !!take && (
        <View className='shotcam__panel'>
          {take.thumbPath
            ? <Image className='shotcam__reviewthumb' mode='aspectFill' src={take.thumbPath} />
            : <View className='shotcam__reviewthumb shotcam__reviewthumb--ph' />}
          <Text className='shotcam__paneltitle'>拍好了 · {fmtClock(take.durationMs)}</Text>
          <Text className='shotcam__panelsub'>确认后开始上传，上传时可以先拍别的分镜</Text>
          <View className='shotcam__panelacts'>
            <Text className='shotcam__btn' onClick={retake}>重拍</Text>
            <Text className='shotcam__btn shotcam__btn--main' onClick={() => { if (take) onDone(take) }}>
              用这条
            </Text>
          </View>
        </View>
      )}

      {/* ★★ 2026-10-19 用户要求改的两点（别再改回去）：
          ① **不显示原始错误串**。`failMsg` 里装的是 `operateCamera:fail:is not recording`
             这类东西 —— 用户看不懂、看着像崩了。版面上统一换成人话「系统卡了一下～」；
             原始串**没有丢**：它仍经 `onUnavailable(failMsg)` 交给调用方，也仍在 console 里。
          ② **「再试一次」与「用系统相机」对调**：把「再试一次」提成主按钮（红底，右侧），
             把「用系统相机」降成下面那行小字。「去设置里允许」保持在左侧当次按钮。
             目的很明确 —— **尽量让用户先就地重试**，别一上来就落回微信原生的长按拍摄
             （那条路一走，这次「点击录制」的改造就白做了）。 */}
      {!!failMsg && (
        <View className='shotcam__panel'>
          <Text className='shotcam__paneltitle'>系统卡了一下～</Text>
          <Text className='shotcam__panelsub'>也可以先用系统相机/相册继续这一条</Text>
          <View className='shotcam__panelacts'>
            <Text className='shotcam__btn' onClick={() => void goSetting()}>去设置里允许</Text>
            <Text
              className='shotcam__btn shotcam__btn--main'
              onClick={retake}
            >
              再试一次
            </Text>
          </View>
          <Text className='shotcam__retry' onClick={handoff}>用系统相机</Text>
        </View>
      )}
    </View>
  )
}
