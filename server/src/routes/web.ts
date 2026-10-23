import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { prisma, redis } from '../db.js'
import { aiGateway } from '../ai/gateway-instance.js'
import { createRouter } from '../lib/async-router.js'
import { idParam, InvalidIdParamError } from '../lib/params.js'
import { requiredText, optionalText } from '../lib/validators.js'
import { ok, fail } from '../lib/result.js'
import { WebPayProviderError } from '../lib/wxpay.js'
import { auth } from '../middleware/auth.js'
import { PackageNotFoundError, PaymentUnavailableError } from '../services/order.service.js'
import { SubscriptionRequiredError } from '../services/subscription.service.js'
import { createWebOrder, getWebCatalog, payWebOrder, WebOrderError } from '../services/web-order.service.js'

const router = createRouter()
const sceneInput = z.object({ scene: z.enum(['NATIVE', 'H5']) })
const orderInput = sceneInput.extend({ kind: z.enum(['MEMBER', 'BEAN']), packageId: requiredText(19).regex(/^\d{1,19}$/) })
const orderNoInput = requiredText(32).regex(/^[MB]W[0-9a-f]{30}$/)

/** 只信任 index 中配置的 loopback 反代；直连取 socket，忽略请求体 IP。 */
export function webPayerClientIp(req: Request): string | undefined {
  const remote = req.socket.remoteAddress
  const ip = remote === '::1' || remote?.startsWith('127.') || remote?.startsWith('::ffff:127.') ? req.ip : remote
  const normalized = ip?.replace(/^::ffff:/, '')
  return normalized && isIP(normalized) ? normalized : undefined
}

async function limitPayment(req: Request, res: Response): Promise<boolean> {
  const count = Number(await redis.eval(`
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end
return n`, 1, `web:pay:merchant:${req.merchantId}`))
  if (count <= 10) return true
  res.setHeader('Retry-After', '60')
  fail(res, 4290, '支付请求过于频繁，请稍后重试', 429)
  return false
}

function paymentFailure(res: Response, error: unknown) {
  let code = 500, status = 500, message = '支付请求失败，请稍后重试'
  if (error instanceof WebOrderError) { code = error.code; status = error.status; message = error.message }
  else if (error instanceof PaymentUnavailableError) { code = 3008; status = 503; message = error.message }
  else if (error instanceof PackageNotFoundError) { code = 3006; status = 404; message = error.message }
  else if (error instanceof SubscriptionRequiredError) { code = 2005; status = 403; message = error.message }
  else if (error instanceof z.ZodError || error instanceof InvalidIdParamError) { code = 4000; status = 400; message = '参数不合法' }
  else if (error instanceof WebPayProviderError) {
    code = 3014; status = 502; message = '微信支付暂不可用，请稍后重试'
    if (error.providerCode === 'ORDERPAID') { code = 3009; status = 409; message = '微信订单已支付，请查询订单状态' }
    if (error.providerCode === 'ORDER_CLOSED') { code = 3010; status = 409; message = '微信订单已关闭，请重新下单' }
    if (error.providerCode === 'FREQUENCY_LIMITED' || error.providerCode === 'RATELIMIT_EXCEEDED' || error.httpStatus === 429) { status = 429; message = '微信支付请求过于频繁，请稍后重试' }
    if (error.providerCode === 'NO_AUTH' || error.providerCode === 'APPID_MCHID_NOT_MATCH') { status = 503; message = '微信支付通道暂不可用' }
  } else if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
    code = 3015; status = 504; message = '微信支付请求超时，请查询订单后重试'
  }
  if (status >= 500) console.error('[web-pay] 支付请求异常:', error instanceof WebPayProviderError ? error.providerCode : error instanceof Error ? error.message : '未知异常')
  const orderNo = error instanceof Error && 'orderNo' in error ? error.orderNo : undefined
  if (typeof orderNo === 'string') {
    return res.status(status).json({ code, message, data: { orderNo }, traceId: res.locals.traceId })
  }
  return fail(res, code, message, status)
}

router.get('/catalog', async (_req, res) => {
  try { ok(res, await getWebCatalog(prisma)) }
  catch (e) { paymentFailure(res, e) }
})

