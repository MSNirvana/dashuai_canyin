/**
 * 发布封面链路的**真机体检**（会真实调用上游、真实花钱，约 ¥0.5~1 / 次）。
 *
 * ★ 与 `publish-cover:verify` 的分工：
 *   · `publish-cover:verify` 是**离线守护**（纯内存 + 读源文件）——守接线、守契约、守解析边界。
 *   · 本脚本是**在线体检** —— 守「模型到底出了什么」。
 *     它能发现守护脚本**结构上就看不见**的问题：画面被拉远/裁切、标题是贴字不是设计、
 *     中文出成错别字、耗时/token 与定价假设不符。这几类共同特点是**不报错**。
 *
 * ★★ 本脚本必须**完整复现产品路径**（2026-09-24 第三轮返工后修正）：
 *   产品不是把源帧直接交给模型，而是
 *     抽帧(640 给模型看 / 1080 当底图) → 选帧 → **本地裁成 3:4** → 图生图
 *   若体检脚本图省事把原帧直接传下去，它验的就是**另一条路**，看图结论毫无意义
 *   （上一轮正是这么验的，于是「拉扯感」被漏掉了）。
 *   所以这里直接 import 产品自己的 `buildCoverBaseDataUri` / `BASE_FRAME_WIDTH`。
 *
 * ★ 什么时候必须跑：
 *   · 改了 `PUBLISH_COVER_PROMPT` / `PUBLISH_COVER_PICK_PROMPT`（改模板 = 改产出，不看图就是盲改）
 *   · 改了 `buildCoverBase` / 抽帧宽度（改几何 = 改取景）
 *   · 改了 `ai_model.unit_price_micro_fen` 或 `publish_cover*` 的 `beanPrice`
 *   · 换了出图模型 / 中转站
 *   · 准备上线前
 *
 * 用法（在 server/ 下）：
 *   npx tsx scripts/probe-publish-cover.ts --asset 84              # ★ 最省事：直接拉本地库里的真实素材
 *   npx tsx scripts/probe-publish-cover.ts --video <真实竖拍视频>   # ★ 走产品同一路径
 *   npx tsx scripts/probe-publish-cover.ts a.jpg b.jpg c.jpg       # 指定候选帧（≥2 张才会跑选帧）
 *   npx tsx scripts/probe-publish-cover.ts                         # 用 outputs/ 里的 4 张真实抽帧
 *
 * 产物（都在 outputs/ 下）：
 *   封面体检-<ts><ext>            —— 成品封面
 *   封面体检-<ts>-底图.jpg         —— 交给模型的**本地裁好的 3:4 底图**
 *   封面体检-<ts>-并排.png         —— 左=底图 右=成品，**一眼看出取景有没有被改**
 *   ⚠ 文件模式（给几张图）没有视频可重抽 ⇒ 底图 = 那张图本身，尺寸多大就是多大，
 *     会明显偏小；要比分辨率就加 `--video`。
 */
import 'dotenv/config'
import { spawn } from 'node:child_process'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma, redis } from '../src/db.js'
import { CircuitBreaker } from '../src/ai/circuit-breaker.js'
import { AiGateway } from '../src/ai/gateway.js'
import { runBilledScene } from '../src/ai/ai.service.js'
import { SCENE } from '../src/ai/scene-codes.js'
import { extractCandidateFrames } from '../src/lib/thumbnail.js'
import { downloadToFile } from '../src/lib/cos.js'
import { fetchImageToFile } from '../src/services/remote-asset.service.js'
import {
  BASE_FRAME_WIDTH,
  buildCoverBaseDataUri,
} from '../src/services/publish-material.service.js'
import { probeClipMeta } from '../src/render/ffmpeg.js'
import { ffmpegBin } from '../src/render/ffmpeg.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const OUT_DIR = join(REPO_ROOT, 'outputs')
const MERCHANT_ID = 1n

