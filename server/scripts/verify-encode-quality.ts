// 「编码档位」守护断言。全是纯计算 + 源码静态检查，不碰数据库、不渲染、不联网。
//                                                    （`npm run encode-quality:verify`）
//
// ★★ 这里防的是一类**完全静默**的回归 —— 它的特征不是「报错」，而是「改了跟没改一样」：
//
//   ① 某个编码点被改回字面量（`'-crf', '23'`），于是那一步又变回交付档。
//      症状：这次改造的收益在**那一条路径上**悄悄消失，日志、产物结构、时长全都正常。
//   ② 中间产物与交付物**档次颠倒**（中间用交付档、最后用近无损）——
//      画质没变好，体积反而全线暴涨。
//   ③ 改了档位却忘了递增缓存版本 ⇒ 线上继续命中旧产物 ⇒ 修复对存量素材完全不生效。
//   ④ 预览被「顺手统一」成交付档 ⇒ 同步 HTTP 请求变慢、体积变大，而预览本来只需看个大概。
//
// 所以断言分两层：
//   · **渲染态**：直接调 `videoEncodeArgs` 等真函数，看拼出来的参数串（不是看常量本身）；
//   · **接线态**：读源码，断言「哪个步骤用了哪一档」—— 这一层无法靠调函数证明，
//     因为步骤与档位的对应关系写在调用点，而不在函数体内。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUDIO_BITRATE,
  ENCODE_DELIVERY,
  ENCODE_INTERMEDIATE,
  audioEncodeArgs,
  audioEncodeArgsStereo,
  videoEncodeArgs,
} from '../src/render/encode-quality.js'
import { INTERMEDIATE_CACHE_VERSION, SPEECH_CUT_VERSION } from '../src/render/cache-keys.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = (rel: string) => readFile(join(here, '..', rel), 'utf8')

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

/** 去掉行注释与块注释行，只留可执行代码（防止注释里提到的旧数字把断言骗红）。 */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

/**
 * 抠出一个**函数声明**的函数体（按花括号配平）。
 *
 * ⚠ 不能直接取「声明之后第一个 `{`」—— 参数表里可能有内联对象类型
 *   （`processTask(task: { id: bigint; ... })`），那会把参数类型当成函数体，
 *   于是断言在一个只有 6 行的片段上跑，**看起来通过了「能定位到函数」，实际什么都没查**
 *   （本脚本第一版就踩了：51 过 / 5 失败，查出来是提取器吃错了括号）。
 *   所以先跳过参数表跳到配平的右括号，再从它之后的返回类型里找函数体的 `{`。
 *   模板字面量里的 `${}` 是配平的，不影响计数。
 */
function bodyOf(text: string, decl: string): string | null {
  const at = text.indexOf(decl)
  if (at < 0) return null
  const openParen = text.indexOf('(', at)
  if (openParen < 0) return null
  let depth = 0
  let i = openParen
  for (; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) break
    }
  }
  // 右括号之后是「可选的返回类型 + 函数体的 `{`」；返回类型本身不含花括号时这个正则可靠
  const tail = /^\s*(?::\s*[^{]*)?\{/.exec(text.slice(i + 1))
  if (!tail) return null
  const brace = i + 1 + tail[0].length - 1
  depth = 0
  for (let j = brace; j < text.length; j++) {
    const ch = text[j]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(brace, j + 1)
    }
  }
  return null
}

function argsContain(args: string[], flag: string, value: string): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === value) return true
  }
  return false
}

// ───────────── ① 两档的取值关系：中间必须比交付更"舍不得压" ─────────────

console.log('\n① 档位取值：中间产物必须严于交付物')
{
  check(
    `中间档 crf(${ENCODE_INTERMEDIATE.crf}) 严格小于交付档 crf(${ENCODE_DELIVERY.crf})`,
    ENCODE_INTERMEDIATE.crf < ENCODE_DELIVERY.crf,
    '两档相等或颠倒 ⇒ 世代叠加根本没被修掉（这就是本次改造的全部意义）',
  )
  check(
    `中间档 crf 至少比交付档低 4（实测 23→12 才有量级差别；只差 1~2 是自欺欺人）`,
    ENCODE_DELIVERY.crf - ENCODE_INTERMEDIATE.crf >= 4,
    `实际差 ${ENCODE_DELIVERY.crf - ENCODE_INTERMEDIATE.crf}`,
  )
  check('中间档是近无损量级（crf <= 15）', ENCODE_INTERMEDIATE.crf <= 15, `实际 ${ENCODE_INTERMEDIATE.crf}`)
  check('两档 preset 都是 x264 可识别的值', [ENCODE_INTERMEDIATE, ENCODE_DELIVERY].every((t) => typeof t.preset === 'string' && t.preset.length > 0))
}

