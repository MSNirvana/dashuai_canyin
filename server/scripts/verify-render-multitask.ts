/**
 * 合成「三档互不干扰」+「失败文案不泄漏」回归。
 *
 * 两个被固化的行为（都是用户报出来的）：
 *   ① 「AI 生成中的时候，基础生成、精品生成都能用，生成按钮都可以点的」
 *      —— 服务端的并发拦截原本查的是「该创作**任意**档位有活跃任务」，
 *         于是 AI 在跑时提交基础档会被 409/4001 顶回来，而文案还把人引向「等一等」。
 *   ② 「前端展示不能出现 ChatCut、GPT 等字眼」
 *      —— `render_task.error_msg` 是**运维字段**（存异常原文），却也被小程序直接渲染。
 *         分流层 `src/render/user-errors.ts` 把用户可见文案单独产成 `errorText`。
 *
 * 跑法：npx tsx scripts/verify-render-multitask.ts
 *
 * ★ 两个刻意的设计：
 *   · 脚本内强制 `FFMPEG_WORKER=false`（不依赖 .env）。.env 里现在是 `true`，
 *     而 dev server 的 worker 与 API **同进程**、还活着 —— 不强制的话我这边刚提交的
 *     假素材任务会被它捡走、跑 ffmpeg 失败、写脏日志，把断言搅浑。
 *     演示模式下 BASIC/AI 在**同一事务**里直接 SUCCESS，只有 PREMIUM 停在人工队列（恒定活跃），
 *     所以「同档位被拦 / 异档位放行」可以在不起服务、不跑 ffmpeg 的前提下稳定复现。
 *   · 全程用**一次性临时商户**（跑完连同会员/账本/任务一起硬删），不碰商户 1/3 的真实数据。
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import * as renderSvc from '../src/services/render.service.js'
import { userFacingRenderError } from '../src/render/user-errors.js'
import { chatCutConfigured } from '../src/render/chatcut.js'

// 必须在任何 submitRender 调用之前生效：simulateWorkerEnabled() 是在**调用时**读 process.env 的
process.env.FFMPEG_WORKER = 'false'

const prisma = new PrismaClient()
const PHONE = '13900009071'
let merchantId: bigint | null = null

let pass = 0
let fail = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? `  ${extra}` : ''}`) }
}
function section(title: string) { console.log(`\n=== ${title} ===`) }

/** 用户界面上绝不允许出现的字节：第三方产品名 / 本机绝对路径 / 内部集成代号 */
const FORBIDDEN = /ChatCut|Chatcut|GPT|MCP|OpenAI|tokenbox|volcano|火山|ENOENT|\/Users\/|\/home\/|ffmpeg|ffprobe/i

async function cleanup(M: bigint) {
  // 依赖顺序照 verify-creation-archive.ts：shot / render_task / business_request 都指向别的主表
  const ids = (await prisma.creation.findMany({ where: { merchantId: M }, select: { id: true } })).map((c) => c.id)
  await prisma.businessRequest.deleteMany({ where: { merchantId: M } })
  await prisma.renderTask.deleteMany({ where: { merchantId: M } })
  if (ids.length > 0) await prisma.shot.deleteMany({ where: { creationId: { in: ids } } })
  await prisma.creation.deleteMany({ where: { merchantId: M } })
  await prisma.mediaAsset.deleteMany({ where: { merchantId: M } })
  await prisma.membershipReminder.deleteMany({ where: { merchantId: M } })
  await prisma.membership.deleteMany({ where: { merchantId: M } })
  await prisma.order.deleteMany({ where: { merchantId: M } })
  await prisma.beanLedger.deleteMany({ where: { merchantId: M } })
  await prisma.beanReservation.deleteMany({ where: { merchantId: M } })
  await prisma.beanAccount.deleteMany({ where: { merchantId: M } })
  await prisma.store.deleteMany({ where: { merchantId: M } })
  await prisma.merchant.deleteMany({ where: { id: M } })
}