/** 默认候选帧：仓库里现成的成片抽帧（真实菜品画面，4 张）。⚠ 它们只有 420×746，偏小 */
const DEFAULT_FRAMES = ['02s', '12s', '22s', '31s'].map((t) =>
  join(REPO_ROOT, 'outputs', `AI档成片-抽帧-${t}.jpg`),
)

/** 体检用的标题。★ 用一句**画面里没有明确对应物**的钩子，顺便复测「不许脑补」。 */
const PROBE_TITLE = '涮8秒就捞，这盘手切鲜牛肉够嫩'
const PROBE_COVER_PROMPT = '突出主角表情，暖色调'

const circuit = new CircuitBreaker(redis)
const gateway = new AiGateway(prisma, redis, circuit)

/**
 * 一个候选帧。
 *
 * ★★ 字段名刻意**不叫** `baseDataUri`：产品里 `baseDataUri` 指的是
 *   **还没裁成 3:4** 的高清素材帧，真正交给模型的是 `buildCoverBaseDataUri()` 的产物。
 *   上一版体检脚本把这两者当成了同一个东西（直接把素材帧当底图发出去），
 *   于是「本地裁 3:4」这一步在体检里**完全没跑**，验出来的当然是旧行为。
 *   命名歧义造成的假验收 —— 所以这里叫 `hiResDataUri`。
 */
interface ProbeFrame {
  label: string
  /** 喂给选帧模型的小图（640px） */
  dataUri: string
  /** 裁剪前的**高清素材帧**（1080px），还要再经 `buildCoverBaseDataUri` 才是底图 */
  hiResDataUri: string
  /** 素材帧的实际像素（用于判断「有没有先被放大再重画」），探不到就是 null */
  srcSize: { width: number; height: number } | null
}

/** 跑一条 ffmpeg 并拿回 stdout+stderr（PSNR 的 stats_file=- 走 stdout，日志走 stderr） */
function runCapture(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args)
    let out = ''
    const timer = setTimeout(() => {
      p.kill('SIGKILL')
      rej(new Error('ffmpeg 超时'))
    }, timeoutMs)
    p.stdout.on('data', (d: Buffer) => (out += d.toString()))
    p.stderr.on('data', (d: Buffer) => (out += d.toString()))
    p.on('error', (e) => {
      clearTimeout(timer)
      rej(e)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      code === 0 ? res(out) : rej(new Error(`ffmpeg 退出码 ${code}`))
    })
  })
}

async function toDataUri(path: string): Promise<{ dataUri: string; bytes: number } | null> {
  try {
    const b = await readFile(path)
    return { dataUri: `data:image/jpeg;base64,${b.toString('base64')}`, bytes: b.length }
  } catch {
    return null
  }
}

/** 把 data URI 落到磁盘（用于存底图、算 PSNR、拼并排图） */
async function dataUriToFile(dataUri: string, path: string): Promise<number> {
  const comma = dataUri.indexOf(',')
  const buf = Buffer.from(comma >= 0 ? dataUri.slice(comma + 1) : dataUri, 'base64')
  await writeFile(path, buf)
  return buf.length
}

