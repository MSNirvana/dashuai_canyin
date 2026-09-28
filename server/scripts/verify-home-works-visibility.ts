/**
 * 「优秀作品」模块显隐的守护 —— 守住「有已上架作品才出现、没有就整块消失」这个契约。
 *
 * ★★ 为什么需要它（2026-09-28 的需求）：
 *   `prisma/seed.ts` 种的 28 条是**没有素材的配方模板**，建出来时却是 `enabled: true`。
 *   后果是：小程序首页「优秀作品」整块**永远渲染**，全是「封面待补」的灰块、点进去也播不了。
 *   修法有三处，任何一处退回去都会**静默**复发（不报错、只是首页又变难看）：
 *     ① seed 默认不上架（否则重跑 seed 就把 28 条灰块推回首页）
 *     ② 前端整块按需渲染（否则空库时仍留着一个空标题和空分类横滑）
 *     ③ 接口层只返回已上架（这是①②共同依赖的前提，一直被依赖、从未被断言过）
 *
 * ★ 特别容易踩的两条：
 *   · **「暂无作品」那一支不能删**：它管的是「有已上架作品、但当前分类为空」，
 *     与「整块要不要出现」是两件事。删了它，用户切到空分类会看到一片空白。
 *   · **判据不能只用 `works.length`**：`works` 是当前分类当前页的条目，
 *     `workTotal` 也带分类过滤 —— 切到空分类时它们都会是 0，
 *     那时若按它们判会把整块连分类横滑一起藏掉，用户再也切不回「全部」。
 *     必须用全局信号（`/works/categories` 的条数）。
 *
 * 运行：cd server && npx tsx scripts/verify-home-works-visibility.ts
 * ⚠ 静态断言 + **只读**库校验：不改任何数据（库里那条真的作品不会被碰到）。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '../src/db.js'
import { listCategories, listWorks } from '../src/services/work.service.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const HOME_PAGE = join(REPO_ROOT, 'apps', 'mini', 'src', 'pages', 'home', 'index.tsx')
const SEED = join(HERE, '..', 'prisma', 'seed.ts')
const SERVICE = join(HERE, '..', 'src', 'services', 'work.service.ts')
const HIDE_SCRIPT = join(HERE, 'hide-placeholder-works.ts')
const ADMIN_WORKS = join(REPO_ROOT, 'apps', 'admin', 'src', 'pages', 'Works.tsx')

let pass = 0
let fail = 0

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

/**
 * 截出某个函数的函数体（用「下一个顶层 export/async function」当右边界）。
 * ★ 只准用在下标明确的 export 函数上；取文件里的**任意片段**请用下面的 `braceBlock`。
 */
function bodyOf(src: string, marker: string): string {
  const start = src.indexOf(marker)
  if (start < 0) return ''
  const rest = src.slice(start + marker.length)
  const next = rest.search(/\nexport (async )?function |\n\/\*\*/)
  return next < 0 ? rest : rest.slice(0, next)
}

/**
 * 取一段**花括号平衡**的代码块：从 marker 之后第一个 `{` 开始配对，配平即止。
 *
 * ★★ 为什么不能用 `slice(indexOf(a), indexOf(b))` 这种写法（本脚本第一版就栽在这里）：
 *   文件里同名文本往往有**更早的一处** —— `const categories = new Set(` 在 seed.ts 里
 *   第 543 行已经出现过一次，而我要的那处在第 679 行 ⇒ `slice(start, end)` 拿到空串，
 *   于是三条断言全红，而**代码其实是好的**。红得莫名其妙时先怀疑断言，别先怀疑代码。
 *   （`${…}` 模板插值里的花括号是配平的，不影响这个匹配器。）
 */
