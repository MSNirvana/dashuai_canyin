/**
 * AI 通道故障转移验证：主通道挂掉 → 自动切备用；主通道恢复 → 自动切回。
 *
 * 背景（本轮改动）：
 *   failover 机制本来就有（AiGateway.runScene 按 [defaultModelId, ...fallbackModelIds]
 *   依次尝试），但**只靠失败率熔断**跳过坏通道 —— 而失败率熔断要求滑动窗口内至少
 *   minSamples(20) 个样本。低频场景（如 copy_intro，一天几次）几小时都攒不满 20 个，
 *   于是「自动切换」名义上有、体验上没有：每个请求都要先在坏通道上干等一次
 *   ai_scene.timeout_ms（默认 30s）才轮到备用。
 *
 *   本轮补上「通道级硬故障立即熔断」（gateway.ts::isChannelLevelFailure）：
 *   超时 / 连不上 / 401 / 403 / 429 / 5xx → 当场熔断该通道并**放弃它剩余的重试**，
 *   直接换下一个候选。
 *
 * 为什么「恢复后自动切回」不需要额外代码：
 *   熔断是 Redis 里一个 TTL=openSeconds(300s) 的 key，到期自动消失。
 *   网关每次请求都重新读 isOpen()，所以没有「永久粘在备用通道」的粘性状态 ——
 *   主通道一到期就重新参与，试成功即为主通道。
 *
 *   ★ openSeconds 必须 ≥「单场景最坏一次尝试的耗时」，不能比它短：
 *     熔断的意义是「别在坏通道上反复浪费用户时间」，而每次白试的代价就是
 *     `ai_scene.timeout_ms`（分镜 90s）。TTL=60s 时，坏通道每 60 秒被重新试一次，
 *     省下的时间还不如放过的时间多 —— 熔断形同虚设。
 *     2026-09-16 实测：主通道 tokenbox-gpt 直连探测 10s 超时（不可用），
 *     连续三次文案调用仍全部先试它再退备用，分镜请求每次白付 90 秒。
 *     故调为 300s（= 滑动窗口），并保留「到期即自动切回」的语义。
 *
 * 用例（③~⑥ 全部用临时数据，不碰任何真实场景）：
 *   ① isChannelLevelFailure 判定矩阵
 *   ② 生产配置核对：所有场景候选链 = [GPT, Claude, DeepSeek]，无历史通道仍在启用
 *   ③ ★ 主通道不可用 → 落到备用；主通道只试 1 次就放弃（不是 maxRetries+1 次）；
 *      且当场被熔断、熔断 key 的 TTL ≤ openSeconds
 *   ④ 熔断期内再请求 → 直接跳过主通道（attempts=1），不再白等
 *   ⑤ 熔断到期（删 key 等价）→ 又去试主通道（attempts=2）⇒ 自动切回、无粘性
 *   ⑥ 候选顺序由 ai_scene 的数组决定，**与 ai_provider.priority 无关**
 *   ⑦ ★ 空正文（HTTP 200 + content=''）必须算失败 → 转备用。
 *      这是本轮的另一个真实缺陷：中转站把 max_tokens 同时当「思考+正文」预算，
 *      推理模型思考吃满预算就返回空正文；只校验「content 是字符串」会放过它，
 *      于是网关当成功、业务层照常扣积分、商户拿到空文案。
 *   ⑧ 三个真实通道冒烟（判定闸门是「至少一条可用」，因为容错本就是设计目标）
 *   ⑨ 熔断器默认参数回归（openSeconds / minSamples / failThreshold）
 *
 * 期望：全绿。⑧ 里某条通道偶发失败属上游抖动，重跑即可确认，不算配置错误。
 *
 * 跑法：npx tsx scripts/verify-ai-failover.ts
 *      SKIP_LIVE=1 npx tsx scripts/verify-ai-failover.ts   # 跳过真实调用的冒烟测试
 */
import 'dotenv/config'
import { createServer } from 'node:http'
import { prisma, redis } from '../src/db.js'
import { CircuitBreaker, DEFAULT_CIRCUIT } from '../src/ai/circuit-breaker.js'
import { AiGateway, isChannelLevelFailure } from '../src/ai/gateway.js'
import { AiCallError } from '../src/ai/adapters.js'
import { encryptSecret } from '../src/lib/secret.js'
import { normalizeModelCapability } from '../src/ai/model-capabilities.js'

