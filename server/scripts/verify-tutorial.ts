/**
 * 教学中心契约验证：分类白名单 / 视频类型嗅探 / 对象键前缀与 GC 登记 / 上传-播放-删除往返。
 *
 * ── 为什么值得单写一个脚本 ────────────────────────────────────────────────
 * 这里有**四道静默失效**，任何一道破了都不会报错，而且三道是「延迟发作」：
 *   ① 新增的 `tutorials/` 前缀没进 lib/local-storage.ts 的 ALLOWED_PREFIXES：
 *      本地模式下上传落盘与 `/media/file` 播放**双双抛错**（生产是 COS，一点事都没有）；
 *   ② tutorial_video 的两列没进 `gc-orphan-objects.ts::collectReferencedKeys()`：
 *      GC 在保留期（默认 24h）后把**在用的教学视频当孤儿删掉** ——
 *      「昨天还能看，今天全 404」，日志里什么都没有；
 *   ③ 视频扩展名按**文件名**而不是按**文件头**判定：一个 `.mp4` 结尾的 webm
 *      会让服务端声明 `Content-Type: video/mp4`，端上按 mp4 解复用 ⇒ 静默不播；
 *   ④ 读接口签名前不校验前缀：库里那列被手工改成 `uploads/2/xxx` 时，
 *      服务端会**替任何人**把别的商家的私有文件签出来。
 *
 * 用法：npm run tutorial:verify
 * 只造一次性数据（一条临时行 + 两个临时对象），跑完硬删；不动任何真实教学内容。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  MAX_TUTORIAL_COVER_BYTES,
  MAX_TUTORIAL_VIDEO_BYTES,
  TUTORIAL_KEY_PREFIX,
  adminListTutorials,
  adminRemoveTutorial,
  adminUpsertTutorial,
  listByCategory,
  listCategoryStats,
  saveTutorialCover,
  saveTutorialVideo,
} from '../src/services/tutorial.service.js'
import { detectVideoType } from '../src/lib/media-type.js'
import { TUTORIAL_CATEGORY_CODES, tutorialCategoryEnum } from '../src/lib/tutorial-categories.js'
import { isLocalStorage, localPathForKey } from '../src/lib/local-storage.js'
import { assertSafeObjectKey } from '../src/lib/object-key.js'
import { deleteObject, objectExists } from '../src/lib/cos.js'

const prisma = new PrismaClient()

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

// ─────────────────────── 测试素材（只造文件头，够嗅探用） ───────────────────────
/** mp4：尺寸字段之后是 'ftyp' + 牌子 'isom'。长度故意乱写 —— 只验类型判定 */
const MP4_HEAD = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.alloc(8),
])
/** mov：同样是 ftyp，牌子是 'qt  ' */
const MOV_HEAD = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x14]),
  Buffer.from('ftypqt  ', 'latin1'),
  Buffer.alloc(8),
])
/** webm：EBML 头 */
const WEBM_HEAD = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00])
const PNG_HEAD = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
])

const createdKeys: string[] = []
const createdIds: bigint[] = []

function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

