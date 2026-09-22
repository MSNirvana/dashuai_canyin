/**
 * 「一次网络往返」的瞬断重试 —— 纯工具，**不依赖任何本项目其它模块**。
 *
 * ★ 为什么要单独一个文件，而不是塞在 `chatcut-driver.ts` 里：
 *   ① 这类「瞬断掐连接」不只 ChatCut 会碰到（COS、微信、TTS 都有），放在 `lib/` 才有人会去复用；
 *   ② 放在驱动里的话，守护脚本一 import 就被迫牵出 Prisma / Redis / 环境变量 ——
 *      于是要么引入外部依赖、要么干脆不写守护。抽出来之后守护可以纯函数式地测。
 *
 * ★★ 背景（2026-09-22，任务 12 的实证）：
 *   ChatCut 链路上会偶发 `TypeError: terminated`（对端把连接掐了）。这个错在**轮询**阶段不致命
 *   —— worker 那边有 `查询失败（第 1/40 次）` 兜着（任务 11 就是靠它活下来的）。
 *   但**启动阶段是一次性调用，外面没有任何重试** ⇒ 上传 12 个素材的路上任何一次瞬断
 *   都会让整条任务 FAILED、用户白等 4 分钟。任务 12 就是这么死的。
 */

/**
 * 重试上限（含首次）。★ 不要调大：这个值同时是「最坏耗时」的乘数，
 * 启动阶段虽有 30 分钟余量，但用户在盯着进度条看。
 */
export const TRANSIENT_RETRY_ATTEMPTS = 3

/**
 * 第 1 次失败后等 500ms、第 2 次后等 1500ms。
 * ★ 不做指数退避到底：瞬断（对端掐连接）下一次多半就成，等太久只是让进度条停住。
 */
export const TRANSIENT_RETRY_BACKOFF_MS = [500, 1_500] as const

/**
 * ★ 为什么要单独提出来：本项目的 tsconfig 开了 `noUncheckedIndexedAccess`，
 *   直接写 `ARR[ARR.length - 1]` 得到的类型是 `number | undefined`
 *   （编译器不知道那个下标一定存在）。`.at(-1)` + `?? 0` 既过类型又不用把 1500 抄第二遍。
 */
const LAST_BACKOFF_MS: number = TRANSIENT_RETRY_BACKOFF_MS.at(-1) ?? 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 「这个错误是不是网络抖动」—— 决定值不值得重试。
 *
 * ★ Node 的 fetch 失败只给一句 `TypeError: fetch failed`，真因藏在 `cause` 里，
 *   所以外层与 `cause` 都要看（本项目实测到的瞬断正好是
 *   `fetch failed` 外面套 `TypeError: terminated`）。
 *
 * ★ 反向也必须准确：`HTTP 400：…` 这类**确定性**拒绝不能进这个集合。
 *   否则用户会看到「重试 3 次后才失败」的假象，真因反而更难查。
 *   唯一的例外是 `5xx` —— 对端过载/网关抽风算抖动，下次可能就好。
 */
export function isTransientTransferError(error: unknown): boolean {
  const outer = error as { name?: string; message?: string; cause?: unknown } | null | undefined
  const cause = outer?.cause
  const texts: Array<string | undefined> = [outer?.name, outer?.message]
  if (cause instanceof Error) texts.push(cause.name, cause.message)
  else if (cause != null) texts.push(String(cause))
  const text = texts.filter(Boolean).join(' ')
  if (/\bHTTP 5\d\d\b/.test(text)) return true
  return /terminated|fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket|aborted|timeout/i.test(
    text,
  )
}

/**
 * 给一次网络往返套上有界重试。
 *
 * ★★ `run` 必须**可重复执行**，且每次自己重新取字节流 —— 预签名 PUT 要求如此。
 *    典型反例：`withTransientRetry('x', () => fetch(url, { body: Readable.toWeb(stream) }))`
 *    里那个 `stream` 若在闭包外创建，第二次尝试会去读一条**已消费完**的流而必然失败。
 *
 * ★ 非瞬断错误**立即抛出**，不浪费用户时间。
 */
export async function withTransientRetry<T>(what: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      const isLast = attempt === TRANSIENT_RETRY_ATTEMPTS - 1
      if (isLast || !isTransientTransferError(error)) throw error
      const wait = TRANSIENT_RETRY_BACKOFF_MS[attempt] ?? LAST_BACKOFF_MS
      console.warn(
        `[transient-retry] ${what} 第 ${attempt + 1}/${TRANSIENT_RETRY_ATTEMPTS} 次失败（${
          (error as Error).message
        }），${wait}ms 后重试`,
      )
      await sleep(wait)
    }
  }
  /* istanbul ignore next —— 循环要么 return 要么 throw，这行只是让 TS 满意 */
  throw lastError
}
