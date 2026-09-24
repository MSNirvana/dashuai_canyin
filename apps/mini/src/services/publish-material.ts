// 发布素材 API：对接 /api/v1/creations/:id/publish-material
//
// 一件事包三样产物：标题、封面、文案 —— 由「合成成片」页在成片出来后调用，
// 目标是让运营人员**不用再自己想标题和文案**，直接复制去发布。
//
// ★ 计费是**两笔独立**的（服务端口径）：
//   · 标题/文案（文本场景）：按 token 成本结算，实际扣费 ≤ `estimate.textBeanCap`
//   · 封面（图像场景）：**固定价** `estimate.coverBeans`（当前 300 积分/张）
//   所以「封面失败」不代表整次失败：标题与文案照常返回，封面单独重试即可，
//   重试**不会**再扣一次文本那笔钱。
import { http } from './request'

/**
 * 发布素材三步的**最坏耗时**，前端必须等这么久才算超时。
 *
 * ★ 取值算法（服务端契约，改任一项都要在这里重算，否则前端会比服务端先放弃）：
 *   前端超时 = Σ 各步骤「候选数 × 单候选超时 × (maxRetries + 1)」
 *     · 抽帧（本地 ffmpeg，不是 AI 调用）：下载 ≤3 段素材 + **每段抽两份**
 *       （640px 给选帧模型看 / 1080px 只当封面底图，见服务端 BASE_FRAME_WIDTH），
 *       秒级~十几秒。★ **它不进上面的候选公式，但它叠在 390s 之上** ——
 *       420 里留给这一段的就是 30s，所以「多加一次抽帧」也属于要重算这个常量的改动
 *     · 文本场景 publish_material   ：候选 3 个（gpt → claude → deepseek）× 30s × (1+1) = 180s
 *     · 选帧场景 publish_cover_pick ：候选 1 个（★ 只有 gpt，见 setup-ai-channels）× 120s × (0+1) = 120s
 *     · 图像场景 publish_cover      ：候选 1 个（tokenbox-image）× 90s × (0+1)          =  90s
 *     · 三步**串行**（选帧要等抽帧、出图要等选帧与文本产出的标题）⇒ AI 时间最坏 **390s**，
 *       再加「下载素材 + 抽帧」那一段（不设超时、也不在公式里）
 *   ⚠ 选帧的 120s 是 2026-09-24 按实测抬的（实测正常 5.6~19.5s，但有一次真实调用超过 90s）。
 *     **它已经贴着这条上限了**：再抬任何一项都要先把 420_000 一起抬上去。
 *   ⚠ 2026-09-24 之前是两步 / 300_000（文本 + 出图）。加了「抽帧选帧」这一步之后
 *     **必须一起抬**：否则上游一抖动就会「服务端还在跑、前端已经超时」——
 *     用户看到失败，而跑完的封面其实已经落库（扣了钱、没看到图）。
 *   ⚠ 这个值还必须 ≤ nginx 的 `proxy_read_timeout`（部署配置在 deploy/ 下），
 *     否则前端等得住、网关先把连接掐了 —— 那种超时最难从日志上看懂。
 *   ⚠ 别按实测（文本 ~10s、选帧 ~20s、出图 ~30s，合计约 1 分钟）去调小：
 *     这个常量的用途是**别在服务端还在跑的时候先断开**，
 *     一个 40s 的窗口连一次候选降级都容不下。
 */
const PUBLISH_TIMEOUT_MS = 420_000

export interface PublishMaterial {
  creationId: string
  title: string
  caption: string
  /** 封面地址（签名 URL，**会过期**；每次进页面都要重新拉，不要缓存到 storage） */
  coverUrl: string | null
  coverWidth: number | null
  coverHeight: number | null
  updatedAt: string
  /**
   * 标题/文案是「AI 没给出可用结果时的兜底拼装」。
   * ⚠ 为 true 时页面要提示「可以重新生成一次」，而不是让用户以为模型就这水平。
   */
  degraded: boolean
  /** 上一次封面没出来的原因（用户可见文案）；null = 没有这个问题。★ 不落库，只在本次响应里有效 */
  coverError: string | null
}

/** 这次生成要花多少积分（客户端必须在点击前摆出来） */
export interface PublishMaterialEstimate {
  /** 标题+文案的单次上限（实际按 token 成本结算，恒不超过它） */
  textBeanCap: number
  /** 封面固定价（点一次就是这么多） */
  coverBeans: number
  /**
   * 封面选帧的单次上限（2026-09-24 新增）。
   *
   * ★ 与服务端 `PublishMaterialEstimate.pickBeans` 对应。
   *   报价时必须算上它：它只在候选帧 ≥ 2 张时发生，客户端不摆出来就会出现
   *   「说好 480、实扣 1080」这种最招骂的偏差。
   */
  pickBeans: number
}

export interface PublishMaterialResult {
  material: PublishMaterial
  beanCharged: number
  /** 重放（同一 requestId 又打了一次）：库里没再动钱，`beanCharged` 报的是当初那次的金额 */
  duplicated: boolean
  /** 给用户的一句补充说明（封面失败、或文本降级）；没有就是 null */
  notice: string | null
}

/**
 * 读已生成的发布素材 + 本次生成的预估花费。
 * 没生成过时 `material` 为 null（不是报错）—— 页面据此显示「去生成」入口。
 */
export function getPublishMaterial(id: string) {
  return http.get<{ material: PublishMaterial | null; estimate: PublishMaterialEstimate }>(
    `/creations/${id}/publish-material`,
  )
}

/**
 * 生成发布素材。
 * @param part `'ALL'` 全量（标题+文案+封面）；`'COVER'` 只重出封面（标题/文案沿用已存的）
 */
export function generatePublishMaterial(id: string, requestId: string, part: 'ALL' | 'COVER' = 'ALL') {
  return http.post<PublishMaterialResult>(
    `/creations/${id}/publish-material`,
    { requestId, part },
    { timeout: PUBLISH_TIMEOUT_MS },
  )
}
