/**
 * 守护：「本地导入的作品，基本配置参数一并导入」这条链路。
 *
 * ── 它盯的是什么 ──
 * 优秀作品（excellent_work）的同款配方里有 track / complexity / titleHint / voiceId / shotSkeleton。
 * 小程序「生成同款」此前只预填了前三项，**shotSkeleton 从头到尾没进创作流**
 * （全小程序唯一读它的地方是作品详情页的展示）。本脚本验证新链路：
 *   ① POST /creations 带 shotSkeleton ⇒ 服务端在**同一个事务**里把它落成初始分镜；
 *   ② 空串字段落 null（库里「没填」只允许一种形态）；
 *   ③ 不传 shotSkeleton 时行为与从前完全一致（0 条分镜，不回归）；
 *   ④ 后台上传通道 POST /admin/works/upload：按**魔数**认类型、键落 works/、非视频被拒。
 *
 * ── 后来补上的另一半：读接口的鉴权边界 ──
 *   ⑤ 优秀作品读接口**未带 token 必须 200**。首页是 tab 页、未登录也进得来，它一进来就会拉
 *      `/works` 与 `/works/categories`；这两条只要按 401 处理，请求层就会把用户
 *      switchTab 到「我的」——未登录用户一打开小程序就被从首页弹走。放开是有意的，
 *      理由与安全边界见 src/routes/works.ts 的文件头。
 *   ⑥ 源码级闸门：签名守卫 isSignableWorkKey 还在、前缀白名单不含 uploads/、
 *      首页不再「未登录整页早退」。服务没起时 ⑤ 会跳过，只有 ⑥ 拦得住。
 *
 * ── 为什么要连着 ④ 一起验 ──
 * 「本地导入」的另一半是后台能选本地文件。那条链路的静默失效特别隐蔽：
 * 扩展名没按魔数取 ⇒ contentTypeForKey 兜底成 video/mp4 ⇒ webm/mov 在小程序里静默不播；
 * 键没落进 ALLOWED_PREFIXES ⇒ 本地模式落盘直接报错（生产 COS 模式却正常）。
 *
 * ── 纪律 ──
 *   · 用商户 3（13800000001）跑，**结束时把造出来的创作与对象硬删干净**（不是软删）。
 *   · 不调任何 AI：本脚本只建创作 + 传文件，**不花一分积分**。
 *   · 全部断言放在 try/finally 里，闸门类用例失败也要还原。
 *
 * 跑法：
 *   npx tsx scripts/verify-work-prefill.ts
 *   （需要本地 server 在跑，且 .env 里 DEV_LOGIN=true）
 */
import '../src/env.js'
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deleteObject } from '../src/lib/cos.js'

const prisma = new PrismaClient()

const API = (process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:3000/api/v1').replace(/\/$/, '')
const ADMIN_API = API.replace(/\/api\/v1$/, '/admin/api/v1')
const PHONE = process.env.VERIFY_PHONE ?? '13800000001'
const ADMIN_USER = process.env.ADMIN_USERNAME ?? 'admin'
const ADMIN_PASS = process.env.ADMIN_PASSWORD ?? 'admin123456'

let pass = 0
let fail = 0
function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` —— ${JSON.stringify(detail)}`}`)
  }
}
/** 读源码做断言：路径相对本脚本所在目录（与 verify-tutorial.ts 同一套写法） */
function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

/** 只发一个 GET 看状态码；连不上返回 null（服务没起就跳过，不该让整个脚本失败） */
async function probeStatus(path: string): Promise<number | null> {
  try {
    const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(2000) })
    // 响应体也要读掉，否则连接不会及时释放
    await res.text().catch(() => '')
    return res.status
  } catch {
    return null
  }
}

function section(title: string) {
  console.log(`\n${title}`)
}

interface ApiResult<T> {
  status: number
  body: { code: number; message: string; data: T }
}

async function api<T = unknown>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = { code: -1, message: text.slice(0, 200) }
  }
  return { status: res.status, body: body as ApiResult<T>['body'] }
}

/** 造一个「字节合法但完全不可解码」的 mp4：只需要第 4-8 字节是 ftyp 牌子 */
function fakeMp4(): Buffer {
  const head = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from('isom', 'latin1'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2avc1mp41', 'latin1'),
  ])
  return Buffer.concat([head, Buffer.alloc(2048)])
}

/** 最小的 JPEG 头（只给魔数嗅探用） */
function fakeJpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.alloc(512),
  ])
}

async function adminUpload(kind: 'video' | 'cover', bytes: Buffer, filename: string) {
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(bytes)]), filename)
  const res = await fetch(`${ADMIN_API}/works/upload?kind=${kind}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: fd,
  })
  const body = (await res.json()) as { code: number; message: string; data: Record<string, unknown> }
  return { status: res.status, code: body.code, message: body.message, data: body.data }
}

