/**
 * 存储孤儿对象 GC（默认**干跑**，只报告不删除）。
 *
 * ── 它解决什么问题 ──
 * 对象存储里的文件只增不减：用户删了素材、创作被删、渲染任务重跑换 key……
 * 数据库记录没了，存储里的对象还在。日积月累就是一笔纯浪费。
 * 本工具列举存储 → 比对数据库全部对象键列 → 找出**无主的对象**。
 *
 * ── 三个必须踩对的坑（否则会误删）──
 *
 * 1) ★ 渲染中间产物缓存 `renders/_cache/{merchantId}/{sha1}.mp4` **从不落库**。
 *    它是内容寻址的缓存（键由 缓存版本+assetId+裁剪区间+尺寸 算出，见 render/worker.ts
 *    intermediateKey），数据库里根本没有对应的列。天真的「列举 vs 比对」会把
 *    **整片缓存误判为孤儿**。这是本工具最大的雷，所以缓存单独归类、默认永不回收，
 *    只有显式 `--include-cache` 且超过 `--cache-retention-hours`（默认 7 天）才处理。
 *
 * 2) ★ 正在上传中的对象在存储里存在、数据库里没有 —— 和真正的孤儿**当下无法区分**。
 *    只能靠**保留期**隔开：默认只回收 mtime 早于 `--retention-hours`（默认 24 小时）
 *    的对象。本地模式下 multer 的中转目录 `.incoming/` 也会被列表实现跳过。
 *
 * 3) 对象键列**漏一列 = 误删一类在用文件**。所以已引用的键由下面 `collectReferencedKeys()`
 *    集中定义，覆盖 schema 里全部 17 个对象键列 / 9 张表（含软删行，宽松保护）。
 *
 * 另外一并处理一类「看不见的垃圾」——**未完成的分片上传（碎片）**：
 *   上传中途失败会留下 UploadId 与已上传分片，它们照样占存储、照样计费，
 *   但**不是对象**，`getBucket` 完全看不到（只能靠 multipartList）。
 *   本工具用 `--abort-fragments` 回收，同样受保留期保护（正在上传中会有活动 UploadId）。
 *
 * ── 跑法 ──
 *   npx tsx scripts/gc-orphan-objects.ts                       # 干跑，只报告
 *   npx tsx scripts/gc-orphan-objects.ts --retention-hours=48   # 调整保留期
 *   npx tsx scripts/gc-orphan-objects.ts --delete --limit=50    # 真正删除（分批）
 *   npx tsx scripts/gc-orphan-objects.ts --abort-fragments      # 回收陈旧的碎片
 *   npx tsx scripts/gc-orphan-objects.ts --include-cache --delete --limit=50
 *
 * 参数：
 *   --delete                     实际删除孤儿对象（缺省为干跑）
 *   --limit=N                    单次最多删除多少个对象（默认 100，强制分批）
 *   --retention-hours=H          保留期，早于此的对象才可能是孤儿（默认 24）
 *   --include-cache              连同渲染中间缓存一起回收（默认关）
 *   --cache-retention-hours=H    缓存的保留期（默认 168 = 7 天）
 *   --abort-fragments            中止陈旧的未完成分片上传（缺省只报告）
 *   --fragment-retention-hours=H 碎片的保留期（默认 24）
 *   --prefix=uploads/,renders/,tutorials/,works/   扫描前缀（默认这四个）
 */
import '../src/env.js' // 必须最先加载 .env，否则读不到 COS_*/STORAGE_MODE
import { PrismaClient } from '@prisma/client'
import { listObjects, deleteObject, listMultipartUploads, abortMultipartUpload } from '../src/lib/cos.js'
import { isLocalStorage, localStorageRoot, type StorageObject } from '../src/lib/local-storage.js'
import { isSafeObjectKey } from '../src/lib/object-key.js'

const prisma = new PrismaClient()

// ──────────────────────────── 参数解析 ────────────────────────────
function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
function numArg(name: string, def: number): number {
  const raw = argValue(name)
  if (raw === undefined) return def
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : def
}

