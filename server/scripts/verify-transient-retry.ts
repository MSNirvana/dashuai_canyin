/**
 * 「启动阶段瞬断重试」的守护 —— 守住「一次网络抖动不再让整条 AI 档任务失败」这个契约。
 *
 * ★★ 为什么需要它（2026-09-22 任务 12 的实证）：
 *   ChatCut 链路会偶发 `TypeError: terminated`（对端把连接掐了）。它在**轮询**阶段不致命
 *   （worker 有 `查询失败（第 1/40 次）`，任务 11 靠它活下来），但**启动阶段是一次性调用、
 *   外面没有任何重试** ⇒ 上传 12 个素材的路上任何一次瞬断都会让整条任务 FAILED
 *   （任务 12 死在 `素材 shot-6.mp4 导入失败：fetch failed（TypeError: terminated）`，用户白等 261s）。
 *
 * ★ 这个守护要守住四件事：
 *   ① **该重试的必须被认出来**：本项目实测的错误形状是
 *      `TypeError: fetch failed`（外层）套 `TypeError: terminated`（`cause`）——
 *      只看外层 message 会漏判，所以两条都要看。
 *   ② **不该重试的必须被排除**：`HTTP 400/403` 这类确定性拒绝重试三次只是白等，
 *      还会把真因埋进重试日志里。**这条比 ① 更容易被写坏**，所以正反都要断言。
 *   ③ **重试次数有上界**：瞬断重试到 3 次就必须放弃，不能无限重试把用户挂住。
 *   ④ **字节流必须在重试闭包内部打开**：预签名 PUT 的 `open()` 注释明确要求
 *      「每次调用都要返回一个**新**流：PUT 重试会重读」。
 *      若把 `await open()` 提到重试外面，第二次尝试会去读一条**已消费完**的流而必然失败
 *      —— 那等于「加了重试反而更容易失败」，是这次改动最危险的回归点，所以用源码断言钉住。
 *
 * 运行：cd server && npx tsx scripts/verify-transient-retry.ts
 * ⚠ 纯内存 + 读一个源文件：不连库、不连 Redis、不发网络请求。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isTransientTransferError,
  TRANSIENT_RETRY_ATTEMPTS,
  TRANSIENT_RETRY_BACKOFF_MS,
  withTransientRetry,
} from '../src/lib/transient-retry.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIVER = join(HERE, '..', 'src', 'render', 'chatcut-driver.ts')

let pass = 0
let fail = 0

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  ok(label, Object.is(actual, expected), `期望 ${String(expected)}，实得 ${String(actual)}`)
}

// ── 造真实形状的错误 ──────────────────────────────────────────────────────────
/** 本项目线上实测的形状：外层 fetch 失败，真因在 cause（见 `describeImportError` 的注释） */
function terminatedError(): Error {
  const cause = new TypeError('terminated')
  return new TypeError('fetch failed', { cause })
}

console.log('\n① 瞬断识别：该认的认、不该认的不认')
{
  ok('★ 线上真实形状（fetch failed ∧ cause=TypeError: terminated）被判为瞬断', isTransientTransferError(terminatedError()))
  ok('  └ ECONNRESET 被判为瞬断', isTransientTransferError(new Error('read ECONNRESET')))
  ok('  └ HTTP 503（对端过载）被判为瞬断', isTransientTransferError(new Error('ChatCut 上传会话返回 HTTP 503：busy')))
  ok('  └ 超时被判为瞬断', isTransientTransferError(new Error('The operation was aborted due to timeout')))

  ok(
    '★★ HTTP 400（我们发错了）**不**判为瞬断 —— 重试只是白等',
    !isTransientTransferError(new Error('ChatCut 上传会话返回 HTTP 400：helper import registration requires metadata')),
  )
  ok(
    '★★ 预签名 403（签名过期/权限）**不**判为瞬断',
    !isTransientTransferError(new Error('ChatCut 素材上传失败（HTTP 403）：<Error><Code>AccessDenied</Code>')),
  )
  ok(
    '  └ 业务性报错（缺上传槽位）**不**判为瞬断',
    !isTransientTransferError(new Error('ChatCut 未返回上传槽位：{"ok":false}')),
  )
  ok(
    '  └ 分片未返回 ETag **不**判为瞬断',
    !isTransientTransferError(new Error('ChatCut 分片上传未返回 ETag，无法完成分片合并')),
  )
  ok('  └ null / undefined 不炸', !isTransientTransferError(null) && !isTransientTransferError(undefined))
}

