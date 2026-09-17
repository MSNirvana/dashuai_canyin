/**
 * 个人资料（个人主页）契约验证：昵称 trim / 头像对象键归属 / 上传链路。
 *
 * 为什么值得单写一个脚本 —— 这里有**三道静默失效**，任何一道破了都不会报错：
 *   ① 昵称若用裸 `z.string()`：`"   "` 能过校验，库里存下纯空白昵称 ⇒
 *      「我的」页用户名位置看起来是空的（回落逻辑 `nickname || phone` 只有在 null 时生效）。
 *   ② 头像键**只做前缀匹配**：`uploads/1/../../2/x.jpg` 前缀是过的，解析后落到别人目录，
 *      而读资料时服务端会替我们签名 ⇒ 形成跨商家读取。
 *   ③ 头像键列漏登记进 `gc-orphan-objects.ts::collectReferencedKeys()`：
 *      GC 会在保留期（默认 24h）后把所有在用头像当孤儿删掉 —— 表现为「昨天还好好的，今天全白了」。
 *
 * 用法：npm run profile:verify
 * 用一个一次性手机号造临时商户，跑完硬删（连头像文件一起删）；不动任何真实商户数据。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AVATAR_MAX_BYTES,
  AvatarKeyNotOwnedError,
  AvatarNotImageError,
  AvatarTooLargeError,
  assertAvatarKeyOwned,
  avatarKeyPrefix,
  detectImageType,
  getProfile,
  saveAvatarUpload,
  updateProfile,
} from '../src/services/profile.service.js'
import { profilePatch } from '../src/routes/profile.js'
import { isLocalStorage, localPathForKey, verifyLocalMediaToken } from '../src/lib/local-storage.js'
import { deleteObject, objectExists } from '../src/lib/cos.js'
import { InvalidObjectKeyError } from '../src/lib/object-key.js'

const prisma = new PrismaClient()
/** 一次性测试账号：本脚本专用，跑完硬删（与 membership/sms/ai-prompts 的号段刻意错开） */
const PHONE = '13900008812'

