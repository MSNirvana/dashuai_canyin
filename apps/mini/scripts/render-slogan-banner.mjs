// 把 slogan-banner.html（红/白/黑三色口号海报的设计源）渲染成
// src/assets/home/slogan-banner-v3.png。
//
// 为什么用代码合成而不是让模型出图：
//   这张图上唯一的**信息**是「让餐饮门店 轻松拍视频」这十个汉字和「AI」。
//   图像模型画中文会糊字/串字，而这里是产品文案 —— 一个错字就要重出图，
//   没法评审也没法 diff。用真实字体在无头 Chrome 里渲染，字是确定的，
//   改文案只是改一行 HTML，且颜色能严格锁死在红/白/黑三色。
//
// 用法：
//   node scripts/render-slogan-banner.mjs            # 渲染 + 量化，写入 src/assets
//   node scripts/render-slogan-banner.mjs --keep-rgba # 不做调色板量化（用于排错）
//
// 依赖（未随包安装，按需解析，缺失时给出可操作的报错）：
//   - puppeteer-core 与本机 Chrome：用来渲染 HTML
//   - python3 + Pillow：把全彩 RGBA PNG 量化成 256 色调色板 PNG（全彩 134KB → 调色板 17KB）。
//     缺 Pillow 时**不报错**，退化成写入全彩 PNG 并提示。
//
// ⚠ 渲染尺寸必须与画布一致，且**改图后要同步改**
//   pages/home/index.scss 里 &__slogan-image 的 height（1125/411 ⇒ 248rpx）。
// ⚠ 小程序端图片按 URL 缓存，换图要**换文件名**（见 upload-static-assets.mjs 的注释）。
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

const SRC_HTML = join(HERE, 'slogan-banner.html')
const OUT_PNG = join(APP_ROOT, 'src', 'assets', 'home', 'slogan-banner-v3.png')

const WIDTH = 1125 // = 375pt 的 3x 上限；视口与画布必须一致
const HEIGHT = 411 // 宽高比 2.737 ⇒ 卡片内宽 678rpx 时展示高 248rpx
const KEEP_RGBA = process.argv.includes('--keep-rgba')

// ── 1. 找到 puppeteer-core ──
function loadPuppeteer() {
  const require = createRequire(import.meta.url)
  const tried = []
  const candidates = [
    process.env.PUPPETEER_CORE,
    join(process.env.WORKBUDDY_NODE_WORKSPACE ?? '', 'node_modules', 'puppeteer-core'),
    '/Users/gaoyunhong/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core',
  ].filter(Boolean)
  for (const dir of candidates) {
    tried.push(dir)
    if (existsSync(dir)) return require(dir)
  }
  try {
    return require('puppeteer-core') // 万一以后进了 package.json
  } catch {
    /* 落到下面统一报错 */
  }
  console.error('✗ 找不到 puppeteer-core。任选一种：')
  console.error('  1) 在 apps/mini 下 `npm i -D puppeteer-core`；')
  console.error('  2) 用环境变量指路：PUPPETEER_CORE=/path/to/puppeteer-core')
  console.error(`  已尝试：\n    ${tried.join('\n    ')}`)
  process.exit(1)
}

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (!existsSync(CHROME)) {
  console.error(`✗ 找不到 Chrome：${CHROME}（可用 CHROME_PATH 覆盖）`)
  process.exit(1)
}

// ── 2. 渲染：固定画布 ──
// 底色由 HTML 里那层实心 `.bg`（纯白）负责，**不靠** `omitBackground` ——
// 背景是设计的一部分，写成实心块才不会随截图参数漂移。
// `omitBackground` 仍然开着：万一哪天要改成透明底，不用同时改这里。
// 用 clip 而不是 fullPage：要的是精确画布，不能被内容撑出来的高度带偏。
async function render(puppeteer, outPath) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb'],
  })
  try {
    const page = await browser.newPage()
    // deviceScaleFactor 固定 1：视口就等于画布像素，别让 DPR 悄悄放大输出
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 })
    await page.goto(pathToFileURL(SRC_HTML).href, { waitUntil: 'load', timeout: 60000 })
    // 等字体真正 ready：不等的话偶发会截到 fallback 字体
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({
      path: outPath,
      omitBackground: true,
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    })
  } finally {
    await browser.close()
  }
}

