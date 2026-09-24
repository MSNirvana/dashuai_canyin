/**
 * 「支付前补绑微信 openid」的契约测试 —— 钉死这个缺陷的修复：
 *
 *   用**手机号验证码**登录（不是微信一键登录）之后去支付，服务端拿不到付款人 openid，
 *   下单直接抛 `NoOpenidError`（码 3007）⇒ 用户看到「账号未绑定微信，无法支付」，
 *   **钱根本付不出去**。
 *
 * 病根不在支付，在登录：`loginByPhone()` 调 `upsertMerchantByPhone(prisma, phone)`，
 * **第三个参数（openid）根本没传** ⇒ 这类账号的 `merchant.wechat_openid` 恒为 NULL。
 * 而微信 JSAPI 支付**必须**带付款人的 openid。
 *
 * 修法：下单前用小程序端 `wx.login()` 的 code 换 openid 并按需绑定（见 auth.service.ts）。
 * 本脚本把这条修复的**六种性质**钉死 —— 它们在真实环境里都不会自然被发现：
 *   ① 短信登录风格的账号确实没有 openid（缺陷的必要条件，先把它复现出来）
 *   ② 补绑生效
 *   ③ ★ 幂等：openid 没变时**不写库**（每次支付前都会调一次，不该刷出无意义的 UPDATE）
 *   ④ 换绑：同一手机号换了微信（换设备/重装）时更新绑定，unionid 一并写
 *   ⑤ ★ 唯一索引冲突要被识别成「该微信已绑过别的账号」，而不是裸 P2002
 *   ⑥ 源码层接线：两个下单口都真的取了 wxLoginCode 并调用绑定，且**失败不阻断**
 *
 * 为什么 ⑥ 只能做源码断言：本修复的价值全在「前端传 code → 路由补绑」这条接线上，
 * 而这条线没有 HTTP 层可测（起服务要真微信）。源码断言是唯一能守住
 * 「有人把 wxLoginCode 从 schema 里删掉、或让绑定失败变成 500」这类回归的东西。
 *
 * ⚠ `code2Session()` 需要真微信，本脚本**不碰它** —— 所以只测「已解析出的身份怎么落库」
 *   这半边（`bindWechatIdentity`）。网络那半边（`bindWechatOpenidByLoginCode`）由
 *   真实支付链路验证。
 *
 * 只用一个临时手机号造商户，跑完硬删；不碰任何真实商户数据。
 * 跑法：npx tsx scripts/verify-pay-openid.ts
 *   ★ 暂不加 package.json 别名：服务器上那份 package.json 可能正被并行会话改着，
 *     为一行别名去动它不值得。等它空下来再补 `"pay-openid:verify"`。
 */
import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { PrismaClient } from '@prisma/client'
import { bindWechatIdentity, OpenidBoundToAnotherAccountError } from '../src/auth/auth.service.js'

const prisma = new PrismaClient()

// 与其它脚本的测试号错开：pay-risk=…9997 / pay-reconcile=…9998 / membership=…9999 / sms-login=…9998,997
const PHONE_A = '13900009996'
const PHONE_B = '13900009995'