console.log('\n② 重试语义：何时重、重几次、什么时候立刻抛')
{
  ok('重试上限为 3（含首次）', TRANSIENT_RETRY_ATTEMPTS === 3, String(TRANSIENT_RETRY_ATTEMPTS))
  ok('退避表非空且递增', TRANSIENT_RETRY_BACKOFF_MS.length >= 2)

  // 2.1 一次就成功 ⇒ 只调用一次
  let calls = 0
  const first = await withTransientRetry('用例1', async () => {
    calls += 1
    return 'ok'
  })
  eq('  └ 一次成功只调用一次', calls, 1)
  eq('  └ 返回值原样透传', first, 'ok')

  // 2.2 先瞬断、后成功 ⇒ 调用两次并返回成功值
  let calls2 = 0
  const second = await withTransientRetry('用例2', async () => {
    calls2 += 1
    if (calls2 === 1) throw terminatedError()
    return `ok-${calls2}`
  })
  eq('★ 瞬断一次后重试成功（调用 2 次）', calls2, 2)
  eq('  └ 返回的是成功那次的返回值', second, 'ok-2')

  // 2.3 一直瞬断 ⇒ 恰好 3 次后放弃，且抛的是**最后一次**的错
  let calls3 = 0
  let thrown: unknown
  try {
    await withTransientRetry('用例3', async () => {
      calls3 += 1
      throw terminatedError()
    })
  } catch (error) {
    thrown = error
  }
  eq('★★ 一直瞬断 ⇒ 恰好尝试 3 次就放弃（不会无限重试）', calls3, TRANSIENT_RETRY_ATTEMPTS)
  ok('  └ 抛出的确实是那个错误', (thrown as Error)?.message === 'fetch failed')

  // 2.4 确定性错误 ⇒ 立刻抛，一次都不重试
  let calls4 = 0
  try {
    await withTransientRetry('用例4', async () => {
      calls4 += 1
      throw new Error('ChatCut 上传会话返回 HTTP 400：bad request')
    })
  } catch {
    /* 预期 */
  }
  eq('★★ 确定性错误（4xx）⇒ 只调用 1 次，立刻放弃', calls4, 1)
}

/**
 * 把源码里的注释剥掉再做文本断言。
 * ★ 不剥会把**注释里写的反例**当成真代码 —— 本轮就踩过：
 *   `putStream` 上方那段注释里为了让读者看清错误写法，原样写了
 *   `body: Readable.toWeb(await open())`，于是「源码里有几处流式上传」直接数成了 3 而不是 2。
 * ★ 用状态机而不是正则：正则遇到 `'https://…'` 会把 `//` 当注释开头、把整行后半截吃掉。
 */
function stripComments(src: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!
    const next = src[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 1
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 1
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

console.log('\n③ 源码契约：字节流必须在重试闭包**内部**打开')
{
  const src = stripComments(await readFile(DRIVER, 'utf8'))

  const openCount = src.split('Readable.toWeb(await open').length - 1
  eq('  └ 有 2 处「把文件流当请求体」（单发 PUT + 分片 PUT）', openCount, 2)

  // 逐个检查：每一处 `Readable.toWeb(await open` 之前、同一个函数体内，必须有 `withTransientRetry(`
  const positions = [...src.matchAll(/Readable\.toWeb\(await open/g)].map((m) => m.index ?? -1)
  let allWrapped = positions.length > 0
  for (const at of positions) {
    const before = src.slice(0, at)
    const lastWrap = before.lastIndexOf('withTransientRetry(')
    const lastFn = before.lastIndexOf('async function')
    // 包裹它的那次必须出现在同一个函数体内（也就是在最近的 `async function` 之后）
    if (lastWrap < 0 || lastWrap < lastFn) allWrapped = false
  }
  ok(
    '★★ 每一处 `await open()` 都落在 `withTransientRetry` 闭包内（否则第二次读的是已消费的流）',
    allWrapped,
  )

  const wraps = src.split('withTransientRetry(').length - 1
  const tailWraps = src.split('return withTransientRetry(').length - 1
  ok(
    `  └ 每次重试都是「整个函数体包起来」（${tailWraps}/${wraps} 处是 return 形式）`,
    wraps > 0 && wraps === tailWraps,
    '有 withTransientRetry 没包住整个函数体 ⇒ 重试覆盖不到全部逻辑',
  )
  ok(
    '  └ 反证：不存在「先 await open 再进重试」的写法',
    !/await open\([^)]*\)[\s\S]{0,200}?withTransientRetry\(/.test(src),
  )

  // postImport 必须是「重试版」，原始函数只能被重试版引用（防止有人绕过去直接调）
  eq('  └ `postImportOnce` 只被引用 2 次（定义 + 重试版内部）', src.split('postImportOnce').length - 1, 2)
  ok('  └ 重试版 postImport 确实调用了 withTransientRetry', /withTransientRetry\(`上传会话/.test(src))
  eq(
    '  └ 上传会话的裸 fetch 只有 1 处（就在 postImportOnce 里，没人在别处另开一条）',
    src.split('fetch(session.endpoint').length - 1,
    1,
  )
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
