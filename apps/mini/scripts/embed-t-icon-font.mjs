#!/usr/bin/env node
/**
 * 把 TDesign 图标字体内嵌进产物（base64），彻底去掉对远程字体的依赖。
 *
 * ── 为什么必须做 ────────────────────────────────────────────────
 * `node_modules/tdesign-miniprogram/miniprogram_dist/icon/icon.wxss` 里只有：
 *   @font-face{font-family:t;src:url(https://tdesign.gtimg.com/icon/0.4.3/fonts/t.eot),
 *     ..., url(...t.woff), url(...t.ttf), url(...t.svg);}
 * **没有一个 base64**。而微信小程序不允许从 CDN 加载字体
 * （官方：不支持 ttf/woff/eot 本地文件，但支持 base64；远程字体域还须在
 * downloadFile 合法域名里），所以真机上 `t-icon` 的元素在、占位在、**字形是空的**，
 * 而且不报错。开发者工具不受这条限制 ⇒ 典型症状是「工具里好好的、真机上没有」。
 * 用户 2026-10-23 连报三次（流量型的云图标、菜品行右箭头、别处的图），同一个根因。
 *
 * ── 为什么是「改产物」而不是「改源码样式」 ──────────────────────
 * `icon.wxss` 是**组件**样式，后于 `app.wxss` 加载；它里面
 * `.t-icon{font-family:t!important}` 作用在组件内部节点上（默认 styleIsolation
 * 是 isolated，app.wxss 根本进不去）。所以在 `app.scss` 里再声明一份同 family 的
 * @font-face **抢不过**它。唯一稳的做法是就地把那份 @font-face 的 src 换掉：
 * family 名不动（还是 `t`）、码位不动（同版本 0.4.3 的 icon.wxss），只把
 * 「远程 4 个 URL」换成本地子集的 base64。
 *
 * ── 守护 ────────────────────────────────────────────────────────
 *  1. 扫 `src/**` 里所有用到图标名的位置（`<t-icon name='x'>`、`name={"x"}` 字面量、
 *     以及 `icon: 'x'` 这种动态取值的来源数组）；**出现子集里没有的名字就报错退出**
 *     —— 否则那个图标在真机上就是空白，谁也不知道为什么。
 *  2. 改完再读一遍，断言文件里**不再含 `tdesign.gtimg.com`**。
 *
 * 子集只有 16 个字形／3.4KB（base64 约 4.5KB）。新增图标时跑
 *   cd apps/mini && python3 scripts/build-t-icon-subset.py
 * 重新生成 `src/assets/fonts/t-icon-subset.{woff,json}`。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const MINI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(MINI_ROOT, 'src')
const DIST_WXSS = join(
  MINI_ROOT,
  'dist/weapp/npm/tdesign-miniprogram/icon/icon.wxss',
)
const FONT_WOFF = join(MINI_ROOT, 'src/assets/fonts/t-icon-subset.woff')
const MANIFEST = join(MINI_ROOT, 'src/assets/fonts/t-icon-subset.json')

/** 微信 toast 的 icon 取值，不是 tdesign 图标名 */
const TOAST_ICONS = new Set(['none', 'success', 'error', 'loading', 'fail', 'exception'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p)
  }
  return out
}

/** src 里出现过的所有图标名 —— 宁可多要一个字形，也不要漏一个变成空白 */
function usedIconNames(known) {
  const used = new Map() // name -> 首次出现的位置
  const note = (name, file, line) => {
    if (!used.has(name)) used.set(name, `${relative(MINI_ROOT, file)}:${line}`)
  }
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      // <t-icon name='x'  /  name="x"
      for (const m of line.matchAll(/<t-icon[^>]*?\bname=(['"])([a-z0-9-]+)\1/g)) {
        note(m[2], file, i + 1)
      }
      // icon: 'x'（swipe-actions 的 actions、services/tutorial.ts 的分类表都是这种）
      for (const m of line.matchAll(/\bicon:\s*'([a-z][a-z0-9-]*)'/g)) {
        if (!TOAST_ICONS.has(m[1])) note(m[1], file, i + 1)
      }
      // name={'x'}/{"x"} 这种把字面量塞进表达式的写法
      for (const m of line.matchAll(/<t-icon[^>]*?\bname=\{\s*(['"])([a-z0-9-]+)\1\s*\}/g)) {
        note(m[2], file, i + 1)
      }
    })
  }
  const missing = [...used].filter(([n]) => !(n in known))
  return { used, missing }
}

function main() {
  if (!existsSync(FONT_WOFF) || !existsSync(MANIFEST)) {
    console.error('✗ 缺少 src/assets/fonts/t-icon-subset.{woff,json}')
    console.error('  先跑：cd apps/mini && python3 scripts/build-t-icon-subset.py')
    process.exit(1)
  }
  if (!existsSync(DIST_WXSS)) {
    console.error(`✗ 找不到 ${relative(MINI_ROOT, DIST_WXSS)} —— 先跑 taro build --type weapp`)
    process.exit(1)
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const known = manifest.glyphs ?? {}

  // ── 守护 1：用到但子集里没有的图标名 ──────────────────────────
  const { used, missing } = usedIconNames(known)
  if (missing.length) {
    console.error('✗ 这些图标名在字体子集里没有，真机上会是空白：')
    for (const [name, where] of missing) console.error(`    ${name}  （${where} 首次出现）`)
    console.error('  处理：把名字加进 scripts/build-t-icon-subset.py 的 NAMES，重跑它，再重新出包。')
    process.exit(1)
  }

  // ── 内嵌：把 @font-face 的 src 换成本地子集 base64 ────────────
  const base64 = readFileSync(FONT_WOFF).toString('base64')
  const css = readFileSync(DIST_WXSS, 'utf8')
  const face = css.match(/@font-face\{[^}]*\}/)
  if (!face) {
    console.error(`✗ ${relative(MINI_ROOT, DIST_WXSS)} 里没有 @font-face —— TDesign 版本变了，需重新核对`)
    process.exit(1)
  }
  // ★ data URI 里不要加 `;charset=utf-8`：这是二进制 woff，带上 charset 只会让
  //   某些 WebView 按文本解码，反而多一个可能失败的环节。
  const patched = `@font-face{font-family:t;src:url(data:font/woff;base64,${base64}) format('woff');font-weight:400;font-style:normal;}`
  const next = css.replace(face[0], patched)

  // ── 守护 2：改完不许再有远程字体地址 ──────────────────────────
  if (next.includes('tdesign.gtimg.com')) {
    console.error('✗ 替换后仍残留 tdesign.gtimg.com（可能有第二处 @font-face）')
    process.exit(1)
  }
  writeFileSync(DIST_WXSS, next)

  console.log(
    `✓ 图标字体内嵌完成：${Object.keys(known).length} 个字形 / ${readFileSync(FONT_WOFF).length} 字节` +
      `（base64 ${base64.length} 字节，已写入 ${relative(MINI_ROOT, DIST_WXSS)}）`,
  )
  console.log(`  源码里实际用到 ${used.size} 个图标名，全部命中`)
}

main()
