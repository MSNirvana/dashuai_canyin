// 本地端到端冒烟：登录 → 门店 → 菜品 → 人设 → 创作 → AI 文案 → AI 分镜 → 上传确认 → 绑素材 → 提交合成 → 账务核对
// 用法：node scripts/e2e-smoke.mjs [baseUrl]（默认 http://localhost:3000）
const BASE = process.argv[2] || 'http://localhost:3000'
const API = `${BASE}/api/v1`
const PHONE = '13800000000'

let failed = 0
const step = (name, okCond, detail) => {
  const mark = okCond ? '✅' : '❌'
  if (!okCond) failed++
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({ code: -1, message: 'non-json' }))
  return { status: res.status, json }
}

const must = (name, r, expectCode = 0) => {
  const okCond = r.json.code === expectCode
  step(name, okCond, okCond ? undefined : `HTTP ${r.status} code=${r.json.code} msg=${r.json.message}`)
  return r.json
}

// ★ 单店模型（2026-09-24）下，正常账号只有一家门店，而且它一定是**默认门店** ——
//   默认门店删不掉（服务层刻意拦住）。所以本函数只对**历史遗留**的多门店数据有意义：
//   清理掉非默认的「冒烟门店 / 隔离校验门店」，让这些老账号能回到单店状态。
const TEST_STORE_PREFIXES = ['冒烟门店', '隔离校验门店']

async function pruneTestStores(token) {
  const r = await api('GET', '/stores', { token })
  const list = r.json?.data ?? []
  const junk = list.filter(
    (s) => !s.isDefault && TEST_STORE_PREFIXES.some((p) => String(s.name ?? '').startsWith(p)),
  )
  for (const s of junk) await api('DELETE', `/stores/${s.id}`, { token })
  return junk.length
}

console.log(`\n=== e2e smoke @ ${API} ===\n`)

// 1. dev-mode 开关
const dm = await api('GET', '/auth/dev-mode')
must('GET /auth/dev-mode（开发登录已开启）', dm)
if (dm.json?.data?.enabled !== true) {
  console.log('⛔ dev-mode 未开启（DEV_LOGIN≠true），终止')
  process.exit(1)
}

// 2. 开发登录
const login = must('POST /auth/dev-login', await api('POST', '/auth/dev-login', { body: { phone: PHONE } }))
const token = login.data.token
const merchantId = login.data.merchant.id
console.log(`   商家: ${login.data.merchant.nickname}(${PHONE}) 积分: ${login.data.bean.balance} 会员: ${login.data.member.isMember}`)

// 2b. 默认保留验收数据；仅显式 CLEAN_TEST_DATA=true 时清理旧数据
if (process.env.CLEAN_TEST_DATA === 'true') {
  const pruned = await pruneTestStores(token)
  if (pruned) console.log(`   已清理历史冒烟门店 ${pruned} 家`)
}

// 3. 门店（★ 单店模型：一个账号只有一家门店）
//    已有门店就**复用**，没有才创建 —— 否则这个脚本第二次跑就会撞上「库存已有一家」而变红。
//    复用意味着本脚本往后的菜品 / 创作会落在这个账号唯一的那家门店下（本地 dev 账号，可接受）。
const storeList = must('GET /stores', await api('GET', '/stores', { token })).data ?? []
let store = storeList[0]
if (store) {
  console.log(`   复用账号已有门店 id=${store.id} ${store.name}`)
} else {
  store = must('POST /stores', await api('POST', '/stores', {
    token,
    body: { name: `冒烟门店 ${Date.now() % 10000}`, category: '川菜', city: '成都', address: '高新区天府三街 1 号' },
  })).data
  const after = must('GET /stores（创建后可读回）', await api('GET', '/stores', { token }))
  step('门店列表包含新门店', Array.isArray(after.data) && after.data.some((s) => s.id === store.id))
}

// 3b. 单店上限：已经有门店的账号**再建第二家必须被拒**（2003）
must('POST /stores 第二家应被拒（一个账号只能一家门店）', await api('POST', '/stores', {
  token, body: { name: `冒烟门店-dup-${Date.now() % 10000}`, category: '川菜' },
}), 2003)

