// 按需拷贝 tdesign-miniprogram 组件（P0-3 主包体积治理）
//
// 背景：原配置把整个 miniprogram_dist（104 个组件目录、1.43MB）拷进 dist/weapp/npm/，
//       而全项目实际只注册了 7 个 t-* 组件 → 直接吃掉主包 2MB 配额的一大半。
//
// 做法：以 src/app.config.ts 里注册的 t-* 为入口，沿真实的引用关系算出**传递闭包**，
//       只拷必要目录。注册新组件时无需改这里，拷贝范围会自动跟着走。
//
// 为什么不能手工维护一份目录清单 —— tdesign 的产物是压缩代码，引用形式很分散：
//   1. JS 里 `from"../common/src/index"`：from 与引号之间**没有空格**，容易漏
//   2. WXSS 里 `@import '../common/style/index.wxss'`
//   3. JSON 里 `usingComponents: {"t-loading": "../loading/loading"}` ← 最隐蔽：
//      我们没用 loading，但 button 会依赖它；只拷 7 个目录会直接白屏
//   4. WXML 里 `<import src="...">` / `<include src="...">`
// 所以这里机械解析四类引用，而不是凭经验列目录。
//
// 独立排查工具：`node scripts/tdesign-closure.mjs`（打印闭包与可排除项）
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'

const DIST_REL = 'node_modules/tdesign-miniprogram/miniprogram_dist'
const APP_CONFIG_REL = 'src/app.config.ts'
const EXT_CANDIDATES = ['', '.js', '.json', '.wxml', '.wxss', '.wxs', '.ts']