// ───────────── ② 渲染态：真函数拼出来的参数串 ─────────────

console.log('\n② 渲染态：真函数拼出来的 ffmpeg 参数')
{
  const mid = videoEncodeArgs(ENCODE_INTERMEDIATE)
  const del = videoEncodeArgs(ENCODE_DELIVERY)
  const midDefault = videoEncodeArgs()

  check('videoEncodeArgs(中间档) 带上中间 crf', argsContain(mid, '-crf', String(ENCODE_INTERMEDIATE.crf)), mid.join(' '))
  check('videoEncodeArgs(交付档) 带上交付 crf', argsContain(del, '-crf', String(ENCODE_DELIVERY.crf)), del.join(' '))
  check('videoEncodeArgs 默认 = 交付档（默认值刻意取更保守那一侧）',
    argsContain(midDefault, '-crf', String(ENCODE_DELIVERY.crf)), midDefault.join(' '))
  check('编码器是 libx264 + yuv420p', argsContain(mid, '-c:v', 'libx264') && argsContain(mid, '-pix_fmt', 'yuv420p'))
  check('不含 -b:v / -maxrate ⇒ CRF 恒质量模式没被改成限码率', !mid.includes('-b:v') && !mid.includes('-maxrate'), mid.join(' '))

  const a1 = audioEncodeArgs()
  check(`audioEncodeArgs 用 ${AUDIO_BITRATE}`, argsContain(a1, '-b:a', AUDIO_BITRATE), a1.join(' '))
  const a2 = audioEncodeArgsStereo()
  check('audioEncodeArgsStereo 额外锁定 44100 / 2ch',
    argsContain(a2, '-ar', '44100') && argsContain(a2, '-ac', '2'), a2.join(' '))
}

// ───────────── ③ 接线态：哪个步骤用哪一档 ─────────────

console.log('\n③ 接线态：步骤与档位的对应关系（读源码）')
{
  const ffmpegSrc = codeOnly(await src('src/render/ffmpeg.ts'))
  const synthesisSrc = codeOnly(await src('src/render/synthesis.ts'))
  const workerSrc = codeOnly(await src('src/render/worker.ts'))
  const previewSrc = codeOnly(await src('src/render/preview.ts'))
  const ttsSrc = codeOnly(await src('src/render/tts.ts'))

  const intermediateSteps = [
    ['ffmpeg.ts', ffmpegSrc, 'export async function ffmpegNormalize'],
    ['ffmpeg.ts', ffmpegSrc, 'export async function ffmpegExtendVideo'],
    ['ffmpeg.ts', ffmpegSrc, 'export async function ffmpegRemoveTimeRanges'],
  ] as const
  for (const [file, text, decl] of intermediateSteps) {
    const body = bodyOf(text, decl)
    check(`${file} 能定位到 ${decl.replace('export async function ', '')}`, body !== null)
    if (body) {
      check(`${decl.replace('export async function ', '')} 用**中间档**`,
        body.includes('ENCODE_INTERMEDIATE'), body.slice(0, 120).replace(/\n/g, ' '))
    }
  }

  const deliverySteps = [
    ['synthesis.ts', synthesisSrc, 'async function muxWithDrawtext'],
    ['synthesis.ts', synthesisSrc, 'async function muxWithCaptionOverlays'],
    ['synthesis.ts', synthesisSrc, 'async function muxWithSubtitles'],
  ] as const
  for (const [file, text, decl] of deliverySteps) {
    const body = bodyOf(text, decl)
    check(`${file} 能定位到 ${decl.replace('async function ', '')}`, body !== null)
    if (body) {
      check(`${decl.replace('async function ', '')} 用**交付档**`,
        body.includes('ENCODE_DELIVERY'), body.slice(0, 120).replace(/\n/g, ' '))
    }
  }

  // 拼接/调色是「看后面还有没有一次编码」才决定档位的两步
  const preFinal = bodyOf(workerSrc, 'async function processTask') ?? workerSrc
  check('worker 能定位到 processTask（拼接/调色的档位判据在这里）', bodyOf(workerSrc, 'async function processTask') !== null)
  check('worker 里用 preFinalTier 表达「后面还有没有一次编码」', preFinal.includes('preFinalTier'))
  check('preFinalTier：AI 档 ⇒ 中间档', /preFinalTier\s*=\s*aiMode\s*\?\s*ENCODE_INTERMEDIATE/.test(preFinal),
    'AI 档后面还要烧字幕（重编码），所以拼接/调色只是中间产物')
  check('preFinalTier：非 AI 档 ⇒ 交付档', /preFinalTier\s*=\s*aiMode\s*\?\s*ENCODE_INTERMEDIATE\s*:\s*ENCODE_DELIVERY/.test(preFinal))
  check('拼接收到 preFinalTier', /ffmpegConcatWithTransitions\([^)]*preFinalTier/.test(preFinal))
  check('调色收到 preFinalTier', /ffmpegApplyColor\([^)]*preFinalTier/.test(preFinal))

  // 预览：必须**不**跟着成片一起变清晰
  check('preview 刻意保持 crf 32（预览是同步请求，只看个大概）', /crf:\s*32/.test(previewSrc))
  check('preview 的归一化仍走共用缓存（normalizedClipKey）—— 与成片同一个键',
    previewSrc.includes('normalizedClipKey'))
}

