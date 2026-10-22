// 「参考视频」可用性 + 审核形态守护。纯源码静态检查，不碰数据库、不联网。
//                                                （`npm run tutorial-visibility:verify`）
//
// ── 这个脚本守两件互不相干、却共用一份数据的错 ──────────────────────────
//
// 【A】可见性口径（数据层）
//   小程序按「这个分类有几条能看的」决定入口露不露脸。判据是 `feedId` 非空。
//   计数与列表两处必须**同一口径**：
//     · 计数多算了 ⇒ 用户点进一个 0 条的分类，看到「还没有内容」（正是要消灭的形态）；
//     · 列表多发了 ⇒ 入口写着 3 条、点进去 4 条其中 1 条点不动。
//   两处不一致时**不会报错**，只能靠断言钉住。
//   具体失守点：
//     ① 有人把 `listCategoryStats` 改回 `groupBy(_count)`（数的是行数，不是可看数）；
//     ② `listByCategory` 的 where 丢了 `feedId: { not: null }`；
//     ③ 空串脏值没被 `.trim()` 那一刀挡掉；
//     ④ 判据被改回 `videoKey` —— 2026-10-22 已整体换成 feedId，改回去会让
//        「传过视频但没填 feedId」的老行重新出现在列表里，点开是没有反应的。
//
// 【B】审核形态（端上）
//   2026-10-22 之前这一页是「顶部深色舞台 + `<Video>`」，腾讯审核判了
//   「涉及提供播放、观看等服务，请补充选择：文娱-其他视频类目」（该类目要 6 选 1 资质）。
//   ⇒ 页面里**不许再出现任何播放器组件**，只许 `openChannelsActivity` 跳转；
//     且文案不许出现「课程 / 教程 / 教学 / 学习 / 技巧 / 知识 / 手册」——那会把页面
//     从「视频类目」推向更难办的「教育服务 / 在线视频课程」。
//
//   ⚠ 检查前先去掉注释：几个文件的注释里**正在解释**为什么不许用这些组件/词，
//     不剥注释的话这个脚本会把自己的说明书判成违规（假红）。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const servicePath = join(here, '..', 'src', 'services', 'tutorial.service.ts')
const src = await readFile(servicePath, 'utf8')

const miniRoot = join(here, '..', '..', 'apps', 'mini', 'src')
const pagePath = join(miniRoot, 'pages', 'tutorial', 'index.tsx')
const pageCfgPath = join(miniRoot, 'pages', 'tutorial', 'index.config.ts')
const svcMiniPath = join(miniRoot, 'services', 'tutorial.ts')
const minePath = join(miniRoot, 'pages', 'mine', 'index.tsx')
const adminRoot = join(here, '..', '..', 'apps', 'admin', 'src')
const adminTutorialsPath = join(adminRoot, 'pages', 'Tutorials.tsx')

/** 取某个导出函数体（从 `export async function NAME` 到下一个顶层 `export` 之间） */
function fnBody(name: string): string {
  const start = src.indexOf(`export async function ${name}`)
  if (start < 0) return ''
  const rest = src.slice(start + 1)
  const next = rest.search(/\nexport\s/)
  return next < 0 ? rest : rest.slice(0, next)
}

/** 去掉 `//` 行注释与 `/* *\/` 块注释（保留字符串里的内容，够用即可） */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

let pass = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

const stats = fnBody('listCategoryStats')
const list = fnBody('listByCategory')

