// 「合成页字幕开关」守护断言。纯计算 + 源码静态检查，不碰数据库、不渲染、不联网。
//                                                        （`npm run subtitle-toggle:verify`）
//
// ★★ 防的是**一类"关了等于没关"的静默回归**：
//   合成页 2026-10-19 新增「生成字幕」开关（默认开）。关掉之后，服务端必须整条字幕链路都不跑：
//   不做原声 ASR、不做 AI 分行、不烧字幕。这条链上最贵的一步就是 ASR ——
//   如果开关只是"看着关了"而 ASR 照跑，用户既没得到字幕、也没省下时间，是最坏的形态。
//
//   具体三个失守点，任一处回来就红：
//     ① `resolveAutoChatcutOptions` 又把 `subtitles/subtitleMode` 写死成开
//        （AUTO 档的唯一裁决入口，前端传 OFF 会被它悄悄改回来）；
//     ② 只认 `subtitles === false`、不认 `subtitleMode === 'OFF'`（或反过来），
//        于是某一版客户端的关闭请求重新变成"关不掉"；
//     ③ `synthesis` 里 OFF 分支被改掉（例如 `subtitleMode !== 'VOICE'` 之类的松动），
//        字幕文本重新被收集、ASR 重新被触发。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAutoChatcutOptions } from '../src/render/auto-edit.js'
import { DEFAULT_CHATCUT_OPTIONS, type ChatCutOptions } from '../src/render/chatcut.js'

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

/** 前端在合成页实际会发出来的那一份（与 apps/mini/src/pages/render/compose.tsx 的 DEFAULT_CHATCUT 同形） */
const CLIENT_DEFAULT: ChatCutOptions = {
  ...DEFAULT_CHATCUT_OPTIONS,
  voiceId: 'none',
  editMode: 'AUTO',
  subtitles: true,
  subtitleMode: 'SOURCE_AUDIO',
  subtitleStyle: 'CLEAN',
  transitions: 'SMOOTH',
  removeSilence: true,
  normalizeAudio: true,
  clipPrep: 'ORIGINAL',
  note: '',
}

const resolve = (patch: Partial<ChatCutOptions>) =>
  resolveAutoChatcutOptions({ ...CLIENT_DEFAULT, ...patch }, 'DISH', [])

console.log('\n[1] AUTO 裁决：默认仍开着字幕（不改变原来的出片行为）')
{
  const out = resolve({})
  check('默认 ⇒ subtitles 仍为 true', out.subtitles === true, `实际 ${out.subtitles}`)
  check("默认 ⇒ subtitleMode 仍为 SOURCE_AUDIO（按原声 ASR）", out.subtitleMode === 'SOURCE_AUDIO', `实际 ${out.subtitleMode}`)
  check('默认 ⇒ 其余强制项照旧（voiceId=none / CLEAN / NATURAL）', out.voiceId === 'none' && out.subtitleStyle === 'CLEAN' && out.pacing === 'NATURAL', JSON.stringify({ voiceId: out.voiceId, subtitleStyle: out.subtitleStyle, pacing: out.pacing }))
}

console.log("\n[2] AUTO 裁决：用户关掉字幕 ⇒ 必须保持关（两个字段任一为关都算）")
{
  const byMode = resolve({ subtitleMode: 'OFF', subtitles: true })
  check("只传 subtitleMode:'OFF' ⇒ subtitles 变 false", byMode.subtitles === false, `实际 ${byMode.subtitles}`)
  check("只传 subtitleMode:'OFF' ⇒ subtitleMode 仍为 OFF（不被改回 SOURCE_AUDIO）", byMode.subtitleMode === 'OFF', `实际 ${byMode.subtitleMode}`)

  const byBool = resolve({ subtitles: false, subtitleMode: 'SOURCE_AUDIO' })
  check('只传 subtitles:false ⇒ subtitleMode 归 OFF', byBool.subtitleMode === 'OFF', `实际 ${byBool.subtitleMode}`)
  check('只传 subtitles:false ⇒ subtitles 仍为 false', byBool.subtitles === false, `实际 ${byBool.subtitles}`)

  const both = resolve({ subtitles: false, subtitleMode: 'OFF' })
  check('两个都传关 ⇒ 仍然是关', both.subtitles === false && both.subtitleMode === 'OFF', JSON.stringify(both))
}

console.log('\n[3] 关闭字幕不得顺带改坏别的项（用户只关了字幕这一件）')
{
  const off = resolve({ subtitleMode: 'OFF' })
  check('voiceId 仍强制 none（不配音）', off.voiceId === 'none', `实际 ${off.voiceId}`)
  check('subtitleStyle 仍 CLEAN（下次开回来不用重新选）', off.subtitleStyle === 'CLEAN', `实际 ${off.subtitleStyle}`)
  check('pacing / transitions / normalizeAudio 不受影响', off.pacing === 'NATURAL' && off.transitions === 'CLEAN' && off.normalizeAudio === true, JSON.stringify({ pacing: off.pacing, transitions: off.transitions, normalizeAudio: off.normalizeAudio }))
  check('bgm 仍按素材画像给（字幕与配乐是两件事）', off.bgm === 'UPBEAT', `实际 ${off.bgm}`)
}

console.log('\n[4] 接线态：synthesis 里 OFF 分支必须是"什么都不做"')
{
  const synthesis = await src('src/render/synthesis.ts')
  check(
    "subtitleMode==='OFF' ⇒ aiLines 直接为 null（不调 AI 分行）",
    /subtitleMode === 'OFF'\s*\?\s*null/.test(synthesis),
    '找不到 `subtitleMode === \'OFF\' ? null`',
  )
  check(
    "subtitleMode==='OFF' ⇒ 字幕片段归零（不烧字幕）",
    /subtitleMode === 'OFF'\s*\n?\s*\?\s*\[\]/.test(synthesis),
    "找不到 `subtitleMode === 'OFF' ? []`",
  )
  check(
    "原声 ASR 只在 SOURCE_AUDIO / VOICE_AND_SOURCE 下触发（OFF 不在其中）",
    /subtitleMode === 'SOURCE_AUDIO' \|\| subtitleMode === 'VOICE_AND_SOURCE'/.test(synthesis),
    '这条 guard 被改动过：OFF 可能又会被拉去做 ASR',
  )
  check(
    '字幕文本收集在 OFF 时被跳过（voice 分支同样只认 VOICE / VOICE_AND_SOURCE）',
    /subtitleMode === 'VOICE' \|\| subtitleMode === 'VOICE_AND_SOURCE'/.test(synthesis),
    'voice 分支的 guard 被改动过',
  )
}

console.log('\n[5] 接线态：worker 用裁决后的 effectiveChatcut 判字幕')
{
  const worker = await src('src/render/worker.ts')
  check(
    'worker 的字幕开关取自 effectiveChatcut（不是原始 p.chatcut）',
    /effectiveChatcut\.subtitles === false/.test(worker),
    '找不到 `effectiveChatcut.subtitles === false`',
  )
  check(
    'AUTO 档确实经过 resolveAutoChatcutOptions',
    /resolveAutoChatcutOptions\(/.test(worker),
    'AUTO 档绕过了裁决函数 ⇒ 前端 OFF 会原样透传或反过来被忽略',
  )
}

console.log('')
if (failures.length) {
  console.log(`✗ 字幕开关守护：${failures.length} 项失败（通过 ${pass} 项）`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exit(1)
}
console.log(`✓ 字幕开关守护全部通过（${pass} 项）`)
