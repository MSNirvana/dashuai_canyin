// 计算 tdesign-miniprogram 指定组件的传递闭包（顶层目录集合）
//
// 为什么要机械计算而不是手工列：
//   tdesign 的 miniprogram_dist 是压缩产物，引用形式很分散，人工很容易漏：
//     1. JS 里 `from"../common/src/index"` —— from 和引号之间**没有空格**
//     2. WXSS 里 `@import '../common/style/index.wxss'`
//     3. JSON 里 `usingComponents: {"t-loading": "../loading/loading"}` ← 最隐蔽，
//        button 会依赖 loading，而 loading 不在 app.config.ts 的 7 个里
//     4. WXML 里 `<import src="...">` / `<include src="...">`
//
// 用法：node scripts/tdesign-closure.mjs [组件名...]
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'

const DIST = 'node_modules/tdesign-miniprogram/miniprogram_dist'
const ENTRIES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['button', 'input', 'cell', 'cell-group', 'toast', 'dialog', 'icon']

const EXT_CANDIDATES = ['', '.js', '.json', '.wxml', '.wxss', '.wxs', '.ts']
const seen = new Set()
const needed = new Set()
const unresolved = new Set()

/** 把引用路径解析成 dist 内的相对文件路径；解析不出返回 null */
function resolveTarget(fromAbs, spec) {
  const raw = resolve(dirname(fromAbs), spec)
  if (existsSync(raw)) {
    if (statSync(raw).isDirectory()) {
      const base = raw.split(sep).pop()
      // 目录：优先 <dir>/<dir>.js，其次 index.js
      for (const c of [`${base}.js`, 'index.js']) if (existsSync(join(raw, c))) return join(raw, c)
      return null
    }
    if (statSync(raw).isFile()) return raw
  }
  for (const ext of EXT_CANDIDATES) if (ext && existsSync(raw + ext)) return raw + ext
  return null
}

function walk(relPath) {
  if (seen.has(relPath)) return
  seen.add(relPath)
  const abs = join(DIST, relPath)
  if (!existsSync(abs) || !statSync(abs).isFile()) return
  needed.add(relPath.split(sep)[0])

  const text = readFileSync(abs, 'utf8')
  const specs = []

  if (/\.(js|wxs|ts)$/.test(relPath)) {
    // from"..." / from '...' / require("...") / import"..." / export...from"..."
    for (const m of text.matchAll(/(?:from|require\s*\(|import)\s*\(?\s*(['"])([^'"]+)\1/g)) specs.push(m[2])
  }
  if (relPath.endsWith('.wxss')) {
    for (const m of text.matchAll(/@import\s+(['"])([^'"]+)\1/g)) specs.push(m[2])
  }
  if (relPath.endsWith('.wxml')) {
    for (const m of text.matchAll(/<(?:import|include|wxs)\s[^>]*src\s*=\s*(['"])([^'"]+)\1/g)) specs.push(m[2])
  }
  if (relPath.endsWith('.json')) {
    try {
      const j = JSON.parse(text)
      for (const v of Object.values(j.usingComponents ?? {})) if (typeof v === 'string') specs.push(v)
    } catch {
      // 有些 json 带注释，退回正则
      for (const m of text.matchAll(/"usingComponents"\s*:\s*\{([^}]*)\}/g)) {
        for (const mm of m[1].matchAll(/:\s*(['"])([^'"]+)\1/g)) specs.push(mm[2])
      }
    }
  }

  for (const spec of specs) {
    if (!spec.startsWith('.')) continue // 非相对路径（npm 包等）不处理
    const target = resolveTarget(abs, spec)
    if (!target) { unresolved.add(`${relPath} → ${spec}`); continue }
    const rel = relative(DIST, target)
    if (rel.startsWith('..')) continue
    walk(rel)
  }
}

for (const name of ENTRIES) {
  const entry = [`${name}/${name}.js`, `${name}/index.js`].find((c) => existsSync(join(DIST, c)))
  if (!entry) { console.error(`!! 找不到组件入口: ${name}`); continue }
  walk(entry)
  for (const side of [`${name}/${name}.json`, `${name}/${name}.wxml`, `${name}/${name}.wxss`]) {
    if (existsSync(join(DIST, side))) walk(side)
  }
}

const allTops = readdirSync(DIST, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
const excluded = allTops.filter((d) => !needed.has(d))

console.log(`入口组件: ${ENTRIES.join(', ')}`)
console.log(`\n需要保留的顶层目录（${needed.size} 个）:`)
console.log([...needed].sort().join('  '))
console.log(`\n可排除（${excluded.length} 个）:`)
console.log(excluded.sort().join('  '))
if (unresolved.size) {
  console.log(`\n⚠ 未解析的引用（${unresolved.size} 条，需人工确认）:`)
  for (const u of [...unresolved].sort()) console.log('  ' + u)
}