console.log('\n[A1] 计数：只数真的配了 feedId 的行')
check('listCategoryStats 存在', stats.length > 0, '函数被改名或删掉了')
check('不再用 groupBy(_count) 数行数', !/groupBy\(/.test(stats), 'groupBy 数的是行数：没配 feedId 的行也会被算进「N 条」')
check('判据只认 feedId（不再认 videoKey）', /feedId/.test(stats) && !/videoKey/.test(stats), '改回 videoKey ⇒ 老行重新露脸，点开没反应')
check(
  '有空串那一刀（trim）',
  /hasPlayableVideo|\.trim\(\)/.test(stats),
  '手改库留下的 `feedId: ""` 会被当成「有内容」',
)
check(
  '仍然四个分类全量返回（count 可为 0，过滤交给客户端）',
  /TUTORIAL_CATEGORY_CODES\.map/.test(stats),
  '服务端把 0 条分类滤掉，客户端就再也分不清「没内容」与「接口挂了」',
)

console.log('\n[A2] 列表：没配 feedId 的行不下发')
check('listByCategory 存在', list.length > 0, '函数被改名或删掉了')
check('where 里有 feedId: { not: null }', /feedId:\s*\{\s*not:\s*null\s*\}/.test(list), '少了这一条 ⇒ 空壳条目会出现在列表里')
check('对空串脏值再做一次过滤', /hasPlayableVideo|\.trim\(\)/.test(list), 'where 挡不住 `feedId: ""`，会下发一条点不动的条目')
check(
  '两处口径一致：都只看 enabled + feedId',
  /enabled:\s*true/.test(stats) && /enabled:\s*true/.test(list),
  '一边看 enabled 一边不看，会出现「列表有、计数没有」',
)
check(
  '视频号 ID 有 env 兜底（行上留空不等于不可用）',
  /TUTORIAL_FINDER_USER_NAME/.test(src),
  '缺这个兜底 ⇒ 每一条都得手填 sph，漏一个就是「点观看没反应」',
)

console.log('\n[B1] 小程序页面：没有播放器，只有跳转')
const page = stripComments(await readFile(pagePath, 'utf8'))
check('页面不再引用 <Video>', !/<Video\b/.test(page), '内嵌 <Video> 会被判「提供播放、观看服务」⇒ 要补文娱-其他视频类目')
check('页面不再引用 <channel-video>', !/channel-video/i.test(page), '跨主体（视频号未认证＝无主体）时这个组件走不通，见页面顶部注释')
check('页面用 openChannelsActivity 跳转', /openChannelsActivity/.test(page), '没有跳转就没有观看路径')
check('跳转失败有提示（接口失败时什么都不发生）', /openChannelsActivity[\s\S]{0,200}\.catch\(/.test(page), '失败静默 ⇒ 用户只看到「点了没反应」')
check('没有 createVideoContext / 全屏调用', !/createVideoContext|requestFullScreen/.test(page), '这些是旧播放器形态的残留')

console.log('\n[B2] 文案：不许出现「课程 / 教程 / 教学」等字样')
const BANNED = ['课程', '教程', '教学', '学习', '技巧', '知识', '手册']
const svcMini = stripComments(await readFile(svcMiniPath, 'utf8'))
const catStart = svcMini.indexOf('export const TUTORIAL_CATEGORIES')
const catBlock = catStart < 0 ? '' : svcMini.slice(catStart, svcMini.indexOf(']', catStart) + 1)
check('解析到 TUTORIAL_CATEGORIES 常量表', catBlock.length > 0, '常量被改名了')
const hitCat = BANNED.filter((w) => catBlock.includes(w))
check('分类 label / pageTitle 无禁词', hitCat.length === 0, hitCat.length ? `命中：${hitCat.join('、')}` : '')

const pageCfg = stripComments(await readFile(pageCfgPath, 'utf8'))
const hitCfg = BANNED.filter((w) => pageCfg.includes(w))
check('页面配置标题无禁词', hitCfg.length === 0, hitCfg.length ? `命中：${hitCfg.join('、')}` : '')

const mine = stripComments(await readFile(minePath, 'utf8'))
check('「我的」页分组标题已改名', /ds-label'>参考视频</.test(mine) || /ds-label[^>]*>\s*参考视频/.test(mine), '仍是「学习中心」⇒ 入口文案继续把人往「课程」上带')
const hitMine = BANNED.filter((w) => new RegExp(`>[^<>{]*${w}[^<>{]*<`).test(mine))
check('「我的」页没有渲染中的禁词', hitMine.length === 0, hitMine.length ? `命中：${hitMine.join('、')}` : '')
check('计数单位是「条」不是「节」', /条</.test(mine) && !/\}\s*节</.test(mine), '「N 节」是课程量词')

// ★★ 2026-10-22 补：光改小程序不够 —— `/api/v1/tutorials` 是**免登录可读**的，
//    服务端兜底标题、后台下拉文案里的字照样对外可见（后台虽不给审核员看，
//    但两处各写一份必然会漂移，一起钉住）。
console.log('\n[B3] 服务端 / 后台文案：同一批禁词')
const svcTitleStart = src.indexOf('FALLBACK_TITLES')
const svcTitleBlock = svcTitleStart < 0 ? '' : src.slice(svcTitleStart, src.indexOf('}', svcTitleStart) + 1)
check('解析到 FALLBACK_TITLES 常量表', svcTitleBlock.length > 0, '常量被改名了')
const hitSvcTitle = BANNED.filter((w) => svcTitleBlock.includes(w))
check(
  '服务端兜底标题无禁词',
  hitSvcTitle.length === 0,
  hitSvcTitle.length
    ? `命中：${hitSvcTitle.join('、')} —— 该接口免登录可读，标题会原样出现在响应体里`
    : '',
)

const adminTutorials = stripComments(await readFile(adminTutorialsPath, 'utf8'))
const adminCatStart = adminTutorials.indexOf('const CATEGORIES')
const adminCatBlock =
  adminCatStart < 0 ? '' : adminTutorials.slice(adminCatStart, adminTutorials.indexOf(']', adminCatStart) + 1)
check('解析到后台 CATEGORIES 常量表', adminCatBlock.length > 0, '常量被改名了')
const hitAdminCat = BANNED.filter((w) => adminCatBlock.includes(w))
check('后台分类下拉文案无禁词', hitAdminCat.length === 0, hitAdminCat.length ? `命中：${hitAdminCat.join('、')}` : '')

// ── [B4] 分类名称可自定义（2026-10-22）──────────────────────────────────────
// 这条线最容易出的两个错：
//   ① 名字改回硬编码 ⇒ 运营改不动，或者改了只变小程序不变后台；
//   ② 后台保存接口声明在 `/tutorials/:id` 之后 ⇒ Express 先匹配 :id，
//      `PUT /tutorials/categories` 永远 400「参数错误」（页面上表现为「保存没反应」）。
console.log('\n[B4] 分类名称：可自定义 + 只换 label 不动 code')
check(
  '服务层从系统设置读名字（getCategoryTitles）',
  /export async function getCategoryTitles/.test(src) && /getString\(/.test(src),
  '名字若只读 FALLBACK_TITLES，运营在后台改完不生效',
)
check(
  '计数用的是 titles[code] 而不是 FALLBACK_TITLES[code]',
  /title: titles\[code\]/.test(src),
  '两处各读各的 ⇒ 后台改名后列表变了、计数没变',
)
check(
  '保存时把与兜底相同的键剔掉（少一条「改不动」的记录）',
  /v !== FALLBACK_TITLES\[code\]/.test(src),
)

const adminRoutePath2 = join(here, '..', 'src', 'routes', 'admin.ts')
const adminRoute = stripComments(await readFile(adminRoutePath2, 'utf8'))
check(
  '后台保存前做了禁词校验',
  /findBannedTitleWord/.test(adminRoute),
  '只靠前端提示 ⇒ 直接调接口/粘贴就绕过去了',
)
const iCategories = adminRoute.indexOf("'/tutorials/categories'")
const iIdRoute = adminRoute.indexOf("'/tutorials/:id'")
check(
  '分类路由声明在 `/tutorials/:id` 之前',
  iCategories > 0 && iIdRoute > 0 && iCategories < iIdRoute,
  'Express 按注册顺序匹配：放后面会被 :id 吃掉，表现是「保存分类名永远 400」',
)

// 小程序端：优先用接口返回的名字，本地常量只兜底
const mine2 = stripComments(await readFile(minePath, 'utf8'))
check(
  '「我的」页优先渲染接口给的名字',
  /tutorialTitles\[c\.code\]\s*\?\?\s*c\.label/.test(mine2),
  '只渲染本地 label ⇒ 后台改名对「我的」页无效',
)
const page2 = stripComments(await readFile(pagePath, 'utf8'))
check(
  '分类页把接口标题用上了（导航 + 页内标题）',
  /setTitle\(r\.title/.test(page2) && /\{title\}/.test(page2),
  '导航标题写死本地常量 ⇒ 改名后页面标题对不上',
)

console.log('')
if (failures.length) {
  console.log(`✗ 参考视频守护：${failures.length} 项失败（通过 ${pass} 项）`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exit(1)
}
console.log(`✓ 参考视频守护全部通过（${pass} 项）`)