const DELETE = process.argv.includes('--delete')
const INCLUDE_CACHE = process.argv.includes('--include-cache')
const ABORT_FRAGMENTS = process.argv.includes('--abort-fragments')
const LIMIT = Math.max(1, Math.floor(numArg('limit', 100)))
const RETENTION_HOURS = numArg('retention-hours', 24)
const CACHE_RETENTION_HOURS = numArg('cache-retention-hours', 168)
const FRAGMENT_RETENTION_HOURS = numArg('fragment-retention-hours', 24)
const PREFIXES = (argValue('prefix') ?? 'uploads/,renders/,tutorials/,works/').split(',').map((p) => p.trim()).filter(Boolean)

/** 渲染中间产物缓存前缀：内容寻址、从不落库，见文件头说明 ① */
const CACHE_PREFIX = 'renders/_cache/'

/**
 * 删除前的**硬编码前缀白名单**（与「扫描前缀」PREFIXES 是两份清单，别合并）。
 *
 * 两者方向相反：PREFIXES 决定「去哪里找孤儿」，这份决定「找到的孤儿敢不敢删」。
 * 白名单里**故意没有 `static/`** —— 运营公开图从不落库（只存在 system_setting 的
 * JSON 里），一旦让它可删，就是在没有任何引用记录可依据的情况下删公网在用的图。
 * 新增落库的对象前缀时，local-storage.ts 的 ALLOWED_PREFIXES 与这里要**同时**加：
 * 只加前者 ⇒ 扫得到但删不掉（对象永远回收不了）；只加后者 ⇒ 白名单形同虚设。
 */
const DELETABLE_PREFIXES = ['uploads/', 'renders/', 'tutorials/', 'works/']

const RETENTION_MS = RETENTION_HOURS * 3_600_000
const CACHE_RETENTION_MS = CACHE_RETENTION_HOURS * 3_600_000
const FRAGMENT_RETENTION_MS = FRAGMENT_RETENTION_HOURS * 3_600_000
const now = Date.now()

// ──────────────────────────── 工具函数 ────────────────────────────
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
function ageText(lastModifiedMs: number): string {
  if (!lastModifiedMs) return '未知'
  const h = (now - lastModifiedMs) / 3_600_000
  if (h < 1) return `${Math.round(h * 60)} 分钟前`
  if (h < 48) return `${h.toFixed(1)} 小时前`
  return `${(h / 24).toFixed(1)} 天前`
}

/**
 * 数据库中「已被引用」的全部对象键。
 *
 * ★ 这里的每一列都必须与 schema.prisma 的真实列一一对应。少一列，
 *   该类文件就会被当成孤儿删掉。新增对象键列时**务必回来补上**。
 *   故意包含软删除行（Store.deletedAt 等）：软删是可恢复的，其对象要保留。
 */
