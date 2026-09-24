/**
 * 「封面三步链路」的守护 —— 守住「封面底图必须来自真实拍摄画面，且标题是有设计感的文字」这个契约。
 *
 * ★★ 为什么需要它（2026-09-24 的两轮真实返工）：
 *
 *   第一轮，封面是**凭空画**的：`publish_cover` 走 `/images/generations`（纯文生图），
 *   标题提到「红烧肉」画面里就多出一盆红烧肉 —— 与用户「不要凭空出封面」直接冲突。
 *
 *   第二轮，改成图生图之后**画面对了、字还是不行**：把任务写成「图片编辑」，模型就
 *   「把画布填满 + 直接把字贴上去」。用户的原话是
 *   **「怎么拉大了图片，还有封面的文字也不够优美，不能单纯叠字上去」**。
 *   真正管用的是把 prompt 的**角色定位**从「编辑这张图」换成
 *   「你在设计一张**抖音封面图**」并写明画面铁律。
 *
 *   ⚠ 这两类返工**都不会让任何东西报错** —— 流程全绿、图也出得来，只是出得难看。
 *     这种「静默变差」正是最需要守护的对象。
 *
 * ★ 这个守护要守住八件事：
 *   ① **选帧场景必须是 TEXT 协议**：它要的是「比较 N 张图」，只能走 chat/completions。
 *      一旦进了 `IMAGE_SCENE_CODES`，网关会拿图像协议去调它 ⇒ 直接失效。
 *   ② **编号必须从 0 开始**：模板让模型按编号回答、调用方按下标取图。
 *      两边差一位就会**静默挑错帧**（不报错、封面用错画面）。
 *   ③ **`parsePickedIndex` 的三种返回形态都要认，且越界必须回 null**：
 *      越界时若返回一个数字，取图那步会拿到 `undefined` ⇒ 崩在离真因很远的地方。
 *   ④ **封面模板必须带 `{{coverTitle}}`**：标题是靠它进 prompt 的。
 *      少了它，prompt 里那段【标题】就是空话，模型只能自己编 —— 而且**不报错**。
 *   ⑤ **画面铁律必须还在**：prompt 被重写时最容易顺手删掉的就是「不许放大/裁切主体」
 *      和「不许添加参考图里不存在的物体」，删了就是第二轮返工重演。
 *   ⑥ **镜头排序必须稳定、未登记类型给中间值**：这条排序是「选帧质量」的第一道保障，
 *      坏掉只会让封面变差。未登记类型若被排到最后，新加的镜头类型会**永远选不进候选**。
 *   ⑦ **比例换算必须留在本地（ffmpeg），不能交回给模型**（2026-09-24 第三轮返工）：
 *      用户的原话是「**这个底图不是从视频抽出来的吗？为什么感觉还是有拉扯感**」。
 *      定量结论：把成品与源帧做「缩放比 × 偏移」二维搜索，**最佳匹配只有 ~13 dB**
 *      （同图应 ∞、视觉相近 25~35）⇒ 成品像素**根本不是**源帧的变换结果，
 *      模型是**拉远镜头 + 凭空补背景**重画了一张。根因是 prompt 自相矛盾：
 *      既要「主体完整入画」又要「标题放在留白处」，而那一帧没有留白。
 *      ⇒ 现在底图由 `buildCoverBase()` 本地满幅裁成 3:4 再交给模型，
 *        prompt 只许它「在给定画面上设计标题」。这一条一旦被改回去，会**静默**重演。
 *   ⑧ **底图必须用高分辨率那一份**：`baseDataUri`（按 `BASE_FRAME_WIDTH` 抽）
 *      而不是喂给模型的 640 小图。出图模型实测输出 ~1086×1448，用 640 打底
 *      等于让它先放大 1.7 倍再重画 —— 真实素材的细节会被它「想象」掉。
 *
 * 运行：cd server && npx tsx scripts/verify-publish-cover-chain.ts
 * ⚠ 纯内存 + 读源文件：不连库、不连 Redis、不调 AI、不花一分钱。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENE, IMAGE_SCENE_CODES, LIVE_SCENE_CODES } from '../src/ai/scene-codes.js'
import { SCENE_VARIABLES } from '../src/ai/prompt-vars.js'
import {
  PUBLISH_SCENES,
  PUBLISH_COVER_PROMPT,
  PUBLISH_COVER_PICK_PROMPT,
  PUBLISH_COVER_PICK_FALLBACK,
} from '../prisma/prompts.js'
import { rankShotsForCover, parsePickedIndex } from '../src/services/publish-material.service.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADAPTERS = join(HERE, '..', 'src', 'ai', 'adapters.ts')
const SERVICE = join(HERE, '..', 'src', 'services', 'publish-material.service.ts')
const THUMBNAIL = join(HERE, '..', 'src', 'lib', 'thumbnail.ts')
const PROBE = join(HERE, 'probe-publish-cover.ts')
const DRIFT = join(HERE, 'cover-framing-drift.py')

let pass = 0
let fail = 0

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  ok(label, Object.is(actual, expected), `期望 ${String(expected)}，实得 ${String(actual)}`)
}

const sceneOf = (code: string) => PUBLISH_SCENES.find((s) => s.code === code)

async function main(): Promise<void> {
  // ── ① 选帧场景的协议与接线 ────────────────────────────────────────────────
  console.log('\n① 选帧场景必须是 TEXT 协议、且已在 LIVE_SCENE_CODES 里')
  ok(
    'publish_cover_pick 不在 IMAGE_SCENE_CODES 里（否则网关会按图像协议调它）',
    !IMAGE_SCENE_CODES.includes(SCENE.publish_cover_pick as never),
    `IMAGE_SCENE_CODES = ${JSON.stringify(IMAGE_SCENE_CODES)}`,
  )
  ok(
    'publish_cover 在 IMAGE_SCENE_CODES 里（它才是真正出图的那个）',
    IMAGE_SCENE_CODES.includes(SCENE.publish_cover as never),
  )
  ok(
    '两个场景都在 LIVE_SCENE_CODES 里（不进就会被后台标成「待接入」）',
    LIVE_SCENE_CODES.includes(SCENE.publish_cover as never) &&
      LIVE_SCENE_CODES.includes(SCENE.publish_cover_pick as never),
  )
  eq('publish_cover_pick 的 kind', sceneOf('publish_cover_pick')?.kind, 'TEXT')
  eq('publish_cover 的 kind', sceneOf('publish_cover')?.kind, 'IMAGE')
  eq('publish_cover_pick 的温度（要判断力，不要创造力）', sceneOf('publish_cover_pick')?.temperature, 0.2)
  eq('publish_cover_pick 的原地重试次数', sceneOf('publish_cover_pick')?.maxRetries, 0)

  // ── ② 模板变量 ────────────────────────────────────────────────────────────
  console.log('\n② 模板变量：标题与候选说明必须真的能进模板')
  eq(
    'publish_cover 的模板变量 = {coverTitle, coverPrompt}（与顺序无关）',
    JSON.stringify([...(SCENE_VARIABLES.publish_cover ?? [])].sort()),
    JSON.stringify(['coverPrompt', 'coverTitle']),
  )
  eq(
    'publish_cover_pick 的模板变量 = [pickContext]',
    JSON.stringify(SCENE_VARIABLES.publish_cover_pick),
    JSON.stringify(['pickContext']),
  )
  ok(
    '封面模板里真的有 {{coverTitle}}（少了它标题进不去，模型只能自己编，且不报错）',
    PUBLISH_COVER_PROMPT.includes('{{coverTitle}}'),
  )
  ok('封面模板里真的有 {{coverPrompt}}', PUBLISH_COVER_PROMPT.includes('{{coverPrompt}}'))
  ok('选帧模板里真的有 {{pickContext}}', PUBLISH_COVER_PICK_PROMPT.includes('{{pickContext}}'))

  // ── ③ 编号从 0 开始（差一位就静默挑错帧）──────────────────────────────────
  console.log('\n③ 候选编号必须以 0 起：模板与解析必须对齐')
  ok(
    '选帧模板写明了「编号从 0 开始」',
    /编号从\s*0\s*开始/.test(PUBLISH_COVER_PICK_PROMPT),
    '模板没写清楚起点，模型可能按 1 起回答',
  )
  ok(
    '选帧兜底模板是可解析的合法 JSON',
    (() => {
      try {
        const o = JSON.parse(PUBLISH_COVER_PICK_FALLBACK) as { index?: unknown }
        return Number.isInteger(Number(o.index))
      } catch {
        return false
      }
    })(),
    `兜底 = ${PUBLISH_COVER_PICK_FALLBACK}`,
  )

  // ── ④ 画面铁律（删掉就重演「拉远镜头 + 叠字」）────────────────────────────
  console.log('\n④ 封面模板的画面铁律必须在（这是三轮返工换来的）')
  ok(
    '写明是「抖音封面图」（角色定位决定成败：写成「图片编辑」就会填满画布 + 贴字）',
    PUBLISH_COVER_PROMPT.includes('抖音封面'),
  )
  ok(
    '★ 角色定位：参考图**已经是我们裁好的 3:4 底图**，模型只负责「在它上面设计标题」',
    /已经是我们裁切好的\s*3:4\s*底图/.test(PUBLISH_COVER_PROMPT) &&
      /在它上面设计标题/.test(PUBLISH_COVER_PROMPT),
    '少了这句，模型会以为「把 9:16 变 3:4」也是它的活 ⇒ 重新取景',
  )
  ok(
    '★★ 构图必须与参考图完全一致（第三轮返工的核心契约）',
    /构图必须与参考图完全一致/.test(PUBLISH_COVER_PROMPT),
  )
  ok(
    '★★ 明写「绝不许改变取景」（用户的原话是「为什么感觉还是有拉扯感」）',
    /绝不许改变取景/.test(PUBLISH_COVER_PROMPT),
  )
  ok(
    '禁止「拉远镜头给文字腾地方」（铁律 1 与铁律 3 各有一处，两处都要在）',
    (PUBLISH_COVER_PROMPT.match(/拉远镜头/g) ?? []).length >= 2,
  )
  ok(
    '★★「完整入画」全文只能出现 1 次，且必须出现在**反面教材**句里（本轮返工的根因）',
    (PUBLISH_COVER_PROMPT.match(/完整入画/g) ?? []).length === 1 &&
      /不要为了「让主体完整入画」而拉远镜头/.test(PUBLISH_COVER_PROMPT),
    '「主体完整入画」与「构图完全一致」是互斥指令，同时出现时模型只会缩主体',
  )
  ok(
    '★ 标题允许压在画面内容上（否则模型又得腾地方 ⇒ 又去缩主体）',
    /标题可以直接压在画面内容上/.test(PUBLISH_COVER_PROMPT) &&
      /只避开|唯一必须避开的部位是\*\*人物的眼睛\*\*/.test(PUBLISH_COVER_PROMPT),
  )
  ok(
    '★ 比例段：声明参考图**已经是 3:4 竖版**、不许再做比例换算',
    /参考图\*\*已经是 3:4 竖版\*\*/.test(PUBLISH_COVER_PROMPT) &&
      /不要再做任何比例换算/.test(PUBLISH_COVER_PROMPT),
  )
  ok(
    '禁止添加参考图里不存在的物体（否则标题提到什么就凭空画什么）',
    /严禁添加参考图中不存在的/.test(PUBLISH_COVER_PROMPT),
  )
  ok(
    '标题要求「设计排版」而不是叠字（用户第二次返工的点）',
    /经过设计排版/.test(PUBLISH_COVER_PROMPT) && /不能.*叠|而不是简单把字叠上去/.test(PUBLISH_COVER_PROMPT),
  )
  ok('要求 3:4 竖版', PUBLISH_COVER_PROMPT.includes('3:4'))

  // ── ⑤ parsePickedIndex 的三种形态与越界 ──────────────────────────────────
  console.log('\n⑤ parsePickedIndex：认三种形态、越界一律回 null')
  eq('标准 JSON', parsePickedIndex('{"index":2,"reason":"主体清晰"}', 4), 2)
  eq('JSON 被 ``` 包住', parsePickedIndex('```json\n{"index":1,"reason":"好"}\n```', 4), 1)
  eq('JSON 被解释文字包住', parsePickedIndex('我选这个：{"index":3,"reason":"有主体"}。', 4), 3)
  eq('光秃秃一个数字', parsePickedIndex('2', 4), 2)
  eq('前后带空格与换行的数字', parsePickedIndex('\n  1  \n', 4), 1)

  console.log('\n   —— 越界与非法的必须回 null（回一个数字就会取到 undefined）')
  eq('下标 === total（差一位的经典错）', parsePickedIndex('{"index":4}', 4), null)
  eq('负数', parsePickedIndex('{"index":-1}', 4), null)
  eq('小数', parsePickedIndex('{"index":1.5}', 4), null)
  eq('完全解析不出数字', parsePickedIndex('我挑不出来', 4), null)
  eq('空字符串', parsePickedIndex('', 4), null)
  eq('total = 0 时任何下标都非法', parsePickedIndex('{"index":0}', 0), null)

  // ── ⑥ 镜头排序：稳定、未登记类型给中间值 ─────────────────────────────────
  console.log('\n⑥ rankShotsForCover：按封面命中率排序、同序保持原顺序、新类型不被排到最后')
  const shots = [
    { seq: 1, shotType: '开场' },
    { seq: 2, shotType: '收尾' },
    { seq: 3, shotType: '特写' },
    { seq: 4, shotType: '制作' },
    { seq: 5, shotType: '试吃' },
  ]
  const ranked = rankShotsForCover(shots)
  eq('最该当封面的是「特写」', ranked[0]?.shotType, '特写')
  eq('其次「制作」', ranked[1]?.shotType, '制作')
  eq('「开场」排在「收尾」之前（同在最差端也保持定义顺序）', ranked[3]?.shotType, '开场')
  eq('「收尾」垫底', ranked[4]?.shotType, '收尾')
  eq('返回条数不变（不丢镜头）', ranked.length, shots.length)
  ok('不改动入参数组的顺序', shots[0]?.shotType === '开场')

  const sameRank = rankShotsForCover([
    { seq: 7, shotType: '原料' },
    { seq: 8, shotType: '原料' },
  ])
  eq('同类镜头保持原 seq 顺序', sameRank[0]?.seq, 7)

  const unknown = rankShotsForCover([
    { seq: 1, shotType: '收尾' },
    { seq: 2, shotType: '全新类型' },
    { seq: 3, shotType: '特写' },
  ])
  eq('未登记类型排在最差类型之前（给中间值 5，不是排到最后）', unknown[1]?.shotType, '全新类型')
  eq('未登记类型不会顶掉已知的高优先级类型', unknown[0]?.shotType, '特写')

  const nullType = rankShotsForCover([
    { seq: 1, shotType: '收尾' },
    { seq: 2, shotType: null },
  ])
  eq('shotType 为 null 也按中间值处理', nullType[0]?.seq, 2)

  // ── ⑦ 两条新路径真的接上了（不是「写了函数没人调」）────────────────────────
  console.log('\n⑦ 接线断言：多图输入与图生图端点真的被调用了')
  const adapters = await readFile(ADAPTERS, 'utf8')
  ok(
    'adapters 里存在 /images/edits 分支（图生图端点）',
    adapters.includes("'/images/edits'"),
  )
  ok(
    'adapters 按有无参考图在编辑/生成两个端点间切换',
    /isEdit/.test(adapters) && adapters.includes("'/images/generations'"),
  )
  ok(
    'adapters 把参考图拼成 images[{image_url}] 请求体（字段名写错上游会直接 400）',
    /images:\s*refs\.map/.test(adapters) && adapters.includes('image_url'),
  )

  const service = await readFile(SERVICE, 'utf8')
  ok(
    '封面场景真的把选中的帧作为 images 传下去了',
    /images:\s*refImage\s*\?\s*\[refImage\]\s*:\s*undefined/.test(service),
    '若这里没接上，封面会静默退回纯文生图 = 凭空画',
  )
  ok(
    '选帧场景真的把候选帧作为 images 传下去了',
    /images:\s*frames\.map\([\s\S]{0,40}?\.dataUri/.test(service),
    '若这里没接上，模型就是在**看不到图**的情况下盲选，而且不报错',
  )
  ok(
    '抽帧一张都拿不到时不会崩（走文生图兜底）',
    /refImage\s*\?\s*\[refImage\]\s*:\s*undefined/.test(service) && /frames\.length\s*>\s*0/.test(service),
  )

  console.log('\n   —— 比例换算必须在本地做（改回「交给出图模型」就会静默重演拉扯感）')
  const thumb = await readFile(THUMBNAIL, 'utf8')
  ok(
    'thumbnail.ts 里有 buildCoverBase（本地满幅裁 3:4 的那一步）',
    /export async function buildCoverBase\(/.test(thumb),
  )
  ok(
    'buildCoverBase 是 full-bleed（铺满再裁），不是「缩放留白」也不是「插虚化条」',
    /force_original_aspect_ratio=increase/.test(thumb) && /crop=\$\{W\}:\$\{H\}/.test(thumb),
  )
  ok(
    'service 真的调用了 buildCoverBase（不是「写了函数没人调」）',
    /buildCoverBase\(srcPath, outPath/.test(service) && /import \{[^}]*buildCoverBase[^}]*\} from '\.\.\/lib\/thumbnail\.js'/.test(service),
    '若这一步断开，参考图会退回未裁的原帧 ⇒ 模型自己重新取景',
  )
  ok(
    '★★ 主流程把**本地裁好的 3:4 底图**当作参考图（这一条断了整条修复就白做）',
    /refImage\s*=\s*await buildCoverBaseDataUri\(/.test(service),
  )
  ok(
    '★★ 底图取高分辨率那一份（baseDataUri），缺失时才退回小图',
    /buildCoverBaseDataUri\(picked\.frame\.baseDataUri\s*\?\?\s*picked\.frame\.dataUri\)/.test(service),
    '退回逻辑必须用 ?? 而不是 ||：空串是坏值、undefined 才是「没有」',
  )
  ok(
    '真的按 BASE_FRAME_WIDTH 抽了第二份高清帧（否则 baseDataUri 会是 undefined）',
    /width:\s*BASE_FRAME_WIDTH/.test(service) && /const BASE_FRAME_WIDTH = COVER_BASE_WIDTH/.test(service),
  )
  ok(
    '★ 两份抽帧按 atSeconds 配对，不是按下标（下标配对一旦错位就是拿错帧当底图，且不报错）',
    /baseByAt/.test(service) && /baseFrames\.map\(\(f\)\s*=>\s*\[f\.atSeconds, f\.path\]\)/.test(service),
  )

  console.log('\n   —— 真机体检脚本必须复现产品路径（它验的是「模型到底出了什么」）')
  const probe = await readFile(PROBE, 'utf8')
  ok(
    '★★ 体检脚本用的是产品自己的 buildCoverBaseDataUri（自己另拼一套就等于验别的路）',
    /import \{[^}]*buildCoverBaseDataUri[^}]*\} from '\.\.\/src\/services\/publish-material\.service\.js'/.test(probe),
    '上一轮「拉扯感」被漏掉，根因就是体检脚本把**未裁的原帧**直接传给了模型',
  )
  ok(
    '★★ 体检脚本**真的调用**了 buildCoverBaseDataUri（只 import 不调用 = 假验收）',
    /await buildCoverBaseDataUri\(/.test(probe),
    '上一轮这条断言只查了 import，于是「没跑本地裁切」的体检脚本照样全绿，验出了旧行为',
  )
  ok(
    '★★ 传给模型的必须是那次裁切的产物（refImage），不是素材帧',
    /images:\s*\[refImage\]/.test(probe) && !/images:\s*\[chosen\./.test(probe),
  )
  ok(
    '体检脚本自带护栏：裁切失败（原样返回 / 底图不是 3:4）时必须显式报警',
    /原样返回了素材帧/.test(probe) && /底图不是 3:4/.test(probe),
    '没有这道护栏，裁切静默失效会让体检退化成旧行为，而输出看起来一切正常',
  )
  ok(
    '★ 护栏判的是「高/宽 = 4/3」，不是宽/高（写反了会变成永远报警的假警报）',
    /baseMeta\.height \/ baseMeta\.width/.test(probe) && !/baseMeta\.width \/ baseMeta\.height - 4 \/ 3/.test(probe),
  )
  ok(
    '量「取景漂移」的脚本存在，且体检输出真的指向它（否则那是一句过期指引）',
    existsSync(DRIFT) && /cover-framing-drift\.py/.test(probe),
  )
  ok(
    '体检脚本在 --video 模式下也按 BASE_FRAME_WIDTH 抽第二份（否则底图必然被放大）',
    /width:\s*BASE_FRAME_WIDTH/.test(probe),
  )
  ok(
    '体检脚本会输出「底图 vs 成品」的并排图与 PSNR（取景是否被改必须可观测）',
    /hstack=inputs=2/.test(probe) && /psnr_avg/.test(probe),
  )

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
  if (fail > 0) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error('\n✗ 守护脚本自身出错：', (e as Error)?.message)
    process.exitCode = 1
  })
  .finally(() => process.exit(process.exitCode ?? 0))
