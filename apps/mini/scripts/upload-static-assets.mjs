// 把小程序里「本来被打进代码包」的展示图上传到 COS，改成 CDN 直链。
//
// 为什么需要它：
//   微信「代码质量」有条建议项 —— 包内图片/音频合计超过 200K 就该上 CDN。
//   更重要的是：这些图**根本不该进包**（静态展示图不需要跟版本走，也不占 2MB 上限的额度）。
//
// ★ 为什么是 public-read 而不是签名 URL：
//   服务端媒资走的是 `getObjectUrl({Sign:true})`，1 小时过期 —— 那是给商家上传的
//   私密素材用的。静态展示图如果用签名 URL，用户下次打开就 403 了。
//   所以这里对**每个对象单独**设 `ACL: public-read`，
//   不动桶级权限（桶里还有商家上传的菜品图、人设图、成片，绝不能整桶放开）。
//
// ★ 为什么不用 `static/` 前缀的桶策略：对象级 ACL 已是更小粒度的授权，
//   且回滚只需对单个对象改回 private，不用碰策略文档。
//
// 用法：
//   node scripts/upload-static-assets.mjs            # 上传 + 重新生成 src/constants/static-assets.ts
//   node scripts/upload-static-assets.mjs --dry-run  # 只打印将要做什么
//
// COS 凭据取自 server/.env（与后端同一套），也支持用环境变量覆盖。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')          // apps/mini
const REPO_ROOT = resolve(APP_ROOT, '..', '..')
const ASSETS_DIR = join(APP_ROOT, 'src', 'assets')
const OUT_TS = join(APP_ROOT, 'src', 'constants', 'static-assets.ts')
const DRY_RUN = process.argv.includes('--dry-run')

/** 需要上 CDN 的图（相对 src/assets）。
 *
 * ★ 7 张展示图全部上 CDN，logo 与 tabBar 图标**故意留在包里**：
 *   - `app.json` 的 `tabBar.iconPath` 只接受**本地路径**，压根没法上 CDN；
 *   - `logo.png` 展示尺寸最大 64rpx(=32pt)，96px 已是 3x 屏的极限，14KB；
 *   两者合计约 32KB，离微信 200K 的建议线还差得远，
 *   而留在本地能让品牌标与 tabBar **零延迟渲染**，不用等网络。
 *
 * ★ `home/slogan-banner.png` 为什么从「本地内联的 1.2KB SVG」换成「CDN 上的 73KB PNG」：
 *   那张手绘口号图换成了一版成品海报（深色字 + 橙色描边 + 胶片带 + 半透明菜品照）。
 *   它带**透明底**且是照相级内容 ⇒ base64 内联会让包体涨 100KB 以上，
 *   而换成调色板 PNG（256 色 + tRNS，半透明保留 111 档）后只有 73KB。
 *   尺寸 1125×411（宽高比 2.737 ⇒ 卡片里展示高 248rpx），裁切基准与踩坑见
 *   `src/assets/home/README.md`「垂直构图」一节。
 */
const FILES = [
  'home/create-hero.jpg',
  'home/slogan-banner.png',
  'home/work-food.jpg',
  'home/work-education.jpg',
  'home/work-beauty.jpg',
  'home/work-service.jpg',
  'home/work-leisure.jpg',
]

const KEY_PREFIX = 'static/mini'

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/** 极简 .env 解析（与 apps/mini/config/index.ts 的同名函数保持一致的风格） */
function readEnvFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t)
    if (!m) continue
    out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

const fileEnv = readEnvFile(join(REPO_ROOT, 'server', '.env'))
const cfg = (name) => process.env[name]?.trim() || fileEnv[name]?.trim() || ''

const BUCKET = cfg('COS_BUCKET')
const REGION = cfg('COS_REGION')
const SECRET_ID = cfg('COS_SECRET_ID')
const SECRET_KEY = cfg('COS_SECRET_KEY')

const missing = Object.entries({ COS_BUCKET: BUCKET, COS_REGION: REGION, COS_SECRET_ID: SECRET_ID, COS_SECRET_KEY: SECRET_KEY })
  .filter(([, v]) => !v)
  .map(([k]) => k)
if (missing.length) {
  console.error(`✗ 缺少 COS 配置：${missing.join(', ')}（读取自 server/.env 或环境变量）`)
  process.exit(1)
}

const PUBLIC_BASE = `https://${BUCKET}.cos.${REGION}.myqcloud.com`

/** 上传 + 校验资源存在性 */
const targets = FILES.map((rel) => {
  const abs = join(ASSETS_DIR, rel)
  if (!existsSync(abs)) {
    console.error(`✗ 找不到资源：${rel}`)
    process.exit(1)
  }
  const buf = readFileSync(abs)
  const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
  const contentType = CONTENT_TYPES[ext]
  if (!contentType) {
    console.error(`✗ 未知图片类型：${rel}`)
    process.exit(1)
  }
  return {
    rel,
    key: `${KEY_PREFIX}/${rel}`,
    buf,
    contentType,
    sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
    url: `${PUBLIC_BASE}/${KEY_PREFIX}/${rel}`,
  }
})

