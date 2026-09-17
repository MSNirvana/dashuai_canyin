// 合成能力探测：小程序在渲染选择档位之前调用。
//
// 存在的理由（P0-5）：
//   AI 档依赖外部剪辑通道（ChatCut MCP）配置齐全才会成功，否则 worker 必然抛错。
//   客户端不知道这件事的话，用户会选到 AI 档 → 提交 → 才被拒（更早的实现还会先冻结积分再退款）。
//   有了这条接口，UI 可以提前把不可用档位标灰并说明原因。
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
import { chatCutConfigured } from '../render/chatcut.js'

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
  const aiReady = chatCutConfigured()
  return [
    {
      key: 'BASIC',
      available: true,
      reason: null,
    },
    {
      key: 'AI',
      available: aiReady,
      reason: aiReady ? null : 'AI 智能档暂不可用（外部剪辑通道未配置完整），请先使用基础档',
    },
    {
      key: 'PREMIUM',
      available: true,
      reason: '提交后进入人工剪辑队列',
    },
  ]
}

router.get('/', (_req, res) => {
  ok(res, { grades: listGradeCapabilities() })
})

export default router