async function collectReferencedKeys(): Promise<Set<string>> {
  const keys = new Set<string>()
  const add = (v: string | null | undefined) => {
    if (v) keys.add(v)
  }

  const [stores, dishes, mediaAssets, dishMedia, shotLibrary, excellentWorks, tutorialVideos, renderTasks, merchants] =
    await Promise.all([
      prisma.store.findMany({ select: { coverKey: true, videoKey: true } }),
      prisma.dish.findMany({ select: { coverKey: true, videoKey: true } }),
      prisma.mediaAsset.findMany({ select: { cosKey: true, coverKey: true } }),
      prisma.dishMedia.findMany({ select: { cosKey: true, coverKey: true } }),
      prisma.shotLibrary.findMany({ select: { demoVideoKey: true, demoCoverKey: true } }),
      // 优秀作品（平台级，新上传落在 works/，存量是 renders/{merchantId}/）。
      // 表是**软删**，而这里刻意不过滤 deletedAt（宽松保护）⇒ 软删后它的两个大对象仍被保护。
      // 也就是说「作品在后台删掉」并**不会**回收存储，要手工清理（这是既有的保守取舍，
      // 宁可多留也不误删，改之前先想清「怎么证明这个对象真的没人用了」）。
      prisma.excellentWork.findMany({ select: { coverKey: true, videoKey: true } }),
      // 教学中心视频（平台级，前缀 tutorials/）。删的是硬删，但行在一天内消失前仍要保护其对象。
      prisma.tutorialVideo.findMany({ select: { videoKey: true, coverKey: true } }),
      prisma.renderTask.findMany({ select: { resultKey: true, previewKey: true } }),
      // 商家自传头像（个人主页）。注意只取 avatarKey：avatarUrl 是微信侧外部链接，不是存储键。
      prisma.merchant.findMany({ select: { avatarKey: true } }),
    ])

  for (const r of stores) {
    add(r.coverKey)
    add(r.videoKey)
  }
  for (const r of dishes) {
    add(r.coverKey)
    add(r.videoKey)
  }
  for (const r of mediaAssets) {
    add(r.cosKey)
    add(r.coverKey)
  }
  for (const r of dishMedia) {
    add(r.cosKey)
    add(r.coverKey)
  }
  for (const r of shotLibrary) {
    add(r.demoVideoKey)
    add(r.demoCoverKey)
  }
  for (const r of excellentWorks) {
    add(r.coverKey)
    add(r.videoKey)
  }
  for (const r of tutorialVideos) {
    add(r.videoKey)
    add(r.coverKey)
  }
  for (const r of renderTasks) {
    add(r.resultKey)
    add(r.previewKey)
  }
  for (const r of merchants) {
    add(r.avatarKey)
  }
  return keys
}

// ──────────────────────────── 主流程 ────────────────────────────
const mode = isLocalStorage() ? 'local' : 'cos'
const target = isLocalStorage()
  ? `本地目录 ${localStorageRoot()}`
  : `COS 桶 ${process.env.COS_BUCKET ?? '(未配置)'} @ ${process.env.COS_REGION ?? '(未配置)'}`

console.log('═'.repeat(72))
console.log(`存储孤儿对象 GC · ${DELETE || ABORT_FRAGMENTS ? `★ 执行模式 ★（${[DELETE && '删除对象', ABORT_FRAGMENTS && '回收碎片'].filter(Boolean).join(' + ')}）` : '干跑（只报告，不删除）'}`)
console.log(`存储后端：${mode} —— ${target}`)
console.log(`扫描前缀：${PREFIXES.join(', ')}`)
console.log(`保留期：普通对象 ${RETENTION_HOURS}h；渲染缓存 ${INCLUDE_CACHE ? `${CACHE_RETENTION_HOURS}h（已启用回收）` : '不回收'}；碎片 ${ABORT_FRAGMENTS ? `${FRAGMENT_RETENTION_HOURS}h（已启用回收）` : '不回收'}`)
console.log(`单次删除上限：${DELETE ? LIMIT : '（干跑不适用）'}`)
console.log('═'.repeat(72))

const referenced = await collectReferencedKeys()
console.log(`数据库已引用对象键：${referenced.size} 个（覆盖 7 表 14 列，含软删行）`)

// 列举存储
const all: StorageObject[] = []
for (const prefix of PREFIXES) {
  const page = await listObjects(prefix)
  console.log(`  列举 ${prefix.padEnd(10)} → ${page.length} 个对象`)
  all.push(...page)
}
const totalBytes = all.reduce((s, o) => s + o.sizeBytes, 0)
console.log(`存储对象合计：${all.length} 个 / ${fmtBytes(totalBytes)}\n`)

// 分类
const cache: StorageObject[] = []
const orphanEligible: StorageObject[] = [] // 超过保留期、可回收
const orphanYoung: StorageObject[] = [] // 疑似上传中，保留期保护
const referencedPresent = new Set<string>()

for (const o of all) {
  if (CACHE_PREFIX && o.key.startsWith(CACHE_PREFIX)) {
    cache.push(o)
    continue
  }
  if (referenced.has(o.key)) {
    referencedPresent.add(o.key)
    continue
  }
  // 到这里就是「数据库没引用」的对象：还要过保留期这一关
  const age = o.lastModifiedMs ? now - o.lastModifiedMs : 0
  // lastModifiedMs 未知（=0）时按「太新」处理，宁可漏删不误删
  if (!o.lastModifiedMs || age < RETENTION_MS) orphanYoung.push(o)
  else orphanEligible.push(o)
}