let pass = 0
let failed = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${extra ? `  （${extra}）` : ''}`)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const openidOf = async (id: bigint) =>
  (await prisma.merchant.findUnique({ where: { id }, select: { wechatOpenid: true } }))?.wechatOpenid ?? null

async function main(): Promise<void> {
  const src = async (rel: string) => readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8')

  try {
    await prisma.merchant.deleteMany({ where: { phone: { in: [PHONE_A, PHONE_B] } } })

    // ─────────── ① 复现病根 ───────────
    console.log('\n════ ① 短信登录风格的账号：openid 为 NULL（3007 的必要条件）════')
    const a = await prisma.merchant.create({ data: { phone: PHONE_A } })
    check(a.wechatOpenid === null, '新建账号的 wechat_openid 是 NULL', String(a.wechatOpenid))

    // 同一件事的第二重证据：**登录侧确实不取 openid**。
    // 这条不是"证明现在坏"，而是钉住本修复的**前提** —— 哪天有人让 loginByPhone 也去取 openid，
    // 这条会亮灯提醒他「补绑这条线的前提变了，请复核是否还要保留」。
    const authSrc = await src('auth/auth.service.ts')
    check(
      /await upsertMerchantByPhone\(prisma, phone\)/.test(authSrc),
      '★ loginByPhone 仍是「不传 openid」的形态（前提断言；若已改成登录时就绑，请同步复核本脚本与本修复）',
    )

    // ─────────── ② 补绑生效 ───────────
    console.log('\n════ ② 补绑生效 ════')
    const OPENID_A = `verify_openid_a_${Date.now()}`
    await bindWechatIdentity(prisma, a.id, OPENID_A)
    check((await openidOf(a.id)) === OPENID_A, '补绑后 wechat_openid 已写入')

    // ─────────── ③ 幂等：同 openid 不写库 ───────────
    console.log('\n════ ③ ★ 幂等：openid 没变时不写库 ════')
    const t1 = (await prisma.merchant.findUnique({ where: { id: a.id }, select: { updatedAt: true } }))!.updatedAt
    await sleep(20) // 隔开一档，若真的写了库，updated_at 必然前进
    await bindWechatIdentity(prisma, a.id, OPENID_A)
    const t2 = (await prisma.merchant.findUnique({ where: { id: a.id }, select: { updatedAt: true } }))!.updatedAt
    check(t2.getTime() === t1.getTime(), '★ updated_at 未前进 ⇒ 没有产生 UPDATE（支付前每次都会调）', `${t1.toISOString()} → ${t2.toISOString()}`)

    // ─────────── ④ 换绑 ───────────
    console.log('\n════ ④ 同一手机号换了微信 ⇒ 更新绑定 ════')
    const OPENID_A2 = `verify_openid_a2_${Date.now()}`
    await bindWechatIdentity(prisma, a.id, OPENID_A2, 'verify_union_a2')
    check((await openidOf(a.id)) === OPENID_A2, '绑定已更新为新 openid')
    const uni = (await prisma.merchant.findUnique({ where: { id: a.id }, select: { wechatUnionid: true } }))!.wechatUnionid
    check(uni === 'verify_union_a2', 'unionid 一并写入')

    // ★ 非真空验证：上面 ③ 用「updated_at 未前进」来证明"没写库"。可万一这张表的
    //   `@updatedAt` 压根不生效，那条断言就**恒真**、等于没写。这里真写一次，
    //   证明时间戳会动 —— ③ 才成立。
    const t3 = (await prisma.merchant.findUnique({ where: { id: a.id }, select: { updatedAt: true } }))!.updatedAt
    check(
      t3.getTime() > t2.getTime(),
      '★ 真写库时 updated_at 会前进 ⇒ 反证 ③ 不是真空断言',
      `${t2.toISOString()} → ${t3.toISOString()}`,
    )

    // ─────────── ⑤ 唯一索引冲突 ───────────
    console.log('\n════ ⑤ ★ openid 已属于另一个账号 ⇒ 专用错误 + 不夺走绑定 ════')
    const b = await prisma.merchant.create({ data: { phone: PHONE_B } })
    let conflict: unknown = null
    try {
      await bindWechatIdentity(prisma, b.id, OPENID_A2) // A 已经占着这个 openid
    } catch (e) {
      conflict = e
    }
    check(
      conflict instanceof OpenidBoundToAnotherAccountError,
      '★ 抛专用错误而不是裸 P2002（P2002 的 message 只有索引名，排不出原因）',
      (conflict as Error | null)?.name ?? '没有抛错',
    )
    check(
      (conflict as OpenidBoundToAnotherAccountError | null)?.otherPhone === PHONE_A,
      '错误里带上了「占用者」的手机号 ⇒ 日志能自证',
    )
    check((await openidOf(a.id)) === OPENID_A2, '原账号的绑定没有被夺走')
    check((await openidOf(b.id)) === null, 'B 账号仍保持未绑定（失败是干净的，没有半写）')

    // ─────────── ⑥ 源码层接线 ───────────
    console.log('\n════ ⑥ 下单口的接线（源码断言：这段没有 HTTP 层可测）════')
    const routeSrc = await src('routes/orders.ts')
    const codeDecl = /^\s*wxLoginCode\s*:.*$/m.exec(routeSrc)?.[0] ?? ''
    check(
      codeDecl.includes('optionalText(') && !codeDecl.includes('z.string()'),
      '★ wxLoginCode 走 optionalText（空串只是「没给」⇒ 不补绑；写成 z.string().min(1) 会把支付判成 400）',
      codeDecl.trim(),
    )
    // 定义 1 次 + 两个下单口各 1 次
    check(
      (routeSrc.match(/bindOpenidBeforeOrder\(/g) ?? []).length === 3,
      '两个下单口（充值 / 会员）都调用了下单前补绑',
      `出现 ${(routeSrc.match(/bindOpenidBeforeOrder\(/g) ?? []).length} 次，期望 3（1 定义 + 2 调用）`,
    )
    check(
      /catch\s*\(e\)\s*\{\s*\n\s*console\.warn\('\[orders\] 下单前补绑 openid 失败/.test(routeSrc),
      '★ 补绑失败被吞掉 ⇒ 不会把「本来有 openid、能付款」的请求打成 500',
    )
    check(
      /if \(!wxLoginCode\) return/.test(routeSrc),
      '不传 wxLoginCode 时直接返回 ⇒ 老客户端行为与改动前完全一致',
    )
  } finally {
    // 硬删测试数据（两个临时号；不给任何真实商户留痕）
    await prisma.merchant.deleteMany({ where: { phone: { in: [PHONE_A, PHONE_B] } } }).catch(() => undefined)
  }

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`通过 ${pass} · 失败 ${failed}`)
  await prisma.$disconnect()
  if (failed > 0) process.exit(1)
}

main().catch(async (e) => {
  console.error('[pay-openid:verify] 未捕获异常：', e)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
