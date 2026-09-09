// 整改后的正确行为断言。准备阶段不导入正在变动的业务模块，也不自动执行。
// 稳定版本提供 Adapter：observe 必须调用真实函数/路由，不得直接返回期望值。
// 每项 observe 必须新建独立 fixture；事务结果不能用内存桩冒充真实 MySQL 验证。
import assert from 'node:assert/strict'

type BucketState = { recharge: bigint; grant: bigint; frozen: bigint; available: bigint }
type Trace = { source: string; boundary: 'real-function-memory-db' | 'real-router-http' | 'real-store-stub-api' }

export interface Observations {
  tokenIsolation: { refreshAccepted: boolean; accessAccepted: boolean; adminAccepted: boolean }
  tenantResources: { dishDenied: boolean; assetDenied: boolean; creationWrites: number; assetWrites: number; leakedKeys: string[]; renderDenied: boolean }
  requestIsolation: { leakedText: boolean; tenantBUsedOwnScope: boolean; samePayloadBusinessExecutions: number; samePayloadSameResult: boolean }
  payloadConflict: { status: number; secondExecutionCount: number; oldResultReturned: boolean }
  splitBuckets: { state: BucketState; grantDebited: bigint; rechargeDebited: bigint; consumed: bigint }
  paymentConfig: { rejectedAtStartupOrOrder: boolean; paidOrders: number; entitlementWrites: number; devTransactionIds: number }
  paymentBody: { rawBytesEqual: boolean; validSignatureAccepted: boolean; invalidSignatureAccepted: boolean }
  paymentMapping: { outTradeNo: string; transactionId: string; tradeState: string; paidOrders: number; entitlementWrites: number }
  paymentAmount: { acceptedWrongAmount: boolean; acceptedWrongMerchant: boolean; acceptedWrongApp: boolean; paidOrders: number; entitlementWrites: number }
  freezeFailure: { failed: boolean; executableTasks: number; frozen: bigint; pendingCompensation: boolean }
  renderSnapshot: { line: string; cosKey: string; simulatedPaidSuccess: boolean }
  subscription: { copyStatus: number; copyCode: number; storyboardStatus: number; storyboardCode: number }
  terminalSuccess: { finalStatus: string; consumeCount: number; refundCount: number; otherReservationUnchanged: boolean }
  terminalFailure: { finalStatus: string; consumeCount: number; refundCount: number; otherReservationUnchanged: boolean }
  grantExpiry: { negativeBucket: boolean; otherReservationUnchanged: boolean; reservationAccountedFor: boolean; expiredGrantSpendableAfterRelease: bigint; validReservationMaySettle: boolean }
  balanceContract: { loginAvailable: bigint; refreshBeanAvailable: bigint; refreshMeAvailable: bigint; composeAvailable: bigint; state: BucketState }
}

export type Scenario = keyof Observations
export type Adapter = {
  // 由主理人确认稳定版本后填写源码版本；不是单凭此标记即证明隔离安全。
  sourceRevision: string
  observe<K extends Scenario>(scenario: K): Promise<Observations[K] & { trace: Trace }>
}

export const fixtures = {
  merchantA: 1n,
  merchantB: 2n,
  buckets: { recharge: 40n, grant: 60n, frozen: 0n, available: 100n },
  consumption: 80n,
  balanceDisplay: { recharge: 40n, grant: 60n, frozen: 15n, available: 85n },
  payment: { outTradeNo: 'AUDIT_ORDER', transactionId: 'AUDIT_TX', tradeState: 'SUCCESS', amountFen: 10000 },
  shot: { line: '必须保留的口播', cosKey: 'tenant-A/authorized.mp4' },
} as const

export const scenarioPlan: Record<Scenario, string> = {
  tokenIsolation: '真实auth：refresh/admin拒绝，合法access允许。',
  tenantResources: 'A引用B菜品和素材拒绝且零写入；异常历史绑定提交render也拒绝。',
  requestIsolation: 'A完成固定键后B重用该键独立处理；A原payload重复仅执行一次。',
  payloadConflict: '同租户同操作同键异payload返回409，不返回旧结果且无第二次执行。',
  splitBuckets: '从40/60/0开始真实freeze80→consume80，按赠送60、充值20结算。',
  paymentConfig: 'production缺支付凭据：配置/下单拒绝，不能PAID或发权益。',
  paymentBody: '真实pay router收到含空格换行的签名JSON原文；无效签名拒绝。',
  paymentMapping: '真实AES-GCM标准通知映射并调用结算，恰好一笔订单与权益。',
  paymentAmount: '有效测试签名下金额/商户/app错误分别拒绝且零结算。',
  freezeFailure: '调用真实submitRender，注入预留异常，不能遗留可执行任务。',
  renderSnapshot: '真实submitRender保存line/授权cosKey，production不允许首素材假成功。',
  subscription: '真实copy/storyboard路由对未订阅请求返回403/2005。',
  terminalSuccess: '成功→重复成功→迟到失败/超时，终态保持SUCCESS且只消费一次。',
  terminalFailure: '失败→重复失败→迟到成功，不能转成功、双退或消费其他任务预留。',
  grantExpiry: '赠送预留跨期到期→结算或释放的独立fixtures；到期豆不得重新可消费。',
  balanceContract: '真实store/API替身：登录、两种刷新、compose使用相同available=85。',
}

