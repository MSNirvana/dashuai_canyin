/**
 * 「上传完成确认」与「AI 出站地址闸门」的回归测试。
 *
 * 覆盖两组静默失效：
 *   A. SSRF：后台可填任意 baseUrl，服务端随后带着**已保存的 API key** 去 fetch 它。
 *      只校验长度 ⇒ 填 127.0.0.1 / 169.254.169.254 / 内网域名 都能打，密钥随请求头外带。
 *   B. 上传确认：完全信任客户端上报的 sizeBytes ⇒ 上报 0 就能绕过空间配额；
 *      不校验对象是否存在 ⇒ 登记一个没上传成功的键也能标 READY；
 *      重试 /complete 不在服务端去重 ⇒ 同一对象键落多行（实测库里真的有一组）。
 *
 * 全部本地跑：不联网、不碰 COS、不调远端 AI。上传部分只用一个临时商户，跑完硬删。
 *
 * 用法：npm run upload-boundary:verify
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { devLogin } from '../src/auth/auth.service.js'
import {
  assertSafeOutboundUrl,
  isBlockedIp,
  safeFetch,
  outboundPolicy,
  UnsafeOutboundUrlError,
  type OutboundPolicy,
} from '../src/lib/outbound-url.js'
import { confirmUpload, MAX_UPLOAD_BYTES } from '../src/services/upload.service.js'
import { headObjectMeta } from '../src/lib/cos.js'
import { writeLocalObject, localStorageRoot, isLocalStorage } from '../src/lib/local-storage.js'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const prisma = new PrismaClient()
const PHONE = '13900009996' // 与 …9999/9998/9997 区分，避免并行跑互相踩

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

/** 只做语法/字面量检查、不做 DNS，且允许 http（隔离出「IP 段判定」这一条规则） */
const P: OutboundPolicy = { allowInsecureHttp: true, hostAllowlist: [], skipDns: true }

async function rejects(url: string, why: string, policy: OutboundPolicy = P) {
  let err: unknown = null
  try {
    await assertSafeOutboundUrl(url, policy)
  } catch (e) {
    err = e
  }
  check(err instanceof UnsafeOutboundUrlError, `拒绝 ${url}（${why}）`, err ? (err as Error).message : '竟然通过了')
}

async function accepts(url: string, policy: OutboundPolicy = P) {
  let err: unknown = null
  try {
    await assertSafeOutboundUrl(url, policy)
  } catch (e) {
    err = e
  }
  check(err === null, `放行 ${url}`, err ? (err as Error).message : '')
}

async function cleanup(merchantId: bigint) {
  // 顺序受外键约束：先删所有引用 merchant 的子表，再删 merchant 本身。
  // 漏掉任何一张（本次实测漏的是 membership_reminder / bean_* / business_request）
  // 都会让清理以「Foreign key constraint violated」失败，临时商户永久留在库里。
  await prisma.membershipReminder.deleteMany({ where: { merchantId } })
  await prisma.membership.deleteMany({ where: { merchantId } })
  await prisma.order.deleteMany({ where: { merchantId } })
  await prisma.beanLedger.deleteMany({ where: { merchantId } })
  await prisma.beanReservation.deleteMany({ where: { merchantId } })
  await prisma.businessRequest.deleteMany({ where: { merchantId } })
  await prisma.beanAccount.deleteMany({ where: { merchantId } })
  await prisma.mediaAsset.deleteMany({ where: { merchantId } })
  await prisma.store.deleteMany({ where: { merchantId } })
  await prisma.merchant.deleteMany({ where: { id: merchantId } })
}

let tempMerchantId: bigint | null = null
const createdKeys: string[] = []

