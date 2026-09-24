// 小程序产物自检（P0-3 收尾）
//
// 为什么必须有这一步：
//   按需拷贝 tdesign 组件时，一旦闭包算漏了某个隐藏依赖（例如 button 依赖 loading、
//   dialog 依赖 overlay/popup），构建**照样成功**，只在真机/开发者工具打开对应页面时才白屏。
//   所以要在构建后机械地核对：产物里每一处 usingComponents 引用的文件是否真实存在。
//
// 校验项：
//   1. 所有 .json 的 usingComponents 路径都能在产物里解析到 .js/.json/.wxml 三件套
//   2. 主包体积是否超过微信 2MB 上限
//   3. 产物体积构成报表
//
// 用法：node scripts/verify-weapp-dist.mjs [distDir]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const DIST = process.argv[2] ?? 'dist/weapp'
const MAIN_LIMIT = 2 * 1024 * 1024 // 微信主包上限 2MB

if (!existsSync(DIST)) {
  console.error(`✗ 产物目录不存在：${DIST}（先执行 npm run build:weapp:dev）`)
  process.exit(1)
}

/** 递归收集所有文件 */
function walkFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) out.push(p)
    }
  }
  return out
}

const files = walkFiles(DIST)
let fail = 0

// ── 1. usingComponents 解析校验 ──
const jsonFiles = files.filter((f) => f.endsWith('.json'))
const problems = []
let checked = 0