/**
 * 官网首页的展示图（**免登录**，必须在 `router.use(auth)` 之前）。
 *
 * ── 为什么另开一个接口，而不是让官网去读 `/api/v1/system/settings` ──────────────
 * 那个接口是给小程序用的：它把**全部** `isPublic` 的配置按组返回，而且 JSON 类型被
 * `coerceValue` 又 stringify 了一次，消费端得自己再 parse 一遍。官网只要 4 张图，
 * 让它去解析几十项别人的配置、还要踩那个「拿到的是字符串」的坑，是把一个内部实现
 * 细节变成官网的长期依赖。这里给一个**已经收敛好、且已做地址校验**的小响应。
 *
 * ── 为什么空表是正常返回、而不是 404 ────────────────────────────────────────
 * 这个功能上线时线上**一条配置都没有**。空串在这一层的语义是「这一格没配」，
 * 官网收到后用内置默认图补上 —— 所以「一次都没配过」和「配了又清空」都必须
 * 是**同一件事**：正常返回空表，不是错误。把没配写成 404 的话，官网就得把
 * 「404」也当成正常分支处理，错误与正常状态从此分不开。
 *
 * ⚠ 不要在这里合并内置默认图：默认图是官网包里的静态资源（`/images/*.jpg`），
 *   由官网自己知道；服务端一旦也知道这份清单，换图就得两边同时改。
 */
const SITE_GROUP = 'web'
const SITE_KEY = 'site'

/** 案例图固定 3 格，与官网首页 `.case-grid` 的 3 张卡一一对应。少则补空，多则丢弃。 */
const CASE_SLOTS = 3

/** 地址只放行绝对 http(s)。空串合法 = 没配。理由见 pickUrl 的调用处说明。 */
function pickUrl(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^https?:\/\//i.test(s) ? s : ''
}

