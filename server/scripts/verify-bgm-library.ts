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
 *   ③ **池子（`assets/bgm/<风格>/`）与单文件（`assets/bgm/<风格>.<ext>`）两个位置共用一套取用逻辑**：
 *      `resolveBgmTrack` 是「池子优先」，补货脚本却要「只找单文件」去清残留 ——
 *      两者共用一个函数就会**删掉刚攒进池子的曲子**（补一首删一首，池子永远长不大）。
 *      ⇒ 所以断言 `singleFileBgmTrack` **不看池子**，且池子非空时 `resolveBgmTrack` 一定来自池子。
 *   ④ **池子随机取用是「每条片子配乐不重样」的唯一依据**：随机一旦退化成固定取第一首，
 *      表现是「所有片子配乐都一样」，**没有任何报错**。
 *      ⇒ 所以断言多次抽取能覆盖池内全部曲子。
 *   ⑤ **火山源的 Text 仅支持中文、Duration 有区间**：提示词里混进英文、或时长调到 60s 以下，
 *      后果分别是「参数非法/质量崩」与「成片中途静音且不报错」，而这两种都只在**真花钱跑一次**时才暴露。
 *      ⇒ 所以断言提示词纯中文且排除人声、生成时长同时满足接口区间与曲库 ≥65s 硬约束、提示词条数不薄于池子目标数。
 *   ⑥ **「密钥一到就能切换」的判据本身**：`volcanoBgmConfigured()` 若把「只配了一个」也算已配置，
 *      运维会以为好了，实际每次生成都失败。⇒ 所以按闸门类用例测它，并 `finally` 还原环境变量。
 *
 *   ⑦ **补货取词会与池内已有曲子撞词**：补货按「池内数量 + 序号」取词，隐含假设「已有曲子正好
 *      占了 0..n-1 号」；而手工单发（`bgm:generate`）是随机取词的 ⇒ 池子被随机播种过之后，
 *      顺序取词就会撞上已经用过的描述，生成近乎重复的曲子，而且**不报任何错**。
 *      ⇒ 所以断言 `usedBgmPromptTexts` 能读出池内已用描述（并 trim），缺侧车/侧车坏掉时不算已用过。
 *
 * 不连库、不联网、不写任何项目文件（只在系统临时目录里造样例，`finally` 清掉）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BGM_MIN_DURATION_MS,
  BGM_POOL_TARGET,
  BGM_STYLES,
  bgmLibraryDir,
  bgmMetadataPath,
  bgmPoolDir,
  describeBgmLibrary,
  listBgmPool,
  pruneBgmPool,
  resolveBgmTrack,
  singleFileBgmTrack,
  usedBgmPromptTexts,
} from '../src/render/bgm-library.js'
import { BGM_PROMPTS, ChatCutOptionsSchema } from '../src/render/chatcut.js'
import {
  VOLCANO_BGM_MAX_SEC,
  VOLCANO_BGM_MIN_SEC,
  VOLCANO_BGM_PROMPTS,
  describeVolcanoBgmConfig,
  pickVolcanoPrompt,
  volcanoBgmConfigured,
  volcanoDurationForStyle,
} from '../src/render/volcano-bgm.js'

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

  // ── ⑧ 池子优先 + 随机取用（见文件头 ③ ④ 号理由） ──────────────────────
  // 自建一个干净的曲库根，避免与上面 ③–⑥ 造出来的单文件互相干扰
  const poolRoot = mkdtempSync(join(tmpdir(), 'dashuai-bgm-pool-'))
  const previousRoot = process.env.BGM_LIBRARY_DIR
  try {
    process.env.BGM_LIBRARY_DIR = poolRoot

    // 池子目录不存在时，`bgmPoolDir` 必须仍返回**约定路径**（补货脚本要靠它 mkdir）
    assert.equal(bgmPoolDir('LIGHT'), join(poolRoot, 'LIGHT'), '池子目录不存在时必须返回约定路径')
    assert.equal(listBgmPool('LIGHT').length, 0, '没有池子时必须返回空数组（而不是抛错）')
    assert.equal(listBgmPool('NONE').length, 0, '非法风格必须返回空数组')

    const poolDir = join(poolRoot, 'LIGHT')
    mkdirSync(poolDir, { recursive: true })
    for (const serial of [1, 2, 3]) {
      writeFileSync(join(poolDir, `LIGHT-0${serial}.mp3`), Buffer.alloc(4096, serial))
    }
    // ⚠ 池子外面**故意也放一首单文件**：要验证的是「池子优先」，不是「有池子就无视单文件」
    writeFileSync(join(poolRoot, 'LIGHT.m4a'), Buffer.alloc(2048, 9))
    // 另一个风格**只有单文件、没有池子** ⇒ 用来验证「池子为空时回退单文件」
    writeFileSync(join(poolRoot, 'UPBEAT.mp3'), Buffer.alloc(2048, 9))

    assert.equal(listBgmPool('LIGHT').length, 3, '池子里应有 3 首')
    assert.equal(listBgmPool('light').length, 3, '池子风格名大小写不敏感')

    // ★ 池子非空 ⇒ 必须 100% 命中，而且必须来自池子（不能落回单文件）
    const picks = new Set<string>()
    for (let round = 0; round < 60; round += 1) {
      const hit = resolveBgmTrack('LIGHT')
      assert.ok(hit, '池子非空时必须**一定**命中（命中与否不能随池子大小波动）')
      assert.equal(dirname(hit), poolDir, '池子非空时结果必须来自池子（池子优先于单文件）')
      picks.add(hit)
    }
    assert.equal(
      picks.size,
      3,
      `60 次抽取应覆盖池内全部 3 首，实际只抽到 ${picks.size} 首 —— 随机退化成固定取一首了（表现：所有片子配乐都一样）`,
    )

    // ★★ 临界断言：`singleFileBgmTrack` **绝不能**看到池子。
    //   若失败 ⇒ 补货脚本的「清理同风格残留」会删掉池内曲子（补一首删一首）。
    assert.equal(
      singleFileBgmTrack('LIGHT'),
      join(poolRoot, 'LIGHT.m4a'),
      'singleFileBgmTrack 必须只认单文件约定，不能返回池内文件',
    )
    // 反证：同一时刻 resolveBgmTrack 返回的是池子里的，而 singleFileBgmTrack 返回的是单文件 ⇒ 两者确实不是一回事
    assert.notEqual(
      resolveBgmTrack('LIGHT'),
      singleFileBgmTrack('LIGHT'),
      '池子非空时「找一个能用的曲子」与「找单文件」必须是两个不同结果',
    )

    // ★ 池子为空的风格 ⇒ 回退单文件（线上现存曲库正是这一档，不能被池子改动弄坏）
    assert.equal(resolveBgmTrack('UPBEAT'), join(poolRoot, 'UPBEAT.mp3'), '池子为空时必须回退到单文件兜底')
    assert.equal(resolveBgmTrack('PREMIUM'), null, '两头都没有时必须返回 null（调用方回退合成垫底）')

    // ── ⑨ 淘汰：只保留最新的 N 首，且连元数据一起删 ────────────────────────
    // 给 3 首池内曲子错开 mtime（新 → 旧的顺序：03 > 02 > 01）
    const base = Date.now() / 1000 - 3600
    ;['01', '02', '03'].forEach((serial, index) => {
      const file = join(poolDir, `LIGHT-${serial}.mp3`)
      utimesSync(file, base + index * 600, base + index * 600)
      writeFileSync(bgmMetadataPath(file), `{"style":"LIGHT","serial":"${serial}"}`, 'utf8')
    })
    assert.deepEqual(pruneBgmPool('LIGHT', 3), [], '池子未超额时不该删任何东西')
    assert.equal(listBgmPool('LIGHT').length, 3, '未超额时数量不变')

    const removed = pruneBgmPool('LIGHT', 2)
    assert.equal(removed.length, 1, '保留 2 首时应删掉 1 首')
    assert.equal(removed[0], join(poolDir, 'LIGHT-01.mp3'), '必须淘汰**最旧**的那首（保留最新）')
    assert.equal(existsSync(removed[0]), false, '被淘汰的曲子文件必须真的删掉')
    assert.equal(existsSync(bgmMetadataPath(removed[0])), false, '被淘汰曲子的 .json 元数据必须一起删（否则留下孤儿元数据）')
    assert.equal(listBgmPool('LIGHT').length, 2, '淘汰后池内剩 2 首')

    // ★ 至少保留 1 首：`keep=0` 不能把池子清空（清空就退回合成垫底，是更差的结果）
    assert.equal(pruneBgmPool('LIGHT', 0).length, 1, 'keep=0 时仍要保留 1 首')
    assert.equal(listBgmPool('LIGHT').length, 1, 'keep=0 之后池内必须还有 1 首')
    assert.deepEqual(pruneBgmPool('NONE', 1), [], '非法风格不该抛错')

    // ── ⑩ 摘要要能同时反映池子大小与单文件命中 ─────────────────────────────
    const summary = describeBgmLibrary()
    const lightEntry = summary.entries.find((entry) => entry.style === 'LIGHT')
    assert.equal(lightEntry?.poolSize, 1, 'poolSize 必须反映池内实际数量（诊断「为什么配乐不重样」靠它）')
    assert.equal(lightEntry?.file, join(poolDir, 'LIGHT-03.mp3'), 'LIGHT 有池子时应命中池内曲子')
    const upbeatEntry = summary.entries.find((entry) => entry.style === 'UPBEAT')
    assert.equal(upbeatEntry?.poolSize, 0, '没有池子的风格 poolSize 必须是 0')
    assert.equal(upbeatEntry?.file, join(poolRoot, 'UPBEAT.mp3'), '没有池子的风格要落到单文件上')

    // ── ⑪ 池内「已用过的提示词」（补货取词靠它避免生成近乎重复的曲子） ──────
    // 承接 ⑨ 之后的状态：池内只剩 LIGHT-03.mp3，侧车存在但**没有 prompt 字段**
    assert.equal(
      usedBgmPromptTexts('LIGHT').size,
      0,
      '侧车没有 prompt 字段时必须算「没用过」（算成已用过 ⇒ 补货会白白跳词）',
    )
    assert.equal(usedBgmPromptTexts('NONE').size, 0, '非法风格不该抛错')

    writeFileSync(join(poolDir, 'LIGHT-04.mp3'), Buffer.alloc(4096, 4))
    writeFileSync(bgmMetadataPath(join(poolDir, 'LIGHT-03.mp3')), JSON.stringify({ prompt: '  描述甲  ' }), 'utf8')
    writeFileSync(bgmMetadataPath(join(poolDir, 'LIGHT-04.mp3')), JSON.stringify({ prompt: '描述乙' }), 'utf8')
    const usedTexts = usedBgmPromptTexts('LIGHT')
    assert.equal(usedTexts.size, 2, `应读出 2 条已用描述，实际 ${usedTexts.size} 条`)
    assert.ok(usedTexts.has('描述甲'), '读出的描述必须 trim（否则与提示词表里的原串永远比不中，等于没跳过）')
    assert.ok(usedTexts.has('描述乙'), '应读出侧车里的描述')

    // ★★ 没有侧车 / 侧车内容坏掉 ⇒ 都当「没用过」，而且**绝不抛错**。
    //   （手放的曲子本来就没有侧车，不能因此让补货跑不动。）
    writeFileSync(join(poolDir, 'LIGHT-05.mp3'), Buffer.alloc(4096, 5))
    writeFileSync(bgmMetadataPath(join(poolDir, 'LIGHT-05.mp3')), '{ 这不是 json', 'utf8')
    assert.equal(usedBgmPromptTexts('LIGHT').size, 2, '没有侧车或侧车坏掉都不该计入「已用过」')
    assert.ok(existsSync(join(poolDir, 'LIGHT-05.mp3')), '读侧车失败绝不能删掉音频文件')
  } finally {
    if (previousRoot === undefined) delete process.env.BGM_LIBRARY_DIR
    else process.env.BGM_LIBRARY_DIR = previousRoot
    rmSync(poolRoot, { recursive: true, force: true })
  }

  // ── ⑫ 火山生成源的契约（改提示词表/时长会让生成**静默**出问题，所以断言钉在这里） ──
  assert.deepEqual(
    Object.keys(VOLCANO_BGM_PROMPTS).sort(),
    [...BGM_STYLES].sort(),
    '火山提示词表必须覆盖全部风格（少一个 ⇒ 该风格永远补不进池子）',
  )
  for (const style of BGM_STYLES) {
    const prompts = VOLCANO_BGM_PROMPTS[style]
    // ★★ 容量约束：提示词条数必须 ≥ 池子目标数。
    //   少于它 ⇒ 补货按「池内数量 + 序号」取词会绕回起点、取到同一批描述 ⇒
    //   池子里长出**近乎重复**的曲子，而且**全程不报任何错**（本项目最典型的静默失效）。
    //   ★ 断言钉在 `BGM_POOL_TARGET` 上而不是写死数字：谁把目标调大，这里就立刻红。
    assert.ok(
      prompts.length >= BGM_POOL_TARGET,
      `${style} 至少要有 ${BGM_POOL_TARGET} 条提示词（＝池子目标数），实际只有 ${prompts.length} 条 ⇒ 池子超过这个数必然重复`,
    )
    // ★ 同风格内描述必须互不相同：重复串等于直接生成两首近乎一样的曲子
    assert.equal(
      new Set(prompts).size,
      prompts.length,
      `${style} 的提示词表里有重复条目（会让池子出现重复曲子）`,
    )
    for (const prompt of prompts) {
      assert.ok(prompt.trim().length >= 8, `${style} 的提示词太短，生成质量会崩：${prompt}`)
      // ★★ 火山 GenBGM 的 `Text` **仅支持中文**：混进英文是「参数非法」或质量崩，
      //    而这两者都只在**真花钱跑一次**时才暴露 ⇒ 必须在这里挡住。
      assert.ok(!/[A-Za-z]/.test(prompt), `${style} 的提示词必须**纯中文**（该接口 Text 不支持英文）：${prompt}`)
      // ★ 配乐要垫在口播下面 ⇒ 每条提示词都必须显式排除人声，否则人声会和旁白打架
      assert.ok(
        /(没有人声|无人声|纯音乐|器乐)/.test(prompt),
        `${style} 的提示词必须显式排除人声（配乐要垫在口播下面）：${prompt}`,
      )
    }

    // ★★ Duration 必须同时满足两件事：接口的 [30,120] 与曲库的 ≥65s 硬约束。
    //   只满足接口那一条 ⇒ 生成一首 60s 的曲子进池子 ⇒ 成片 65s 时**中途静音且不报错**。
    const seconds = volcanoDurationForStyle(style)
    assert.ok(
      seconds >= VOLCANO_BGM_MIN_SEC && seconds <= VOLCANO_BGM_MAX_SEC,
      `${style} 的火山 Duration=${seconds}s 必须落在接口允许的 [${VOLCANO_BGM_MIN_SEC},${VOLCANO_BGM_MAX_SEC}] 内`,
    )
    assert.ok(
      seconds * 1000 >= BGM_MIN_DURATION_MS,
      `${style} 的生成时长 ${seconds}s 必须 ≥ 曲库硬约束 ${BGM_MIN_DURATION_MS / 1000}s（否则进池子就是中途静音）`,
    )

    // ★ 顺序取词（补货脚本用它保证「一轮内不撞词」）：必须是稳定的 `序号 % 条数` 轮转
    for (let index = 0; index < prompts.length * 2; index += 1) {
      assert.equal(
        pickVolcanoPrompt(style, index),
        prompts[index % prompts.length],
        `${style} 顺序取词必须按 % 轮转（第 ${index} 次）`,
      )
    }
    if (prompts.length > 1) {
      assert.notEqual(
        pickVolcanoPrompt(style, 0),
        pickVolcanoPrompt(style, 1),
        `${style} 相邻序号必须取到不同提示词，否则补货一轮里会生成近乎重复的曲子`,
      )
    }
  }

  // ── ⑬ 「密钥一到就能切换」的判据本身要被测到 ────────────────────────────
  // 这组是**闸门类**用例：会改环境变量，必须 finally 还原（否则串到后面的用例）。
  const savedAccessKey = process.env.VOLCENGINE_ACCESS_KEY
  const savedSecretKey = process.env.VOLCENGINE_SECRET_KEY
  try {
    delete process.env.VOLCENGINE_ACCESS_KEY
    delete process.env.VOLCENGINE_SECRET_KEY
    assert.equal(volcanoBgmConfigured(), false, '没配 AK/SK 时必须报「未配置」')
    assert.deepEqual(
      describeVolcanoBgmConfig().missing,
      ['VOLCENGINE_ACCESS_KEY', 'VOLCENGINE_SECRET_KEY'],
      '必须精确报出缺哪两个变量（否则运维不知道该去配什么）',
    )

    // 只配一半也不能算已配置 —— 「配了一个就以为好了」是最常见的误判
    process.env.VOLCENGINE_ACCESS_KEY = 'ak-verify-only'
    assert.equal(volcanoBgmConfigured(), false, '只配 AK 不算已配置')
    process.env.VOLCENGINE_SECRET_KEY = 'sk-verify-only'
    assert.equal(volcanoBgmConfigured(), true, 'AK/SK 齐全必须报「已配置」（这就是切换开关的判据）')
    assert.deepEqual(describeVolcanoBgmConfig().missing, [], '配置齐全时 missing 必须为空')
  } finally {
    if (savedAccessKey === undefined) delete process.env.VOLCENGINE_ACCESS_KEY
    else process.env.VOLCENGINE_ACCESS_KEY = savedAccessKey
    if (savedSecretKey === undefined) delete process.env.VOLCENGINE_SECRET_KEY
    else process.env.VOLCENGINE_SECRET_KEY = savedSecretKey
  }
  // 还原后不能残留（凭据串到别的用例里会让「未配置」的用例假绿）
  assert.equal(volcanoBgmConfigured(), Boolean(savedAccessKey && savedSecretKey), '环境变量必须已还原')

  console.log(
    '配乐曲库守护通过：风格集合三处同源、扩展名白名单不含元数据、空文件不命中、环境变量可还原、' +
      '池子优先且随机取用、单文件查找不看池子、淘汰保留最新并连元数据清掉、池内已用描述可读出、' +
      '火山提示词纯中文且排除人声、条数不薄于池子目标、生成时长同时满足接口与曲库硬约束、AK/SK 判据精确',
  )
}

try {
  main()
} catch (error) {
  console.error(`配乐曲库守护失败：${(error as Error).message}`)
  process.exitCode = 1
}
