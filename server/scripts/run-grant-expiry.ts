// 手动触发一次「赠积分到期清零」扫描。
//
// 用途：服务器上不想等定时任务、或需要立刻核账时手动跑一次。
// 幂等：重复跑不会重复清零（expireGrant 对 grant_balance<=0 直接返回；会员状态已置 EXPIRED 也不再入选）。
//
// 跑法：npm run grant-expiry:run
import { prisma } from '../src/db.js'
import { scanGrantExpiry } from '../src/services/grant-expiry.service.js'

const now = process.argv[2] ? new Date(process.argv[2]) : new Date()
console.log(`[grant-expiry] 以基准时间 ${now.toISOString()} 执行扫描…`)

const r = await scanGrantExpiry(prisma, now)

console.log('[grant-expiry] 完成：')
console.log(`  候选会员记录    ${r.scanned}`)
console.log(`  实际清零商户    ${r.merchantsExpired}`)
console.log(`  跳过（已续期）  ${r.skippedStillActive}`)
console.log(`  清零积分数        ${r.beansCleared}`)

await prisma.$disconnect()