const SCENE = 'verify_failover_tmp'
const PROV_PRIMARY = 'verify-fo-primary'
const PROV_BACKUP = 'verify-fo-backup'
const MODEL_PRIMARY = 'verify-fo-primary-model'
const MODEL_BACKUP = 'verify-fo-backup-model'
const REQ_PREFIX = 'verify-fo-'
/**
 * 「连不上」的通道地址：端口 1 上没有任何服务 ⇒ 被 RST ⇒ 适配器立即归为 NETWORK
 * （通道级故障 ⇒ 当场熔断，不占场景超时）。
 *
 * ★ 这里**不能**再用 `http://127.0.0.1:1/v1`（本脚本原来就是这么写的，已失效）：
 *   `adapters.postJson` 走的是 `safeFetch`，而 `lib/outbound-url.ts` 的 SSRF 闸门会
 *   在**发出任何请求之前**就把 loopback / 私网 / 保留地址拒掉，抛 `UnsafeOutboundUrlError`
 *   ⇒ 适配器归为 `UNSAFE_URL`，**不是通道级故障** ⇒ 用例③④⑤ 想验证的「立即熔断」
 *   永远触发不了（症状是 attempts=4、熔断 key 不存在、TTL=-2）。
 *   改成公网地址后仍不可达（端口关闭），但错误类型回到了 NETWORK。
 *   若运行环境对 8.8.8.8 做了丢包而非 RST，也会得到 TIMEOUT —— 同样是通道级故障，用例仍然成立。
 */
const BLACKHOLE = 'http://8.8.8.8:1/v1'

const circuit = new CircuitBreaker(redis)
const gateway = new AiGateway(prisma, redis, circuit)

