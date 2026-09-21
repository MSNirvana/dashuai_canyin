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
import { chatCutConfigured, chatCutHealth } from '../render/chatcut.js'

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
      // ★ 文案会**原样展示**给商户（客户端拿去做档位卡片下方的说明），所以只说「能不能用」，
      //   不写「外部剪辑通道未配置完整」这类集成细节 —— 用户既看不懂也无从操作，
      //   还顺带把服务端的实现依赖抖了出来。
      reason: aiReady ? null : 'AI 生成正在升级维护，请先选择基础生成',
    },
    {
      key: 'PREMIUM',
      available: true,
      reason: '提交后进入人工剪辑队列',
    },
  ]
}

router.get('/', (_req, res) => {
  // `chatcut` 是**给运维看**的健康位（不含凭证、不含错误原文）：
  // 之前「refresh_token 已被 ChatCut 作废」时，能力表照样报 available=true，
  // 商户点提交 → 冻结积分 → 等几分钟 → 才在 worker 里失败，且没有任何告警。
  // 现在 lastRefresh.kind === 'auth' 会同时把 AI 档置灰（见 chatCutConfigured），
  // 这里再把它摆出来，让「档位为什么灰了」一眼可见。
  // ⚠ 小程序端只读 `grades`，这个字段是纯增量的，不影响旧客户端。
  ok(res, { grades: listGradeCapabilities(), chatcut: chatCutHealth() })
})

export default router