const assertions: { [K in Scenario]: (observed: Observations[K]) => void } = {
  tokenIsolation(o) {
    assert.equal(o.refreshAccepted, false)
    assert.equal(o.adminAccepted, false)
    assert.equal(o.accessAccepted, true)
  },
  tenantResources(o) {
    assert.equal(o.dishDenied, true)
    assert.equal(o.assetDenied, true)
    assert.equal(o.creationWrites, 0)
    assert.equal(o.assetWrites, 0)
    assert.deepEqual(o.leakedKeys, [])
    assert.equal(o.renderDenied, true)
  },
  requestIsolation(o) {
    assert.equal(o.leakedText, false)
    assert.equal(o.tenantBUsedOwnScope, true)
    assert.equal(o.samePayloadBusinessExecutions, 1)
    assert.equal(o.samePayloadSameResult, true)
  },
  payloadConflict(o) {
    assert.equal(o.status, 409)
    assert.equal(o.secondExecutionCount, 0)
    assert.equal(o.oldResultReturned, false)
  },
  splitBuckets(o) {
    assert.deepEqual(o.state, { recharge: 20n, grant: 0n, frozen: 0n, available: 20n })
    assert.equal(o.grantDebited, 60n)
    assert.equal(o.rechargeDebited, 20n)
    assert.equal(o.consumed, 80n)
  },
  paymentConfig(o) {
    assert.equal(o.rejectedAtStartupOrOrder, true)
    assert.equal(o.paidOrders, 0)
    assert.equal(o.entitlementWrites, 0)
    assert.equal(o.devTransactionIds, 0)
  },
  paymentBody(o) {
    assert.equal(o.rawBytesEqual, true)
    assert.equal(o.validSignatureAccepted, true)
    assert.equal(o.invalidSignatureAccepted, false)
  },
  paymentMapping(o) {
    assert.equal(o.outTradeNo, fixtures.payment.outTradeNo)
    assert.equal(o.transactionId, fixtures.payment.transactionId)
    assert.equal(o.tradeState, 'SUCCESS')
    assert.equal(o.paidOrders, 1)
    assert.equal(o.entitlementWrites, 1)
  },
  paymentAmount(o) {
    assert.equal(o.acceptedWrongAmount, false)
    assert.equal(o.acceptedWrongMerchant, false)
    assert.equal(o.acceptedWrongApp, false)
    assert.equal(o.paidOrders, 0)
    assert.equal(o.entitlementWrites, 0)
  },
  freezeFailure(o) {
    assert.equal(o.failed, true)
    assert.equal(o.executableTasks, 0)
    assert.equal(o.frozen, 0n)
    assert.equal(o.pendingCompensation, false)
  },
  renderSnapshot(o) {
    assert.equal(o.line, fixtures.shot.line)
    assert.equal(o.cosKey, fixtures.shot.cosKey)
    assert.equal(o.simulatedPaidSuccess, false)
  },
  subscription(o) {
    assert.equal(o.copyStatus, 403)
    assert.equal(o.copyCode, 2005)
    assert.equal(o.storyboardStatus, 403)
    assert.equal(o.storyboardCode, 2005)
  },
  terminalSuccess(o) {
    assert.equal(o.finalStatus, 'SUCCESS')
    assert.equal(o.consumeCount, 1)
    assert.equal(o.refundCount, 0)
    assert.equal(o.otherReservationUnchanged, true)
  },
  terminalFailure(o) {
    assert.equal(o.finalStatus, 'FAILED')
    assert.equal(o.consumeCount, 0)
    assert.equal(o.refundCount, 1)
    assert.equal(o.otherReservationUnchanged, true)
  },
  grantExpiry(o) {
    assert.equal(o.negativeBucket, false)
    assert.equal(o.otherReservationUnchanged, true)
    assert.equal(o.reservationAccountedFor, true)
    assert.equal(o.expiredGrantSpendableAfterRelease, 0n)
    assert.equal(o.validReservationMaySettle, true)
  },
  balanceContract(o) {
    assert.equal(o.loginAvailable, 85n)
    assert.equal(o.refreshBeanAvailable, 85n)
    assert.equal(o.refreshMeAvailable, 85n)
    assert.equal(o.composeAvailable, 85n)
    assert.deepEqual(o.state, fixtures.balanceDisplay)
  },
}

export class EnvironmentBlocked extends Error {}

export async function runAcceptance(adapter: Adapter) {
  assert.ok(adapter.sourceRevision, '必须标识主理人确认的稳定版本')
  const results: Array<{ scenario: Scenario; status: 'PASS' | 'FAIL' | 'ENVIRONMENT_BLOCKED'; detail: string }> = []
  async function run<K extends Scenario>(scenario: K) {
    try {
      const observation = await adapter.observe(scenario)
      assert.ok(observation.trace.source, '必须记录调用的真实源文件/函数，不能复制算法')
      assertions[scenario](observation)
      results.push({ scenario, status: 'PASS', detail: `${observation.trace.boundary}: ${observation.trace.source}` })
    } catch (error) {
      results.push({ scenario, status: error instanceof EnvironmentBlocked ? 'ENVIRONMENT_BLOCKED' : 'FAIL', detail: String(error) })
    }
  }
  for (const scenario of Object.keys(scenarioPlan) as Scenario[]) await run(scenario)
  return {
    sourceRevision: adapter.sourceRevision,
    results,
    passed: results.filter((r) => r.status === 'PASS').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
    blocked: results.filter((r) => r.status === 'ENVIRONMENT_BLOCKED').length,
    note: '仅受控行为验证，不证明真实MySQL并发/回滚或外部平台验收。',
  }
}