async function main() {
  // ── A. 出站地址闸门 ────────────────────────────────────────────
  console.log('\n════ A. AI 出站地址闸门：本机 / 私网 / 保留地址 / 重定向 ════')
  {
    console.log('  ── IPv4 段 ──')
    await rejects('http://127.0.0.1:3000/api/v1/stores', 'loopback')
    await rejects('http://127.1.2.3/', '整个 127/8')
    await rejects('http://0.0.0.0/', '未指定地址')
    await rejects('http://10.1.2.3/', '私网 10/8')
    await rejects('http://172.16.0.1/', '私网 172.16/12')
    await rejects('http://172.31.255.254/', '私网 172.16/12 上界')
    await rejects('http://192.168.1.1/', '私网 192.168/16')
    await rejects('http://169.254.169.254/latest/meta-data/', '云元数据服务（link-local）')
    await rejects('http://100.64.0.1/', 'CGNAT 100.64/10')
    await rejects('http://224.0.0.1/', '组播')
    await rejects('http://255.255.255.255/', '广播')

    console.log('  ── IPv6 段（含 IPv4-mapped 绕过）──')
    await rejects('http://[::1]/', 'IPv6 loopback')
    await rejects('http://[::]/', 'IPv6 未指定')
    await rejects('http://[fc00::1]/', 'ULA fc00::/7')
    await rejects('http://[fd12:3456::1]/', 'ULA fd00::/8')
    await rejects('http://[fe80::1]/', 'link-local fe80::/10')
    await rejects('http://[ff02::1]/', 'IPv6 组播')
    await rejects('http://[::ffff:127.0.0.1]/', '★ IPv4-mapped 形式的 loopback')
    await rejects('http://[::ffff:7f00:1]/', '★ IPv4-mapped 的十六进制写法')
    await rejects('http://[64:ff9b::a00:1]/', 'NAT64 包裹的私网地址（十六进制段）')

    console.log('  ── 主机名与协议 ──')
    await rejects('http://localhost:3000/', 'localhost')
    await rejects('http://api.localhost/', '*.localhost')
    await rejects('http://db.local/', '*.local')
    await rejects('http://metadata.google.internal/', '元数据服务别名')
    await rejects('http://foo.internal/', '*.internal')
    await rejects('http://user:pass@api.example.com/', 'URL 内嵌凭据')
    await rejects('file:///etc/passwd', '非 http(s) 协议')
    await rejects('ftp://api.example.com/', '非 http(s) 协议')
    await rejects('', '空地址')
    await rejects('不是 URL', '非法 URL')

    console.log('  ── 生产必须 https ──')
    await rejects('http://api.deepseek.com/v1', '生产禁用 http', outboundPolicy({ NODE_ENV: 'production' }))
    await accepts('https://api.deepseek.com/v1', outboundPolicy({ NODE_ENV: 'production' }))

    console.log('  ── 域名白名单（可选开关）──')
    const wl: OutboundPolicy = { allowInsecureHttp: true, hostAllowlist: ['tokenbox.com'], skipDns: true }
    await accepts('https://api.tokenbox.com/v1', wl)
    await accepts('https://tokenbox.com/v1', wl)
    await rejects('https://evil.com/v1', '不在白名单内', wl)
    await rejects('https://nottokenbox.com/v1', '★ 后缀匹配必须是「域名边界」，不能是裸 endsWith', wl)

    console.log('  ── 正常公网地址必须放行（避免把功能一起闸死）──')
    await accepts('https://api.deepseek.com/v1')
    await accepts('https://dashscope.aliyuncs.com/compatible-mode/v1')
    await accepts('https://api.anthropic.com')

    console.log('  ── isBlockedIp 单元表 ──')
    check(isBlockedIp('169.254.169.254'), '169.254.169.254 被判定为禁止')
    check(!isBlockedIp('8.8.8.8'), '8.8.8.8 被判定为允许')
    check(!isBlockedIp('1.1.1.1'), '1.1.1.1 被判定为允许')
    check(isBlockedIp('不是IP'), '非 IP 一律按禁止处理')

    // safeFetch 的「不跟随重定向」分支需要真实公网 302 才能覆盖，这里只验证它对
    // 被禁止地址的行为（其余分支由代码审阅保证）。
    let fetchErr: unknown = null
    try {
      await safeFetch('http://127.0.0.1:9/', { method: 'GET' })
    } catch (e) {
      fetchErr = e
    }
    check(
      fetchErr instanceof UnsafeOutboundUrlError,
      'safeFetch 在发起连接**之前**就拦下被禁止的地址',
      fetchErr ? (fetchErr as Error).message : '竟然发出去了',
    )
  }

  // ── B. 上传完成确认 ────────────────────────────────────────────
  console.log('\n════ B. 上传完成确认：以存储侧事实为准，且同键幂等 ════')
  // ★ 这一段强制切到本地存储模式再跑。
  //   本项目 .env 里是 STORAGE_MODE=cos，那样 headObjectMeta 会真的去 HEAD 线上对象，
  //   而本脚本承诺「不碰 COS」。storageMode()/isLocalStorage() 每次调用都读 process.env，
  //   所以在运行期改得动（且只影响本进程）。
  const prevMode = process.env.STORAGE_MODE
  process.env.STORAGE_MODE = 'local'
  try {
    await runUploadChecks()
  } finally {
    if (prevMode === undefined) delete process.env.STORAGE_MODE
    else process.env.STORAGE_MODE = prevMode
  }
}

