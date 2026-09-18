/**
 * 历史「同一对象键落多行」的只读盘点（**不动任何数据**）。
 *
 * 背景：`/upload/complete` 原先不去重，而小程序端的 `confirmUploadWithRetry` 会重试 3 次
 * （弱网下很常见）。第一次其实已落库、只是响应丢了 ⇒ 重试再落一行**同一 cosKey** 的素材。
 * 后果：空间配额被重复计算、素材列表出现重复项、GC 判定引用时方向不明。
 *
 * 为什么只盘点、不自动合并：
 *   实测库里那一组重复（商户 1 的同一个 mp4）两行**分别被 1 个和 6 个分镜引用**
 *   （客户端两次上报的大小还不一样：22495870 与 5242880）。盲目「保留最早、软删其余」
 *   会直接打断 6 个分镜的素材绑定。合并需要人工决定「保留哪一行、把引用改到哪一行」，
 *   属于业务判断，不能由脚本替你拍板。
 *
 * 用法：
 *   npm run storage:dup-assets            # 全表盘点
 *   npm run storage:dup-assets -- 1       # 只看商户 1
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

async function main() {
  const arg = process.argv[2]
  const merchantFilter = arg ? BigInt(arg) : null

  // 用 groupBy 而不是 $queryRaw：Prisma 的模板标签**不能**拼接 SQL 片段
  // （插值会被当成参数占位符，条件化拼接会直接报 1064 语法错误）。
  const groups = await prisma.mediaAsset.groupBy({
    by: ['merchantId', 'cosKey'],
    ...(merchantFilter !== null ? { where: { merchantId: merchantFilter } } : {}),
    _count: { _all: true },
    having: { cosKey: { _count: { gt: 1 } } },
    orderBy: { _count: { cosKey: 'desc' } },
  })

  console.log(`\n重复 (merchant_id, cos_key) 组数：${groups.length}`)
  if (groups.length === 0) {
    console.log('★ 没有重复素材行。\n')
    return
  }

  let affectedShots = 0
  for (const g of groups) {
    const rows = await prisma.mediaAsset.findMany({
      where: { merchantId: g.merchantId, cosKey: g.cosKey },
      orderBy: { id: 'asc' },
      select: { id: true, type: true, sizeBytes: true, status: true, deletedAt: true, createdAt: true, coverKey: true },
    })
    console.log(`\n─ 商户 ${g.merchantId}  key=${g.cosKey}  ${g._count._all} 行`)
    for (const r of rows) {
      const shots = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*) AS n FROM shot WHERE asset_id = ${r.id}`
      const refs = Number(shots[0]?.n ?? 0n)
      affectedShots += refs
      console.log(
        `   asset#${r.id}  type=${r.type}  size=${r.sizeBytes}  status=${r.status}  deleted=${r.deletedAt ?? '-'}  ` +
          `cover=${r.coverKey ?? '-'}  createdAt=${r.createdAt.toISOString()}  shot 引用=${refs}`,
      )
    }
  }
  console.log(`\n合计被这些重复行绑定的分镜引用数：${affectedShots}`)
  console.log(
    '处置建议：由人工决定保留哪一行（通常保留被引用最多、且有 coverKey 的那一行），' +
      '把另一行的分镜引用改到保留行后再软删。脚本不代为决策 —— 两行的引用分布可能都不为空。\n',
  )
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error('盘点失败：', j((e as Error).message))
    await prisma.$disconnect()
    process.exit(1)
  })