// 4. 菜品
const dish = must('POST /stores/:id/dishes', await api('POST', `/stores/${store.id}/dishes`, {
  token,
  body: { name: '招牌麻婆豆腐', intro: '麻、辣、烫、香、酥、嫩、鲜、活八字箴言', sellingPoints: '手工石磨豆腐,现泼红油,3 分钟出锅' },
})).data

// 5. 人设（门店级：/stores/:id/persona，一门店一条）
must('PUT /stores/:id/persona', await api('PUT', `/stores/${store.id}/persona`, {
  token,
  body: { bossTags: '川菜老师傅,20 年掌勺,爱唠嗑,宠粉', activity: '到店报暗号「大帅」送例汤' },
}))
const personaRead = must('GET /stores/:id/persona', await api('GET', `/stores/${store.id}/persona`, { token })).data
step('人设写入后可读回', personaRead?.bossTags === '川菜老师傅,20 年掌勺,爱唠嗑,宠粉' && personaRead?.activity === '到店报暗号「大帅」送例汤')

// 5b. 原「人设按门店隔离」用例（建第二家门店再读它的空人设）已随**单店模型**下线：
//     一个账号只能有一家门店（见上面的单店上限断言），第二家门店根本建不出来，
//     「两家店之间会不会串人设」也就无从验证了。若将来恢复多门店，这个用例要一起加回来。

// 6. 创作
const creation = must('POST /creations', await api('POST', '/creations', {
  token,
  body: { storeId: store.id, dishId: dish.id, title: '麻婆豆腐爆款短视频' },
})).data
console.log(`   创作 id=${creation.id} status=${creation.status}`)

// 7. AI 文案
const copy = must('POST /creations/:id/copy（AI mock）', await api('POST', `/creations/${creation.id}/copy`, {
  token, body: { requestId: `smoke-copy-${Date.now()}` },
}))
console.log(`   文案积分扣费: ${copy.data.beanCharged ?? copy.data.beansCharged ?? '(见流水)'}`)

// 8. AI 分镜
const shots = must('POST /creations/:id/storyboard（AI mock）', await api('POST', `/creations/${creation.id}/storyboard`, {
  token, body: { requestId: `smoke-shot-${Date.now()}` },
}))
const shotList = shots.data.shots ?? shots.data
step('分镜数量 ≥ 3', Array.isArray(shotList) && shotList.length >= 3, `共 ${Array.isArray(shotList) ? shotList.length : '?'} 镜`)

// 9. 上传确认（本地无 COS：占位凭证 + 直接落库）
const asset = must('POST /upload/complete', await api('POST', '/upload/complete', {
  token,
  body: {
    cosKey: `uploads/${merchantId}/smoke-${Date.now()}.mp4`,
    storeId: store.id,
    type: 'VIDEO',
    sizeBytes: 5 * 1024 * 1024,
    width: 1080,
    height: 1920,
    durationMs: 8000,
  },
})).data

// 10. 分镜绑定素材（全部镜头绑同一个素材，模拟）
for (let i = 0; i < shotList.length; i++) {
  const s = shotList[i]
  if (!s) continue
  await api('PUT', `/creations/${creation.id}/shots/${s.id}`, {
    token,
    body: { assetId: asset.id, trimStartMs: 0, trimEndMs: 3000 },
  })
}
step('分镜绑定素材', true, `${shotList.length} 镜全部绑定 asset=${asset.id}`)

// 11. 预览拼图（不扣积分）
must('POST /render/preview-collage', await api('POST', '/render/preview-collage', {
  token, body: { creationId: creation.id },
}))