/** 从 src/app.config.ts 里抽出 `'t-xxx': 'tdesign-miniprogram/<comp>/<comp>'` 的组件名 */
function readRegisteredComponents(cwd: string): string[] {
  const p = join(cwd, APP_CONFIG_REL)
  if (!existsSync(p)) return []
  const text = readFileSync(p, 'utf8')
  const names = new Set<string>()
  const re = /['"]tdesign-miniprogram\/([a-z0-9-]+)\//g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) names.add(m[1])
  return [...names].sort()
}

function resolveTarget(fromAbs: string, spec: string): string | null {
  const raw = resolve(dirname(fromAbs), spec)
  if (existsSync(raw)) {
    if (statSync(raw).isDirectory()) {
      const base = raw.split(sep).pop() as string
      for (const c of [`${base}.js`, 'index.js']) if (existsSync(join(raw, c))) return join(raw, c)
      return null
    }
    if (statSync(raw).isFile()) return raw
  }
  for (const ext of EXT_CANDIDATES) if (ext && existsSync(raw + ext)) return raw + ext
  return null
}

export interface ClosureResult {
  needed: string[]
  excluded: string[]
  unresolved: string[]
  components: string[]
}

/** 计算组件及其依赖涉及的顶层目录集合 */
export function computeTdesignClosure(cwd: string): ClosureResult {
  const DIST = join(cwd, DIST_REL)
  const components = readRegisteredComponents(cwd)
  const seen = new Set<string>()
  const needed = new Set<string>()
  const unresolved = new Set<string>()

  function walk(relPath: string): void {
    if (seen.has(relPath)) return
    seen.add(relPath)
    const abs = join(DIST, relPath)
    if (!existsSync(abs) || !statSync(abs).isFile()) return
    needed.add(relPath.split(sep)[0])

    const text = readFileSync(abs, 'utf8')
    const specs: string[] = []
    if (/\.(js|wxs|ts)$/.test(relPath)) {
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
        const j = JSON.parse(text) as { usingComponents?: Record<string, string> }
        for (const v of Object.values(j.usingComponents ?? {})) if (typeof v === 'string') specs.push(v)
      } catch {
        for (const m of text.matchAll(/"usingComponents"\s*:\s*\{([^}]*)\}/g)) {
          for (const mm of m[1].matchAll(/:\s*(['"])([^'"]+)\1/g)) specs.push(mm[2])
        }
      }
    }

    for (const spec of specs) {
      if (!spec.startsWith('.')) continue
      const target = resolveTarget(abs, spec)
      if (!target) {
        unresolved.add(`${relPath} → ${spec}`)
        continue
      }
      const rel = relative(DIST, target)
      if (rel.startsWith('..')) continue
      walk(rel)
    }
  }

  for (const name of components) {
    const entry = [`${name}/${name}.js`, `${name}/index.js`].find((c) => existsSync(join(DIST, c)))
    if (!entry) {
      unresolved.add(`组件入口缺失: ${name}`)
      continue
    }
    walk(entry)
    for (const side of [`${name}/${name}.json`, `${name}/${name}.wxml`, `${name}/${name}.wxss`]) {
      if (existsSync(join(DIST, side))) walk(side)
    }
  }

  const allTops = existsSync(DIST)
    ? readdirSync(DIST, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : []

  return {
    needed: [...needed].sort(),
    excluded: allTops.filter((d) => !needed.has(d)).sort(),
    unresolved: [...unresolved].sort(),
    components,
  }
}

/** 目录字节数（用于构建日志里报「省了多少」） */
function dirSize(p: string): number {
  if (!existsSync(p)) return 0
  let total = 0
  const stack = [p]
  while (stack.length) {
    const cur = stack.pop() as string
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const child = join(cur, e.name)
      if (e.isDirectory()) stack.push(child)
      else if (e.isFile()) total += statSync(child).size
    }
  }
  return total
}

function fmt(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)}MB` : `${(bytes / 1024).toFixed(0)}KB`
}

export interface CopyPattern {
  from: string
  to: string
  ignore?: string[]
}

// ────────────────────────────────────────────────────────────────
// tslib：tdesign 的隐式外部依赖
//
// tdesign-miniprogram >= 1.9.0 的产物里有 `import{__decorate}from"tslib"`，
// 但它 package.json 未声明任何 dependencies（官方 issue #3697），
// 所以上面的传递闭包**永远拷不到 tslib**（闭包只处理 `.` 开头的相对引用），
// 运行时报 `module 'npm/tdesign-miniprogram/button/tslib.js' is not defined`。
//
// 微信对 `npm/` 下的裸模块名会退回**相对当前文件**解析，所以 shim 必须落到
// **每个引用 tslib 的组件目录**里。整份 tslib.js 23KB × 11 目录 = 253KB 会顶爆
// 主包配额，故用 config/tdesign-tslib-shim.js（只含实际用到的 helper，约 2KB）。
// ────────────────────────────────────────────────────────────────
const TSLIB_SHIM_REL = 'config/tdesign-tslib-shim.js'

/** shim 里实际导出的 helper —— 必须与 config/tdesign-tslib-shim.js 末尾的 exports 一致 */
const TSLIB_SHIM_EXPORTS = ['__awaiter', '__decorate', '__rest']

export interface TslibUsage {
  /** 引用 tslib 的目录（相对 tdesign-miniprogram/），已排序 */
  dirs: string[]
  /** 实际用到的 helper 名 */
  helpers: string[]
}

/**
 * 扫描闭包内所有 .js，收集 tslib 的引用位置与实际用到的 helper。
 * 用于 ① 决定把 shim 拷到哪些目录 ② 校验 shim 是否覆盖了全部 helper。
 */
export function collectTslibUsage(distRoot: string, needed: string[]): TslibUsage {
  const dirs = new Set<string>()
  const helpers = new Set<string>()

  for (const top of needed) {
    const stack = [top]
    while (stack.length) {
      const rel = stack.pop() as string
      const abs = join(distRoot, rel)
      if (!existsSync(abs)) continue
      if (statSync(abs).isDirectory()) {
        for (const e of readdirSync(abs, { withFileTypes: true })) stack.push(`${rel}/${e.name}`)
        continue
      }
      if (!rel.endsWith('.js')) continue

      const text = readFileSync(abs, 'utf8')
      if (!/["']tslib["']/.test(text)) continue

      const dir = rel.split('/').slice(0, -1).join('/')
      if (dir) dirs.add(dir)

      // import { a, b } from "tslib" —— 产物里 from 与引号之间无空格
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']tslib["']/g)) {
        for (const raw of m[1].split(',')) {
          const name = raw.trim().split(/\s+as\s+/)[0].trim()
          if (name) helpers.add(name)
        }
      }
      // 整体引入（require("tslib") / import * as tslib）—— 无法静态确定用了哪些
      if (/require\s*\(\s*["']tslib["']\s*\)|import\s*\*\s*as\s+\w+\s*from\s*["']tslib["']/.test(text)) {
        helpers.add('*')
      }
    }
  }

  return { dirs: [...dirs].sort(), helpers: [...helpers].sort() }
}

/**
 * 生成 Taro copy 规则：只拷闭包内的组件目录。
 * 若解析出现未决引用，直接抛错中断构建 —— 宁可构建失败，也不要出一个白屏的包。
 */
export function buildTdesignCopyPatterns(cwd: string, taroEnv: string | undefined): CopyPattern[] {
  const env = taroEnv ?? 'weapp'
  const r = computeTdesignClosure(cwd)

  if (r.components.length === 0) {
    console.warn('[tdesign] src/app.config.ts 里没有找到 tdesign-miniprogram 组件注册，跳过拷贝')
    return []
  }
  if (r.unresolved.length > 0) {
    throw new Error(
      `[tdesign] 组件依赖解析失败，无法安全裁剪：\n  ${r.unresolved.join('\n  ')}\n` +
        '请检查 tdesign-miniprogram 版本是否变化，或用 node scripts/tdesign-closure.mjs 排查。',
    )
  }

  const distRoot = join(cwd, DIST_REL)
  const keptBytes = dirSize(join(distRoot, '.')) - r.excluded.reduce((s, d) => s + dirSize(join(distRoot, d)), 0)

  // ── tslib shim：补齐 tdesign 未声明的隐式依赖，见本文件顶部的说明 ──
  const usage = collectTslibUsage(distRoot, r.needed)
  const shimPath = join(cwd, TSLIB_SHIM_REL)
  if (usage.dirs.length > 0 && !existsSync(shimPath)) {
    throw new Error(
      `[tdesign] tdesign 产物引用了 tslib，但找不到 shim：${TSLIB_SHIM_REL}\n` +
        '该文件用于补齐 tdesign 未声明的隐式依赖，缺失会导致小程序运行时白屏。',
    )
  }
  const uncovered = usage.helpers.filter((h) => !TSLIB_SHIM_EXPORTS.includes(h))
  if (uncovered.length > 0) {
    throw new Error(
      `[tdesign] tslib shim 未覆盖以下 helper：${uncovered.join(', ')}\n` +
        `  tdesign 实际用到：${usage.helpers.join(', ') || '(无)'}\n` +
        `  shim 已提供：${TSLIB_SHIM_EXPORTS.join(', ')}\n` +
        '多半是 tdesign-miniprogram 升级引入了新的 helper（`*` 表示整体引入、无法静态判断）。\n' +
        `修法：从 node_modules/tslib/tslib.js 取出对应实现补进 ${TSLIB_SHIM_REL}，` +
        '并同步更新 config/tdesign-copy.ts 里的 TSLIB_SHIM_EXPORTS。',
    )
  }

  const tslibFullBytes = (() => {
    const p = join(cwd, 'node_modules/tslib/tslib.js')
    return existsSync(p) ? statSync(p).size : 0
  })()

  console.log(
    `[tdesign] 按需拷贝：注册 ${r.components.length} 个组件 → 保留 ${r.needed.length} 个目录` +
      `（${r.needed.join(', ')}），排除 ${r.excluded.length} 个，npm 体积约 ${fmt(keptBytes)}`,
  )
  if (usage.dirs.length > 0) {
    const shimBytes = statSync(shimPath).size
    console.log(
      `[tdesign] tslib shim：${usage.helpers.join('/')} → 拷到 ${usage.dirs.length} 个目录` +
        `（${fmt(shimBytes * usage.dirs.length)}；若整拷 tslib.js 需 ${fmt(tslibFullBytes * usage.dirs.length)}）`,
    )
  }

  return [
    ...r.needed.map((dir) => ({
      from: `node_modules/tdesign-miniprogram/miniprogram_dist/${dir}/`,
      to: `dist/${env}/npm/tdesign-miniprogram/${dir}/`,
      // 注意：这里必须用 `**/*.d.ts` 而不是 `*.d.ts`。
      // 原来的 `*.d.ts` 只能匹配 from 目录的直属文件，子目录里的类型声明会照拷进来 ——
      // 实测残留 69 个 .d.ts、46.4KB。类型声明在小程序产物里毫无用处。
      ignore: ['**/*.d.ts', '**/*.md'],
    })),
    ...usage.dirs.map((dir) => ({
      from: TSLIB_SHIM_REL,
      to: `dist/${env}/npm/tdesign-miniprogram/${dir}/tslib.js`,
    })),
  ]
}

/** 供构建后自检：把未决引用暴露出去 */
export function tdesignClosureReport(cwd: string): string {
  const r = computeTdesignClosure(cwd)
  return `入口组件(${r.components.length}): ${r.components.join(', ')}\n保留目录(${r.needed.length}): ${r.needed.join(', ')}\n排除目录(${r.excluded.length})`
}