console.log(`桶 ${BUCKET} / ${REGION}`)
console.log(`公共域名 ${PUBLIC_BASE}`)
console.log(`待上传 ${targets.length} 个文件，合计 ${(targets.reduce((s, t) => s + t.buf.length, 0) / 1024).toFixed(1)} KB\n`)

if (DRY_RUN) {
  for (const t of targets) console.log(`  [dry-run] ${t.rel.padEnd(28)} → ${t.key}  (${(t.buf.length / 1024).toFixed(1)}KB, ${t.contentType})`)
  console.log('\n（--dry-run：未实际上传，也未改写 static-assets.ts）')
  process.exit(0)
}

// ★ cos-nodejs-sdk-v5 装在 server/ 里（后端在上传下载素材时用它），
//   这个脚本住在 apps/mini/ 下，直接用 import 会解析不到。
//   所以显式从 server/package.json 的上下文里 require。
const requireFromServer = createRequire(join(REPO_ROOT, 'server', 'package.json'))
let COS
try {
  COS = requireFromServer('cos-nodejs-sdk-v5')
} catch {
  console.error('✗ 找不到 cos-nodejs-sdk-v5。先在 server/ 下 npm i（或 pnpm i）。')
  process.exit(1)
}
const client = new COS({ SecretId: SECRET_ID, SecretKey: SECRET_KEY })

for (const t of targets) {
  await new Promise((res, rej) => {
    client.putObject(
      {
        Bucket: BUCKET,
        Region: REGION,
        Key: t.key,
        Body: t.buf,
        ContentType: t.contentType,
        // 对象级公开读：不动桶权限（桶里还有商家上传的私密素材）
        ACL: 'public-read',
        // 展示图很少变；真要换图就改文件名或直接重新上传后清一次 CDN 缓存
        CacheControl: 'public, max-age=604800',
      },
      (err) => (err ? rej(err) : res()),
    )
  })
  console.log(`  ✓ 已上传 ${t.rel.padEnd(28)} → ${t.key}`)
}

// ── 匿名可读性校验：这是整件事的成败判据 ──
// 桶是私有桶，只要对象 ACL 没生效，线上就是一片裂图，而且**开发者工具里看不出来**
// （真机才会暴露）。所以上传完必须真的匿名拉一次。
console.log('\n匿名可读性校验：')
let bad = 0
for (const t of targets) {
  let status = 0
  try {
    const resp = await fetch(t.url, { method: 'GET', headers: { Range: 'bytes=0-0' } })
    status = resp.status
  } catch (err) {
    console.log(`  ✗ ${t.rel}  请求失败：${err?.message ?? err}`)
    bad += 1
    continue
  }
  const ok = status === 200 || status === 206
  if (!ok) bad += 1
  console.log(`  ${ok ? '✓' : '✗'} ${t.rel.padEnd(28)} HTTP ${status}${ok ? '' : '  ← 匿名读不到！'}`)
}

if (bad) {
  console.error(`\n✗ ${bad} 个对象匿名不可读。多半是桶开启了「阻止公共访问」，`)
  console.error('  或对象 ACL 未生效。请去 COS 控制台 → 权限管理确认，或改用桶策略只放开 static/ 前缀。')
  process.exit(1)
}

// ── 生成常量文件 ──
/** `home/work-food.jpg` → `HOME_WORK_FOOD`（目录名也进常量名，避免不同目录重名） */
const constName = (rel) =>
  rel
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()

const entries = targets.map((t) => [constName(t.rel), t.rel, t.url])
const body = `// ★ 本文件由 \`npm run assets:upload\` 生成，请勿手改。
// 生成时间依据：每次上传会重写，内容只取决于 server/.env 里的桶/区域与文件名。
//
// 为什么这些图不放在 src/assets 里：
//   它们是纯展示图，不需要跟版本走。放进代码包会同时踩两条微信「代码质量」红线 ——
//   包内图片合计超过 200K（建议项），以及白占 2MB 主包上限的额度。
//
// ⚠ 这些对象是**匿名可读**（putObject 时设了 ACL: public-read），
//   因为服务端媒资那套签名 URL 只有 1 小时有效期，不适合做静态资源。
//
// ⚠ 真机/体验版/正式版要把域名加进小程序后台的「downloadFile 合法域名」，
//   否则 image 组件会被静默拦掉（开发者工具里勾了"不校验合法域名"看不出来）。
export const STATIC_BASE_URL = '${PUBLIC_BASE}'

${entries.map(([name, , url]) => `/** ${url.slice(PUBLIC_BASE.length + 1)} */\nexport const ${name} = '${url}'`).join('\n\n')}
`

writeFileSync(OUT_TS, body, 'utf8')
console.log(`\n✓ 已重新生成 ${relative(REPO_ROOT, OUT_TS)}（${entries.length} 个常量）`)
console.log(`\n⚠ 下一步（需要你手动做一次）：`)
console.log(`   小程序后台 → 开发管理 → 开发设置 → 服务器域名 → downloadFile 合法域名`)
console.log(`   加入：${PUBLIC_BASE}`)