async function collect(): Promise<ProbeFrame[]> {
  const argv = process.argv.slice(2)
  const videoIdx = argv.indexOf('--video')
  const assetIdx = argv.indexOf('--asset')

  // ★ `--asset <id>`：直接从**本地库**取一条真实上传素材拉到 /tmp 再抽帧。
  //   比让人手工找视频省事，也让「复现某个商户看到的问题」变成一条命令。
  //   ⚠ 它打的是**本地库**（tsx 脚本的默认行为），别指望它拿到线上的素材。
  let videoPath = videoIdx >= 0 ? argv[videoIdx + 1] : undefined
  if (assetIdx >= 0) {
    const id = Number(argv[assetIdx + 1])
    if (!Number.isInteger(id) || id <= 0) throw new Error('--asset 后面要跟一个 media_asset.id')
    const a = await prisma.mediaAsset.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, merchantId: true, cosKey: true, durationMs: true, type: true, width: true, height: true },
    })
    if (!a) throw new Error(`本地库里没有 id=${id} 的素材（或已删除）`)
    if (a.type !== 'VIDEO') throw new Error(`素材 #${id} 的 type=${a.type}，不是 VIDEO`)
    const dest = `/tmp/probe-src-${a.id}.mp4`
    console.log(
      `--asset #${a.id}  m=${a.merchantId}  ${a.durationMs}ms  ${a.width ?? '?'}×${a.height ?? '?'}  ${a.cosKey}`,
    )
    await downloadToFile(a.cosKey, dest)
    console.log(`  已下载到 ${dest}`)
    videoPath = dest
  }

  if (videoPath !== undefined) {
    if (!videoPath) throw new Error('--video 后面要跟一个视频路径')
    const video = videoPath
    // ★ 两份宽度分开抽，与产品完全一致（见 publish-material.service.ts 的 BASE_FRAME_WIDTH）：
    //   640 那份只发给模型看，1080 那份只当底图 —— 底图越大，模型「重画」的成分越少。
    const cand = await extractCandidateFrames(video, '/tmp/probe-cover-frames/f', {
      count: 6,
      width: 640,
    })
    const base = await extractCandidateFrames(video, '/tmp/probe-cover-frames/b', {
      count: 6,
      width: BASE_FRAME_WIDTH,
    })
    console.log(
      `从视频抽出 ${cand.length} 帧（模型看的 640px） / ${base.length} 帧（当底图的 ${BASE_FRAME_WIDTH}px）`,
    )
    // ★ 按时戳配对，不按下标 —— 与产品同一套防错位逻辑
    const baseByAt = new Map(base.map((f) => [f.atSeconds, f.path]))
    const out: ProbeFrame[] = []
    for (const f of cand) {
      const small = await toDataUri(f.path)
      const basePath = baseByAt.get(f.atSeconds)
      const big = basePath ? await toDataUri(basePath) : null
      if (!small) continue
      const size = basePath ? await probeClipMeta(basePath).catch(() => null) : null
      out.push({
        label: `视频第 ${f.atSeconds}s`,
        dataUri: small.dataUri,
        hiResDataUri: big?.dataUri ?? small.dataUri,
        srcSize: size?.ok && size.width && size.height ? { width: size.width, height: size.height } : null,
      })
    }
    return out
  }

  const paths = argv.length > 0 ? argv : DEFAULT_FRAMES
  const out: ProbeFrame[] = []
  for (const p of paths) {
    const abs = resolve(p)
    const d = await toDataUri(abs)
    if (!d) {
      console.log(`  （读不到 ${p}，跳过）`)
      continue
    }
    const size = await probeClipMeta(abs).catch(() => null)
    const wh = size?.ok && size.width && size.height ? { width: size.width, height: size.height } : null
    console.log(`  ${p}  ${d.bytes} bytes${wh ? `  ${wh.width}×${wh.height}` : ''}`)
    out.push({ label: p.split('/').pop() ?? p, dataUri: d.dataUri, hiResDataUri: d.dataUri, srcSize: wh })
  }
  return out
}