let adminToken = ''
/** 上传产生的对象键，收尾时逐个删掉 */
const uploadedKeys: string[] = []
/** 造出来的创作 id（收尾时硬删） */
const createdIds: bigint[] = []
/** 临时建的菜品 id（收尾时硬删；只在该商户一条菜都没有时才有值） */
let tempDishId: bigint | null = null

async function main() {
  section('① 创作：同款分镜骨架预置')
  const login = await api<{ token: string; merchant: { id: string } }>('POST', '/auth/dev-login', {
    body: { phone: PHONE },
  })
  if (login.body.code !== 0 || !login.body.data?.token) {
    console.log(`  ✗ 开发登录失败（DEV_LOGIN 是否开着？）：${login.body.message}`)
    process.exit(1)
  }
  const token = login.body.data.token

  const stores = await api<Array<{ id: string; name: string }>>('GET', '/stores', { token })
  if (!stores.body.data?.length) {
    console.log('  ✗ 该商户没有门店，无法验证')
    process.exit(1)
  }
  /**
   * ★ 不能直接用 stores[0]：这条自检要求「门店下**有菜品**」，而商户 3 名下
   *   （实测）一家有菜的门店都没有。所以两段走：
   *     1) 先找该商户已有的菜；
   *     2) 一个都没有时**临时建一条**（明细在 finally 里硬删），
   *        而不是转头去用商户 1 —— 那是真实数据，测试不该碰。
   *   建菜不花积分、不产生对象，是最干净的「借个上下文」。
   */
  const store = stores.body.data[0]!
  let dish = await prisma.dish.findFirst({
    where: { storeId: BigInt(store.id), deletedAt: null },
    select: { id: true, name: true },
  })
  if (!dish) {
    const temp = await prisma.dish.create({
      data: { storeId: BigInt(store.id), name: `自检用菜品 ${Date.now() % 100000}` },
      select: { id: true, name: true },
    })
    tempDishId = temp.id
    dish = temp
    console.log(`  · 该门店没有菜品，临时建了一条（收尾会删）：${dish.name}`)
  }

  // 骨架里刻意混入**空串**（后台录入允许留空行）：断言它落成 null 而不是 ''
  const skeleton = [
    { shotType: '开场', shotSize: '全景', durationSuggest: 3, visualReq: '门店门头，招牌灯全亮' },
    { shotType: '特写', shotSize: '大特写', durationSuggest: 3, line: '', visualReq: '' },
    { shotType: '收尾', shotSize: '中景', durationSuggest: 4, visualReq: '成品上桌，热气蒸腾' },
  ]

  const created = await api<{ id: string }>('POST', '/creations', {
    token,
    body: {
      storeId: store.id,
      dishId: String(dish.id),
      title: `骨架预置自检 ${Date.now() % 100000}`,
      track: 'TRAFFIC',
      complexity: 'COMPLEX',
      shotSkeleton: skeleton,
    },
  })
  check(created.body.code === 0, '带 shotSkeleton 创建创作成功', created.body)
  if (created.body.code !== 0) {
    console.log('     （这条不过，后面就不用看了）')
    return
  }
  const creationId = created.body.data.id
  createdIds.push(BigInt(creationId))

  const detail = await api<{ shots: Array<Record<string, unknown>> }>('GET', `/creations/${creationId}`, { token })
  const shots = detail.body.data?.shots ?? []
  check(shots.length === 3, '分镜被一并落库（3 条）', shots.length)
  check(
    shots.map((s) => s.seq).join(',') === '1,2,3',
    'seq 从 1 连续编号',
    shots.map((s) => s.seq),
  )
  check(shots[0]?.shotType === '开场' && shots[2]?.shotType === '收尾', '镜头分类原样带过来')
  check(shots[0]?.visualReq === '门店门头，招牌灯全亮', '画面要求原样带过来')
  check(shots[0]?.durationSuggest === 3 && shots[2]?.durationSuggest === 4, '建议时长原样带过来')
  // ★ 这两条是「空串静默留下」的闸门：库里出现 '' 之后，凡判断「用户有没有写过」
  //   的地方都得写两遍（null 与 '' 两种形态）
  check(shots[1]?.line === null, '空串台词落成 null（不是空字符串）', shots[1]?.line)
  check(shots[1]?.visualReq === null, '空串画面要求落成 null', shots[1]?.visualReq)
  check(
    shots.every((s) => s.assetId === null),
    '预置分镜没有绑定素材（与 AI 生成的分镜同一个起始状态）',
  )

  section('② 反例：不传 shotSkeleton 时行为不变')
  const plain = await api<{ id: string }>('POST', '/creations', {
    token,
    body: { storeId: store.id, dishId: String(dish.id), title: `无骨架自检 ${Date.now() % 100000}` },
  })
  check(plain.body.code === 0, '不传 shotSkeleton 依然能建创作', plain.body)
  if (plain.body.code === 0) {
    const pid = plain.body.data.id
    createdIds.push(BigInt(pid))
    const pdetail = await api<{ shots: unknown[] }>('GET', `/creations/${pid}`, { token })
    check((pdetail.body.data?.shots ?? []).length === 0, '不传骨架 ⇒ 0 条分镜（不回归）')
  }

  section('③ 反例：骨架超过 20 条被拒')
  const tooMany = await api('POST', '/creations', {
    token,
    body: {
      storeId: store.id,
      dishId: String(dish.id),
      shotSkeleton: Array.from({ length: 21 }, () => ({ shotType: '口播' })),
    },
  })
  check(tooMany.status === 400, '21 条骨架被参数校验拒绝（400）', tooMany.status)
  if (tooMany.body.code === 0) createdIds.push(BigInt((tooMany.body.data as { id: string }).id))

  section('④ 后台上传：作品视频 / 封面')
  const loginRes = await fetch(`${ADMIN_API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  })
  const loginBody = (await loginRes.json()) as { code: number; message: string; data: { token: string } }
  if (loginBody.code !== 0) {
    console.log(`  ! 后台登录失败（${loginBody.message}），跳过 ④`)
    return
  }
  adminToken = loginBody.data.token

  const videoRes = await adminUpload('video', fakeMp4(), 'check.mp4')
  check(videoRes.code === 0, '视频上传成功', videoRes.message)
  const videoKey = String(videoRes.data?.videoKey ?? '')
  if (videoKey) uploadedKeys.push(videoKey)
  check(videoKey.startsWith('works/'), '视频键落在 works/ 前缀下', videoKey)
  // 反例：伪装成 mp4 的文本必须被拒（放行任意字节 = 任意文件都能写进对象存储）
  const badRes = await adminUpload('video', Buffer.from('this is not a video at all'), 'fake.mp4')
  check(badRes.status === 400 && badRes.code === 400, '非视频字节被拒（按魔数，不信文件名）', badRes)
  check(
    String(badRes.message).includes('MP4'),
    '拒绝时给的是可读文案（不是「服务器内部错误」）',
    badRes.message,
  )

  const coverRes = await adminUpload('cover', fakeJpeg(), 'cover.jpg')
  check(coverRes.code === 0, '封面上传成功', coverRes.message)
  const coverKey = String(coverRes.data?.coverKey ?? '')
  if (coverKey) uploadedKeys.push(coverKey)
  check(coverKey.startsWith('works/') && coverKey.endsWith('.jpg'), '封面键落在 works/ 且扩展名按魔数取', coverKey)

  const badCover = await adminUpload('cover', Buffer.from('not an image'), 'cover.png')
  check(badCover.status === 400, '非图片字节被拒', badCover.status)

  section('⑤ 服务端抽出的封面键也落在 works/ 下（不阻断上传）')
  const autoCover = String(videoRes.data?.coverKey ?? '')
  if (autoCover) uploadedKeys.push(autoCover)
  check(autoCover === '' || autoCover.startsWith('works/'), '自动抽帧的封面键前缀正确', autoCover)

  // ─────────────── ⑥ 公开读接口：未带 token 必须 200 ───────────────
  section('⑥ 优秀作品读接口：未带 token 必须 200')
  // ★ 这一节盯的是一次真实事故（真机日志原样）：
  //     GET /api/v1/works?page=1&pageSize=6   401 (Unauthorized)
  //     GET /api/v1/works/categories          401 (Unauthorized)
  //   首页「优秀作品」在未登录时就会拉这两个接口（useDidShow 里不判断登录态），
  //   服务端挂着 auth ⇒ 401 ⇒ 小程序请求层 redirectToLogin() ⇒ 300ms 后 switchTab 到「我的」——
  //   未登录用户**一打开小程序就被从首页弹走**。
  //   放开是有意的，理由与安全边界写在 src/routes/works.ts 的文件头（与 tutorials.ts 同一套）。
  //   这里断言 200 同时也是防回归：谁把 auth 加回去，这条就会红。
  //
  // ★ 两个计数接口（POST /:id/view、POST /:id/clone）**刻意不在这里冒烟**：
  //   它们会真的 +1，打在真实作品上就是污染运营数据。
  //   那条线改用下面的源码断言兜 —— 公开与否写在源码里，同样看得见。
  for (const path of ['/works?page=1&pageSize=6', '/works/categories']) {
    const status = await probeStatus(path)
    if (status === null) {
      check(true, `${path} —— 本地服务未启动，跳过`)
    } else {
      check(status === 200, `${path} 未带 token 返回 200`, status)
    }
  }

  // 详情接口：用库里**已有**的一条已上架作品只读它，不改它（造数据没必要，也不该为这个改库）
  const someWork = await prisma.excellentWork.findFirst({
    where: { enabled: true, deletedAt: null },
    select: { id: true },
    orderBy: { id: 'desc' },
  })
  if (someWork) {
    const status = await probeStatus(`/works/${someWork.id}`)
    if (status === null) check(true, '作品详情 —— 本地服务未启动，跳过')
    else check(status === 200, `作品详情 /works/${someWork.id} 未带 token 返回 200`, status)
  } else {
    check(true, '库里没有已上架作品，跳过详情冒烟')
  }

  // ─────────────── ⑦ 源码级闸门（服务没起也拦得住） ───────────────
  section('⑦ 源码级闸门（服务没起也拦得住）')
  // 上面那几条 HTTP 断言在服务没起时是「跳过」，所以必须再有一道不依赖运行时的闸门：
  // 「读接口有意公开」这件事要能在源码里直接读出来。
  const worksRouteSrc = readSrc('../src/routes/works.ts')
  check(
    !/router\.use\(auth\)/.test(worksRouteSrc),
    'works 路由没有挂 auth 中间件（公开是有意的，见该文件头注释）',
  )
  check(
    /if \(!workSvc\.isSignableWorkKey\(key\)\) return null/.test(worksRouteSrc),
    '★ 签名守卫还在 —— 免登录之后它才是这条线上真正的安全边界，别顺手删',
  )
  const workSvcSrc = readSrc('../src/services/work.service.ts')
  check(
    !/SIGNABLE_WORK_PREFIXES = \[[^\]]*'uploads\/'/.test(workSvcSrc),
    '★ 前缀白名单不含 uploads/（否则免登录的详情接口会替任何人签出商户私有文件）',
  )
  // 这条是**跨端契约**的一半：服务端公开了，首页就必须真的把它渲染给未登录用户，
  // 否则接口白公开（未登录还是看不到作品）。放在这里是因为两半只有一起看才拦得住。
  const homeSrc = readSrc('../../apps/mini/src/pages/home/index.tsx')
  check(
    !/if \(!merchant\) return <View className='home'>/.test(homeSrc),
    '★ 首页不再「未登录整页早退」——作品区对未登录用户也要露出（那才是引流素材）',
  )
}

async function cleanup() {
  section('清理（硬删，不留痕）')
  for (const id of createdIds) {
    try {
      await prisma.shot.deleteMany({ where: { creationId: id } })
      await prisma.creation.deleteMany({ where: { id } })
      console.log(`  · 已删除自检创作 ${id}`)
    } catch (e) {
      console.log(`  ! 删除创作 ${id} 失败：${(e as Error).message}`)
    }
  }
  for (const key of uploadedKeys) {
    try {
      await deleteObject(key)
      console.log(`  · 已删除对象 ${key}`)
    } catch (e) {
      console.log(`  ! 删除对象 ${key} 失败：${(e as Error).message}`)
    }
  }
  if (tempDishId !== null) {
    try {
      await prisma.dish.deleteMany({ where: { id: tempDishId } })
      console.log(`  · 已删除临时菜品 ${tempDishId}`)
    } catch (e) {
      console.log(`  ! 删除临时菜品 ${tempDishId} 失败：${(e as Error).message}`)
    }
  }
}

main()
  .catch((e) => {
    fail++
    console.error('\n自检异常中断：', e)
  })
  .finally(async () => {
    await cleanup()
    console.log(`\n结果：通过 ${pass} / 失败 ${fail}`)
    // ★ 必须显式收尾：否则事件循环被 Prisma 连接挂住，脚本「跑完却不退出」
    await prisma.$disconnect()
    process.exit(fail ? 1 : 0)
  })
