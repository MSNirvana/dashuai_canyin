// 调色预览的守护断言。全是纯计算，不碰数据库、不碰对象存储、不渲染。（`npm run color-preview:verify`）
//
// 这里防的是三类**静默失效** —— 它们都不会报错，只会让功能「看起来能跑但结果是错的」：
//
//   ① 预览与成片的调色滤镜不再同源：有人给预览加了缩放 / 降帧（为了「更快」），
//      于是锐化（unsharp 是像素半径卷积）的观感与成片不一致 ⇒ 用户按预览把锐化调过头。
//   ② 归一化缓存键被改动：预览与 worker 算出的键不再相同 ⇒ 预览每次都判定缓存未命中，
//      现场把全部素材重新归一化 ⇒ 只是「预览很慢」，没有任何报错。
//   ③ 预览产物的落盘前缀与 GC 的排除前缀不再一致：预览 mp4 不在库里，
//      GC 会把它当成「未跟踪的孤儿」删掉 ⇒ 用户拿到 404 或播不了的链接。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  intermediateKey,
  normalizedClipKey,
  colorPreviewHash,
  colorPreviewKey,
  INTERMEDIATE_CACHE_VERSION,
  INTERMEDIATE_CACHE_PREFIX,
} from '../src/render/cache-keys.js'
import { buildColorFilter, buildApplyColorArgs } from '../src/render/ffmpeg.js'
import type { ColorGrade, RenderClip } from '../src/services/render.service.js'

const here = dirname(fileURLToPath(import.meta.url))

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

const OUTPUT = { width: 1080, height: 1920, fps: 30 }
const CLIP: RenderClip = {
  shotId: '77',
  assetId: '4242',
  cosKey: 'uploads/9/xxx.mp4',
  coverKey: null,
  trimStartMs: 500,
  trimEndMs: 4200,
  durationMs: 9000,
  line: '招牌菜出锅',
}
const COLOR: ColorGrade = { brightness: 10, contrast: -5, saturation: 20, sharpen: 15 }
const PREVIEW_ENCODE = { preset: 'ultrafast', crf: 32 }

// ───────────── ① 调色滤镜必须同源 ─────────────

console.log('\n① 调色滤镜：预览与成片必须逐字节相同')
{
  const finalArgs = buildApplyColorArgs('in.mp4', 'final.mp4', COLOR)
  const previewArgs = buildApplyColorArgs('in.mp4', 'preview.mp4', COLOR, PREVIEW_ENCODE)
  const vfOf = (a: string[]) => a[a.indexOf('-vf') + 1] ?? ''
  const cf = buildColorFilter(COLOR)!

  check('成片的 -vf 就是 buildColorFilter 的输出', vfOf(finalArgs) === cf, `实际 ${vfOf(finalArgs)}`)
  check('预览的 -vf 与成片完全一致', vfOf(previewArgs) === vfOf(finalArgs), `预览 ${vfOf(previewArgs)}`)

  // 「不许为了提速而改画面」——缩放/裁切/改帧率都会改变锐化的观感
  const forbidden = ['scale', 'crop']
  for (const [label, args] of [['成片', finalArgs], ['预览', previewArgs]] as const) {
    check(`-vf 存在且位置正常（${label}）`, args.includes('-vf') && vfOf(args) === cf)
    check(`不含缩放/裁切滤镜（${label}）`, !forbidden.some((f) => vfOf(args).includes(f)), vfOf(args))
    check(`不含 -s / -r 这类改分辨率或帧率的参数（${label}）`, !args.includes('-s') && !args.includes('-r'), args.join(' '))
  }

  // 编码参数确实被换掉了（否则「低码率预览」名不副实）
  check('预览确实换了编码 preset', previewArgs[previewArgs.indexOf('-preset') + 1] === 'ultrafast')
  check('预览确实换了 crf', previewArgs[previewArgs.indexOf('-crf') + 1] === '32')
  check('成片仍是 veryfast/crf23（默认值没被顺手改掉）',
    finalArgs[finalArgs.indexOf('-preset') + 1] === 'veryfast' && finalArgs[finalArgs.indexOf('-crf') + 1] === '23')
}

// ───────────── ② 归一化缓存键：格式与两侧一致性 ─────────────

