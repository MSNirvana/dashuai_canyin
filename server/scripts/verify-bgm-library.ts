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
 *   ⑧ **按内容选曲是一次「候选清单下标」的往返**：服务把候选写成**带编号的清单**交给模型，
 *      模型回一个下标，服务拿它去 `candidates[index]` 取文件。以下几种写法**全都不会报错**，
 *      只会让片子配上另一首歌，或者「永远选第一首」变成一条谁也没定过的规律：
 *        · 编号从 1 开始（或只给描述不给编号）⇒ 稳定偏一首
 *        · 候选顺序与 `listBgmPool` 不同（下标与文件错位）
 *        · 没有描述的候选把 `null` 渲染进提示词（模型把字面量当成曲风特征）
 *        · 下标越界后**夹取**而不是判非法 ⇒ 把「模型写了 9」变成「永远选第一首」
 *      ⇒ 所以断言：清单严格从 0 编号且逐行对应、候选与 `listBgmPool` 严格同序、无描述写占位而非
 *      `null`；`parseBgmChoice` 对越界 / 非整数 / 非 JSON / 缺字段一律返回 `null`（退回随机抽取），
 *      并且**绝不抛错**（`count` 非法也不行）。
 *
 *   ⑨ **「别重样」这件事光靠随机做不到**：随机**没有记忆** —— 同时出片的几条片子两两撞同一首的
 *      概率仍是 `1/N`；而用户真正会察觉的是「**我这个店**连着几条重样」（生日问题：池子再大也躲
 *      不掉短期重叠）。更要紧的是：`index = f(门店, 时间)` 这类**纯函数救不了并发撞车** ——
 *      碰撞概率一样是 `1/N`，而且映射相同的那一对门店会**永久**撞在一起（比随机更差）。
 *      ⇒ 必须有**共享的分配状态**在中间协调。所以断言派发器：**完整轮转**（池子遍历一遍才回到起点，
 *      因而池里每一首都用得上）、相邻两次派发**必然**不同首、门店历史是**硬过滤**、历史把候选占满时
 *      **放宽而不是返回空**（宁可重样也不能没有配乐）、LRU 容量为 0 时退化成「永远取第一首」
 *      （证明容量是个真旋钮）、`note()` 能让 AI 选走的那首也进出口径；以及门店历史的过滤
 *      **只认池子目录** —— `LIGHT.mp3` 这种单文件混进来会白占一个避开位。
 *      ⚠ 特别注意「完整轮转」这条：最初写成「避开最近 3 首 + 取第一个可用」时，池子里第 5 首
 *      **永远轮不到**（窗口一放宽队首又可用，序列稳定落在 `A B C D A B C D…`）—— 比随机更浪费。
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
  describeBgmCandidates,
  describeBgmLibrary,
  listBgmPool,
  pruneBgmPool,
  resolveBgmTrack,
  singleFileBgmTrack,
  usedBgmPromptTexts,
} from '../src/render/bgm-library.js'
import { buildBgmOptionText, parseBgmChoice } from '../src/render/bgm-choice.js'
import {
  BGM_HISTORY_AVOID,
  BGM_LRU_CAPACITY,
  createBgmAllocator,
  filterTracksByStyle,
  pickLeastRecent,
} from '../src/render/bgm-dispatch.js'
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

    // ── ⑫ 候选清单：选曲服务把「每首长什么样」交给模型的唯一依据 ──────────────
    // 承接 ⑪ 之后的状态：03/04 有描述（甲/乙），05 的侧车是坏的
    const described = describeBgmCandidates('LIGHT')
    assert.equal(described.length, 3, `候选数必须等于池内曲子数，实际 ${described.length}`)
    // ★★ 顺序即下标。模型返回的是下标，这里一旦重排，同样的返回值就指向了另一首曲子 ——
    //    「配乐选错」但**不报任何错**，是最难查的一类。所以必须与 listBgmPool 严格同序。
    assert.deepEqual(
      described.map((candidate) => candidate.file),
      listBgmPool('LIGHT'),
      '候选顺序必须与 listBgmPool 完全一致（顺序 = 下标，重排 ⇒ 静默选错曲子）',
    )
    assert.deepEqual(
      described.map((candidate) => candidate.note),
      ['描述甲', '描述乙', null],
      '描述必须逐首对应；侧车坏掉的那一首必须为 null（被算成有描述 ⇒ 模型会拿一个假特征做判断）',
    )
    assert.deepEqual(describeBgmCandidates('NONE'), [], '非法风格必须返回空数组而不是抛错')
    for (const badStyle of [undefined, null, '']) {
      assert.deepEqual(describeBgmCandidates(badStyle), [], `空风格 ${String(badStyle)} 必须返回空数组`)
    }
  } finally {
    if (previousRoot === undefined) delete process.env.BGM_LIBRARY_DIR
    else process.env.BGM_LIBRARY_DIR = previousRoot
    rmSync(poolRoot, { recursive: true, force: true })
  }

  // ── ⑬ 火山生成源的契约（改提示词表/时长会让生成**静默**出问题，所以断言钉在这里） ──
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

  // ── ⑭ 「密钥一到就能切换」的判据本身要被测到 ────────────────────────────
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

  // ── ⑮ 选曲的「清单编号」与「下标解析」—— 选错歌要在这里挡住，不能等线上（见文件头 ⑧） ──
  // 这两个函数是**纯的**（不连库、不联网、不读文件），所以能被这个不连库的守护直接测。
  const options = buildBgmOptionText([
    { file: '/x/LIGHT-1.mp3', note: '轻快尤克里里' },
    { file: '/x/LIGHT-2.mp3', note: '舒缓钢琴' },
    { file: '/x/LIGHT-3.mp3', note: null },
  ])
  assert.equal(
    options.split('\n')[0],
    '0. 轻快尤克里里',
    '候选清单必须从 **0** 开始编号 —— 从 1 开始不会报错，只会让每次选曲都稳定偏一首',
  )
  assert.ok(options.includes('1. 舒缓钢琴'), '每一首候选都要带上自己的编号与描述')
  assert.equal(options.trim().split('\n').length, 3, '候选几首就写几行（漏行 ⇒ 编号与下标错位）')
  assert.ok(
    !options.includes('null'),
    '没有描述的候选不能把 null 渲染进提示词（模型会把字面量当成一种曲风特征）',
  )

  // 正常返回
  assert.deepEqual(parseBgmChoice('{"index":2,"reason":"更贴"}', 3), { index: 2, reason: '更贴' })
  // ★ 被 Markdown 代码块/解释包着也要认得出来 —— 模型经常这么写，解析不出来就等于每次白花钱
  assert.deepEqual(
    parseBgmChoice('好的，我选第 1 首：\n```json\n{"index":1,"reason":"x"}\n```', 3),
    { index: 1, reason: 'x' },
    '被代码块包住的 JSON 必须仍能解析',
  )
  assert.equal(parseBgmChoice('{"index":"0"}', 3)?.index, 0, 'index 写成字符串也要认（模型偶尔加引号）')
  assert.equal(parseBgmChoice('{"index":2}', 3)?.reason, '', '没有 reason 时给空串，不能因此判失败')
  assert.ok(
    (parseBgmChoice(`{"index":0,"reason":"${'长'.repeat(200)}"}`, 3)?.reason.length ?? 999) <= 80,
    'reason 会进日志，必须截断',
  )

  // ★★ 越界 / 非法一律 null（调用方据此退回**随机抽取**），**绝不夹取**：
  //   夹到 0 会把「模型写了 9」变成「永远选第一首」—— 那是把一个可见的错误
  //   换成一条看不见的规律，比直接退回随机更糟。
  for (const bad of [
    '{"index":3}', // == count，越界
    '{"index":-1}',
    '{"index":9}',
    '{"index":1.5}',
    '{"index":"abc"}',
    '{}',
    '{"reason":"只有理由没有下标"}',
    '"index":0', // 没有花括号
    '{"index":0', // 半截 JSON
    '{bad json}',
    '不是 JSON',
    '',
  ]) {
    assert.equal(parseBgmChoice(bad, 3), null, `非法返回必须解析为 null（退回随机抽取）：${bad}`)
  }
  // count 本身非法时也**绝不能抛错**（它是从候选数来的，候选为 0 时就是 0）
  for (const badCount of [0, -1, 1.5, Number.NaN]) {
    assert.equal(parseBgmChoice('{"index":0}', badCount), null, `count=${badCount} 必须返回 null 而不是抛错`)
  }

  // ── ⑯ 派发器 + 门店历史过滤（见文件头 ⑨）—— 同样是不连库的纯逻辑 ──────────────
  const cands = ['a', 'b', 'c', 'd', 'e']
  assert.equal(pickLeastRecent([], []), null, '没有候选必须返回 null，让调用方去走单文件兜底')
  assert.equal(pickLeastRecent(cands, []), 'a', '都没用过时取顺序里第一个（结果必须完全确定）')
  assert.equal(pickLeastRecent(['a', 'b'], ['a']), 'b', '刚用过的必须让位给没用过的')
  assert.equal(pickLeastRecent(['a', 'b'], ['b', 'a']), 'a', '两首都用过时取**最久**的那首（不是随便一首）')
  assert.equal(
    pickLeastRecent(['a', 'b', 'c'], ['b']),
    'a',
    '从没用过的优先级最高 —— 否则新补进池子的曲子会永远轮不到',
  )

  const alloc = createBgmAllocator()
  const seq: string[] = []
  for (let i = 0; i < 10; i += 1) {
    const hit = alloc.dispatch(cands)
    assert.ok(hit, `第 ${i} 次派发不该返回 null`)
    seq.push(hit.file)
  }
  // ★★ 这一条是整段改动的核心保证：随机抽取做不到「5 次覆盖全池且相邻必不同」
  assert.equal(new Set(seq.slice(0, 5)).size, 5, '前 5 次必须覆盖全池（稳定轮转；随机抽样做不到）')
  for (let i = 1; i < seq.length; i += 1) {
    assert.notEqual(seq[i], seq[i - 1], `相邻两次派发必须不同首（第 ${i} 次）—— 这就是并发不撞车的保证`)
  }
  assert.deepEqual(
    seq,
    ['a', 'b', 'c', 'd', 'e', 'a', 'b', 'c', 'd', 'e'],
    '必须是**完整轮转**：池子里每一首都用得上，且遍历一遍才回到起点',
  )

  // ★ 该门店的历史是**硬过滤**：传进来的必须真的被避开
  assert.equal(createBgmAllocator().dispatch(cands, ['a'])?.file, 'b', 'exclude 里的曲子必须被跳过')
  // ★ 历史把候选占满 ⇒ 放宽（宁可重样，也不能没有配乐），而不是返回 null
  const relaxedHit = createBgmAllocator().dispatch(['a'], ['a'])
  assert.equal(relaxedHit?.file, 'a', '候选被历史占满时必须放宽，而不是派不出配乐')
  assert.equal(relaxedHit?.relaxed, true, '放宽这一事实必须能被日志看见（`relaxed` 字段）')

  // ★ 容量是个**真旋钮**：置 0 就退化成「永远取第一个」（证明记忆确实在起作用）
  const noMemory = createBgmAllocator(0)
  assert.equal(noMemory.dispatch(cands)?.file, 'a')
  assert.equal(noMemory.dispatch(cands)?.file, 'a', 'LRU 容量为 0 时必须退化成固定取第一首')

  // ★ AI 选曲绕过派发器，必须能把「它选走的那首」回填进使用次序，否则紧接着的派发会又发同一首
  const alloc2 = createBgmAllocator()
  assert.equal(alloc2.dispatch(cands)?.file, 'a')
  alloc2.note('c')
  assert.notEqual(alloc2.dispatch(cands)?.file, 'c', 'note() 记过的曲子必须被后续派发避开')
  alloc2.reset()
  assert.equal(alloc2.dispatch(cands)?.file, 'a', 'reset() 后记忆必须清空（测试之间不能互相串）')

  // ★ 池子只有 1~2 首时：既不能返回 null、也不能死循环（2 首必须交替）
  const tiny = createBgmAllocator()
  const tinySeq: string[] = []
  for (let i = 0; i < 4; i += 1) {
    const hit = tiny.dispatch(['a', 'b'])
    assert.ok(hit, '池子只有 2 首时也必须派得出来')
    tinySeq.push(hit.file)
  }
  assert.deepEqual(tinySeq, ['a', 'b', 'a', 'b'], '池子只有 2 首时必须交替，而不是只发第一首')
  assert.ok(createBgmAllocator().dispatch(['a']), '池子只有 1 首时也必须派得出来')

  assert.ok(BGM_HISTORY_AVOID >= 1, '门店历史的避开深度至少要是 1，否则「避开最近用过的」整体失效')
  assert.ok(BGM_LRU_CAPACITY >= 16, 'LRU 容量必须明显大于常见池子大小，否则轮转会退化成「只在前几首里转」')

  // ── 门店历史过滤：**只认池子目录**（单文件与别的风格都不是候选，绝不能占避开位） ──
  const lightDir = bgmPoolDir('LIGHT')
  const upbeatDir = bgmPoolDir('UPBEAT')
  const light1 = join(lightDir, 'LIGHT-1.wav')
  const light2 = join(lightDir, 'LIGHT-2.wav')
  const light3 = join(lightDir, 'LIGHT-3.wav')
  const light4 = join(lightDir, 'LIGHT-4.wav')
  const mixed = [
    light4,
    light3,
    'LIGHT.mp3', // ← 单文件约定：**不是**池内候选
    join(upbeatDir, 'UPBEAT-1.wav'), // ← 别的风格
    null,
    '',
    light2,
    light1,
  ]
  assert.deepEqual(
    filterTracksByStyle(mixed, 'LIGHT'),
    [light4, light3, light2],
    '必须只挑同风格池子目录里的路径、保持原顺序、默认取最近几首（单文件与别的风格都要剔掉）',
  )
  assert.deepEqual(filterTracksByStyle(mixed, 'LIGHT', 2), [light4, light3], 'limit 必须生效')
  assert.deepEqual(filterTracksByStyle(mixed, 'PREMIUM'), [], '没有该风格的历史时必须返回空数组')
  assert.deepEqual(filterTracksByStyle(mixed, 'LIGHT', 0), [], 'limit=0 必须返回空')
  assert.deepEqual(filterTracksByStyle(mixed, null), [], '没有风格时返回空（别把别的风格当成要避开的）')
  assert.deepEqual(filterTracksByStyle(mixed, 'NONE'), [], '非法风格名返回空（它本来就没有池子）')

  console.log(
    '配乐曲库守护通过：风格集合三处同源、扩展名白名单不含元数据、空文件不命中、环境变量可还原、' +
      '池子优先且随机取用、单文件查找不看池子、淘汰保留最新并连元数据清掉、池内已用描述可读出、' +
      '候选描述与候选清单严格同序、选曲清单从 0 编号、下标解析越界不夹取且不抛错、' +
      '火山提示词纯中文且排除人声、条数不薄于池子目标、生成时长同时满足接口与曲库硬约束、AK/SK 判据精确、' +
      '派发器完整轮转且相邻必不同、门店历史是硬过滤且占满时放宽、LRU 容量可关、历史过滤只认池子目录',
  )
}

try {
  main()
} catch (error) {
  console.error(`配乐曲库守护失败：${(error as Error).message}`)
  process.exitCode = 1
}