function braceBlock(src: string, marker: string): string {
  const m = src.indexOf(marker)
  if (m < 0) return ''
  const open = src.indexOf('{', m + marker.length)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

async function main(): Promise<void> {
  const home = await readFile(HOME_PAGE, 'utf8')
  const seed = await readFile(SEED, 'utf8')
  const service = await readFile(SERVICE, 'utf8')
  const admin = await readFile(ADMIN_WORKS, 'utf8')

  // ── ① 前端：整块必须按需渲染 ─────────────────────────────────────────────
  console.log('\n① 首页「优秀作品」整块必须按需渲染（空库时连标题一起消失）')
  const condIdx = home.indexOf('hasWorks &&')
  // ★ 认**真正的 JSX 元素**而不是「优秀作品」四个字：那四个字在 `hasWorks` 的上方注释里
  //   已经出现过一次，用 indexOf 找字面量会永远得到「标题在条件之前」的假红。
  const TITLE_JSX = "<Text className='home__sec-title'>优秀作品</Text>"
  const titleIdx = home.indexOf(TITLE_JSX)
  ok(
    '首页里有 `hasWorks` 条件，且能找到优秀作品的标题元素',
    condIdx >= 0 && titleIdx >= 0,
    `hasWorks@${condIdx}、标题元素@${titleIdx}`,
  )
  ok(
    '★ 标题元素出现在 `hasWorks` 条件**之后**（说明它被包住了）',
    condIdx >= 0 && titleIdx > condIdx,
    `hasWorks@${condIdx}、标题元素@${titleIdx} —— 在条件之前说明没包住`,
  )
  ok(
    '★ 整块（标题 … 到底部「已经到底了」）都在条件之后（防「只包住了标题」）',
    condIdx >= 0 && home.slice(condIdx).includes('优秀作品') && home.slice(condIdx).includes('已经到底了'),
    '只包住一半的写法很难一眼看出：标题藏了、分类横滑还在',
  )
  ok(
    '★ 条件里同时用了「分类条数」与「总数」两个信号（取或）',
    /const hasWorks = workCats\.length > 0 \|\| workTotal > 0/.test(home),
    '只用其中一个：分类请求失败或切到空分类时会把整块误藏',
  )
  ok(
    '★★ 判据**不能**只用 `works.length`（切到空分类时它会归零 ⇒ 连分类横滑一起藏掉）',
    !/const hasWorks = works\.length/.test(home),
  )
  ok(
    '★ 「暂无作品」分支必须留着（它管「有作品但当前分类为空」，与整块显隐是两件事）',
    /暂无作品/.test(home),
    '删了它，用户切到空分类会看到一片空白',
  )

  // ── ② seed：默认不上架、且不覆盖运营的上下架决定 ─────────────────────────
  console.log('\n② seed 造的作品必须**默认不上架**（否则每次 seed 都把灰块推回首页）')
  const seedFn = braceBlock(seed, 'async function seedExcellentWorks')
  ok('能截出 seedExcellentWorks 的函数体（截不出说明它被改名/挪走了）', seedFn.length > 0)
  const createBlock = braceBlock(seedFn, 'prisma.excellentWork.create')
  ok('能截出 seed 的 create 块', createBlock.length > 0)
  ok('seed 创建作品时写的是 `enabled: false`', /enabled: false/.test(createBlock))
  ok(
    'seed 创建时 `publishedAt` 一起给 null（未上架却带一个上架时间 = 后台显示自相矛盾）',
    /publishedAt: null/.test(createBlock),
  )
  // `data` 是更新分支唯一写进去的东西 —— 它里面出现 enabled 就会覆盖运营的上下架
  // ★ 必须在 **seedExcellentWorks 的函数体里**取这个 `const data = {…}`：
  //   seed.ts 里还有四处同名变量（模型/场景/后台账号），取到任何一处都是假红或假绿。
  const dataBlock = braceBlock(seedFn, 'const data =')
  ok('能截出 seed 里给作品用的那个 `const data = {…}`', dataBlock.length > 0)
  ok(
    '★ seed 的更新分支（`data`）里**不许出现 `enabled`**（否则重跑 seed 会打回运营的上下架决定）',
    dataBlock.length > 0 && !/enabled/.test(dataBlock),
    dataBlock ? `实测 data = ${dataBlock.replace(/\s+/g, ' ').slice(0, 100)}` : '',
  )

  // ── ③ 接口层：三个读口都必须只返回已上架 ─────────────────────────────────
  console.log('\n③ 接口层只返回已上架（①②都建立在这条之上，改了它前两条一起失效）')
  for (const fn of ['export async function listWorks', 'export async function listCategories', 'export async function getWork']) {
    const body = bodyOf(service, fn)
    ok(`${fn.replace('export async function ', '')} 的查询带 enabled: true`, /enabled: true/.test(body))
    ok(`${fn.replace('export async function ', '')} 的查询带 deletedAt: null`, /deletedAt: null/.test(body))
  }

  // ── ④ 清理脚本：默认 dry-run、判据明确 ───────────────────────────────────
  console.log('\n④ 存量清理脚本：默认只看不动，且判据是「没有任何素材」')
  ok('清理脚本存在', existsSync(HIDE_SCRIPT))
  if (existsSync(HIDE_SCRIPT)) {
    const hide = await readFile(HIDE_SCRIPT, 'utf8')
    ok(
      '★ 默认 dry-run：只有带 `--yes` 才写库',
      /--yes/.test(hide) && /if \(targets\.length === 0\)[\s\S]{0,200}?else if \(!apply\)/.test(hide),
      '一跑就改运营状态太危险 —— 必须先看清单',
    )
    ok(
      '判据是「既无视频也无封面」（= seed 造的占位品的等价描述）',
      /videoKey: null/.test(hide) && /coverKey: null/.test(hide),
      '用标题清单点名会与 seed 漂移；用 enabled 一条会误伤真作品',
    )
    ok('下架时同时清 `publishedAt`', /publishedAt: null/.test(hide))
  }

  // ── ⑤ 后台要有上下架入口（「后台有传就自动打开」靠它）──────────────────
  console.log('\n⑤ 后台必须有上下架入口（否则「后台有传 ⇒ 自动打开」无从触发）')
  ok('后台作品页有「上架 / 下架」动作', /已上架/.test(admin) && /下架/.test(admin))
  ok('后台新建表单有「立即上架」开关', /立即上架/.test(admin))

  // ── ⑥ 活库交叉校验（只读）：前端两个信号 ⟺ 「有没有已上架作品」──────────
  console.log('\n⑥ 只读库校验：前端判据用的两个信号，是否恰好等价于「有没有已上架作品」')
  const enabledCount = await prisma.excellentWork.count({ where: { deletedAt: null, enabled: true } })
  const cats = await listCategories(prisma)
  const firstPage = await listWorks(prisma, { page: 1, pageSize: 6 })
  ok(
    '★ `listCategories()` 非空 ⟺ 库里存在已上架作品（前端 `workCats.length > 0` 的语义）',
    cats.length > 0 === enabledCount > 0,
    `已上架 ${enabledCount} 条、分类 ${cats.length} 个 —— 两者必须同时为 0 或同时非 0`,
  )
  ok(
    '★ `listWorks().total` 恰好等于已上架作品数（前端 `workTotal` 的语义）',
    firstPage.total === enabledCount,
    `total=${firstPage.total}、已上架=${enabledCount}`,
  )
  ok(
    '列表条目全部带 coverKey/videoKey 字段（前端据此判「封面待补」）',
    firstPage.items.every((w) => 'coverKey' in w && 'videoKey' in w),
  )
  console.log(
    `  ℹ 当前库：已上架 ${enabledCount} 条 ⇒ 首页「优秀作品」整块${
      enabledCount > 0 ? '**会显示**' : '**会隐藏**'
    }`,
  )

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
  if (fail > 0) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error('\n✗ 守护脚本自身出错：', (e as Error)?.message)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect().finally(() => process.exit(process.exitCode ?? 0))
  })
