/**
 * 配乐曲库守护 —— `npm run bgm:verify`
 *
 * 为什么需要它（都是**已经真实发生过**的那类事故）：
 *   ① **同一份集合被抄成三份**：`BGM_STYLES`、`ChatCutOptionsSchema.shape.bgm` 的枚举、
 *      `BGM_PROMPTS` 的 key。加一个风格只改其中两处，就会得到
 *      「曲库认得、但生成时取不到 prompt」这类只在运行时才炸的错。
 *      ⇒ 所以判据**不抄清单**，直接问 Zod schema 要枚举值（唯一的真源）。
 *   ② **`<STYLE>.json` 元数据与 `<STYLE>.mp3` 曲子同目录**：扩展名白名单一旦写松
 *      （例如允许 `json`，或按前缀匹配），渲染就会把元数据当成音频喂给 ffmpeg，
 *      症状是「配乐静默变成垫底」或 ffmpeg 报错 —— 很难往「曲库」上想。
 *      ⇒ 所以专门断言「只有 json 时必须解析不到」。
 *
 * 不连库、不联网、不写任何项目文件（只在系统临时目录里造样例，`finally` 清掉）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BGM_STYLES,
  bgmLibraryDir,
  bgmMetadataPath,
  describeBgmLibrary,
  resolveBgmTrack,
} from '../src/render/bgm-library.js'
import { BGM_PROMPTS, ChatCutOptionsSchema } from '../src/render/chatcut.js'

function main(): void {
  // ── ① 三份清单必须同源 ────────────────────────────────────────────────
  // 真源 = ChatCutOptions 的 bgm 枚举去掉 NONE（它是提交入参的校验器，改它才能改行为）
  const bgmField = ChatCutOptionsSchema.shape.bgm
  assert.ok(bgmField, 'ChatCutOptionsSchema 里必须有 bgm 字段')
  const enumValues = (bgmField as unknown as { options: string[] }).options
  const expected = enumValues.filter((value) => value !== 'NONE').sort()
  assert.deepEqual(
    [...BGM_STYLES].sort(),
    expected,
    `BGM_STYLES 必须等于 ChatCutOptions.bgm 去掉 NONE：曲库=${BGM_STYLES.join('/')} 枚举=${enumValues.join('/')}`,
  )
  assert.deepEqual(
    Object.keys(BGM_PROMPTS).sort(),
    expected,
    'BGM_PROMPTS 的 key 必须与风格集合完全一致（少一个 ⇒ 生成时取不到提示词）',
  )
  for (const style of BGM_STYLES) {
    assert.ok((BGM_PROMPTS[style] ?? '').trim().length > 0, `${style} 的生成提示词不能为空`)
  }

  // ── ② 未知风格 / 空值一律解析不到（不能抛错） ──────────────────────────
  for (const bad of [undefined, null, '', '   ', 'NONE', 'none', 'RANDOM', 42 as unknown as string]) {
    assert.equal(resolveBgmTrack(bad), null, `非法风格 ${String(bad)} 必须解析为 null`)
  }

  const dir = mkdtempSync(join(tmpdir(), 'dashuai-bgm-verify-'))
  const previous = process.env.BGM_LIBRARY_DIR
  try {
    process.env.BGM_LIBRARY_DIR = dir
    assert.equal(bgmLibraryDir(), dir, 'BGM_LIBRARY_DIR 必须优先生效')

    // ── ③ 只有元数据 json、没有音频 ⇒ 必须解析不到（见文件头 ② 号理由） ──
    writeFileSync(join(dir, 'LIGHT.json'), '{"style":"LIGHT"}', 'utf8')
    assert.equal(resolveBgmTrack('LIGHT'), null, '只有 <STYLE>.json 时不能把元数据当成曲子')
    assert.equal(bgmMetadataPath('/x/y/LIGHT.mp3'), '/x/y/LIGHT.json', '元数据路径 = 同目录同名换 .json')

    // ── ④ 放了音频就能解析到，且大小写不敏感 ─────────────────────────────
    writeFileSync(join(dir, 'LIGHT.mp3'), Buffer.alloc(4096, 7))
    assert.equal(resolveBgmTrack('LIGHT'), join(dir, 'LIGHT.mp3'), '放了 LIGHT.mp3 就能解析到')
    assert.equal(resolveBgmTrack('light'), join(dir, 'LIGHT.mp3'), '风格名大小写不敏感')

    // ── ⑤ 空文件不算命中（半截下载不能拿去当配乐） ────────────────────────
    writeFileSync(join(dir, 'UPBEAT.mp3'), Buffer.alloc(0))
    assert.equal(resolveBgmTrack('UPBEAT'), null, '0 字节的文件不能算命中')
    // 同时存在同风格的两个扩展名时，按白名单优先级取（mp3 在 m4a 前）
    writeFileSync(join(dir, 'UPBEAT.m4a'), Buffer.alloc(2048, 1))
    assert.equal(resolveBgmTrack('UPBEAT'), join(dir, 'UPBEAT.m4a'), '同风格只有 m4a 时取 m4a')

    // ── ⑥ 曲库现状摘要能同时反映「有」与「缺」 ────────────────────────────
    const summary = describeBgmLibrary()
    assert.equal(summary.dirExists, true, '目录存在时 dirExists 必须为 true')
    assert.deepEqual(
      summary.entries.map((entry) => entry.style).sort(),
      [...BGM_STYLES].sort(),
      '摘要必须覆盖全部风格（缺的也要列出来，否则排查时看不到缺口）',
    )
    const light = summary.entries.find((entry) => entry.style === 'LIGHT')
    assert.equal(light?.file, join(dir, 'LIGHT.mp3'), 'LIGHT 应命中')
    assert.equal(light?.note, null, '没有元数据时 note 必须为 null（不能抛错）')
  } finally {
    // 闸门类用例必须还原：环境变量与临时目录都不留给后续用例
    if (previous === undefined) delete process.env.BGM_LIBRARY_DIR
    else process.env.BGM_LIBRARY_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }

  // ── ⑦ 还原之后不残留环境变量 ──────────────────────────────────────────
  assert.notEqual(bgmLibraryDir(), dir, 'BGM_LIBRARY_DIR 必须已还原（否则会串到别的用例）')

  console.log('配乐曲库守护通过：风格集合三处同源、扩展名白名单不含元数据、空文件不命中、环境变量可还原')
}

try {
  main()
} catch (error) {
  console.error(`配乐曲库守护失败：${(error as Error).message}`)
  process.exitCode = 1
}
