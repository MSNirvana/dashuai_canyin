// 合成能力探测：小程序在渲染选择档位之前调用。
//
// 存在的理由（P0-5）：
//   AI 档默认由本地自动剪辑引擎完成；外部 ChatCut 只是可选实验通道。
//   这条接口仍用于下发档位说明和人工档提示，避免客户端自行猜测服务端能力。
//
// 为什么做成接口而不是在小程序里写死：
//   1. 通道配置齐备后**无需重新发版小程序**，档位会自动放开 —— 小程序发版审核周期长，
//      把「服务端能力」编码进客户端会拖慢上线节奏；
//   2. 档位可用性是服务端事实（取决于服务端环境变量），客户端没有判断依据。
//
// 不鉴权：返回内容只有「哪个档位能不能用」，不含任何商户数据；放在渲染前一步调用，
// 也避免了 401 带来的额外处理分支。
import { createRouter } from '../lib/async-router.js'
import { ok } from '../lib/result.js'
import { chatCutHealth } from '../render/chatcut.js'

const router = createRouter()

export type GradeKey = 'BASIC' | 'AI' | 'PREMIUM'

export interface GradeCapability {
  key: GradeKey
  /** 当前是否可提交 */
  available: boolean
  /** 不可用或需要额外说明时给用户看的文案 */
  reason: string | null
}

/**
 * 档位能力表 —— 单一事实来源。
 * 客户端只负责展示（标题/描述留在客户端，避免文案两处维护）。
 */
export function listGradeCapabilities(): GradeCapability[] {
  return [
    {
      key: 'BASIC',
      available: true,
      reason: null,
    },
    {
      key: 'AI',
      // AI 默认走本地自动剪辑；ChatCut 只影响可选的外部实验通道。
      available: true,
      reason: null,
    },
    {
      key: 'PREMIUM',
      available: true,
      reason: '提交后进入人工剪辑队列',
    },
  ]
}

router.get('/', (_req, res) => {
  // `chatcut` 是给运维看的可选外部通道健康位（不含凭证、不含错误原文）。
  // 小程序端只读 `grades`，这个字段是纯增量的，不影响旧客户端。
  ok(res, { grades: listGradeCapabilities(), chatcut: chatCutHealth() })
})

export default router