async function runUploadChecks() {
  {
    const stale = await prisma.merchant.findUnique({ where: { phone: PHONE } })
    if (stale) {
      console.log(`（清理上次残留：商户 ${stale.id}）`)
      await cleanup(stale.id)
    }
    await devLogin(prisma, PHONE)
    const mid = (await prisma.merchant.findUniqueOrThrow({ where: { phone: PHONE } })).id
    tempMerchantId = mid
    const store = await prisma.store.create({
      data: { merchantId: mid, name: '上传边界测试门店', intro: '' },
    })

    const REAL_BYTES = 123_456
    const key = `uploads/${mid}/verify_${Date.now()}_abcdef.mp4`
    createdKeys.push(key)
    // 真实写入一个对象：大小与客户端上报的**故意不同**
    await writeLocalObject(key, Buffer.alloc(REAL_BYTES, 7))

    const meta = await headObjectMeta(key)
    check(meta.exists && meta.sizeBytes === REAL_BYTES, '★ headObjectMeta 读出存储侧真实大小', `${meta.sizeBytes}`)

    // B1：客户端撒谎上报 0 —— 落库必须用真实大小，配额不能被绕过
    const a1 = await confirmUpload(prisma, mid, {
      cosKey: key,
      storeId: store.id,
      type: 'VIDEO',
      sizeBytes: 0,
    })
    check(
      a1.sizeBytes === BigInt(REAL_BYTES),
      '★ 客户端上报 0 时，落库仍是存储侧真实大小（配额无法被绕过）',
      `sizeBytes=${a1.sizeBytes}`,
    )

    // B2：同键重复确认必须幂等（客户端 /complete 最多重试 3 次）
    const a2 = await confirmUpload(prisma, mid, {
      cosKey: key,
      storeId: store.id,
      type: 'VIDEO',
      sizeBytes: REAL_BYTES,
    })
    const cnt = await prisma.mediaAsset.count({ where: { merchantId: mid, cosKey: key, deletedAt: null } })
    check(a2.id === a1.id && cnt === 1, '★ 同一对象键重复确认只落一行（返回同一素材）', `rows=${cnt}`)

    // B3：对象不存在 ⇒ 拒绝登记（旧实现会直接标 READY）
    const ghostKey = `uploads/${mid}/verify_ghost_${Date.now()}.mp4`
    let e3: unknown = null
    try {
      await confirmUpload(prisma, mid, { cosKey: ghostKey, storeId: store.id, type: 'VIDEO', sizeBytes: 1024 })
    } catch (e) {
      e3 = e
    }
    check(
      e3 instanceof Error && e3.name === 'UploadObjectMismatchError',
      '★ 对象不存在时拒绝登记（不再凭空标 READY）',
      e3 ? (e3 as Error).message : '竟然通过了',
    )
    check(
      (await prisma.mediaAsset.count({ where: { merchantId: mid, cosKey: ghostKey } })) === 0,
      '幽灵键没有留下任何素材行',
    )

    // B4：后缀与声明类型不符 ⇒ 拒绝（防「视频声明成 IMAGE」蒙过后继管线）
    const imgKey = `uploads/${mid}/verify_typecheck_${Date.now()}.mp4`
    createdKeys.push(imgKey)
    await writeLocalObject(imgKey, Buffer.alloc(2048, 1))
    let e4: unknown = null
    try {
      await confirmUpload(prisma, mid, { cosKey: imgKey, storeId: store.id, type: 'IMAGE', sizeBytes: 2048 })
    } catch (e) {
      e4 = e
    }
    check(
      e4 instanceof Error && e4.name === 'UploadObjectMismatchError',
      '★ .mp4 声明成 IMAGE 被拒绝',
      e4 ? (e4 as Error).message : '竟然通过了',
    )

    // B5：越权前缀仍然拦住
    let e5: unknown = null
    try {
      await confirmUpload(prisma, mid, {
        cosKey: 'uploads/999999/steal.mp4',
        storeId: store.id,
        type: 'VIDEO',
        sizeBytes: 10,
      })
    } catch (e) {
      e5 = e
    }
    check(e5 instanceof Error && e5.name === 'UploadPrefixError', '他人前缀仍被拒绝', e5 ? (e5 as Error).message : '')

    // B6：单文件上限存在且为正
    check(MAX_UPLOAD_BYTES === 2 * 1024 * 1024 * 1024, '单文件上限常量仍为 2GB', String(MAX_UPLOAD_BYTES))
  }
}

async function teardown() {
  if (tempMerchantId !== null) {
    console.log('\n（清理临时商户与测试对象…）')
    await cleanup(tempMerchantId).catch((e) => console.error('清理失败：', (e as Error).message))
  }
  for (const key of createdKeys) {
    await rm(join(localStorageRoot(), key), { force: true }).catch(() => undefined)
  }
}

main()
  .then(async () => {
    await teardown()
    console.log(`\n★ ${failed === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${failed} 失败\n`)
    await prisma.$disconnect()
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch(async (e) => {
    console.error('\n脚本异常：', e)
    await teardown()
    await prisma.$disconnect()
    process.exit(1)
  })