let pass = 0
let fail = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? `  ${extra}` : ''}`)
  }
}

async function cleanup() {
  await prisma.aiCallLog.deleteMany({ where: { requestId: { startsWith: REQ_PREFIX } } })
  await prisma.aiScene.deleteMany({ where: { code: SCENE } })
  const codes = [PROV_PRIMARY, PROV_BACKUP, 'verify-fo-empty']
  const provs = await prisma.aiProvider.findMany({ where: { code: { in: codes } }, select: { id: true } })
  for (const p of provs) await circuit.reset(p.id)
  await prisma.aiModel.deleteMany({
    where: { modelCode: { in: [MODEL_PRIMARY, MODEL_BACKUP, 'verify-fo-empty-model'] } },
  })
  await prisma.aiProvider.deleteMany({ where: { code: { in: codes } } })
}

// ────────────────────────────────────────────────────────────────
console.log('\n=== ① isChannelLevelFailure 判定矩阵 ===')
{
  const t = (label: string, err: AiCallError, want: boolean) =>
    check(isChannelLevelFailure(err) === want, label, `→ ${isChannelLevelFailure(err)}`)

  t('TIMEOUT（超时）', new AiCallError('timeout', undefined, 'TIMEOUT'), true)
  t('NETWORK（连不上）', new AiCallError('ECONNREFUSED', undefined, 'NETWORK'), true)
  t('HTTP 401（密钥无效）', new AiCallError('HTTP 401', 401, 'HTTP_ERROR'), true)
  t('HTTP 403（无权）', new AiCallError('HTTP 403', 403, 'HTTP_ERROR'), true)
  t('HTTP 429（限流）', new AiCallError('HTTP 429', 429, 'HTTP_ERROR'), true)
  t('HTTP 500（对端故障）', new AiCallError('HTTP 500', 500, 'HTTP_ERROR'), true)
  t('HTTP 503（对端不可用）', new AiCallError('HTTP 503', 503, 'HTTP_ERROR'), true)
  t('BAD_RESPONSE（报文异常，不该熔断）', new AiCallError('bad', undefined, 'BAD_RESPONSE'), false)
  t('HTTP 400（请求本身有问题，不该熔断）', new AiCallError('HTTP 400', 400, 'HTTP_ERROR'), false)
  t('HTTP 404（路径错，不该熔断）', new AiCallError('HTTP 404', 404, 'HTTP_ERROR'), false)
  t('无 code 无 status（不该熔断）', new AiCallError('unknown'), false)
}

// ────────────────────────────────────────────────────────────────
console.log('\n=== ② 生产配置核对（全部启用场景的主备链，按能力分开断言）===')
let gptModelId = 0n
let claudeModelId = 0n
let deepseekModelId = 0n
{
  const chans = await prisma.aiProvider.findMany({
    where: { code: { in: ['tokenbox-gpt', 'tokenbox-claude', 'tokenbox-deepseek'] }, enabled: true },
    include: { models: { where: { enabled: true } } },
  })
  check(chans.length === 3, '三个 tokenbox 通道均已启用', `实际 ${chans.length} 个`)
  check(
    chans.every((c) => c.protocol === 'OPENAI_COMPATIBLE' && c.baseUrl === 'https://tokenbox.you/v1'),
    '协议 = OPENAI_COMPATIBLE，baseUrl = https://tokenbox.you/v1',
  )
  const byCode = new Map(chans.map((c) => [c.code, c]))
  gptModelId = byCode.get('tokenbox-gpt')?.models[0]?.id ?? 0n
  claudeModelId = byCode.get('tokenbox-claude')?.models[0]?.id ?? 0n
  deepseekModelId = byCode.get('tokenbox-deepseek')?.models[0]?.id ?? 0n
  check(
    gptModelId > 0n && claudeModelId > 0n && deepseekModelId > 0n,
    '三个通道各有一个启用模型',
    `gpt=${gptModelId} claude=${claudeModelId} deepseek=${deepseekModelId}`,
  )

  const scenes = await prisma.aiScene.findMany({ where: { enabled: true }, orderBy: { id: 'asc' } })
  const chainOf = (s: (typeof scenes)[number]) =>
    [s.defaultModelId, ...(Array.isArray(s.fallbackModelIds) ? (s.fallbackModelIds as unknown[]) : []).map((v) => BigInt(v as number))]

  // 默认链：其余场景都是 主GPT → 备Claude → 备DeepSeek
  // 已知例外：storyboard_generate（**大输出**场景，候选链完全不同）→ 见下单独断言
  const SPECIAL = new Set(['storyboard_generate'])

  /**
   * ★★ 候选链断言必须**按场景能力分开**，不能一律要求 [GPT → Claude → DeepSeek]。
   *
   * 图像场景（`kind='IMAGE'`，如 publish_cover）的候选**只能是图像模型**：
   * gateway 的能力闸门会把文本模型逐个跳过，最终整链失败、落兜底模板 ——
   * 运营在后台看到的只是「生成失败」，而根因（候选配错能力）被藏在
   * `no available provider` 里。所以这里要把它断言成「候选全都是 IMAGE」，
   * 而不是「不是 GPT→Claude→DeepSeek 就算错」。
   * （2026-09-21 封面事故里模型的 capability 其实是对的，问题在探活；
   *   但这条断言此前根本不存在，等于这条最容易配错的地方一直没人守。）
   */
  const capOfModel = new Map(
    (await prisma.aiModel.findMany({ select: { id: true, capability: true } })).map((m) => [
      m.id.toString(),
      normalizeModelCapability(m.capability),
    ]),
  )
  const isImageScene = (s: (typeof scenes)[number]) => s.kind === 'IMAGE'

  const bad = scenes.filter((s) => {
    const c = chainOf(s)
    if (isImageScene(s)) {
      // 图像场景：至少 1 个候选，且每个候选都必须是 IMAGE 模型
      return c.length === 0 || c.some((id) => capOfModel.get(id.toString()) !== 'IMAGE')
    }
    if (SPECIAL.has(s.code)) return false
    return c.length !== 3 || c[0] !== gptModelId || c[1] !== claudeModelId || c[2] !== deepseekModelId
  })
  check(
    scenes.length > 0 && bad.length === 0,
    `${scenes.length} 个场景候选链符合各自能力要求（文本 = GPT→Claude→DeepSeek；图像 = 全 IMAGE）`,
  )
  if (bad.length) {
    for (const s of bad.slice(0, 5)) {
      console.log(`      ✗ ${s.code}：主=${s.defaultModelId} 备=${JSON.stringify(s.fallbackModelIds)}`)
    }
  }

  const imgScenes = scenes.filter(isImageScene)
  check(
    imgScenes.length >= 1,
    `存在图像场景（kind=IMAGE）：${imgScenes.map((s) => s.code).join(', ') || '一个都没有'}`,
  )
  const coverScene = scenes.find((s) => s.code === 'publish_cover')
  if (coverScene) {
    const c = chainOf(coverScene)
    check(
      c.length >= 1 && c.every((id) => capOfModel.get(id.toString()) === 'IMAGE'),
      '★ publish_cover 的候选全是 IMAGE 模型（配成文本模型 = 每次出图都静默落兜底模板）',
      `链=${c.map((v) => String(v)).join(',')}`,
    )
    check(
      (coverScene.timeoutMs ?? 0) >= 90_000,
      '★ publish_cover 超时 ≥ 90s（出图实测 35.7s，给太短会误杀）',
      `实际 ${coverScene.timeoutMs}ms`,
    )
  }

  // storyboard_generate 的例外必须成立。
  // ★ 2026-09-21 重定向：这条链**不再包含 GPT**（对长输出必然失败），主候选换成 DeepSeek。
  //   依据（同一真 prompt 直连实测，绕过熔断器、上限给足）：
  //     · gpt-5.5：极短 ping 就要 15s；长请求稳定 125s 后 HTTP 524（上游网关硬时限）
  //     · claude-sonnet-5：max_tokens=4000 时**连续两次空正文**（finish_reason=length），
  //       给到 12000 才成功（109.8s，out=10433）
  //     · deepseek-v4-flash：无视 max_tokens 上限，max_tokens=4000 也能出稿，但耗时
  //       在 60~130+ 秒之间波动 ⇒ 超时必须给到 150s
  const sb = scenes.find((s) => s.code === 'storyboard_generate')
  if (sb) {
    const c = chainOf(sb)
    check(
      c.length === 2 && c[0] === deepseekModelId && c[1] === claudeModelId,
      'storyboard_generate 候选链 = [DeepSeek → Claude]',
      `实际 ${JSON.stringify(c.map((v) => String(v)))}`,
    )
    check(
      !c.includes(gptModelId),
      'storyboard_generate 候选链里没有 GPT（长输出必被上游 524 掐断，留着只是白等一个超时）',
    )
    check(
      sb.timeoutMs >= 150_000,
      'storyboard_generate 超时 ≥ 150s（DeepSeek 实测 60~130+ 秒，130s 会误杀它）',
      `实际 ${sb.timeoutMs}ms`,
    )
    check(
      (sb.maxOutputTokens ?? 0) >= 10_000,
      'storyboard_generate 输出预算 ≥ 10000（实测思考+正文需 ~10500；4000 会让严格截断的通道返回空正文）',
      `实际 ${sb.maxOutputTokens}`,
    )
    check(
      sb.maxRetries === 0,
      'storyboard_generate 不重试（单次尝试 ~100s，重试代价大于换通道；并保证最坏 2×150s=300s 不超过前端 340s）',
      `实际 ${sb.maxRetries}`,
    )
  } else {
    check(false, 'storyboard_generate 场景存在')
  }

  // 三个候选通道都是推理模型，max_tokens 要同时容纳「思考 + 正文」。
  // 原先 300~800 的预算（按 mock/非推理模型定的）会让输出被思考吃光、正文返回空。
  const thin = scenes.filter((s) => (s.maxOutputTokens ?? 0) < 4000)
  check(
    thin.length === 0,
    '所有场景输出预算 ≥ 4000 token（容纳推理模型的思考开销）',
    thin.length ? `偏低：${thin.map((s) => `${s.code}=${s.maxOutputTokens}`).join(', ')}` : '',
  )

  const leftovers = await prisma.aiProvider.findMany({ where: { enabled: true }, select: { code: true } })
  const unexpected = leftovers.map((p) => p.code).filter((c) => !c.startsWith('tokenbox-'))
  check(unexpected.length === 0, '没有其它历史通道仍在启用（旧的已停用）', unexpected.length ? `仍在启用：${unexpected.join(', ')}` : '')
}

// ────────────────────────────────────────────────────────────────
console.log('\n=== ③ 主通道不可用 → 落到备用（且不白等重试）===')
await cleanup()

let primaryId = 0n
let backupId = 0n
{
  const enc = encryptSecret('sk-verify-not-a-real-key')
  // priority 故意「反向」：坏通道 999、好通道 1。
  // 若候选顺序由 priority 决定，就会先去好的备用通道、坏通道一次都不试；
  // 实测必须仍先试坏的主通道 ⇒ 证明顺序来自 ai_scene 的数组（用例 ⑥）。
  const primary = await prisma.aiProvider.create({
    data: {
      code: PROV_PRIMARY,
      name: '验证用坏通道（黑洞地址）',
      providerType: 'LLM',
      protocol: 'OPENAI_COMPATIBLE',
      baseUrl: BLACKHOLE,
      apiKeyEncrypted: enc,
      apiKeyMasked: 'sk-****test',
      enabled: true,
      priority: 999,
      healthStatus: 'HEALTHY',
    },
  })
  primaryId = primary.id

  const bk = await prisma.aiProvider.create({
    data: {
      code: PROV_BACKUP,
      name: '验证用备用通道（MOCK，不会失败）',
      providerType: 'LLM',
      protocol: 'MOCK',
      baseUrl: 'http://mock.local',
      apiKeyEncrypted: enc,
      apiKeyMasked: 'sk-****test',
      enabled: true,
      priority: 1,
      healthStatus: 'HEALTHY',
    },
  })
  backupId = bk.id

  const mp = await prisma.aiModel.create({
    data: { providerId: primaryId, modelCode: MODEL_PRIMARY, displayName: '坏模型', enabled: true },
  })
  const mb = await prisma.aiModel.create({
    data: { providerId: backupId, modelCode: MODEL_BACKUP, displayName: '备用模型', enabled: true },
  })

  await prisma.aiScene.create({
    data: {
      code: SCENE,
      name: '故障转移验证（临时）',
      promptTemplate: '门店：{{store}}\n菜品：{{dish}}',
      defaultModelId: mp.id,
      fallbackModelIds: [Number(mb.id)],
      beanPrice: 0n,
      timeoutMs: 5000,
      maxRetries: 2, // 故意留 2：若没有「立即熔断 + break」，坏通道会被试 3 次
      enabled: true,
    },
  })

  await circuit.reset(primaryId)
  await circuit.reset(backupId)

  const r1 = await gateway.runScene({
    sceneCode: SCENE,
    variables: { store: '验证小馆', dish: '红烧肉' },
    requestId: `${REQ_PREFIX}r1-${Date.now()}`,
  })

  check(r1.ok === true, '请求成功（未整体失败）', r1.ok ? '' : `reason=${r1.reason}`)
  if (r1.ok) {
    check(r1.usedFallback === true, 'usedFallback = true（确实用了备用）')
    check(r1.modelCode === MODEL_BACKUP, `落到备用通道模型`, `model=${r1.modelCode}`)
    // 关键断言：坏通道「试 1 次就放弃」+ 备用成功 1 次 = 2
    // 若退化为「重试到 maxRetries 才换」则是 1+3 = 4
    check(r1.attempts === 2, '总尝试次数 = 2（坏通道仅 1 次，未耗尽重试）', `attempts=${r1.attempts}`)
  }

  const opened = await circuit.isOpen(primaryId)
  check(opened === true, '坏通道已被立即熔断（不等攒满 20 个样本）')

  const ttl = await redis.ttl(`ai:cb:open:${primaryId}`)
  check(
    ttl > 0 && ttl <= DEFAULT_CIRCUIT.openSeconds,
    `熔断 key 的 TTL ≤ openSeconds(${DEFAULT_CIRCUIT.openSeconds}s)`,
    `ttl=${ttl}s`,
  )

  const log = await prisma.aiCallLog.findFirst({
    where: { sceneCode: SCENE, status: 'FALLBACK_USED' },
    orderBy: { id: 'desc' },
  })
  check(log !== null && log.isFallback === true, '调用日志记 status=FALLBACK_USED、isFallback=true')
}

// ────────────────────────────────────────────────────────────────
console.log('\n=== ④ 熔断期内再请求 → 直接跳过主通道 ===')
{
  const r2 = await gateway.runScene({
    sceneCode: SCENE,
    variables: { store: '验证小馆', dish: '红烧肉' },
    requestId: `${REQ_PREFIX}r2-${Date.now()}`,
  })
  check(r2.ok === true, '请求仍成功')
  if (r2.ok) {
    check(r2.attempts === 1, '总尝试次数 = 1（主通道被跳过，没白等）', `attempts=${r2.attempts}`)
    check(r2.usedFallback === true, '仍记为使用了备用')
  }
}

// ────────────────────────────────────────────────────────────────
console.log('\n=== ⑤ 熔断到期 → 自动切回主通道（无粘性）===')
{
  // 删 key 等价于 openSeconds 到期：网关每次都重新读 isOpen()，不缓存结论
  await circuit.reset(primaryId)

  const r3 = await gateway.runScene({
    sceneCode: SCENE,
    variables: { store: '验证小馆', dish: '红烧肉' },
    requestId: `${REQ_PREFIX}r3-${Date.now()}`,
  })
  check(r3.ok === true, '请求成功')
  if (r3.ok) {
    check(r3.attempts === 2, '又去试了主通道（attempts=2）⇒ 到期自动切回', `attempts=${r3.attempts}`)
  }
  check((await circuit.isOpen(primaryId)) === true, '试失败后再次被熔断（下一轮又走备用）')
}

// ────────────────────────────────────────────────────────────────
console.log('\n=== ⑥ 候选顺序与 ai_provider.priority 无关 ===')
{
  const p = await prisma.aiProvider.findUniqueOrThrow({ where: { id: primaryId } })
  const b = await prisma.aiProvider.findUniqueOrThrow({ where: { id: backupId } })
  check(
    p.priority === 999 && b.priority === 1,
    '坏通道 priority=999、好备用 priority=1（priority 表达的是「好通道更靠前」）',
  )
  check(
    true,
    '但用例 ③/⑤ 实测仍先试坏的主通道 ⇒ 顺序由 ai_scene.fallbackModelIds 决定',
    '（priority 仅用于后台列表排序）',
  )
}

// ────────────────────────────────────────────────────────────────
console.log('\n=== ⑦ 空正文必须算失败 → 触发故障转移（否则会「成功」返回空文案并扣积分）===')
{
  // 起一个本地 HTTP 服务，模拟「HTTP 200 + 合法报文 + content 为空」的通道。
  // 这正是 tokenbox 上推理模型把 max_tokens 全花在思考上时的返回：
  //   {"choices":[{"message":{"content":""},"finish_reason":"length"}]}
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-empty',
        model: 'empty-model',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 100, completion_tokens: 800, total_tokens: 900 },
      }),
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const enc = encryptSecret('sk-verify-not-a-real-key')
  const emptyProv = await prisma.aiProvider.create({
    data: {
      code: 'verify-fo-empty',
      name: '验证用空正文通道',
      providerType: 'LLM',
      protocol: 'OPENAI_COMPATIBLE',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKeyEncrypted: enc,
      apiKeyMasked: 'sk-****test',
      enabled: true,
      priority: 50,
      healthStatus: 'HEALTHY',
    },
  })
  const emptyModel = await prisma.aiModel.create({
    data: { providerId: emptyProv.id, modelCode: 'verify-fo-empty-model', displayName: '空正文模型', enabled: true },
  })
  const bk = await prisma.aiProvider.findUniqueOrThrow({ where: { code: PROV_BACKUP } })
  const bkModel = await prisma.aiModel.findFirstOrThrow({ where: { providerId: bk.id } })

  const scene = await prisma.aiScene.findUniqueOrThrow({ where: { code: SCENE } })
  await prisma.aiScene.update({
    where: { id: scene.id },
    data: { defaultModelId: emptyModel.id, fallbackModelIds: [Number(bkModel.id)] },
  })
  await circuit.reset(emptyProv.id)

  try {
    const r = await gateway.runScene({
      sceneCode: SCENE,
      variables: { store: '验证小馆', dish: '红烧肉' },
      requestId: `${REQ_PREFIX}empty-${Date.now()}`,
    })
    check(r.ok === true, '整体成功（没有把空正文当最终结果）')
    check(r.ok && r.usedFallback === true, '空正文被识别为失败 → 转入备用通道')
    check(r.ok && r.text.trim().length > 0, '最终正文非空', r.ok ? `${r.text.length} 字` : '')
    // maxRetries=2 ⇒ 空正文通道被重试 3 次（非通道级故障不熔断），第 4 次落到备用
    check(r.attempts === 4, '尝试次数 = 4（空通道按 maxRetries 重试 2 次后放弃 → 备用）', `attempts=${r.attempts}`)
  } finally {
    server.close()
    await prisma.aiScene.update({
      where: { id: scene.id },
      data: { defaultModelId: scene.defaultModelId, fallbackModelIds: scene.fallbackModelIds as number[] },
    })
    await circuit.reset(emptyProv.id)
    await prisma.aiModel.deleteMany({ where: { modelCode: 'verify-fo-empty-model' } })
    await prisma.aiProvider.deleteMany({ where: { code: 'verify-fo-empty' } })
  }
}

// ────────────────────────────────────────────────────────────────
console.log('\n=== ⑧ 三个真实通道冒烟（会真实调用，SKIP_LIVE=1 可跳过）===')
if (process.env.SKIP_LIVE === '1') {
  console.log('  （已跳过）')
} else {
  // 这里的闸门故意放宽成「至少一条可用」而不是「三条都要可用」：
  // · 故障转移的意义就是「部分通道挂掉仍能用」，所以三条全绿不是需求
  // · GPT 池实测约 1/3 请求会挂到 45s+（上游尾部延迟），本探测器只有 10s，
  //   把它当失败会让验证结果随机变红 —— 那是上游抖动，不是配置错
  // 逐条状态照实打印，让人看得见每条通道当下的真实表现。
  let alive = 0
  for (const code of ['tokenbox-gpt', 'tokenbox-claude', 'tokenbox-deepseek']) {
    const prov = await prisma.aiProvider.findUnique({ where: { code } })
    if (!prov) {
      console.log(`  ✗ ${code} 不存在`)
      continue
    }
    const r = await gateway.testProvider(prov.id)
    if (r.status === 'SUCCESS') {
      alive++
      console.log(`  ✓ ${code} 可调用  ${r.latencyMs}ms  model=${r.modelReturned}`)
    } else {
      console.log(`  ! ${code} 本次失败（可能是上游抖动，可重跑确认）  ${r.errorMsg}`)
    }
  }
  check(alive >= 1, '至少一条通道实时可用（故障转移的前提）', `本次 ${alive}/3 条成功`)
}

// ────────────────────────────────────────────────────────────────
console.log('\n=== ⑨ 关键行为回归：熔断器参数未被改动 ===')
{
  // 用例 ⑤ 依赖「熔断到期自动失效」，openSeconds 被调大就会拖长切换窗口；
  // minSamples 被调小又会让偶发抖动误熔断。锁住默认值，改的人必须是有意的。
  //
  // ★ openSeconds 的下界是硬约束（不是口味问题）：必须 ≥ 单场景最坏一次尝试的耗时
  //   （ai_scene.timeout_ms 最大 90s）。比它短 ⇒ 坏通道会在熔断刚过期时立刻被重新试一次，
  //   等于每次请求都白付一个完整超时，熔断就没起到作用。上界别太大：
  //   它同时也是「主通道恢复后多久自动切回」的窗口。
  const d = { ...DEFAULT_CIRCUIT }
  check(
    d.openSeconds >= 90 && d.openSeconds <= 600,
    'openSeconds ∈ [90, 600]（≥ 单场景最坏一次超时，且切回窗口不至于过长）',
    `实际 ${d.openSeconds}`,
  )
  check(d.minSamples === 20, 'minSamples = 20（失败率熔断的样本下限）', `实际 ${d.minSamples}`)
  check(d.failThreshold === 0.5, 'failThreshold = 0.5', `实际 ${d.failThreshold}`)
}

// ────────────────────────────────────────────────────────────────
console.log('\n=== 清理临时数据 ===')
await cleanup()
const leftover = await prisma.aiCallLog.count({ where: { requestId: { startsWith: REQ_PREFIX } } })
check(leftover === 0, '临时调用日志已清空')
check(
  (await prisma.aiProvider.count({ where: { code: { in: [PROV_PRIMARY, PROV_BACKUP] } } })) === 0,
  '临时供应商已删除',
)
check((await prisma.aiScene.count({ where: { code: SCENE } })) === 0, '临时场景已删除')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1

await redis.quit()
await prisma.$disconnect()
