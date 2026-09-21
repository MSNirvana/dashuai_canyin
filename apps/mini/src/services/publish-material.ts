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

/** 封面出图 + 文本生成的**最坏耗时**，前端必须等这么久才算超时。 */
/**
 * ★ 取值算法（服务端契约，改任一项都要在这里重算，否则前端会比服务端先放弃）：
 *   前端超时 = Σ 各步骤「候选数 × 单候选超时 × (maxRetries + 1)」
 *     · 文本场景 publish_material：候选 3 个（gpt → claude → deepseek）× 30s × (1+1) = 180s
 *     · 图像场景 publish_cover   ：候选 1 个（tokenbox-image）× 90s × (0+1)          =  90s
 *     · 两步**串行**（封面要用文本产出的画面描述）⇒ 最坏 270s
 *   实测：文本 9.7s、封面 28~30s，一步到位时合计约 40s。
 *   ⚠ 别按「实测 40s」去调小：这个值的用途是**别在服务端还在跑的时候先断开** ——
 *     上游抖动时文本那一步会走到备用候选上（每次 30s），40s 的窗口连一次降级都容不下。
 */
const PUBLISH_TIMEOUT_MS = 300_000

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