// ── 3. 量化：全彩 RGBA → 256 色调色板（134KB → 28KB） ──
// 这张图只有红/白/黑三色 + 抗锯齿过渡，256 色绰绰有余；
// dither=NONE 很关键 —— 抖动会在纯色块里撒噪点，PNG 反而变大且看得见。
function findPythonWithPillow() {
  const candidates = [
    process.env.PYTHON,
    '/Users/gaoyunhong/.workbuddy/binaries/python/versions/3.13.12/bin/python3',
    'python3',
  ].filter(Boolean)
  for (const py of candidates) {
    const probe = spawnSync(py, ['-c', 'import PIL; print(PIL.__version__)'], { encoding: 'utf8' })
    if (probe.status === 0) return { py, version: probe.stdout.trim() }
  }
  return null
}

function quantize(srcPath, dstPath) {
  const found = findPythonWithPillow()
  if (!found) {
    copyFileSync(srcPath, dstPath)
    console.warn('⚠ 没找到带 Pillow 的 python3 —— 已写入全彩 PNG（体积约 4.8 倍）。')
    console.warn('  要拿到调色板版：pip install Pillow，或用 PYTHON=/path/to/python3 指路。')
    return
  }
  const snippet = `
from PIL import Image
src = Image.open(${JSON.stringify(srcPath)}).convert('RGBA')
src.quantize(colors=256, method=Image.FASTOCTREE, dither=Image.NONE).save(${JSON.stringify(dstPath)}, optimize=True)
out = Image.open(${JSON.stringify(dstPath)})
assert out.mode == 'P', f'量化后不是调色板模式：{out.mode}'

# ★ 把设计色「吸」回调色板：FASTOCTREE 用的是聚类中心，纯白 #ffffff 会被量化成
#   (254,254,254) 这种近似值。肉眼分不出，但「纯白底」是明确要求，也是可验证的判据，
#   不能靠「差不多白」交付。只改**最接近该设计色**的那一个表项，抗锯齿的过渡色不动。
DESIGN_COLORS = [(255, 255, 255), (225, 37, 27), (23, 24, 26)]  # 白 / 品牌红 #e1251b / 黑 #17181a
pal = out.getpalette()
for target in DESIGN_COLORS:
    best, bestd = None, 10 ** 9
    for i in range(256):
        d = sum((pal[i * 3 + k] - target[k]) ** 2 for k in range(3))
        if d < bestd:
            bestd, best = d, i
    before = tuple(pal[best * 3:best * 3 + 3])
    pal[best * 3:best * 3 + 3] = list(target)
    print(f'  调色板[{best}] {before} → {target}')
out.putpalette(pal)
out.save(${JSON.stringify(dstPath)}, optimize=True)
out = Image.open(${JSON.stringify(dstPath)})
# 透明度**分布**必须与源一致：既不能凭空多出透明像素，也不能把透明吃掉。
# （不要断言「必须有透明像素」——这张图底色是纯白，全不透明才是对的。）
sa = src.getchannel('A').histogram()
oa = out.convert('RGBA').getchannel('A').histogram()
tol = src.size[0] * src.size[1] * 0.005
assert abs(sa[0] - oa[0]) <= tol, f'透明度分布对不上：源全透明 {sa[0]} vs 产物 {oa[0]}'
print(f'  量化后 {out.mode} 模式，全透明像素 {oa[0]}（源 {sa[0]}），半透明档位 {sum(1 for v in oa if v)}')
`
  console.log(`· 量化（Pillow ${found.version}）`)
  console.log(execFileSync(found.py, ['-c', snippet], { encoding: 'utf8' }).trimEnd())
}

// ── 主流程 ──
if (!existsSync(SRC_HTML)) {
  console.error(`✗ 找不到设计源：${SRC_HTML}`)
  process.exit(1)
}

const tmp = mkdtempSync(join(tmpdir(), 'slogan-banner-'))
const rawPng = join(tmp, 'raw.png')
try {
  console.log(`· 渲染 ${WIDTH}×${HEIGHT}（纯白底，见 HTML 的 .bg）`)
  await render(loadPuppeteer(), rawPng)
  if (KEEP_RGBA) {
    copyFileSync(rawPng, OUT_PNG)
  } else {
    quantize(rawPng, OUT_PNG)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

const bytes = statSync(OUT_PNG).size
console.log(`✓ 已写入 src/assets/home/slogan-banner-v3.png（${(bytes / 1024).toFixed(1)} KB）`)
console.log('')
console.log('下一步（换图必做，缺一不可）：')
console.log('  1. npm run assets:upload        # 传 CDN 并重生成 src/constants/static-assets.ts')
console.log('  2. npm run typecheck && npm run build:weapp:dev')
console.log('  ⚠ 文件名带 v3 是为了击穿小程序与 CDN 的图片缓存，不是版本管理；')
console.log('     换图请再换一次文件名，并同步 FILES 列表 / 页面引用 / index.scss 的高度。')
