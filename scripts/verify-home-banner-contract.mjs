// 首页口号图（后台可上传替换）的**跨端契约**守卫。
//
// 为什么需要它：这个功能靠一串**字符串**把三个 app 串起来 —— 配置项的 groupKey/settingKey、
// 上传接口的路径、内置默认图的地址。它们之间没有任何类型约束，**漂了也不会报错**：
//   · 后台把值写进 `home.sloganBanner`，小程序却在找 `home.sloganBannerUrl` ⇒ 运营保存成功、
//     小程序永远显示内置图，两边日志都是干净的；
//   · 后台传到 `/uploads/slogan-banner-image`，服务端注册的是别的路径 ⇒ 404；
//   · 内置图换了文件名（换图必须换文件名，见 upload-static-assets.mjs），
//     只改了小程序、没改后台的预览常量 ⇒ 后台给运营看的是**已经不生效的旧图**。
// 三条都属于「只有人眼盯才可能发现」的那类，所以用脚本钉住。
//
// 用法：node scripts/verify-home-banner-contract.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const errors = []
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    errors.push(`${label}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

/** 从源码里抠一个字面量的值（只用于「两边必须一致」这类比对，不做通用解析） */
const literal = (src, re) => re.exec(src)?.[1]

console.log('首页口号图契约：')

// ── 1. 配置项：seed 建的行 与 后台页写的行 必须是同一行 ──
const seed = read('server/prisma/seed.ts')
check(
  "seed 建了 groupKey='home' / settingKey='sloganBanner' 的配置行",
  /groupKey:\s*'home',\s*\n\s*settingKey:\s*'sloganBanner'/.test(seed) ||
    /settingKey:\s*'sloganBanner',\s*\n[\s\S]{0,200}?groupKey:\s*'home'/.test(seed),
  '没找到（小程序读不到任何配置，会一直用内置图）',
)
check('seed 里这一项是公开的（isPublic: true，小程序免登录拉取）',
  /settingKey:\s*'sloganBanner'[\s\S]{0,600}?isPublic:\s*true/.test(seed))
check('seed 里这一项是 STRING 类型（值就是地址，不用二次 parse）',
  /settingKey:\s*'sloganBanner'[\s\S]{0,600}?valueType:\s*'STRING'/.test(seed),
  'valueType 改了的话小程序侧要跟着改读取方式')

const adminPage = read('apps/admin/src/pages/HomeSloganBanner.tsx')
check("后台页 GROUP_KEY = 'home'", literal(adminPage, /const GROUP_KEY = '([^']+)'/) === 'home')
check("后台页 SETTING_KEY = 'sloganBanner'",
  literal(adminPage, /const SETTING_KEY = '([^']+)'/) === 'sloganBanner',
  '与 seed / 小程序不一致时，运营保存的是另一行，小程序看不到')

// ── 2. 上传接口：服务端注册的路径 与 后台请求的路径 ──
const adminRoute = read('server/src/routes/admin.ts')
const routePath = literal(adminRoute, /path:\s*'(\/uploads\/slogan-banner-image)'/)
check("服务端注册了 /uploads/slogan-banner-image", !!routePath)
check('后台页请求的就是这个路径',
  adminPage.includes(`url: '${routePath ?? '/uploads/slogan-banner-image'}'`))

// ── 3. 对象键前缀：必须是 static/ 下（GC 不扫、且匿名可读是设计的一部分）──
const assetSvc = read('server/src/services/public-asset.service.ts')
const prefix = literal(assetSvc, /const SLOGAN_BANNER_KEY_PREFIX = '([^']+)'/)
check('口号图前缀在 static/ 下（GC 扫描范围之外，不会被当孤儿删掉）',
  !!prefix && prefix.startsWith('static/'), `当前 ${prefix}`)
const localStorage = read('server/src/lib/local-storage.ts')
check('该前缀在本地存储白名单内（本地模式上传不会抛「键前缀无效」）',
  !!prefix && /const ALLOWED_PREFIXES = \[([^\]]+)\]/.exec(localStorage)?.[1]
    .split(',').map((s) => s.trim().replace(/['"]/g, '')).some((p) => prefix.startsWith(p)))

// ── 4. 内置默认图：小程序真正在用的那张 与 后台给运营看的预览 必须同一张 ──
const staticAssets = read('apps/mini/src/constants/static-assets.ts')
const miniDefault = literal(staticAssets, /HOME_SLOGAN_BANNER_V\d+ = '([^']+)'/)
check('小程序 constants 里有口号图常量（由 assets:upload 生成）', !!miniDefault, '没找到 HOME_SLOGAN_BANNER_Vn')
const adminBuiltin = literal(adminPage, /const BUILTIN_IMAGE =\s*\n?\s*'([^']+)'/)
check('后台预览常量 = 小程序在用的那张', !!miniDefault && miniDefault === adminBuiltin,
  `后台 ${adminBuiltin} ≠ 小程序 ${miniDefault}（换图换文件名后最容易漏这里）`)

// ── 5. 小程序侧：读的键名、以及「取不到就回内置图」的兜底 ──
const homeSvc = read('apps/mini/src/services/home.ts')
check("小程序读的是 home 组的 sloganBanner",
  /find\(\(i\) => i\.key === 'sloganBanner'\)/.test(homeSvc),
  '键名与后台/seed 不一致')
check('小程序默认值直接取生成的常量（不把地址抄一份写死）',
  /DEFAULT_SLOGAN_BANNER = HOME_SLOGAN_BANNER_V\d+/.test(homeSvc))
check('小程序对非 http(s) 值会回退内置图（<Image src> 收到别的只会白图）',
  /isHttpUrl\(banner\) \? banner : DEFAULT_SLOGAN_BANNER/.test(homeSvc))
check('小程序拉取失败时也回退内置图',
  /catch \{[\s\S]{0,200}?sloganBanner: DEFAULT_SLOGAN_BANNER/.test(homeSvc))

// ── 6. 页面确实用了这个 state（不是把常量直接写进 <Image src>）──
const homePage = read('apps/mini/src/pages/home/index.tsx')
check('首页 <Image src> 用的是后台配置解析出来的值',
  /src=\{sloganBanner\}/.test(homePage),
  '页面直接引用常量的话，后台怎么传都不会生效')

console.log('')
if (errors.length) {
  console.error(`✗ 契约守卫失败（${errors.length} 项）：`)
  for (const e of errors) console.error(`   · ${e}`)
  process.exit(1)
}
console.log('★ 首页口号图契约一致（seed / 服务端路由 / 后台页 / 小程序四处对齐）')