console.log('\n② 归一化缓存键：预览与合成必须算出同一个键')
{
  const key = intermediateKey(CLIP, 500, 4200, OUTPUT)
  // 独立写一遍「期望的原文」，不复制实现 —— 字段顺序/分隔符变了就会失配
  const expectedRaw = `${INTERMEDIATE_CACHE_VERSION}:4242:500:4200:1080x1920`
  const expected = createHash('sha1').update(expectedRaw).digest('hex')
  check('缓存键原文格式未变（版本:assetId:起始:结束:宽x高）', key === expected, `实际 ${key}`)

  check(
    'normdizedClipKey 拼出的路径与旧的手写路径一致',
    normalizedClipKey(9n, CLIP, OUTPUT) === `${INTERMEDIATE_CACHE_PREFIX}9/${key}.mp4`,
    normalizedClipKey(9n, CLIP, OUTPUT),
  )

  // trimEndMs 为空 = 到素材结尾，必须与 worker 的 `?? 0` 同口径
  const openEnded: RenderClip = { ...CLIP, trimEndMs: null }
  check(
    'trimEndMs 为空时与 trimEndMs=0 同键（worker 就是这么写的）',
    intermediateKey(openEnded, 500, 0, OUTPUT) === intermediateKey({ ...CLIP, trimEndMs: 0 }, 500, 0, OUTPUT),
  )

  // 调色参数绝不能进这个键：否则「仅改调色重合成」会全部缓存未命中，10 积分的成本依据就没了
  check(
    '缓存键不含调色参数（改调色不影响归一化缓存）',
    intermediateKey(CLIP, 500, 4200, OUTPUT) === intermediateKey(CLIP, 500, 4200, OUTPUT) && !key.includes('brightness'),
  )
}

// ───────────── ③ 预览产物必须仍被 GC 排除 ─────────────

console.log('\n③ 预览落盘前缀：必须与 GC 的排除前缀一致（否则预览会被当孤儿删掉）')
{
  const gcSource = await readFile(join(here, 'gc-orphan-objects.ts'), 'utf8')
  const m = gcSource.match(/const\s+CACHE_PREFIX\s*=\s*'([^']+)'/)
  check('能从 GC 脚本里读到 CACHE_PREFIX', !!m, '正则没匹配到，GC 脚本可能改名了')
  if (m) {
    check(
      `预览前缀(${INTERMEDIATE_CACHE_PREFIX}) === GC 排除前缀(${m[1]})`,
      INTERMEDIATE_CACHE_PREFIX === m[1],
      '两边不一致 ⇒ 预览 mp4 不在库里、会被 GC 判为孤儿删除',
    )
  }

  const previewKey = colorPreviewKey(9n, colorPreviewHash([CLIP], OUTPUT, COLOR))
  check('预览对象键落在被排除的缓存目录下', previewKey.startsWith(INTERMEDIATE_CACHE_PREFIX), previewKey)
  check('预览对象键带商家前缀（隔离到商家目录）', previewKey.startsWith(`${INTERMEDIATE_CACHE_PREFIX}9/`), previewKey)
  check('预览对象键以 .mp4 结尾', previewKey.endsWith('.mp4'))
}

// ───────────── ④ 内容寻址：同参数同键、异参数异键 ─────────────

console.log('\n④ 内容寻址：同一组参数必须命中同一个键')
{
  const base = colorPreviewHash([CLIP], OUTPUT, COLOR)
  check('同参数两次计算结果相同', base === colorPreviewHash([CLIP], OUTPUT, COLOR))

  const axes: Array<[string, ColorGrade]> = [
    ['亮度', { ...COLOR, brightness: COLOR.brightness + 1 }],
    ['对比度', { ...COLOR, contrast: COLOR.contrast + 1 }],
    ['饱和度', { ...COLOR, saturation: COLOR.saturation + 1 }],
    ['锐化', { ...COLOR, sharpen: COLOR.sharpen + 1 }],
  ]
  for (const [label, c] of axes) {
    check(`改「${label}」⇒ 换成另一个键`, colorPreviewHash([CLIP], OUTPUT, c) !== base)
  }

  check('改输出尺寸 ⇒ 换成另一个键', colorPreviewHash([CLIP], { width: 720, height: 1280 }, COLOR) !== base)
  check('改 trim ⇒ 换成另一个键', colorPreviewHash([{ ...CLIP, trimEndMs: 3000 }], OUTPUT, COLOR) !== base)
  check('分镜顺序不同 ⇒ 换成另一个键（顺序会影响成片）',
    colorPreviewHash([CLIP, { ...CLIP, assetId: '99' }], OUTPUT, COLOR) !==
      colorPreviewHash([{ ...CLIP, assetId: '99' }, CLIP], OUTPUT, COLOR))
}

// ───────────── ⑤ 全 0 调色：应当被拦在渲染之前 ─────────────

console.log('\n⑤ 全 0 调色：必须在做任何 I/O 之前就报错')
{
  const zero: ColorGrade = { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }
  check('buildColorFilter(全0) 返回 null', buildColorFilter(zero) === null)
  let threw = false
  try {
    buildApplyColorArgs('in.mp4', 'out.mp4', zero)
  } catch {
    threw = true
  }
  check('buildApplyColorArgs(全0) 直接抛错（不产出一条无效命令）', threw)

  // 真正调用服务时也必须在 I/O 之前抛出：若实现先去查对象存储，就会卡在 objectExists 上，
  // 而不是干脆地抛 ColorPreviewNoopError。这条同时说明「全 0」的判定排在缓存探测之前。
  process.env.COLOR_PREVIEW_RATE_MAX = '3'
  const { buildColorPreview, ColorPreviewNoopError, __resetColorPreviewState } =
    await import('../src/render/preview.js')
  __resetColorPreviewState()

  let noop = false
  try {
    await buildColorPreview({ merchantId: 9n, clips: [CLIP], color: zero, output: OUTPUT })
  } catch (e) {
    noop = e instanceof ColorPreviewNoopError
    if (!noop) console.log(`      （抛的是别的错误：${(e as Error).name}: ${(e as Error).message}）`)
  }
  check('buildColorPreview(全0) 抛 ColorPreviewNoopError（未触碰存储）', noop)
  __resetColorPreviewState()
}