// 4) 未完成的分片上传（碎片）：不是对象，getBucket 看不到，只能靠 multipartList。
//    正在上传的任务也会有活动 UploadId，故同样用保留期隔离。
const fragments = isLocalStorage()
  ? []
  : (await Promise.all(PREFIXES.map((p) => listMultipartUploads(p)))).flat()
const fragmentOld = fragments.filter((f) => (f.initiatedMs ? now - f.initiatedMs : 0) >= FRAGMENT_RETENTION_MS)
const fragmentFresh = fragments.filter((f) => !fragmentOld.includes(f))

// 5) 悬空引用：数据库指向的对象已不在存储（用户会看到坏图/坏视频）
//
// 口径注意：只在**本次扫描的前缀范围内**判定。否则 `--prefix=uploads/1/` 这种
// 缩范围跑法会把「没扫到的 renders/ 键」全部误报成悬空引用（实测 29 → 48）。
const presentKeys = new Set(all.map((o) => o.key))
const inScanScope = (k: string) => PREFIXES.some((p) => k.startsWith(p))
const dangling: string[] = []
for (const k of referenced) {
  if (k.startsWith(CACHE_PREFIX)) continue // 缓存本就不该在库里
  if (!inScanScope(k)) continue // 不在本次扫描范围内，无从判断
  if (!isSafeObjectKey(k)) continue // 历史脏键，不参与统计
  if (!presentKeys.has(k)) dangling.push(k)
}

// ──────────────────────────── 报告 ────────────────────────────
console.log('── 分类统计 ──')
console.log(`  在库且在用       ：${referencedPresent.size} 个`)
console.log(`  渲染中间缓存     ：${cache.length} 个 / ${fmtBytes(cache.reduce((s, o) => s + o.sizeBytes, 0))}  （按设计不落库）`)
console.log(`  孤儿·可回收      ：${orphanEligible.length} 个 / ${fmtBytes(orphanEligible.reduce((s, o) => s + o.sizeBytes, 0))}`)
console.log(`  孤儿·保留期保护  ：${orphanYoung.length} 个  （可能是正在上传的对象，本轮不动）`)
console.log(`  未完成分片上传   ：${fragments.length} 个  （不是对象，getBucket 看不到；陈旧 ${fragmentOld.length} 个）`)
console.log(`  悬空引用(库有存无)：${dangling.length} 个  （需要运营关注，不影响回收）`)

function dump(title: string, items: StorageObject[], max = 30) {
  if (items.length === 0) return
  console.log(`\n── ${title}（共 ${items.length} 个）──`)
  for (const o of items.slice(0, max)) {
    console.log(`  ${o.key}  ${fmtBytes(o.sizeBytes)}  ${ageText(o.lastModifiedMs)}`)
  }
  if (items.length > max) console.log(`  … 其余 ${items.length - max} 个省略`)
}

dump('孤儿对象·可回收', orphanEligible)
dump('孤儿对象·保留期保护（疑似上传中）', orphanYoung, 10)
dump('悬空引用（数据库指向的对象已不存在）', dangling.map((key) => ({ key, sizeBytes: 0, lastModifiedMs: 0 })), 10)

if (fragments.length > 0) {
  console.log(`\n── 未完成的分片上传（碎片）（共 ${fragments.length} 个，陈旧 ${fragmentOld.length} 个）──`)
  for (const f of fragments.slice(0, 20)) {
    const tag = fragmentOld.includes(f) ? '陈旧' : '较新(保留期保护)'
    console.log(`  ${f.key}  uploadId=${f.uploadId.slice(0, 16)}…  ${ageText(f.initiatedMs)}  [${tag}]`)
  }
  if (fragments.length > 20) console.log(`  … 其余 ${fragments.length - 20} 个省略`)
  console.log('  说明：碎片占用存储并计费，但不在对象列表里。中止后可立即回收其已上传分片。')
  console.log('  长期方案：在 COS 控制台配「碎片过期自动删除」生命周期规则，无需人工干预。')
}