let pass = 0
let fail = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? `  ${extra}` : ''}`)
  }
}
function section(t: string) {
  console.log(`\n── ${t} ──`)
}

// ─────────────────────── 测试素材（只造文件头，够 sniff 用） ───────────────────────
const PNG_HEAD = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 0),
])
const JPG_HEAD = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0)])
const GIF_HEAD = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 0)])
const WEBP_HEAD = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(16, 0),
])

let tmpDir = ''
async function writeTmp(name: string, content: string | Buffer): Promise<string> {
  const p = join(tmpDir, name)
  await writeFile(p, content)
  return p
}

// ═══════════════════════════ ① 图片类型按文件头判 ═══════════════════════════
section('① detectImageType：按文件头判类型（文件名是客户端可控的，不能信）')
check(detectImageType(PNG_HEAD)?.ext === '.png', 'PNG 头 → .png')
check(detectImageType(PNG_HEAD)?.contentType === 'image/png', 'PNG 头 → image/png')
check(detectImageType(JPG_HEAD)?.ext === '.jpg', 'JPEG 头 → .jpg')
check(detectImageType(GIF_HEAD)?.ext === '.gif', 'GIF 头 → .gif')
check(detectImageType(WEBP_HEAD)?.ext === '.webp', 'WebP 头 → .webp')
check(detectImageType(Buffer.from('<html><script>alert(1)</script>')) === null, 'HTML 伪装的「图片」被识破')
check(detectImageType(Buffer.from('GIF')) === null, '长度不足的残缺头不会被误判')
check(detectImageType(Buffer.alloc(0)) === null, '空缓冲区不抛异常，判为非图片')

// ═══════════════════════════ ② 头像键归属闸门 ═══════════════════════════
section('② assertAvatarKeyOwned：越权 / 穿越闸门')

const ME = 900001n
const OTHER = 900002n
const myKey = `${avatarKeyPrefix(ME)}1700000000000_abc.png`

function rejected(fn: () => void): unknown {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

/**
 * 拒绝路径必须用 async 版。
 * 踩过的坑：`rejected(() => void someAsyncFn())` 里那个箭头函数**立刻返回 undefined**，
 * 于是同步 try 捕不到任何东西，异步的 rejection 变成 unhandledRejection 直接打死进程 ——
 * 断言报的是「未被拒绝」，实际是断言写错了。凡是 async 调用一律用这个。
 */
async function rejectedAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

check(rejected(() => assertAvatarKeyOwned(ME, myKey)) === null, '自己 avatar 目录下的键放行')
check(
  rejected(() => assertAvatarKeyOwned(ME, `${avatarKeyPrefix(OTHER)}x.png`)) instanceof AvatarKeyNotOwnedError,
  '别人的头像键被拒（跨商家引用）',
)
check(
  rejected(() => assertAvatarKeyOwned(ME, `uploads/${ME}/avatar/../../${OTHER}/x.png`)) instanceof
    InvalidObjectKeyError,
  '`..` 穿越被拒（前缀匹配拦不住它）',
)
check(
  rejected(() => assertAvatarKeyOwned(ME, `uploads/${ME}/avatar/%2e%2e/x.png`)) instanceof InvalidObjectKeyError,
  '编码后的穿越段 %2e%2e 被拒',
)
check(
  rejected(() => assertAvatarKeyOwned(ME, `uploads/${ME}/1700000000000_abc.png`)) instanceof
    AvatarKeyNotOwnedError,
  '同商家但不在 avatar/ 子目录（收紧到头像专用前缀）',
)
check(
  rejected(() => assertAvatarKeyOwned(ME, 'renders/900001/x.mp4')) instanceof AvatarKeyNotOwnedError,
  '渲染产物不能当头像',
)
check(
  rejected(() => assertAvatarKeyOwned(ME, '')) instanceof InvalidObjectKeyError,
  '空键被拒',
)

// ═══════════════════════════ ③ 路由 schema（线上同一份） ═══════════════════════════
section('③ profilePatch：昵称 trim / 上限；头像键不 trim')

function ok3(input: unknown): { nickname?: string | null; avatarKey?: string } | null {
  const r = profilePatch.safeParse(input)
  return r.success ? r.data : null
}

check(ok3({ nickname: '  张老板  ' })?.nickname === '张老板', '昵称两边空格被真的删掉（落库值已 trim）')
check(ok3({ nickname: '   ' })?.nickname === '', '纯空白昵称 → 空串（语义等于清空，不是留 20 个空格）')
check(ok3({ nickname: '' })?.nickname === '', '空串通过（表示清空）')
check(ok3({ nickname: null })?.nickname === null, 'null 通过（表示清空）')
check(ok3({}) !== null, '空对象通过（两个字段都可选，语义=什么都不改）')
check(ok3({ nickname: 'x'.repeat(20) }) !== null, '20 字昵称通过（与 DB VARCHAR(64) 兼容，UI maxlength 同为 20）')
check(ok3({ nickname: 'x'.repeat(21) }) === null, '21 字昵称被拒')
check(!profilePatch.safeParse({ nickname: 123 }).success, '非字符串昵称被拒')
check(
  ok3({ avatarKey: `  ${myKey}  ` })?.avatarKey === `  ${myKey}  `,
  'avatarKey 前后空格**不被 trim**（对象键是存储标识，trim 会指向另一个对象）',
)

// ═══════════════════════════ ④ 上传链路（真写文件） ═══════════════════════════
let merchantId: bigint | null = null

async function main(): Promise<void> {
  const existing = await prisma.merchant.findUnique({
    where: { phone: PHONE },
    select: { id: true, avatarKey: true },
  })
  if (existing) {
    console.log(`  ℹ 发现上次残留的临时商户 ${existing.id}，先清理`)
    // 连上次留下的头像对象一起删：对象键只存在这一行里，删了行就再也找不回键了
    if (existing.avatarKey) await deleteObject(existing.avatarKey).catch(() => undefined)
    await prisma.merchant.delete({ where: { id: existing.id } })
  }
  const m = await prisma.merchant.create({
    data: { phone: PHONE, nickname: '原位昵称', status: 'ACTIVE' },
    select: { id: true },
  })
  merchantId = m.id
  const mid = merchantId

  section('④ 上传链路：只写 avatarKey，不进素材池、不占存储配额')
  const assetsBefore = await prisma.mediaAsset.count({ where: { merchantId: mid } })

  const pngPath = await writeTmp('a.png', PNG_HEAD)
  const first = await saveAvatarUpload(prisma, mid, { path: pngPath, size: PNG_HEAD.length })
  check(first.avatarKey?.startsWith(avatarKeyPrefix(mid)) === true, 'avatarKey 落在本商家 avatar 前缀下', `${first.avatarKey}`)
  check(first.avatarKey?.endsWith('.png') === true, '扩展名取自文件头（不看客户端文件名）')
  check(first.avatarUrl !== null, '返回了可直接展示的地址')

  if (isLocalStorage()) {
    const key = first.avatarKey!
    check(existsSync(localPathForKey(key)), '头像文件真的落在本地存储里')
    const url = new URL(first.avatarUrl!)
    check(url.pathname.endsWith('/media/file'), '本地模式下展示地址走 /media/file（不是本路由前缀）')
    check(
      verifyLocalMediaToken(key, url.searchParams.get('expires') ?? '', url.searchParams.get('token') ?? ''),
      '★ 展示地址的 HMAC 令牌校验通过（= 这个头像真的能被取到，不是拼了个假 URL）',
    )
  } else {
    check(/^https?:\/\//.test(first.avatarUrl ?? ''), 'COS 模式下展示地址是签好的 https 直链')
    check(await objectExists(first.avatarKey!), '★ 头像对象真的在桶里（签名地址不是凭空拼的）')
  }

  check(
    (await prisma.mediaAsset.count({ where: { merchantId: mid } })) === assetsBefore,
    '头像**没有**写进 media_asset（那会污染素材列表与上传空间条）',
  )

  const row1 = await prisma.merchant.findUniqueOrThrow({
    where: { id: mid },
    select: { avatarKey: true },
  })
  check(
    !/^https?:/.test(row1.avatarKey ?? '') && !String(row1.avatarKey).includes('token='),
    '★ 库里存的是**对象键**而不是签名 URL（签名 URL 1 小时就失效，落库必然变红叉）',
  )

  const oldKey = first.avatarKey!
  const jpgPath = await writeTmp('b.jpg', JPG_HEAD)
  const second = await saveAvatarUpload(prisma, mid, { path: jpgPath, size: JPG_HEAD.length })
  check(second.avatarKey !== oldKey, '再次上传换了新的对象键')
  if (isLocalStorage()) {
    check(!existsSync(localPathForKey(oldKey)), '旧头像对象已删除（不留孤儿文件）')
    check(existsSync(localPathForKey(second.avatarKey!)), '新头像对象存在')
  }

  section('⑤ 上传的拒绝路径：非图片 / 超大 都必须被拒且不留残渣')
  const htmlPath = await writeTmp('evil.png', '<html>not an image</html>')
  const e1 = await rejectedAsync(() => saveAvatarUpload(prisma, mid, { path: htmlPath, size: 25 }))
  check(e1 instanceof AvatarNotImageError, 'HTML 伪装成 .png 被拒', (e1 as Error)?.name ?? String(e1))
  check(
    (await prisma.merchant.findUniqueOrThrow({ where: { id: mid }, select: { avatarKey: true } })).avatarKey ===
      second.avatarKey,
    '被拒的上传没有改动 avatarKey（无部分写入）',
  )
  // 中转文件始终是**本地**临时文件（multer 落盘 / 脚本自己写），与存储模式无关，所以不套 isLocalStorage 判断
  check(!existsSync(htmlPath), '被拒上传的临时文件已清理（不会堆在 .incoming 里）')

  const bigPath = await writeTmp('big.png', PNG_HEAD)
  const e2 = await rejectedAsync(() =>
    saveAvatarUpload(prisma, mid, { path: bigPath, size: AVATAR_MAX_BYTES + 1 }),
  )
  check(e2 instanceof AvatarTooLargeError, '超过体积上限被拒', (e2 as Error)?.message ?? '')
  check(!existsSync(bigPath), '超大被拒的临时文件同样已清理')

  section('⑥ 更新语义：昵称 trim / 清空 / 越权键不落库')
  const renamed = await updateProfile(prisma, mid, { nickname: '  新名字  ' })
  check(renamed.nickname === '新名字', '改昵称：返回的已是 trim 后的值')
  const back = await prisma.merchant.findUniqueOrThrow({ where: { id: mid }, select: { nickname: true } })
  check(back.nickname === '新名字', '改昵称：库里读回来的也是 trim 后的值')

  const cleared = await updateProfile(prisma, mid, { nickname: null })
  check(cleared.nickname === null, '传 null 清空昵称（存 null，不是空串）')
  const wsOnly = await updateProfile(prisma, mid, { nickname: '   ' })
  check(
    wsOnly.nickname === null,
    '★ 服务层也 trim：纯空白昵称归一成 null（防未经路由直调服务的调用方绕过去）',
  )
  const clearedByEmpty = await updateProfile(prisma, mid, { nickname: '' })
  check(clearedByEmpty.nickname === null, '传空串清空昵称也被归一成 null')

  const before = await prisma.merchant.findUniqueOrThrow({ where: { id: mid }, select: { avatarKey: true } })
  const e3 = await rejectedAsync(() => updateProfile(prisma, mid, { avatarKey: `uploads/${OTHER}/avatar/x.png` }))
  check(e3 instanceof AvatarKeyNotOwnedError, '写入别人的头像键被拒', (e3 as Error)?.name ?? String(e3))
  check(
    (await prisma.merchant.findUniqueOrThrow({ where: { id: mid }, select: { avatarKey: true } })).avatarKey ===
      before.avatarKey,
    '越权请求被拒后 avatarKey 未被改动（闸门用例已还原）',
  )

  const view = await getProfile(prisma, mid, 'http://127.0.0.1:3000/api/v1/media')
  check(view.phone === PHONE, 'getProfile 返回手机号')
  check(view.avatarKey === before.avatarKey, 'getProfile 返回对象键（供客户端判断是否有自传头像）')

  // ═══════════════════════════ ⑦ 源码守护（防「新增键列忘了登记」） ═══════════════════════════
  section('⑦ 源码守护：新增的对象键列必须登记进 GC 引用集')
  const gcSrc = readFileSync(fileURLToPath(new URL('./gc-orphan-objects.ts', import.meta.url)), 'utf8')
  check(/prisma\.merchant\.findMany/.test(gcSrc), '在用的键：merchant 已纳入 collectReferencedKeys 的查询')
  check(
    /add\(r\.avatarKey\)/.test(gcSrc),
    '★ avatarKey 已 add 进引用集（漏掉 = 保留期后误删所有在用头像）',
  )
  const schemaSrc = readFileSync(fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url)), 'utf8')
  check(/avatarKey\s+String\?/.test(schemaSrc), 'schema：Merchant.avatarKey 列存在')
  check(
    /avatarKey\s+String\?[^\n]*@map\("avatar_key"\)/.test(schemaSrc),
    'schema：avatarKey 映射到 avatar_key（蛇形命名与其它列一致）',
  )
}

try {
  tmpDir = await mkdtemp(join(tmpdir(), 'profile-verify-'))
  await main()
} finally {
  if (merchantId !== null) {
    // 先删存储里的头像对象（硬删商户行后键就找不回来了），再删商户行
    const row = await prisma.merchant
      .findUnique({ where: { id: merchantId }, select: { avatarKey: true } })
      .catch(() => null)
    if (row?.avatarKey) await deleteObject(row.avatarKey).catch(() => undefined)
    await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => undefined)
    const left = await prisma.merchant.count({ where: { phone: PHONE } })
    check(left === 0, '临时商户已清理干净', `残留 ${left}`)
  }
  if (tmpDir) {
    await import('node:fs/promises').then(({ rm }) => rm(tmpDir, { recursive: true, force: true }))
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exitCode = 1
await prisma.$disconnect()