function pickText(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v.trim() : ''
  return s.length > max ? s.slice(0, max) : s
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

const EMPTY_SITE = {
  hero: { image: '', alt: '' },
  cases: Array.from({ length: CASE_SLOTS }, () => ({ image: '', title: '', alt: '' })),
}

router.get('/site', async (_req, res) => {
  let row: { settingVal: string; isPublic: boolean } | null
  try {
    row = await prisma.systemSetting.findUnique({
      where: { groupKey_settingKey: { groupKey: SITE_GROUP, settingKey: SITE_KEY } },
      select: { settingVal: true, isPublic: true },
    })
  } catch (e) {
    // ★ 读库失败要**出声**：这一条和「没配」是两回事，混在一起就永远发现不了库出问题
    console.error('[web] 官网图片配置读取失败:', e)
    return fail(res, 500, '读取失败', 500)
  }
  // 没这一项、或后台把它关成非公开 ⇒ 回空表，官网用内置默认图
  if (!row || !row.isPublic) return ok(res, EMPTY_SITE)

  // 值被人手改坏（不是 JSON 对象 / 结构不对）⇒ 同样当「没配」，别让首页整块塌掉。
  // 这类情况运营在后台看得到（页面会亮红条），不需要官网也报错。
  let raw: unknown
  try { raw = JSON.parse(row.settingVal) } catch { return ok(res, EMPTY_SITE) }
  const it = asRecord(raw)
  if (Object.keys(it).length === 0) return ok(res, EMPTY_SITE)
  const hero = asRecord(it.hero)
  const casesRaw = Array.isArray(it.cases) ? it.cases : []

  ok(res, {
    hero: { image: pickUrl(hero.image), alt: pickText(hero.alt, 120) },
    cases: Array.from({ length: CASE_SLOTS }, (_, i) => {
      const c = asRecord(casesRaw[i])
      // ★ 案例图最多 3 格：超出的直接丢弃，而不是让官网拿到一个 4 张的数组去硬塞进
      //   一个三列的网格里（那会挤成一条，而且是运营在后台改数据时才现形）。
      return { image: pickUrl(c.image), title: pickText(c.title, 20), alt: pickText(c.alt, 120) }
    }),
  })
})

/**
 * ───────── 官网「免费试一条」（免登录） ─────────
 *
 * 为什么要有它：微信支付 H5 权限 2026-10-20 被驳回，理由是「网站中体验不到服务内容」。
 * 官方《商户申请H5支付权限注意事项》第 1 条要求「能清晰的看到网站售卖的商品以及
 * **网站内体验到服务的具体内容**」，反例第 4 类就是「网页只有课程介绍，要线下才能体验」——
 * 我们正是这一类：工具在小程序里，网页只有介绍 + 套餐。
 * ⇒ 网页上必须有一个**不登录就能用**的最小服务，让人当场看到成品的形状。
 *
 * ★ 这**不是**业务链路：`copy_demo` 场景 `beanPrice: 0`（不扣积分），只接受菜名与卖点。
 * ★ 成本敞口靠两层限流卡住（AI 是真花钱的）：
 *   ① 单 IP 每 24 小时 3 条；② 全站每 24 小时 200 条。
 *   计数用 Redis 滚动窗口（首次 INCR 时挂 TTL），不依赖服务器时区。
 */
const demoInput = z.object({
  dish: requiredText(20),
  sellingPoint: optionalText(60),
})
const DEMO_PER_IP_DAILY = 3
const DEMO_TOTAL_DAILY = 200

/** 返回 'ok' 表示放行；否则是拒绝原因（已经扣掉一次配额）。 */
async function takeDemoQuota(ip: string): Promise<'ok' | 'ip' | 'total'> {
  const incr = async (key: string) =>
    Number(
      await redis.eval(
        `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], 86400) end
return n`,
        1,
        key,
      ),
    )
  // 先扣 IP 配额：被 IP 限住的人不应该再占用全站额度
  if ((await incr(`web:demo:ip:${ip}`)) > DEMO_PER_IP_DAILY) return 'ip'
  if ((await incr('web:demo:total')) > DEMO_TOTAL_DAILY) return 'total'
  return 'ok'
}

/**
 * 把模型输出拆成「文案 / 分镜 / 标题」三段。
 *
 * ★★ 为什么不用 JSON：这条提示词要模型一次产出三种结构，JSON 是最容易「看起来对」的格式，
 *   但也是**最容易静默坏**的：前后缀 ```json、尾逗号、字段名被改写成 shots/videoShots……
 *   一旦解析失败，模型其实是**生成成功**了的，我们却只能整条丢掉或整条拒掉。
 *   三段标记行是纯文本切分：缺一段就少渲染一块，其余照常可用 —— 降级是渐进的。
 *
 * ★★ 标记一个都没认出来（模型完全没照格式写）时**不报错**：整段当文案返回。
 *   理由同上 —— 内容是好的，坏的只是包装，这时把好内容扔掉最亏。
 *   这条规则由 `parseDemoPack` 末尾那个 `if (!copy)` 分支兜住。
 *
 * ★ 分隔符只认全角竖线｜是幻觉：模型经常顺手写半角 `|`，两种都收。
 */
interface DemoShot {
  no: number
  time: string
  scene: string
  line: string
}

const DEMO_MARKERS = /(【\s*文案\s*】|【\s*分镜\s*】|【\s*标题\s*】)/

function parseDemoPack(raw: string): { text: string; shots: DemoShot[]; title: string } {
  // `**` 是模型最爱加的装饰，剥掉不影响任何内容，但留在画面上就是一堆星号
  const source = raw.replace(/\r\n/g, '\n').replace(/\*\*/g, '').trim()

  const seg: Record<'copy' | 'story' | 'title', string> = { copy: '', story: '', title: '' }
  const parts = source.split(DEMO_MARKERS)
  // split 带捕获组 ⇒ 奇数位是标记、偶数位是内容：['', '【文案】', '正文', '【分镜】', '…']
  for (let i = 1; i < parts.length; i += 2) {
    const marker = parts[i] ?? ''
    const body = (parts[i + 1] ?? '').trim()
    if (marker.includes('文案')) seg.copy = body
    else if (marker.includes('分镜')) seg.story = body
    else if (marker.includes('标题')) seg.title = body
  }

  const shots: DemoShot[] = []
  for (const [index, line] of seg.story.split('\n').map((s) => s.trim()).filter(Boolean).entries()) {
    if (index >= 5) break // 分镜正常 3 条；多出来的当模型跑偏，不展示
    // 解构给默认值，而不是 `cells[0]` 取值：本项目开了 `noUncheckedIndexedAccess`，
    // `cells[0]` 的类型是 `string | undefined`，直接塞进 `DemoShot` 编不过。
    const [first = '', second = '', third = '', ...rest] = line.split(/[｜|]/).map((c) => c.trim())
    if (rest.length > 0) {
      // 四格及以上：镜号｜时间段｜画面｜说什么（多出来的格并回「说什么」，不丢内容）
      shots.push({
        no: Number(first.replace(/\D/g, '')) || index + 1,
        time: second,
        scene: third,
        line: rest.join('｜'),
      })
    } else if (third) {
      // 只有三格：模型省了镜号 ⇒ 按出现顺序补，比丢掉这一镜强
      shots.push({ no: index + 1, time: first, scene: second, line: third })
    }
  }
  // 分镜整段认不出四格、但确实有字 ⇒ 至少让这段话能读，不要显示成空白卡
  if (!shots.length && seg.story) shots.push({ no: 1, time: '', scene: '', line: seg.story })

  return {
    text: seg.copy || (seg.story || seg.title ? '' : source),
    shots,
    title: seg.title,
  }
}

router.post('/demo/copy', async (req, res) => {
  const parsed = demoInput.safeParse(req.body)
  if (!parsed.success) return fail(res, 4000, '请填一个菜名（2~20 字）', 400)
  const { dish, sellingPoint } = parsed.data

  const ip = webPayerClientIp(req)
  if (!ip) return fail(res, 4000, '无法识别请求来源，请稍后再试', 400)

  const quota = await takeDemoQuota(ip)
  if (quota === 'ip') {
    res.setHeader('Retry-After', '3600')
    return fail(res, 4290, '今天的免费体验已经用完了，明天再来；想看更多就直接开通', 429)
  }
  if (quota === 'total') {
    res.setHeader('Retry-After', '3600')
    return fail(res, 4291, '今天体验的人有点多，稍后再试或直接开通', 429)
  }

  const r = await aiGateway.runScene({
    sceneCode: 'copy_demo',
    requestId: `demo-${randomUUID()}`,
    variables: { dishName: dish, sellingPoints: sellingPoint ?? '' },
  })
  if (!r.ok) {
    // 失败要出声：这条路径没有用户账号，日志是唯一能查到「为什么没人试成」的地方
    console.error('[web] 试用样例生成失败:', r.reason, r.message)
    return fail(res, 5000, '体验服务暂时忙不过来，请稍后再试', 503)
  }

  const pack = parseDemoPack(r.text)
  if (!pack.text && !pack.shots.length && !pack.title) {
    console.error('[web] 试用样例解析后为空:', JSON.stringify(r.text.slice(0, 200)))
    return fail(res, 5000, '体验服务暂时忙不过来，请稍后再试', 503)
  }
  // ★ 字段名保持 `text` 不变：老前端（浏览器里缓存的旧 bundle）只认它，
  //   多给两个字段不会让它报错，页面还能正常显示文案。
  ok(res, { ...pack, dish })
})

router.use(auth)
router.post('/orders', async (req, res) => {
  try {
    const input = orderInput.parse(req.body)
    const packageId = idParam(input.packageId, 'packageId')
    if (!await limitPayment(req, res)) return
    ok(res, await createWebOrder(prisma, req.merchantId!, { ...input, packageId }, webPayerClientIp(req)))
  } catch (e) { paymentFailure(res, e) }
})
router.post('/orders/:orderNo/pay', async (req, res) => {
  try {
    const { scene } = sceneInput.parse(req.body)
    const orderNo = orderNoInput.parse(req.params.orderNo)
    if (!await limitPayment(req, res)) return
    ok(res, await payWebOrder(prisma, req.merchantId!, orderNo, scene, webPayerClientIp(req)))
  } catch (e) { paymentFailure(res, e) }
})

export default router