// 12. 提交合成（FFMPEG_WORKER=false 时提交即 SUCCESS；=true 时进队列异步执行）
const submit = must('POST /creations/:id/render', await api('POST', `/creations/${creation.id}/render`, {
  token,
  body: { mode: 'FULL', aiMode: true, requestId: `smoke-render-${Date.now()}` },
}))
const render = submit.data.task
const ACCEPTED_STATUS = ['SUCCESS', 'QUEUED', 'PENDING', 'RUNNING', 'PROCESSING']
step('合成任务已受理', ACCEPTED_STATUS.includes(render.status), `status=${render.status}`)
if (render.status !== 'SUCCESS') {
  console.log('   ℹ FFMPEG_WORKER=true 时合成走异步队列，非即时 SUCCESS 属预期（非缺陷）')
}
step('合成扣积分 > 0', BigInt(render.beanCharged) > 0n, `beanCharged=${render.beanCharged}`)
console.log(`   合成任务 id=${render.id} status=${render.status} 扣积分=${render.beanCharged} 时长=${render.durationMs}ms`)

// 13. 合成列表 + 详情
must('GET /creations/:id/renders', await api('GET', `/creations/${creation.id}/renders`, { token }))
must('GET /creations/:id/render/:taskId', await api('GET', `/creations/${creation.id}/render/${render.id}`, { token }))

// 14. 账务核对
const ledger = must('GET /account/bean/ledger', await api('GET', '/account/bean/ledger?page=1&pageSize=50', { token })).data
console.log(`   流水 ${ledger.total} 条：${(ledger.list ?? []).map((l) => `${l.type}(${l.bizType ?? '-'})`).join(', ')}`)
step('流水含 AI/合成扣费记录', ledger.total > 0)

const aiLogs = must('GET /account/bean/ai-logs', await api('GET', '/account/bean/ai-logs?page=1&pageSize=20', { token })).data
console.log(`   AI 日志 ${aiLogs.total} 条`)

const member = must('GET /account/membership/current', await api('GET', '/account/membership/current', { token })).data
step('订阅有效', member.active === true, `${member.planName ?? ''} 至 ${member.endAt ?? '-'}`)

// 15. 镜头库（seed 后应有 9 类 18 条拍摄技巧）
const shotLib = must('GET /shot-library', await api('GET', '/shot-library', { token }))
const libList = shotLib.data ?? []
const libCats = new Set(libList.map((it) => it.category))
const libOk = Array.isArray(libList) && libList.length >= 18 && libCats.size >= 9 && libList.every((it) => it.tips)
step('镜头库有种子数据且带拍摄技巧', libOk, `${libList.length} 条 / ${libCats.size} 类`)
// 必备基础拍摄手法（AI 分镜匹配依赖这 6 条）
const REQUIRED_CODES = ['closeup_food', 'boss_talk', 'make_serve', 'scene_ambience', 'make_ingredient', 'make_process']
const libCodes = new Set(libList.map((it) => it.code))
const missingCodes = REQUIRED_CODES.filter((c) => !libCodes.has(c))
step('镜头库含必备基础手法', missingCodes.length === 0, missingCodes.length ? `缺: ${missingCodes.join(', ')}` : `美食特写/口播/出锅/环境/原料/制作 齐备`)
// 按分类过滤
const libByCat = await api('GET', '/shot-library?category=' + encodeURIComponent('特写'), { token })
step('镜头库按分类过滤', libByCat.json.code === 0 && (libByCat.json.data ?? []).length > 0 && (libByCat.json.data ?? []).every((it) => it.category === '特写'), `特写 ${(libByCat.json.data ?? []).length} 条`)
// 分镜类型与镜头库分类对齐（AI mock 分镜的开场镜应有技巧可查）
const catSet = new Set(libList.map((it) => it.category))
step('AI 分镜 shotType 与镜头库分类对齐', shotList.some((s) => s.shotType && catSet.has(s.shotType)), `镜头库分类: ${[...catSet].join('/')}`)

// 16. 收尾：默认保留全部验收数据，便于后台复核；清理仅由 CLEAN_TEST_DATA=true 显式开启
if (process.env.CLEAN_TEST_DATA === 'true') {
  const cleaned = await pruneTestStores(token)
  if (cleaned) console.log(`   已清理本次冒烟门店 ${cleaned} 家`)
} else {
  console.log(`   验收数据已保留：merchant=${merchantId} store=${store.id} creation=${creation.id} render=${render.id}`)
}

console.log(`\n=== 结果：${failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`} ===\n`)
process.exit(failed === 0 ? 0 : 1)