for (const jf of jsonFiles) {
  let json
  try {
    json = JSON.parse(readFileSync(jf, 'utf8'))
  } catch {
    continue // 带注释的 json 跳过
  }
  const uc = json.usingComponents
  if (!uc || typeof uc !== 'object') continue

  for (const [tag, path] of Object.entries(uc)) {
    if (typeof path !== 'string') continue
    if (/^plugin:\/\//.test(path)) continue // 插件组件不校验

    // 小程序组件路径解析规则：以 / 开头是相对产物根，否则相对当前 json 所在目录
    const base = path.startsWith('/') ? DIST : dirname(jf)
    const target = resolve(base, path.replace(/^\//, ''))
    checked += 1

    const ok = ['.js', '.json', '.wxml'].every((ext) => existsSync(target + ext))
    if (!ok) {
      const missing = ['.js', '.json', '.wxml'].filter((ext) => !existsSync(target + ext))
      problems.push(`${jf.replace(DIST + '/', '')}  组件 "${tag}" → ${path}  缺少 ${missing.join(', ')}`)
    }
  }
}

console.log(`[自检] 校验 ${jsonFiles.length} 个 json、${checked} 处 usingComponents 引用`)
if (problems.length) {
  fail += 1
  console.log(`✗ ${problems.length} 处引用解析失败（运行时会白屏）：`)
  for (const p of problems) console.log('    ' + p)
} else {
  console.log('✓ 全部组件引用均可解析')
}

// ── 2. 体积校验 ──
const total = files.reduce((s, f) => s + statSync(f).size, 0)
const pct = ((total / MAIN_LIMIT) * 100).toFixed(1)
// 提前预警线：撞到 2MB 才报错就太晚了（那时只能仓促改架构）。到 90% 就该规划分包。
const WARN_LIMIT = Math.floor(MAIN_LIMIT * 0.9)
console.log(`\n[自检] 主包体积 ${(total / 1048576).toFixed(2)}MB / 上限 2.00MB（${pct}%）`)
if (total > MAIN_LIMIT) {
  fail += 1
  console.log(`✗ 超出主包上限 ${((total - MAIN_LIMIT) / 1024).toFixed(0)}KB，上传会被拒`)
} else if (total > WARN_LIMIT) {
  console.log(
    `⚠ 已达上限的 ${pct}%（超过预警线 90%）。剩余余量不足 ${((MAIN_LIMIT - WARN_LIMIT) / 1024).toFixed(0)}KB，` +
      '再增长就会撞 2MB 硬上限 —— 此时应该切分包，而不是继续压图片：' +
      '启用步骤与约束见 src/app.config.ts 的 subPackages 注释（注意分包 root 不能放在 pages/ 下，需要搬文件）',
  )
} else {
  console.log(`✓ 余量 ${((MAIN_LIMIT - total) / 1024).toFixed(0)}KB`)
}

// ── 3. 构成报表 ──
const buckets = new Map()
for (const f of files) {
  const rel = f.slice(DIST.length + 1)
  const top = rel.includes('/') ? rel.split('/')[0] : '(根文件)'
  buckets.set(top, (buckets.get(top) ?? 0) + statSync(f).size)
}
console.log('\n[自检] 体积构成：')
for (const [k, v] of [...buckets].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(12)} ${(v / 1024).toFixed(1).padStart(8)} KB  ${((v / total) * 100).toFixed(1)}%`)
}

// ── 4. 关键项点检 ──
const essential = [
  'app.json',
  'app.js',
  'common.js',
  'npm/tdesign-miniprogram/button/button.js',
  'npm/tdesign-miniprogram/button/tslib.js',
  'npm/tdesign-miniprogram/loading/loading.js',
  'npm/tdesign-miniprogram/common/style/index.wxss',
]
console.log('\n[自检] 关键文件点检：')
for (const e of essential) {
  const ok = existsSync(join(DIST, e))
  console.log(`    ${ok ? '✓' : '✗'} ${e}`)
  if (!ok) fail += 1
}

// ── 5. tslib 隐式依赖校验 ──
// tdesign-miniprogram >= 1.9.0 的产物里有 `import{__decorate}from"tslib"`，
// 但它 package.json 未声明该依赖（官方 issue #3697）。微信对 `npm/` 下的裸模块名
// 会退回「相对当前文件」解析，所以**每个引用 tslib 的组件目录**里都必须有 tslib.js，
// 否则运行时报 `module 'npm/tdesign-miniprogram/button/tslib.js' is not defined`。
// 这类问题构建期完全静默，只在开发者工具/真机打开对应页面时才炸 —— 必须机械核对。
const npmJs = files.filter((f) => f.endsWith('.js') && f.includes('/npm/tdesign-miniprogram/'))
const tslibMissing = []
let tslibChecked = 0
for (const f of npmJs) {
  if (!/["']tslib["']/.test(readFileSync(f, 'utf8'))) continue
  tslibChecked += 1
  if (!existsSync(join(dirname(f), 'tslib.js'))) {
    tslibMissing.push(f.replace(DIST + '/', ''))
  }
}
console.log(`\n[自检] tslib 隐式依赖：${tslibChecked} 个文件引用它`)
if (tslibChecked === 0) {
  console.log('    ⚠ 没有任何文件引用 tslib —— 若 tdesign 版本仍是 >=1.9.0，说明本项校验已失效，请人工确认')
} else if (tslibMissing.length) {
  fail += 1
  console.log(`    ✗ ${tslibMissing.length} 处所在目录缺 tslib.js：`)
  for (const m of tslibMissing) console.log('        ' + m)
  console.log('      修法：见 config/tdesign-copy.ts 的 TSLIB_SHIM_REL 与 config/tdesign-tslib-shim.js')
} else {
  console.log('    ✓ 每个引用 tslib 的目录里都有 tslib.js')
}

// ── 6. 产物里不应出现的联调地址（P0-4） ──
const jsFiles = files.filter((f) => f.endsWith('.js'))
const localhostHits = []
for (const f of jsFiles) {
  const t = readFileSync(f, 'utf8')
  if (/127\.0\.0\.1:\d+|localhost:\d+/.test(t)) localhostHits.push(f.replace(DIST + '/', ''))
}
console.log('\n[自检] 联调地址检查（P0-4）：')
if (localhostHits.length) {
  console.log(`    ⚠ 以下产物内联了本机地址，真机会连不上：${localhostHits.join(', ')}`)
  console.log('      正式出包请用 scripts/build-weapp-prod.sh https://api.<域名>/api/v1')
} else {
  console.log('    ✓ 未发现 127.0.0.1 / localhost 内联地址')
}

// ── 7. 跨端隔离：微信产物里不得出现抖音端的代码 ──
// 平台适配层刻意拆成 src/platform/impl.weapp.ts / impl.tt.ts，由 Taro 的
// MultiPlatformPlugin 按 TARO_ENV 解析 ⇒ 另一端那份**根本不会进本端产物**。
// 这条断言守的就是它：既防止包体积被另一端代码吃掉，也防止「一端包里出现另一端的
// 代码 / 字样」这类平台审核风险（凸先生明确要求过的那一点）。
//
// 第一项（金丝雀）是硬断言：impl.tt.ts 把 TT_IMPL_CANARY 插值进了运行时错误消息，
// 所以只要那份文件进了图，这个串就一定在产物里 —— 不会被压缩器当死代码删掉。
// 第二项（兜底退化）防的是另一种失效：Taro 若没解析到 impl.weapp.ts，会落到
// src/platform/impl.ts 兜底文件（该文件在模块顶层直接抛错），产物里就会出现它的标记。
const TT_CANARY = 'platform-impl-canary:tt' // 必须与 src/platform/impl.tt.ts 的 TT_IMPL_CANARY 一致
const FALLBACK_MARKER = 'platform-impl-missing:' // src/platform/impl.ts 兜底标记
const ttLeaks = []
const fallbackLeaks = []
for (const f of jsFiles) {
  const t = readFileSync(f, 'utf8')
  if (t.includes(TT_CANARY)) ttLeaks.push(f.replace(DIST + '/', ''))
  if (t.includes(FALLBACK_MARKER)) fallbackLeaks.push(f.replace(DIST + '/', ''))
}
console.log('\n[自检] 跨端隔离：')
if (ttLeaks.length) {
  fail += 1
  console.log(`    ✗ 微信产物里出现了抖音端代码（金丝雀 ${TT_CANARY}）：${ttLeaks.join(', ')}`)
  console.log('      修法：端差异必须走 src/platform/impl.<端>.ts，不要在公共代码里写 if (IS_DOUYIN) ——')
  console.log('            那会把两端的代码和字样一起编进同一个包。约定见 docs/12-多端架构约定.md')
}
if (fallbackLeaks.length) {
  fail += 1
  console.log(`    ✗ 适配层退化到兜底文件（${FALLBACK_MARKER}）：${fallbackLeaks.join(', ')}`)
  console.log('      修法：确认 src/platform/impl.weapp.ts 存在且被正确解析（见 src/platform/index.ts 顶部说明）')
}
if (!ttLeaks.length && !fallbackLeaks.length) {
  console.log('    ✓ 无另一端代码，适配层未退化')
}

console.log(`\n${fail === 0 ? '★ 自检通过' : `★ 自检失败（${fail} 项）`}`)
process.exit(fail === 0 ? 0 : 1)