// ───────────── ⑥ 限流口径：只计「新计算」 ─────────────
//
// 这条只能靠读源码来守，因为「命中缓存不占名额」在纯计算层面观察不到（要真的连对象存储）。
// 防的是一处**不报错的误伤**：有人把 checkColorPreviewRate 挪回函数开头、或挪回路由层，
// 于是「用户来回滑到同一个参数」这种零成本操作也吃名额，表现为莫名 429 —— 代码看着更"安全"，
// 但用户被无谓地拒了。缓存命中只是一次 HEAD、复用 in-flight 只是等别人的结果。
console.log('\n⑥ 限流口径：只计新计算，命中缓存与复用 in-flight 不占名额')
{
  const src = await readFile(join(here, '../src/render/preview.ts'), 'utf8')
  const cacheAt = src.indexOf('await objectExists(key)')
  const inflightAt = src.indexOf('const running = inflight.get(key)')
  const rateAt = src.indexOf('checkColorPreviewRate(merchantId)')
  check('能在 preview.ts 里定位到三处关键调用（缓存探测 / in-flight 复用 / 限流）',
    cacheAt > 0 && inflightAt > 0 && rateAt > 0,
    `缓存 ${cacheAt} / in-flight ${inflightAt} / 限流 ${rateAt}`)
  check('限流排在「命中已有产物」之后 ⇒ 命中缓存不占名额', rateAt > cacheAt)
  check('限流排在「复用 in-flight」之后 ⇒ 复用不占名额', rateAt > inflightAt)

  // 路由层若也限一次，就等于按「请求数」而不是「新计算数」限流
  const routeSrc = await readFile(join(here, '../src/routes/renders.ts'), 'utf8')
  const routeCode = routeSrc
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  check('路由层不再自行限流 ⇒ 否则每个请求（含缓存命中）都占名额',
    !routeCode.includes('checkColorPreviewRate'))

  const { checkColorPreviewRate, ColorPreviewBusyError, __resetColorPreviewState } =
    await import('../src/render/preview.js')
  __resetColorPreviewState()
  let limited = false
  for (let i = 0; i < 3; i++) checkColorPreviewRate(9n)
  try {
    checkColorPreviewRate(9n)
  } catch (e) {
    limited = e instanceof ColorPreviewBusyError
  }
  check('超过窗口上限后抛 ColorPreviewBusyError', limited)
  check('限流按商家隔离（另一个商家不受影响）', (() => { try { checkColorPreviewRate(10n); return true } catch { return false } })())
  __resetColorPreviewState()
}

// ───────────── ⑦ 路由挂载：请求真的能走到这个 handler ─────────────
//
// 为什么只能读源码、不做运行时探针：auth 中间件挂在**前缀层**（`router.use(auth)`），
// 任何未带 token 的请求 —— **哪怕路径根本不存在** —— 都会先返 401。
// 实测反例：`POST /creations/1/render/preview` 与 `POST /creations/1/render/nope` 都是 401，
// 所以「curl 打一下看是不是 401」**无法**区分「路由已挂载」与「路由没挂载」。
// 与其留一个证明不了任何事的探针，不如把「注册了哪个路径 + 挂到哪个前缀」钉死。
console.log('\n⑦ 路由挂载：POST /api/v1/creations/:id/render/preview 真的会被路由到')
{
  const routeSrc = await readFile(join(here, '../src/routes/renders.ts'), 'utf8')
  check("routes/renders.ts 注册了 POST '/:id/render/preview'", routeSrc.includes("router.post('/:id/render/preview'"))
  check('该 handler 调用了 buildColorPreview', routeSrc.includes('await buildColorPreview({'))
  check('播放地址由 getGeneratedPlayUrl 签发（键是服务端自己算的，不是请求参数）',
    routeSrc.includes('getGeneratedPlayUrl(result.key'))
  check('该 handler 有订阅门槛（否则预览会变成绕开扣积分的免费取片通道）',
    routeSrc.includes("requireSubscription(prisma, merchantId, '调色预览')"))

  const entry = await readFile(join(here, '../src/index.ts'), 'utf8')
  check('入口把 renderRouter 挂在 /api/v1/creations',
    entry.includes("app.use('/api/v1/creations', renderRouter)"))
  check('同一前缀下也挂着 creationRouter（两条路由共用前缀，先后顺序不影响匹配）',
    entry.includes("app.use('/api/v1/creations', creationRouter)"))
}

console.log(`\n通过 ${pass} · 失败 ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exitCode = 1
}