async function main(): Promise<void> {
  console.log('\n=== 发布封面链路体检（会真实扣钱）===')
  console.log('★ 本脚本复现产品路径：抽帧 → 选帧 → **本地裁 3:4** → 图生图\n')

  const frames = await collect()
  if (frames.length === 0) {
    console.log('✗ 一张候选帧都没有，无法体检')
    return
  }

  // ── ① 选帧 ──
  let picked = 0
  if (frames.length <= 1) {
    console.log('\n① 候选只有 1 张 ⇒ 按设计**跳过**选帧（没有可比对象，白花一笔钱）')
  } else {
    const pickContext = [
      `本次共 ${frames.length} 张候选画面，编号从 0 到 ${frames.length - 1}：`,
      ...frames.map((f, i) => `· 编号 ${i}：${f.label}`),
    ].join('\n')
    const t = Date.now()
    const r = await runBilledScene(prisma, gateway, {
      sceneCode: SCENE.publish_cover_pick,
      merchantId: MERCHANT_ID,
      requestId: `probe-pick-${Date.now()}`,
      variables: { pickContext },
      images: frames.map((f) => f.dataUri),
    })
    const secs = ((Date.now() - t) / 1000).toFixed(1)
    console.log(`\n① 选帧  ${secs}s  isFallback=${r.isFallbackTemplate}  实扣=${r.beanCharged} 积分`)
    console.log(`   返回：${r.text.slice(0, 200)}`)
    if (r.isFallbackTemplate) {
      console.log('   ⚠ 走了兜底（退第 0 张）。查 business_request.error_msg 看是超时还是通道故障。')
      console.log('   ⚠ 若上一轮刚超时过，通道级熔断（ai:cb:*，300s）会让本次**秒失败**、伪装成新 bug。')
    }
    if (!r.isFallbackTemplate) {
      // 与产品同一个解析器：它认 JSON / ``` 包裹 / 光秃秃数字，越界一律回 null
      const o = JSON.parse(r.text.replace(/```[a-z]*/g, '').trim()) as { index?: number }
      if (Number.isInteger(o.index) && o.index! >= 0 && o.index! < frames.length) picked = o.index!
    }
  }
  const chosen = frames[picked]!
  console.log(`\n   ⇒ 选中的源帧：第 ${picked} 张（${chosen.label}）`)

  // ── ② 本地裁 3:4（★ 产品的关键一步，绝不能省）──
  //   ★★ 必须调用**产品自己的**函数，不能在这里另写一段 ffmpeg：
  //      否则体检走的是另一条路，看图结论对产品无效。产品那一行是
  //      `refImage = await buildCoverBaseDataUri(picked.frame.baseDataUri ?? picked.frame.dataUri)`。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  await mkdir(OUT_DIR, { recursive: true })
  const basePath = join(OUT_DIR, `封面体检-${stamp}-底图.jpg`)
  const refImage = await buildCoverBaseDataUri(chosen.hiResDataUri)
  if (refImage === chosen.hiResDataUri) {
    console.log('\n   ⚠ buildCoverBaseDataUri 原样返回了素材帧 —— 本地裁切**失败了**。')
    console.log('     体检会退化成「旧行为」，看图结论不可用（查 ffmpeg 是否可用 / 是否装在服务端）。')
  }
  const baseBytes = await dataUriToFile(refImage, basePath)
  const baseMeta = await probeClipMeta(basePath).catch(() => null)
  const baseWH =
    baseMeta?.ok && baseMeta.width && baseMeta.height
      ? `${baseMeta.width}×${baseMeta.height}`
      : '尺寸未知'
  console.log(`\n② 本地底图  ${baseWH}  ${baseBytes} bytes`)
  const srcWH = chosen.srcSize ? `${chosen.srcSize.width}×${chosen.srcSize.height}` : '未知'
  console.log(`   源帧 ${srcWH} ⇒ 底图 ${baseWH}（这一步是 ffmpeg 做的，零重绘）`)
  // ★ 判据是「高/宽 = 1.333」——**别写成宽/高**：1080×1440 的宽/高正是 0.750，
  //   拿 4/3 去比会得到一个「永远报警」的护栏（报警比不报警更害人：会让人忽略真报警）。
  if (
    baseMeta?.ok &&
    baseMeta.width &&
    baseMeta.height &&
    Math.abs(baseMeta.height / baseMeta.width - 4 / 3) > 0.02
  ) {
    console.log(
      `   ⚠ 底图不是 3:4（高/宽 = ${(baseMeta.height / baseMeta.width).toFixed(3)}）⇒ 本地裁切没起作用，` +
        '模型会自己重新取景。体检结论不可用。',
    )
  }
  if (chosen.srcSize && baseMeta?.ok && baseMeta.width) {
    const up = baseMeta.width / chosen.srcSize.width
    if (up > 1.05) {
      console.log(
        `   ⚠ 底图被放大了 ${up.toFixed(2)} 倍 —— 源帧本身太小。真实拍摄素材应在 1000px 以上，` +
          `放大的部分模型只能「重新想象」。「--video」模式会按 ${BASE_FRAME_WIDTH}px 重抽，可对比。`,
      )
    }
  }

  // ── ③ 图生图出封面（参考图 = 本地裁好的 3:4 底图）──
  const t2 = Date.now()
  const cover = await runBilledScene(prisma, gateway, {
    sceneCode: SCENE.publish_cover,
    merchantId: MERCHANT_ID,
    requestId: `probe-cover-${Date.now()}`,
    variables: { coverPrompt: PROBE_COVER_PROMPT, coverTitle: PROBE_TITLE },
    images: [refImage],
  })
  const secs2 = ((Date.now() - t2) / 1000).toFixed(1)
  console.log(`\n③ 出封面  ${secs2}s  isFallback=${cover.isFallbackTemplate}  实扣=${cover.beanCharged} 积分`)
  console.log(`   标题：${PROBE_TITLE}`)
  console.log(`   返回：${cover.text.slice(0, 160)}`)

  if (cover.isFallbackTemplate) {
    console.log('   ⚠ 走了兜底 ⇒ 没有产出图片，见上一条的排查方法。')
    return
  }

  // ── ④ 落盘 + 取景一致性定量 ──
  // ★ 先写临时名、等**嗅探出真实类型**再改名：出图接口回的 Content-Type 未必可靠，
  //   而错的扩展名会骗过后续所有看图/上传环节（本项目已踩过 webp 落到 .mp4 的坑）。
  const destTmp = join(OUT_DIR, `封面体检-${stamp}.bin`)
  let dest = ''
  try {
    const saved = await fetchImageToFile(cover.text.trim(), destTmp)
    // ★ `saved.ext` **自带前导点**（'.png' 不是 'png'）—— 再补一个点会得到 `xx..png`
    dest = join(OUT_DIR, `封面体检-${stamp}${saved.ext}`)
    await rename(destTmp, dest)
    const probe = await probeClipMeta(dest).catch(() => null)
    const covWH = probe?.ok && probe.width && probe.height ? `${probe.width}×${probe.height}` : '尺寸未知'
    if (probe?.ok && probe.width && probe.height) {
      const ratio = probe.height / probe.width
      console.log(`\n④ 成品  ${covWH}（高/宽 = ${ratio.toFixed(3)}，3:4 应为 1.333）`)
      if (Math.abs(ratio - 4 / 3) > 0.02) {
        console.log('   ⚠ 比例不是 3:4 —— 承诺是竖版 3:4，要么改 AI_IMAGE_SIZE，要么改这里的期望')
      }
    } else {
      console.log(`\n④ 成品  ${covWH}`)
    }
    console.log(`   落盘 ${saved.bytes} bytes / 嗅探类型 ${saved.contentType}（后缀 ${saved.ext}）`)

    // 取景一致性：把成品缩到底图尺寸后算 PSNR（纯几何诊断，不做断言）
    // ★★ 必须同时给「无文字区」那一版：标题是纯色描边大字，会把全图 PSNR 压得很低，
    //    于是「取景到底有没有被改」从全图数字上根本读不出来（标题盖住的面积越大越糟）。
    //    只取下半幅（45% 以下没有文字）来比，噪声源就只剩调色与重绘。
    const bw = baseMeta?.width ?? 1080
    const bh = baseMeta?.height ?? 1440
    const bandY = Math.round(bh * 0.45)
    const bandH = bh - bandY
    const psnrOf = async (filter: string): Promise<string | null> => {
      try {
        const out = await runCapture(ffmpegBin(), [
          '-y', '-i', dest, '-i', basePath, '-filter_complex', filter, '-f', 'null', '-',
        ])
        const mm = out.match(/psnr_avg:([\d.]+|inf)/i)
        if (!mm) return null
        const raw = mm[1] ?? ''
        return raw.toLowerCase() === 'inf' ? '∞' : Number(raw).toFixed(2)
      } catch {
        return null
      }
    }
    const full = await psnrOf(
      `[0:v]scale=${bw}:${bh}:flags=bicubic[c];[c][1:v]psnr=stats_file=-`,
    )
    const band = await psnrOf(
      `[0:v]scale=${bw}:${bh}:flags=bicubic,crop=${bw}:${bandH}:0:${bandY}[c];` +
        `[1:v]crop=${bw}:${bandH}:0:${bandY}[b];[c][b]psnr=stats_file=-`,
    )
    if (full || band) {
      console.log('\n   ★ 取景一致性（成品缩到底图尺寸后的 PSNR）')
      console.log(`     全图      ：${full ?? '未算出'} dB（被标题压住，只是参考）`)
      console.log(`     无文字区  ：${band ?? '未算出'} dB（★ 看这个：只有调色与重绘的差异）`)
      console.log('     参照：∞ = 同一张图；25~35 = 视觉上很接近；≤16 = 取景被改过')
      console.log('     ⚠ 只靠 PSNR 判「取景有没有动」不够 —— 想量出准确的缩放/平移，跑：')
      console.log('       python3 scripts/cover-framing-drift.py <底图> <成品>')
      console.log('       （它在下半幅上做二维对齐搜索，直接给出最佳匹配的缩放与平移像素）')
    } else {
      console.log('\n   （PSNR 没算出来，跳过；不影响看图验收）')
    }

    // 并排图：左 = 交给模型的底图，右 = 成品。一眼看出取景有没有被改。
    const side = join(OUT_DIR, `封面体检-${stamp}-并排.png`)
    try {
      await runCapture(ffmpegBin(), [
        '-y', '-i', basePath, '-i', dest,
        '-filter_complex',
        '[0:v]scale=-2:1000[l];[1:v]scale=-2:1000[r];[l][r]hstack=inputs=2',
        '-frames:v', '1', side,
      ])
      console.log(`\n⑤ 并排图（左=底图 右=成品）：${side}`)
    } catch {
      console.log('\n⑤ 并排图生成失败（不影响成品）')
    }
  } catch (e) {
    console.log(`\n④ 下载封面失败（${(e as Error).message}）`)
    console.log(`   URL 仍然可用，自己打开看：${cover.text.trim()}`)
  }

  console.log(`\n⑥ 成品封面：${dest || '(未落盘)'}`)
  console.log('   ★ 必须**用眼睛看**这四件事（它们都不会报错）：')
  console.log('     a) **取景**：与左图（底图）比，主体大小/位置是否**完全一致**？')
  console.log('        被拉远、被缩小、凭空多出背景 = 修复失败（这是本轮返工的核心）。')
  console.log('     b) 标题是不是「设计过的字」而不是直接叠上去的？有没有错别字？')
  console.log('     c) 标题有没有遮住**眼睛**？（压在额头/头发上是允许的）')
  console.log('     d) 有没有出现底图里**本来没有**的菜 / 道具？（标题提到什么就画什么 = 脑补）')

  // ── ⑦ 本次明细 ──
  const logs = await prisma.aiCallLog.findMany({
    where: { merchantId: MERCHANT_ID, sceneCode: { in: [SCENE.publish_cover_pick, SCENE.publish_cover] } },
    orderBy: { id: 'desc' },
    take: 4,
    select: {
      sceneCode: true,
      latencyMs: true,
      status: true,
      promptTokens: true,
      completionTokens: true,
      costFen: true,
      beanCharged: true,
    },
  })
  console.log('\n⑦ 最近调用明细（ai_call_log）')
  for (const l of logs) {
    console.log(
      `   ${l.sceneCode.padEnd(20)} ${String(l.latencyMs).padStart(6)}ms ${l.status} in=${l.promptTokens} out=${l.completionTokens} costFen=${l.costFen} beans=${l.beanCharged}`,
    )
  }
  console.log('\n   ★ 拿这些数字去核对 docs/09 第 4.1 / 4.2 节的定价表；偏离明显就更新那两张表。')
}

main()
  .catch((e) => {
    console.error('\n✗ 体检失败：', (e as Error)?.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    await redis.quit().catch(() => {})
    process.exit(process.exitCode ?? 0)
  })