/** 提交一次合成，把「是不是被并发拦截」与「是不是别的错」分开表达，避免用一句 try/catch 蒙混过去 */
async function submit(creationId: bigint, grade: 'BASIC' | 'AI' | 'PREMIUM', tag: string) {
  try {
    const r = await renderSvc.submitRender(prisma, merchantId!, creationId, {
      mode: 'FULL',
      grade,
      requestId: `verify-multitask-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    })
    return { ok: true as const, status: r.task.status, id: r.task.id }
  } catch (e) {
    const err = e as Error
    return {
      ok: false as const,
      name: err.name,
      message: err.message,
      // 只认这一类错：其余（如 AI 通道未配置的 RenderGradeUnavailableError）不是并发问题
      alreadyRunning: e instanceof renderSvc.RenderAlreadyRunningError,
    }
  }
}

// ═══════════════════════ ① 用户可见文案映射（纯函数） ═══════════════════════
section('① 失败文案映射：技术原文 → 用户话术')
{
  const cases: Array<[string, string | null, RegExp]> = [
    [
      '云端上传会话原文（实测存量 id=990025 就是这条）',
      'ChatCut 上传会话返回 HTTP 400：{"statusCode":400,"message":"helper import registration for video requires complete metadata"}',
      /素材/,
    ],
    [
      '本机绝对路径泄漏（实测存量 5 条 ENOENT）',
      "ENOENT: no such file or directory, copyfile '/Users/gaoyunhong/Documents/ChatGPT/Evvvv/server/storage/uploads/1/smoke-1.mp4' -> '/var/folders/x/in_0.mp4'",
      /素材/,
    ],
    ['授权/工具映射', 'AI 档需要先完成 ChatCut MCP 授权和工具映射', /暂不可用|稍后/],
    ['结算补偿原文', '积分释放失败：Connection pool timeout', /结算/],
    ['ffmpeg 命令行', 'ffmpeg exited with code 1: Conversion failed', /视频处理/],
    ['配音', 'volcano TTS 合成失败：quota exceeded', /配音/],
    ['未分类的技术噪音', 'tokenbox-gpt: upstream returned 502', /合成失败|稍后/],
  ]
  for (const [label, raw, expect] of cases) {
    const got = userFacingRenderError(raw)
    check(
      !!got && expect.test(got) && !FORBIDDEN.test(got),
      `${label} → 已脱敏且给得出动作`,
      `「${got}」`,
    )
  }
  check(userFacingRenderError(null) === null, 'null 原样返回 null（没失败就没文案）')
  check(userFacingRenderError('   ') === null, '纯空白也返回 null')
  // 业务提示必须**原样保留**：脱敏层不该把「该去补素材」这类可操作提示洗成通用话术
  const biz = '请先为至少一个分镜上传素材'
  check(userFacingRenderError(biz) === biz, '业务提示原样透传（不被过度脱敏）', `「${userFacingRenderError(biz)}」`)
}

// ═══════════════════════ ② 三档互不干扰（真走 submitRender） ═══════════════════════
section('② 三档互不干扰：同一档位才互相拦，异档位放行')
console.log(`  环境：FFMPEG_WORKER=${process.env.FFMPEG_WORKER}（脚本内强制演示模式）  chatCutConfigured=${chatCutConfigured()}`)

let toViewTaskId: bigint | null = null
let toViewOriginalErrorMsg: string | null = null

try {
  const stale = await prisma.merchant.findFirst({ where: { phone: PHONE }, select: { id: true } })
  if (stale) { console.log(`  ℹ 清理上次残留的临时商户 ${stale.id}`); await cleanup(stale.id) }

  const merchant = await prisma.merchant.create({ data: { phone: PHONE, nickname: '三档并行用例' } })
  merchantId = merchant.id
  const store = await prisma.store.create({ data: { merchantId: merchant.id, name: '三档并行店' } })

  // 会员：submitRender 里 requireSubscription('合成出片') 会拦，不给会员连第一档都提交不了
  const pkg = await prisma.memberPackage.findFirst({ orderBy: { id: 'asc' } })
  if (!pkg) throw new Error('库里没有任何会员套餐，无法构造用例（先跑 npm run db:seed 或后台建套餐）')
  await prisma.membership.create({
    data: {
      merchantId: merchant.id, packageId: pkg.id,
      startAt: new Date(Date.now() - 86400_000), endAt: new Date(Date.now() + 30 * 86400_000), status: 'ACTIVE',
    },
  })
  // 豆账户：freeze 要求可用余额足够，否则第一档就 BeanNotEnoughError
  await prisma.beanAccount.create({ data: { merchantId: merchant.id, balance: 1000n } })

  const creation = await prisma.creation.create({
    data: { merchantId: merchant.id, storeId: store.id, title: '三档并行用例', track: 'TRAFFIC', complexity: 'SIMPLE' },
  })
  // 素材：只是给 buildRenderClips 一个合法来源（同商户同门店、未删、有时长）。
  // 演示模式下不会真的去读它，所以 bucket/region 用占位值即可。
  const asset = await prisma.mediaAsset.create({
    data: {
      merchantId: merchant.id, storeId: store.id, ownerType: 'CREATION', type: 'VIDEO',
      cosKey: `uploads/${merchant.id}/verify-multitask.mp4`,
      bucket: 'verify', region: 'verify', sizeBytes: 1024n, durationMs: 4000, status: 'READY',
    },
  })
  await prisma.shot.create({ data: { creationId: creation.id, seq: 1, assetId: asset.id, status: 'READY', trimStartMs: 0 } })

  // ── 用 PREMIUM 占住「精品」档：它在任何环境下都停在人工队列（恒定活跃），不跑 ffmpeg ──
  const premium1 = await submit(creation.id, 'PREMIUM', 'premium1')
  check(premium1.ok && premium1.status === 'MANUAL_PENDING', '第 1 次提交精品生成 → 进入人工队列（活跃）', JSON.stringify(premium1))

  // ── 同档位再提一次：必须被拦，且文案点名是哪一档 ──
  const premium2 = await submit(creation.id, 'PREMIUM', 'premium2')
  const premium2Blocked = !premium2.ok && premium2.alreadyRunning
  const premium2Msg = premium2.ok ? '' : premium2.message
  check(premium2Blocked, '同档位重复提交 → RenderAlreadyRunningError（被拦）', JSON.stringify(premium2))
  check(
    premium2Blocked && premium2Msg.includes('精品生成'),
    '拦截文案点名了具体档位（不再是一句「已有合成任务进行中」）',
    `「${premium2Msg}」`,
  )
  check(premium2Blocked && /其他档位不受影响/.test(premium2Msg), '拦截文案说明了其他档位不受影响')

  // ── 异档位提交：这就是用户要的那条 ──
  const basic = await submit(creation.id, 'BASIC', 'basic')
  const basicBlocked = !basic.ok && basic.alreadyRunning
  check(!basicBlocked, '★ 精品占着的时候，基础生成**不被拦**（本轮修的核心行为）', JSON.stringify(basic))

  const ai = await submit(creation.id, 'AI', 'ai')
  const aiBlocked = !ai.ok && ai.alreadyRunning
  check(!aiBlocked, '★ 精品占着的时候，AI 生成**不被并发拦截**（通道未配置而拒绝属另一回事）', JSON.stringify(ai))

  // ── 精品这一档仍被占着（异档位放行不等于把并发保护弄丢了）──
  const premium3 = await submit(creation.id, 'PREMIUM', 'premium3')
  const premium3Blocked = !premium3.ok && premium3.alreadyRunning
  check(premium3Blocked, '精品档仍被占着 → 再提精品依旧被拦（保护没被削弱）')

  // ── 落到库里的实况 ──
  const tasks = await prisma.renderTask.findMany({ where: { creationId: creation.id }, orderBy: { id: 'asc' } })
  check(tasks.length === 3, '库中恰好 3 条任务（1 精品成功入队 + 1 基础 + 1 AI；两次被拦的没有落库）', `tasks=${tasks.map((t) => `${t.grade}:${t.status}`).join(', ')}`)
  check(
    tasks.filter((t) => t.grade === 'PREMIUM').length === 1,
    '被拦的两次精品提交没有产生第二行（并发保护在事务内生效）',
  )

  // ═══════════════════════ ③ 出口不泄漏 ═══════════════════════
  section('③ 接口出口：只给 errorText，且存量脏数据也被兜住')
  const target = tasks.find((t) => t.grade === 'PREMIUM')!
  toViewTaskId = target.id
  toViewOriginalErrorMsg = target.errorMsg

  // 故意把库里的 error_msg 写成最脏的样子（存量里真实存在的那种），
  // 验证**读出口**能兜住历史数据 —— 否则上线后老任务的报错照旧泄漏。
  await prisma.renderTask.update({
    where: { id: target.id },
    data: { errorMsg: 'ChatCut 上传会话返回 HTTP 400：ENOENT /Users/gaoyunhong/Documents/ChatGPT/Evvvv/server/storage/x.mp4' },
  })
  const view = await renderSvc.getRender(prisma, merchantId!, target.id) as unknown as Record<string, unknown>
  check(!('errorMsg' in view), '用户端视图里**没有** errorMsg 这个字段（原文不再下发）')
  check(typeof view.errorText === 'string', '用户端视图给了 errorText', `「${String(view.errorText)}」`)
  check(
    typeof view.errorText === 'string' && !FORBIDDEN.test(view.errorText),
    '★ 存量脏数据经过出口后不含产品名 / 本机路径',
  )
} catch (e) {
  fail++
  console.log(`  ✗ 用例中断：${(e as Error).stack ?? e}`)
} finally {
  // ★ 闸门/写库类用例必须还原：把被改过的 error_msg 写回去，别把临时商户的痕迹留在库里
  try {
    if (toViewTaskId !== null) {
      await prisma.renderTask.update({ where: { id: toViewTaskId }, data: { errorMsg: toViewOriginalErrorMsg } })
    }
  } catch { /* 商户已删就无需还原 */ }
  try {
    if (merchantId !== null) {
      await cleanup(merchantId)
      const left = await prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true } })
      check(left === null, '临时商户及其会员/账本/任务/素材已硬删干净')
    }
  } catch (e) {
    fail++
    console.log(`  ✗ 清理失败（手工清一下商户 ${merchantId}）：${(e as Error).message}`)
  }
}

console.log(`\n★ ${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
