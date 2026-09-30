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
// 不鉴权：返回内容只有「档位能不能用」与**公开价目**（每档一次的固定积分），不含任何商户数据；
//   放在渲染前一步调用，也避免了 401 带来的额外处理分支。
//   ★ 2026-09-30 起多回一个 `beans`（固定价）。价目表不是账户数据，鉴权与否都不敏感；
//     但 **别把商户自己的余额/优惠塞进来** —— 那样这个免鉴权路由立刻变成越权读接口。
import { createRouter } from '../lib/async-router.js'
import { ok } from '../lib/result.js'
import { chatCutHealth } from '../render/chatcut.js'
import { prisma } from '../db.js'
import { readGradeBeans, renderAmountBeans, type RenderGrade } from '../render/grade-pricing.js'

const router = createRouter()

/** 档位代号。定义已搬到 `render/grade-pricing.ts`（固定价按它配置）；此处保留旧名字以便追溯。 */
export type GradeKey = RenderGrade

export interface GradeCapability {
  key: GradeKey
  /** 当前是否可提交 */
  available: boolean
  /** 不可用或需要额外说明时给用户看的文案 */
  reason: string | null
  /**
   * 提交一次的**固定扣费**（积分）。
   *
   * ★ 与成片时长无关（2026-09-30 改的计费口径）⇒ 用户还没选素材、也不知道成片多长时
   *   就能**准确**报出来，不用再给个「约」字。旧口径做不到这一点。
   * ★ 取自后台 `render.grade_beans_*` ⇒ **后台调价不需要重新发版小程序**。
   * ★ 报的是 FULL 模式（不打折）的价，与服务端真正冻结的金额一致；
   *   RECOLOR 的折扣价不在这里透出（调色模块当前不对外，见小程序 SHOW_COLOR_MODULE）。
   */
  beans: number
}

/**
 * 档位能力表 —— 单一事实来源。
 * 客户端只负责展示（标题/描述留在客户端，避免文案两处维护）。
 * 价格反过来：**必须由服务端给**。让客户端自己按住时长 + 系数算一遍，
 * 就是改价后「页面显示 5000、实际扣 300」的成因（详见 grade-pricing.ts 顶部说明）。
 */
export async function listGradeCapabilities(): Promise<GradeCapability[]> {
  // 三档的价一次并发读完。
  // ★ 透出的是「实际会扣的那个整数」而不是库里可能带小数的原值：renderAmountBeans
  //   已经含了「最低 1 积分」与向上取整 ⇒ 展示与实扣才对得上。
  const [basic, ai, premium] = await Promise.all([
    readGradeBeans(prisma, 'BASIC'),
    readGradeBeans(prisma, 'AI'),
    readGradeBeans(prisma, 'PREMIUM'),
  ])
  return [
    {
      key: 'BASIC',
      available: true,
      reason: null,
      beans: Number(renderAmountBeans(basic)),
    },
    {
      key: 'AI',
      // AI 默认走本地自动剪辑；ChatCut 只影响可选的外部实验通道。
      available: true,
      reason: null,
      beans: Number(renderAmountBeans(ai)),
    },
    {
      key: 'PREMIUM',
      available: true,
      reason: '提交后进入人工剪辑队列',
      beans: Number(renderAmountBeans(premium)),
    },
  ]
}

// ★ handler 必须是 async（`grades` 现在要读库取价）。createRouter 会把 Promise rejection
//   转给错误中间件；若换成裸 express Router 注册，一次读库失败就能让整个进程退出。
router.get('/', async (_req, res) => {
  // `chatcut` 是给运维看的可选外部通道健康位（不含凭证、不含错误原文）。
  // 小程序端只读 `grades`，这个字段是纯增量的，不影响旧客户端。
  ok(res, { grades: await listGradeCapabilities(), chatcut: chatCutHealth() })
})

export default router