// ──────────────────────────── 执行删除 ────────────────────────────
if (!DELETE && !ABORT_FRAGMENTS) {
  console.log('\n（干跑结束，未删除任何对象。）')
  console.log(`确认无误后执行：npx tsx scripts/gc-orphan-objects.ts --delete --limit=${LIMIT}`)
  if (cache.length > 0 && !INCLUDE_CACHE) {
    console.log(`渲染缓存 ${cache.length} 个未纳入回收；如需回收：追加 --include-cache --cache-retention-hours=${CACHE_RETENTION_HOURS}`)
  }
  if (fragmentOld.length > 0 && !ABORT_FRAGMENTS) {
    console.log(`陈旧碎片 ${fragmentOld.length} 个未回收；如需回收：追加 --abort-fragments --fragment-retention-hours=${FRAGMENT_RETENTION_HOURS}`)
  }
} else {
  if (DELETE) {
    const victims = orphanEligible.slice(0, LIMIT)
    console.log(`\n★ 删除模式：本轮计划删除 ${victims.length} 个对象（可回收 ${orphanEligible.length} 个，上限 ${LIMIT}）`)

    let ok = 0
    let failed = 0
    let freedBytes = 0
    for (const o of victims) {
      // 删除前再校验一次：键必须安全、必须属于允许前缀、必须不在缓存区（除非显式启用）
      if (!isSafeObjectKey(o.key)) {
        console.log(`  ✗ 跳过非法键：${o.key}`)
        failed++
        continue
      }
      if (!DELETABLE_PREFIXES.some((p) => o.key.startsWith(p))) {
        console.log(`  ✗ 跳过前缀外键：${o.key}`)
        failed++
        continue
      }
      if (o.key.startsWith(CACHE_PREFIX) && !INCLUDE_CACHE) {
        console.log(`  ✗ 跳过缓存键（未启用 --include-cache）：${o.key}`)
        failed++
        continue
      }
      try {
        await deleteObject(o.key)
        ok++
        freedBytes += o.sizeBytes
        console.log(`  ✓ ${o.key}  ${fmtBytes(o.sizeBytes)}`)
      } catch (e) {
        failed++
        console.log(`  ✗ 删除失败：${o.key} —— ${(e as Error).message}`)
      }
    }
    console.log(`\n删除完成：成功 ${ok} 个 / 失败 ${failed} 个，释放 ${fmtBytes(freedBytes)}`)
    if (orphanEligible.length > LIMIT) {
      console.log(`仍有 ${orphanEligible.length - LIMIT} 个可回收对象未处理，可再次运行（每次上限 ${LIMIT}）`)
    }
  }

  if (ABORT_FRAGMENTS) {
    const targets = fragmentOld.slice(0, LIMIT)
    console.log(`\n★ 碎片回收：本轮计划中止 ${targets.length} 个（陈旧 ${fragmentOld.length} 个，上限 ${LIMIT}）`)
    let fok = 0
    let ffail = 0
    for (const f of targets) {
      if (!isSafeObjectKey(f.key)) {
        console.log(`  ✗ 跳过非法键：${f.key}`)
        ffail++
        continue
      }
      try {
        await abortMultipartUpload(f.key, f.uploadId)
        fok++
        console.log(`  ✓ 已中止 ${f.key}  uploadId=${f.uploadId.slice(0, 16)}…  ${ageText(f.initiatedMs)}`)
      } catch (e) {
        ffail++
        console.log(`  ✗ 中止失败：${f.key} —— ${(e as Error).message}`)
      }
    }
    console.log(`\n碎片回收完成：成功 ${fok} 个 / 失败 ${ffail} 个`)
    if (fragmentOld.length > LIMIT) {
      console.log(`仍有 ${fragmentOld.length - LIMIT} 个陈旧碎片未处理，可再次运行`)
    }
  }
}

await prisma.$disconnect()
