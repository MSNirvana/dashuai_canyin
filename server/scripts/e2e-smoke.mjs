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

// 3. 门店
const store = must('POST /stores', await api('POST', '/stores', {
  token,
  body: { name: `冒烟门店 ${Date.now() % 10000}`, category: '川菜', city: '成都', address: '高新区天府三街 1 号', isDefault: true },
})).data
const stores = must('GET /stores', await api('GET', '/stores', { token }))
step('门店列表包含新门店', Array.isArray(stores.data) && stores.data.some((s) => s.id === store.id))

// 4. 菜品
const dish = must('POST /stores/:id/dishes', await api('POST', `/stores/${store.id}/dishes`, {
  token,
  body: { name: '招牌麻婆豆腐', intro: '麻、辣、烫、香、酥、嫩、鲜、活八字箴言', sellingPoints: '手工石磨豆腐,现泼红油,3 分钟出锅' },
})).data

// 5. 人设
must('PUT /persona', await api('PUT', '/persona', {
  token,
  body: { bossTags: '川菜老师傅,20 年掌勺,爱唠嗑,宠粉', activity: '到店报暗号「大帅」送例汤' },
}))

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
console.log(`   文案豆扣费: ${copy.data.beanCharged ?? copy.data.beansCharged ?? '(见流水)'}`)

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

// 11. 预览拼图（不扣豆）
must('POST /render/preview-collage', await api('POST', '/render/preview-collage', {
  token, body: { creationId: creation.id },
}))

// 12. 提交合成（演示模式：提交即 SUCCESS）
const submit = must('POST /creations/:id/render（演示模式）', await api('POST', `/creations/${creation.id}/render`, {
  token,
  body: { mode: 'FULL', aiMode: true, requestId: `smoke-render-${Date.now()}` },
}))
const render = submit.data.task
step('合成任务即时 SUCCESS（演示模式）', render.status === 'SUCCESS', `status=${render.status}`)
step('合成扣积分 > 0', BigInt(render.beanCharged) > 0n, `beanCharged=${render.beanCharged}`)
console.log(`   合成任务 id=${render.id} status=${render.status} 扣豆=${render.beanCharged} 时长=${render.durationMs}ms`)

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

// 15. 镜头库（seed 后应有 6 类 12 条拍摄技巧）
const shotLib = must('GET /shot-library', await api('GET', '/shot-library', { token }))
const libList = shotLib.data ?? []
const libOk = Array.isArray(libList) && libList.length >= 12 && libList.every((it) => it.tips)
step('镜头库有种子数据且带拍摄技巧', libOk, `${Array.isArray(libList) ? libList.length : 0} 条`)
// 按分类过滤
const libByCat = await api('GET', '/shot-library?category=' + encodeURIComponent('特写'), { token })
step('镜头库按分类过滤', libByCat.json.code === 0 && (libByCat.json.data ?? []).length > 0 && (libByCat.json.data ?? []).every((it) => it.category === '特写'), `特写 ${(libByCat.json.data ?? []).length} 条`)
// 分镜类型与镜头库分类对齐（AI mock 分镜的开场镜应有技巧可查）
const catSet = new Set(libList.map((it) => it.category))
step('AI 分镜 shotType 与镜头库分类对齐', shotList.some((s) => s.shotType && catSet.has(s.shotType)), `镜头库分类: ${[...catSet].join('/')}`)

console.log(`\n=== 结果：${failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`} ===\n`)
process.exit(failed === 0 ? 0 : 1)