// ───────────── ④ 字面量清扫：老参数不许残留 ─────────────

console.log('\n④ 字面量清扫：编码点必须都走 encode-quality')
{
  const files = [
    ['src/render/ffmpeg.ts', codeOnly(await src('src/render/ffmpeg.ts'))],
    ['src/render/synthesis.ts', codeOnly(await src('src/render/synthesis.ts'))],
    ['src/render/tts.ts', codeOnly(await src('src/render/tts.ts'))],
    ['src/render/worker.ts', codeOnly(await src('src/render/worker.ts'))],
  ] as const

  for (const [file, text] of files) {
    check(`${file} 无写死的 '-crf', '23'（那一步会静默退回交付档）`,
      !text.includes("'-crf', '23'"))
    check(`${file} 无写死的 '-crf', '12'（中间档也必须走常量，否则以后改档位会漏掉这一处）`,
      !text.includes("'-crf', '12'"))
    check(`${file} 无写死的 '-b:a', '128k'`,
      !text.includes("'-b:a', '128k'"))
    check(`${file} 无内联 '-c:v', 'libx264'（应统一走 videoEncodeArgs）`,
      !text.includes("'-c:v', 'libx264'"))
  }

  const eqSrc = await src('src/render/encode-quality.ts')
  check('encode-quality.ts 是唯一的 libx264 出处', eqSrc.includes("'libx264'"))

  // 音频码率也不许在别处另写一份
  for (const [file, text] of files) {
    check(`${file} 无写死的 '-b:a', '96k'`, !text.includes("'-b:a', '96k'"))
  }
}

// ───────────── ⑤ 缓存版本：改了档位就必须作废旧产物 ─────────────

console.log('\n⑤ 缓存版本耦合：档位改了、键没变 ⇒ 修复对存量素材不生效')
{
  /**
   * ★ 为什么这里**硬编码**一个下界而不只是「非空」：
   *   键里不含编码参数，所以「改了档位忘了递增版本」在运行时**不可能被发现** ——
   *   它只会表现为「改了跟没改一样」。既然没有别的机制能发现，就把它钉在这里：
   *   下一次改档位时，这条会红，逼作者想一下「要不要一起递增」。
   *   （不想递增的正当理由也存在 —— 比如只改了 preset 但产物按内容不变 —— 那就**改这个下界**，
   *     但"改下界"这个动作本身会被 code review 看见，这正是目的。）
   */
  const iv = Number(INTERMEDIATE_CACHE_VERSION.replace(/^v/, ''))
  const sv = Number(SPEECH_CUT_VERSION.replace(/^v/, ''))
  check('INTERMEDIATE_CACHE_VERSION 形如 vN', Number.isFinite(iv), INTERMEDIATE_CACHE_VERSION)
  check('SPEECH_CUT_VERSION 形如 vN', Number.isFinite(sv), SPEECH_CUT_VERSION)
  check(`INTERMEDIATE_CACHE_VERSION >= v4（2026-09-29 归一化改近无损时递增的版本）`, iv >= 4, `实际 ${INTERMEDIATE_CACHE_VERSION}`)
  check(`SPEECH_CUT_VERSION >= v2（同批次口播裁剪改近无损）`, sv >= 2, `实际 ${SPEECH_CUT_VERSION}`)
}

console.log(`\n通过 ${pass} · 失败 ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exitCode = 1
}