async function main() {
  // ─────────────── ① 分类白名单（服务端权威） ───────────────
  section('分类白名单')
  const enumSchema = z.enum(tutorialCategoryEnum)
  for (const code of TUTORIAL_CATEGORY_CODES) {
    check(enumSchema.safeParse(code).success, `合法分类通过：${code}`)
  }
  check(!enumSchema.safeParse('SHOTTING').success, '拼错的分类被拒（SHOTTING）')
  check(!enumSchema.safeParse('').success, '空分类被拒')
  check(!enumSchema.safeParse('shooting').success, '小写被拒（路由层会先 upper，库里的值必须是大写）')
  check(
    TUTORIAL_CATEGORY_CODES.length === 4,
    '分类数量 = 4（「我的」页四宫格）',
    `实际 ${TUTORIAL_CATEGORY_CODES.length}`,
  )

  // ─────────────── ② 视频类型按文件头判定 ───────────────
  section('视频类型嗅探（按内容，不按文件名）')
  check(detectVideoType(MP4_HEAD)?.ext === '.mp4', 'mp4 头 → .mp4')
  check(detectVideoType(MOV_HEAD)?.ext === '.mov', 'ftyp/qt 头 → .mov（而不是误判成 .mp4）')
  check(detectVideoType(WEBM_HEAD)?.ext === '.webm', 'EBML 头 → .webm')
  check(detectVideoType(PNG_HEAD) === null, '★ PNG 头被拒（图片不能当视频存进来）')
  check(detectVideoType(Buffer.from('not a video at all')) === null, '随机文本被拒')
  check(detectVideoType(Buffer.alloc(0)) === null, '空文件被拒（不会越界读到 undefined）')
  check(
    detectVideoType(MP4_HEAD)?.contentType === 'video/mp4' &&
      detectVideoType(WEBM_HEAD)?.contentType === 'video/webm',
    'Content-Type 跟着判定结果走（不是全落到 video/mp4 兜底）',
  )

  // ─────────────── ③ 对象键前缀 ───────────────
  section('对象键前缀（tutorials/）')
  const probeKey = `${TUTORIAL_KEY_PREFIX}probe/0000.mp4`
  if (isLocalStorage()) {
    let ok = true
    try {
      localPathForKey(probeKey)
    } catch {
      ok = false
    }
    check(ok, '★ tutorials/ 在本地存储的 ALLOWED_PREFIXES 内（漏了 ⇒ 本地模式落盘与播放都报错）')
  } else {
    check(true, '当前是 COS 模式，跳过本地前缀白名单实测（下面用源码断言兜住）')
  }
  let dotdotRejected = false
  try {
    assertSafeObjectKey(`${TUTORIAL_KEY_PREFIX}../uploads/1/x.mp4`)
  } catch {
    dotdotRejected = true
  }
  check(dotdotRejected, '★ 含 `..` 的键被 assertSafeObjectKey 拒绝（前缀匹配本身拦不住）')

  // ─────────────── ④ 源码守护：GC 引用集与扫描前缀 ───────────────
  section('源码守护（防延迟发作的误删）')
  const localSrc = readSrc('../src/lib/local-storage.ts')
  check(/ALLOWED_PREFIXES = \[[^\]]*'tutorials\/'/.test(localSrc), 'local-storage：tutorials/ 已加入 ALLOWED_PREFIXES')
  const gcSrc = readSrc('../scripts/gc-orphan-objects.ts')
  // ★ 这两条守护原本断言的是**实现写法**（`'uploads/,renders/,tutorials/'` 紧邻引号、
  //   以及一种已经被重构掉的 `!o.key.startsWith('tutorials/')` 黑名单写法），
  //   于是实现一升级它们就失败 —— 而且指的是「实现变了」而不是「行为坏了」。
  //   现在改成从源码里**抽出真正决定行为的两个常量**再断言其内容：
  //   常量名一旦被改名，正则抽不到 ⇒ 断言照样失败（不会变成静默通过的空守护）。
  const defaultPrefixLit = /argValue\('prefix'\)\s*\?\?\s*'([^']*)'/.exec(gcSrc)?.[1]
  check(
    defaultPrefixLit !== undefined,
    'GC：能定位到默认扫描前缀常量（改名后本守护必须一起改，否则它会失败而不是静默通过）',
  )
  check(
    (defaultPrefixLit ?? '').split(',').includes('tutorials/'),
    `GC：默认扫描前缀含 tutorials/（实际：${defaultPrefixLit ?? '未取到'}）`,
  )
  const deletableLit = /DELETABLE_PREFIXES\s*=\s*\[([^\]]*)\]/.exec(gcSrc)?.[1]
  check(deletableLit !== undefined, 'GC：能定位到删除白名单常量 DELETABLE_PREFIXES')
  check(
    (deletableLit ?? '').includes("'tutorials/'"),
    `GC：删除白名单放行 tutorials/（否则扫得到却永远删不掉。实际：${deletableLit ?? '未取到'}）`,
  )
  check(/prisma\.tutorialVideo\.findMany/.test(gcSrc), 'GC：collectReferencedKeys 已查询 tutorialVideo')
  check(
    /add\(r\.videoKey\)[\s\S]{0,80}add\(r\.coverKey\)/.test(gcSrc),
    '★ GC：videoKey 与 coverKey 都已 add 进引用集（漏了 ⇒ 24h 后在用视频被删）',
  )
  const schemaSrc = readSrc('../prisma/schema.prisma')
  check(/videoKey\s+String\?[^\n]*@map\("video_key"\)/.test(schemaSrc), 'schema：videoKey → video_key')
  check(/coverKey\s+String\?[^\n]*@map\("cover_key"\)/.test(schemaSrc), 'schema：coverKey → cover_key')
  check(/@@map\("tutorial_video"\)/.test(schemaSrc), 'schema：表名 tutorial_video')

  // ─────────────── ⑤ 上传往返（真实写对象） ───────────────
  section('上传往返')
  const tmpDir = await mkdtemp(join(tmpdir(), 'tutorial-verify-'))
  try {
    const videoPath = join(tmpDir, 'lesson.mp4')
    await writeFile(videoPath, MP4_HEAD)
    // 只有文件头、不是合法 mp4 ⇒ 抽帧必然失败，正好覆盖「抽帧失败不阻断上传」
    const up = await saveTutorialVideo(videoPath)
    createdKeys.push(up.videoKey)
    if (up.coverKey) createdKeys.push(up.coverKey)
    check(up.videoKey.startsWith(TUTORIAL_KEY_PREFIX), '视频键落在 tutorials/ 前缀下', up.videoKey)
    check(up.videoKey.endsWith('.mp4'), '扩展名取自文件头判定结果')
    check(up.contentType === 'video/mp4', '返回的 contentType 正确', up.contentType)
    check(up.sizeBytes === MP4_HEAD.length, '字节数 = 落盘内容长度', `${up.sizeBytes}`)
    check(await objectExists(up.videoKey), '视频对象真的落到了存储里')
    check(up.coverKey === null, '★ 抽帧失败时 coverKey 为 null 且不抛错（不阻断上传）')

    const coverPath = join(tmpDir, 'cover.png')
    await writeFile(coverPath, PNG_HEAD)
    const cover = await saveTutorialCover(coverPath)
    createdKeys.push(cover.coverKey)
    check(cover.coverKey.endsWith('.png'), '封面扩展名取自魔数（png）', cover.coverKey)
    check(await objectExists(cover.coverKey), '封面对象真的落到了存储里')

    // 中转文件必须被清掉：multer 全部落在 storage/.incoming/，不清会一直堆积
    check(!existsSync(videoPath), '★ 上传后中转文件已被清理（不清会一直堆积在 .incoming）')

    // ─────────────── ⑥ 落库 → 读接口 ───────────────
    section('落库与读接口')
    const row = await adminUpsertTutorial(prisma, undefined, {
      category: 'SHOOTING',
      title: '【契约验证】临时课程',
      videoKey: up.videoKey,
      coverKey: cover.coverKey,
      sort: 9999,
    })
    createdIds.push(row.id)
    check(row.id > 0n, '创建成功')
    check(row.enabled === true, '默认上架（enabled=true）')

    const listed = await adminListTutorials(prisma, { category: 'SHOOTING' })
    check(
      listed.some((r) => r.id === row.id),
      '后台列表按分类能查到',
      `共 ${listed.length} 条`,
    )

    const items = await listByCategory(prisma, 'SHOOTING')
    const mine = items.find((i) => i.id === row.id.toString())
    check(!!mine, '小程序侧列表能查到')
    check(!!mine?.videoUrl, '视频播放地址现签成功（非 null）')
    check(!!mine?.coverUrl, '封面地址现签成功（非 null）')
    check((mine?.videoUrl ?? '').includes('tutorials'), '签出来的地址指向 tutorials/ 对象')

    const stats = await listCategoryStats(prisma)
    check(stats.length === 4, '分类概览返回 4 项')
    check(
      stats.every((s) => typeof s.count === 'number' && s.count >= 0),
      '每项都带数量（四宫格直接用）',
      stats.map((s) => `${s.code}:${s.count}`).join(' '),
    )

    // ★ 闸门用例：库里那列被改成别的前缀时，读接口**必须**拒绝签名而不是照签
    //   （服务端替客户端签名 ⇒ 不校验就等于把别人的私有文件签出去）
    await prisma.tutorialVideo.update({
      where: { id: row.id },
      data: { videoKey: 'uploads/1/not-mine.mp4' },
    })
    const tampered = (await listByCategory(prisma, 'SHOOTING')).find((i) => i.id === row.id.toString())
    check(
      tampered?.videoUrl === null,
      '★ 键不属于 tutorials/ 前缀时拒绝签名（返回 null，不抛错、不泄露）',
    )
    await prisma.tutorialVideo.update({ where: { id: row.id }, data: { videoKey: up.videoKey } })
    const restored = (await listByCategory(prisma, 'SHOOTING')).find((i) => i.id === row.id.toString())
    check(!!restored?.videoUrl, '还原后又能正常签名（闸门没有把正常路径一起挡掉）')

    // 下架后不再下发
    await prisma.tutorialVideo.update({ where: { id: row.id }, data: { enabled: false } })
    const off = await listByCategory(prisma, 'SHOOTING')
    check(!off.some((i) => i.id === row.id.toString()), 'enabled=false 的课程不再下发给小程序')
    await prisma.tutorialVideo.update({ where: { id: row.id }, data: { enabled: true } })

    // ─────────────── ⑦ 删除：行与对象一起走 ───────────────
    section('删除（硬删 + 删对象）')
    const removed = await adminRemoveTutorial(prisma, row.id)
    createdIds.splice(createdIds.indexOf(row.id), 1)
    createdKeys.splice(createdKeys.indexOf(up.videoKey), 1)
    createdKeys.splice(createdKeys.indexOf(cover.coverKey), 1)
    check(removed.removedObjects === 2, '两个对象都被删掉', `实际 ${removed.removedObjects}`)
    check(!(await objectExists(up.videoKey)), '视频对象已不存在')
    check(!(await objectExists(cover.coverKey)), '封面对象已不存在')
    check((await prisma.tutorialVideo.count({ where: { id: row.id } })) === 0, '数据行已删除')

    let notFound = false
    try {
      await adminRemoveTutorial(prisma, row.id)
    } catch {
      notFound = true
    }
    check(notFound, '重复删除抛 TutorialNotFoundError（路由层转 404）')

    // ─────────────── ⑧ 上限常量 ───────────────
    section('上限常量')
    check(MAX_TUTORIAL_VIDEO_BYTES === 100 * 1024 * 1024, '视频上限 100MB')
    check(MAX_TUTORIAL_COVER_BYTES === 5 * 1024 * 1024, '封面上限 5MB')
    const adminSrc = readSrc('../src/routes/admin.ts')
    check(/fileSize: tutorialSvc\.MAX_TUTORIAL_VIDEO_BYTES/.test(adminSrc), 'multer 的 limits 用的是同一个常量（不是另写一个数字）')
    check(/id: 'file'|\.single\('file'\)/.test(adminSrc), '上传字段名固定为 file')

    // ─────────────── ⑨ 路由挂载（HTTP 冒烟） ───────────────
    // 期望值是逐个写死的，不再假设「未带 token 一律 401」：
    //   · 小程序那两个读接口**故意公开**（理由见 routes/tutorials.ts 顶部注释：
    //     未登录也能点进来，一旦按 401 处理就会触发请求层的登录跳转，
    //     把还没落定的 navigateTo 打断 ⇒ 空白页 + `navigateTo:fail timeout`）
    //     ⇒ 期望 200。这里断言 200 同时也是**防回归**：谁把 auth 加回去就会红。
    //   · 后台那两个接口必须仍然是 401。
    // 服务没起就跳过 —— 这一条不该让整个脚本失败。
    section('路由挂载（HTTP 冒烟）')
    const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`
    const routes: Array<{ path: string; expect: number }> = [
      { path: '/api/v1/tutorials', expect: 200 },
      { path: '/api/v1/tutorials/SHOOTING', expect: 200 },
      { path: '/admin/api/v1/tutorials', expect: 401 },
    ]
    for (const r of routes) {
      const status = await probe(base + r.path)
      if (status === null) {
        check(true, `${r.path} —— 本地服务未启动，跳过`)
      } else {
        check(
          status === r.expect,
          `${r.path} 未带 token 返回 ${r.expect}（不是 404 ⇒ 路由确实挂上了）`,
          `实际 ${status}`,
        )
      }
    }

    // 源码级闸门：小程序读接口不鉴权这件事必须在源码里看得见。
    // 光靠上面那两条 HTTP 断言不够 —— 服务没起时它们整体被跳过，就没人拦得住「顺手加回 auth」。
    const tutorialRouteSrc = readSrc('../src/routes/tutorials.ts')
    check(
      !/router\.use\(auth\)/.test(tutorialRouteSrc),
      '小程序读接口没有挂 auth 中间件（公开是有意的，见该文件头注释）',
    )
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

/** 返回 HTTP 状态码；连不上返回 null（用于跳过） */
async function probe(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    // 401 的响应体也要读掉，否则连接不会及时释放
    await res.text().catch(() => '')
    return res.status
  } catch {
    return null
  }
}

try {
  await main()
} finally {
  // 先删行再删对象：行是键的唯一存放处，行没了就再也找不回键
  for (const id of createdIds) {
    await prisma.tutorialVideo.deleteMany({ where: { id } }).catch(() => undefined)
  }
  for (const key of createdKeys) {
    await deleteObject(key).catch(() => undefined)
  }
  const leftoverRows = await prisma.tutorialVideo.count({ where: { title: { contains: '契约验证' } } }).catch(() => 0)
  check(leftoverRows === 0, '临时数据已清理干净（数据行）', `残留 ${leftoverRows}`)
  const leftoverKeys = await Promise.all(createdKeys.map((k) => objectExists(k).catch(() => false)))
  check(!leftoverKeys.some(Boolean), '临时数据已清理干净（存储对象）')
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exitCode = 1
await prisma.$disconnect()
